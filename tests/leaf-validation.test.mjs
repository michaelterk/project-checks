import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runChecks, runTests } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

const options = { workers: 1, inputConcurrency: 1, logger: false, progress: false };
const diagnostics = overrides => ({
  event() {}, files() {}, file() {},
  span: (_, __, operation) => operation(),
  ...overrides,
});

async function fixture(t, count = 1) {
  const root = await temporary(t, 'project-checks-leaf-');
  const source = await put(root, 'source.txt', 'original');
  const files = Array.from({ length: count }, (_, index) => `test/${index}.test.mjs`);
  for (const file of files) await put(root, file, '');
  return {
    root, source, files,
    config: {
      root, suite: 'leaf', inputs: [], coverage: false, logger: false,
      setup: () => ({ execute: () => 0 }),
      testInputs: () => ['source.txt'],
    },
  };
}

test('all-cached graph leaf discovers inputs only in initial and final full scans', async t => {
  const state = await fixture(t, 4);
  let callbacks = 0;
  const config = { ...state.config, testInputs: () => { callbacks++; return ['source.txt']; } };
  assert.equal((await runTests({ ...config, ...options })).passed, 4);
  callbacks = 0;
  const result = await runChecks([{ id: 'leaf', config }], options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.results[0].cached, 4);
  assert.equal(callbacks, 8, 'four files need one initial and one invocation-final discovery each');
});

for (const phase of ['setup', 'cache-hit']) {
  test(`cached prerequisite changed during ${phase} cannot launch dependent command`, async t => {
    const state = await fixture(t);
    let mutate = false;
    const config = {
      ...state.config, suite: 'prerequisite',
      setup: () => {
        if (mutate && phase === 'setup') writeFileSync(state.source, 'changed');
        return { execute: () => 0 };
      },
    };
    assert.equal((await runTests({ ...config, ...options })).passed, 1);
    mutate = true;
    const marker = join(state.root, 'dependent-ran');
    const running = runChecks([
      { id: 'prerequisite', config },
      { id: 'dependent', dependsOn: ['prerequisite'], cwd: state.root,
        command: [process.execPath, '-e', "require('node:fs').writeFileSync('dependent-ran','unsafe')"] },
    ], { ...options, diagnostics: diagnostics({
      file(_, __, event) {
        if (phase === 'cache-hit' && event === 'cache-hit') writeFileSync(state.source, 'changed');
      },
    }) });
    try {
      await assert.rejects(running, /inputs changed/i);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
    } finally { await running.catch(() => {}); }
  });
}

test('leaf source changed after suite end fails invocation final gate', async t => {
  const state = await fixture(t);
  let ended = false;
  const running = runChecks([{ id: 'leaf', config: state.config }], {
    ...options, diagnostics: diagnostics({ suiteEnd() {
      ended = true;
      writeFileSync(state.source, 'changed after suite end');
    } }),
  });
  try {
    await assert.rejects(running, /inputs changed/i);
    assert.equal(ended, true);
  } finally { await running.catch(() => {}); }
});

for (const mutation of ['source', 'added test', 'removed test']) {
  test(`leaf targeted validation latches a transient ${mutation}`, async t => {
    const state = await fixture(t);
    const owner = join(state.root, state.files[0]);
    const added = join(state.root, 'test/transient.test.mjs');
    let restored = false;
    const config = { ...state.config, cache: false, setup: () => ({ execute: () => {
      if (mutation === 'source') writeFileSync(state.source, 'transient source');
      else if (mutation === 'added test') writeFileSync(added, '');
      else rmSync(owner);
      return 0;
    } }) };
    const running = runChecks([{ id: 'leaf', config }], {
      ...options, progress: { files() {}, file(_, __, event) {
        if (event !== 'file-end') return;
        if (mutation === 'source') writeFileSync(state.source, 'original');
        else if (mutation === 'added test') rmSync(added, { force: true });
        else writeFileSync(owner, '');
        restored = true;
      } },
    });
    try {
      const outcome = await running.then(result => ({ result }), error => ({ error }));
      assert.equal(restored, true, 'mutation restored after targeted validation, before final gate');
      if (outcome.error) assert.match(outcome.error.message, /inputs changed|discovery changed|No test files found/i);
      else {
        assert.equal(outcome.result.exitCode, 1);
        assert.equal(outcome.result.results[0].inputsChanged, true);
      }
    } finally { await running.catch(() => {}); }
  });
}

for (const failure of ['input mutation', 'cancellation']) {
  test(`leaf final ${failure} leaves duration hints untouched`, async t => {
    const state = await fixture(t);
    const hints = await put(state.root, '.test-cache/project-checks/durations-leaf.json', '{"previous":true}');
    const controller = new AbortController();
    const running = runChecks([{ id: 'leaf', config: { ...state.config, cache: false, durationHints: true } }], {
      ...options, signal: controller.signal, diagnostics: diagnostics({ suiteEnd() {
        if (failure === 'cancellation') controller.abort();
        else writeFileSync(state.source, 'changed after suite end');
      } }),
    });
    try {
      await assert.rejects(running, failure === 'cancellation' ? { name: 'AbortError' } : /inputs changed/i);
      assert.equal(await readFile(hints, 'utf8'), '{"previous":true}');
      assert.equal((await readdir(join(state.root, '.test-cache/project-checks'))).some(name => name.endsWith('.tmp')), false);
    } finally { await running.catch(() => {}); }
  });
}

test('successful leaf publishes duration hints after invocation final verification', async t => {
  const state = await fixture(t);
  const hints = await put(state.root, '.test-cache/project-checks/durations-leaf.json', '{"previous":true}');
  let atSuiteEnd;
  const running = runChecks([{ id: 'leaf', config: { ...state.config, cache: false, durationHints: true } }], {
    ...options, diagnostics: diagnostics({ suiteEnd() { atSuiteEnd = readFileSync(hints, 'utf8'); } }),
  });
  try {
    assert.equal((await running).exitCode, 0);
    assert.equal(atSuiteEnd, '{"previous":true}');
    const saved = JSON.parse(await readFile(hints, 'utf8'));
    assert.ok(Object.hasOwn(saved, state.files[0]));
  } finally { await running.catch(() => {}); }
});

for (const failure of ['failure', 'cancellation']) {
  test(`final definition verifier ${failure} cannot publish leaf duration hints`, async t => {
    const state = await fixture(t);
    const hints = await put(state.root, '.test-cache/project-checks/durations-leaf.json', '{"previous":true}');
    const controller = new AbortController();
    const reason = new Error('definition final verification failed');
    let calls = 0;
    const running = runChecks([{
      id: 'leaf', config: { ...state.config, cache: false, durationHints: true },
      verify() {
        if (++calls !== 2) return;
        if (failure === 'cancellation') controller.abort();
        else throw reason;
      },
    }], { ...options, signal: controller.signal });
    try {
      await assert.rejects(running, failure === 'cancellation' ? { name: 'AbortError' } : error => error === reason);
      assert.equal(calls, 2);
      assert.equal(await readFile(hints, 'utf8'), '{"previous":true}');
    } finally { await running.catch(() => {}); }
  });
}

test('blocked peer final definition verifier delays all leaf hint publication', { timeout: 10000 }, async t => {
  const first = await fixture(t), peer = await fixture(t);
  const hints = await Promise.all([first, peer].map(state =>
    put(state.root, '.test-cache/project-checks/durations-leaf.json', '{"previous":true}')));
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0;
  const running = runChecks([
    { id: 'first', config: { ...first.config, cache: false, durationHints: true } },
    { id: 'peer', config: { ...peer.config, cache: false, durationHints: true }, verify() {
      if (++calls !== 2) return;
      entered.resolve();
      return release.promise;
    } },
  ], options);
  try {
    await Promise.race([entered.promise, running.then(() => { throw new Error('Peer final verifier never started'); })]);
    for (const path of hints) assert.equal(await readFile(path, 'utf8'), '{"previous":true}');
    release.resolve();
    assert.equal((await running).exitCode, 0);
    for (const path of hints) assert.ok(JSON.parse(await readFile(path, 'utf8'))['test/0.test.mjs']);
  } finally { release.resolve(); await running.catch(() => {}); }
});

test('duration hint write failure leaves owned progress in failed terminal state', async t => {
  const state = await fixture(t);
  const hints = await put(state.root, '.test-cache/project-checks/durations-leaf.json', '{"previous":true}');
  const messages = [];
  let calls = 0;
  const running = runChecks([{
    id: 'leaf', config: { ...state.config, cache: false, durationHints: true },
    verify() {
      if (++calls !== 2) return;
      rmSync(hints);
      mkdirSync(hints);
    },
  }], { ...options, progress: undefined, logger: {
    log: message => messages.push(message), error: message => messages.push(message),
  } });
  try {
    await assert.rejects(running, { code: 'EISDIR' });
    assert.equal(calls, 2);
    const summaries = messages.filter(message => message.includes('TEST_SUMMARY:'));
    assert.equal(summaries.length, 1);
    assert.match(summaries[0], /\| FAIL$/);
  } finally { await running.catch(() => {}); }
});
