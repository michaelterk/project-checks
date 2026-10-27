import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runCachedUnits, runTests } from '../src/index.mjs';
import { cachedRecord, put, temporary } from './helpers.mjs';

const deferred = () => Promise.withResolvers();
const tick = () => new Promise(resolve => setImmediate(resolve));

test('same-suite validation completes a fast unit while another dependency discovery is blocked', { timeout: 10000 }, async t => {
  const root = await temporary(t);
  for (const id of ['slow', 'fast']) await put(root, `test/${id}.test.mjs`, '');
  const entered = deferred(), release = deferred(), fastDone = deferred();
  t.after(() => release.resolve());
  let executing = false, commonCalls = 0;
  const calls = { slow: 0, fast: 0 };
  const running = runTests({
    root, inputs: [], workers: 1, coverage: false, logger: false,
    inputProjection: (entries, { kind }) => { if (kind === 'common') commonCalls++; return entries; },
    testInputs: async id => {
      const name = id.includes('slow') ? 'slow' : 'fast';
      calls[name]++;
      if (executing && name === 'slow') { entered.resolve(); await release.promise; }
      return [];
    },
    setup: () => ({ execute: () => { executing = true; return 0; } }),
    progress: { files() {}, file(suite, id, event) {
      if (id.includes('fast') && event === 'file-end') fastDone.resolve();
    } },
  });
  try {
    await Promise.race([Promise.all([entered.promise, fastDone.promise]),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Independent fast validator blocked behind slow dependency')), 1000); timer.unref(); })]);
    assert.deepEqual(calls, { slow: 2, fast: 2 }, 'each validator discovers only its own dependencies');
    assert.equal(commonCalls, 2, 'one common projection per batch, including initial scan');
    assert.equal((await cachedRecord(join(root, '.test-cache/project-checks'), 'tests', 'test/fast.test.mjs')).passed, true);
  } finally { release.resolve(); await running; }
});

test('a command finishing after an in-flight full scan starts gets a new freshness observation', { timeout: 10000 }, async t => {
  const root = await temporary(t), cacheDirectory = join(root, 'cache');
  const collecting = deferred(), releaseScan = deferred(), secondFinished = deferred(), observed = deferred();
  t.after(() => releaseScan.resolve());
  let state = 'original', calls = 0, observedSecond = 0;
  const snapshot = () => ({ common: 'same', units: { first: 'same', second: state } });
  const running = runCachedUnits({
    cacheDirectory, workers: 2, logger: null,
    units: ['first', 'second'].map(id => ({ id, identity: id })),
    snapshot: async () => {
      const value = snapshot();
      if (++calls === 2) { collecting.resolve(); await releaseScan.promise; }
      else if (calls > 2) { observedSecond++; observed.resolve(); }
      return value;
    },
    execute: async ({ id }) => {
      if (id === 'second') { await collecting.promise; state = 'changed'; secondFinished.resolve(); }
      return 0;
    },
  });
  try {
    await secondFinished.promise;
    await Promise.race([observed.promise, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Late completion reused an observation started before the command finished')), 1000); timer.unref();
    })]);
    assert.equal(observedSecond, 1);
  } finally { releaseScan.resolve(); await running; }
  const result = await running;
  assert.equal(result.inputsChanged, true);
  await assert.rejects(cachedRecord(cacheDirectory, 'tests', 'second'), /Missing passing record/);
});

for (const target of ['dependency', 'common']) {
  test(`targeted overlapping validators reject a ${target} mutation`, { timeout: 10000 }, async t => {
    const root = await temporary(t);
    for (const name of ['a', 'b']) await put(root, `test/${name}.test.mjs`, '');
    const dependency = await put(root, `${target}.txt`, 'original');
    const entered = deferred(), release = deferred();
    t.after(() => release.resolve());
    let executed = false, validating = 0;
    const running = runTests({ root, inputs: target === 'common' ? ['common.txt'] : [],
      workers: 1, coverage: false, logger: false,
      setup: () => ({ execute: () => { executed = true; return 0; } }),
      testInputs: async () => {
        if (executed) { if (++validating === 2) entered.resolve(); await release.promise; }
        return target === 'dependency' ? ['dependency.txt'] : [];
      },
    });
    try {
      await entered.promise;
      await writeFile(dependency, 'mutation');
    } finally { release.resolve(); await running; }
    const result = await running;
    assert.equal(result.inputsChanged, true);
    assert.deepEqual(await readdir(join(root, '.test-cache/project-checks')), []);
  });
}

test('artifact collection retains command admission and obeys validator concurrency', { timeout: 10000 }, async t => {
  const root = await temporary(t), artifact = await put(root, 'artifact', 'evidence');
  const full = deferred(), release = deferred();
  t.after(() => release.resolve());
  let active = 0, peak = 0;
  const ids = Array.from({ length: 12 }, (_, i) => String(i));
  const running = runCachedUnits({
    cacheDirectory: join(root, 'cache'), workers: 8, verificationConcurrency: 2, logger: null,
    units: ids.map(id => ({ id, identity: id })),
    snapshot: () => ({ common: 'same', units: Object.fromEntries(ids.map(id => [id, 'same'])) }),
    execute: () => 0, restoreEvidence: () => false,
    saveEvidence: async () => {
      peak = Math.max(peak, ++active);
      if (active === 2) full.resolve();
      try { await release.promise; return { files: [artifact] }; }
      finally { active--; }
    },
  });
  try {
    await full.promise;
    await tick();
    assert.equal(active, 2);
  } finally { release.resolve(); await running; }
  assert.equal((await running).passed, 12);
  assert.equal(peak, 2);
});

test('cancelled targeted validations drain dependency callbacks before fixture cleanup and publish nothing', { timeout: 10000 }, async t => {
  const root = await temporary(t);
  for (const id of ['a', 'b']) await put(root, `test/${id}.test.mjs`, '');
  const entered = deferred(), release = deferred(), controller = new AbortController();
  t.after(() => release.resolve());
  let executed = false, active = 0, started = 0, closed = false;
  const running = runTests({ root, inputs: [], coverage: false, workers: 1,
    signal: controller.signal, logger: false,
    testInputs: async () => {
      if (executed) {
        active++;
        if (++started === 2) entered.resolve();
        try { await release.promise; } finally { active--; }
      }
      return [];
    },
    setup: () => ({ execute: () => { executed = true; return 0; },
      close: () => { assert.equal(active, 0); closed = true; } }),
  });
  const rejected = assert.rejects(running, { name: 'AbortError' });
  try {
    await entered.promise;
    controller.abort();
    await tick();
    assert.equal(closed, false);
  } finally { controller.abort(); release.resolve(); await rejected; }
  assert.equal(closed, true);
  assert.deepEqual(await readdir(join(root, '.test-cache/project-checks')), []);
});


test('targeted validation latches an added test even if it disappears before final verification', { timeout: 10000 }, async t => {
  const root = await temporary(t);
  await put(root, 'test/one.test.mjs', '');
  const added = join(root, 'test/transient.test.mjs');
  const result = await runTests({ root, inputs: [], coverage: false, workers: 1, logger: false,
    setup: () => ({ execute: () => { writeFileSync(added, ''); return 0; } }),
    progress: { files() {}, file(_, id, event) {
      if (event === 'file-end') rmSync(added, { force: true });
    } },
  });
  assert.equal(result.inputsChanged, true);
  assert.equal(result.exitCode, 1);
});
