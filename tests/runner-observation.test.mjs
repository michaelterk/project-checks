import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Admission, createDiagnostics, createFileSnapshot, createSnapshotContext, runTests } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

async function fixture(t, suite = 'checks') {
  const root = await temporary(t);
  const files = ['test/a.test.mjs', 'test/b.test.mjs', 'test/c.test.mjs'];
  for (const file of files) await put(root, file, '// Independent fixture\n');
  const calls = join(root, '.test-cache/calls');
  await put(root, '.test-cache/calls', '');
  return {
    root,
    files,
    calls,
    options: {
      root,
      suite,
      inputs: [],
      workers: 1,
      logger: false,
      command: [
        process.execPath,
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv[1] + '\\n');`,
        '{file}',
      ],
    },
  };
}

const sourceHash = (source) => createHash('sha256').update(source).digest('hex');
const calls = async (path) => (await readFile(path, 'utf8')).trim().split('\n');

test('duration hints prioritize long unchanged files, retain cached times and discard changed-source times', async (t) => {
  const f = await fixture(t);
  const path = await put(
    f.root,
    '.test-cache/project-checks/durations-checks.json',
    JSON.stringify({
      [f.files[0]]: { hash: sourceHash('// Independent fixture\n'), seconds: 10 },
      [f.files[1]]: { hash: sourceHash('// Independent fixture\n'), seconds: 90 },
    }),
  );
  const options = { ...f.options, durationHints: true };
  assert.equal((await runTests(options)).passed, 3);
  assert.deepEqual(await calls(f.calls), [f.files[1], f.files[0], f.files[2]]);
  const measured = await readFile(path, 'utf8');
  const values = JSON.parse(measured);
  assert.deepEqual(Object.keys(values).sort(), f.files);
  assert.ok(
    Object.values(values).every((value) => value.seconds > 0 && value.hash === sourceHash('// Independent fixture\n')),
  );
  assert.equal((await runTests(options)).cached, 3);
  assert.equal(await readFile(path, 'utf8'), measured);
  await writeFile(
    path,
    JSON.stringify({
      [f.files[0]]: { hash: sourceHash('// Independent fixture\n'), seconds: 10 },
      [f.files[1]]: { hash: sourceHash('// Independent fixture\n'), seconds: 90 },
    }),
  );
  await put(f.root, f.files[1], '// Changed source\n');
  await writeFile(f.calls, '');
  assert.equal((await runTests({ ...options, cache: false })).passed, 3);
  assert.deepEqual(await calls(f.calls), [f.files[0], f.files[1], f.files[2]]);
});

test('disabled timing hints leave the timing file untouched; corrupt and nested-suite files work', async (t) => {
  const f = await fixture(t, 'tools/client');
  const path = await put(f.root, '.test-cache/project-checks/durations-tools%2Fclient.json', '{');
  assert.equal((await runTests({ ...f.options, durationHints: false })).passed, 3);
  assert.equal(await readFile(path, 'utf8'), '{');
  assert.equal((await runTests({ ...f.options, cache: false, durationHints: true })).passed, 3);
  assert.equal(Object.keys(JSON.parse(await readFile(path, 'utf8'))).length, 3);
});

test('diagnostics account for fresh/cached work, snapshots and time-weighted summaries', async (t) => {
  const f = await fixture(t);
  for (const cached of [false, true]) {
    const events = [];
    const diagnostics = createDiagnostics({
      logger: { log: (line) => events.push(JSON.parse(line.trim().slice('TEST_DIAGNOSTIC '.length))) },
    });
    diagnostics.suiteStart('checks');
    try {
      const result = await runTests({ ...f.options, diagnostics });
      assert.equal(cached ? result.cached : result.passed, 3);
      diagnostics.suiteEnd('checks');
    } finally {
      diagnostics.close(0);
    }
    const completions = events.filter((value) => value.event === (cached ? 'cache-hit' : 'file-end'));
    assert.equal(completions.length, 3);
    assert.equal(completions.at(-1).counts.queued, 0);
    assert.equal(completions.at(-1).counts.running, 0);
    assert.equal(completions.at(-1).counts[cached ? 'cached' : 'completed'], 3);
    assert.ok(events.find((value) => value.event === 'snapshot-final').call >= 2);
    const summary = events.find((value) => value.event === 'summary' && value.phase === 'whole-run');
    assert.ok(summary.seconds > 0);
    assert.ok(Math.abs(summary.secondsAtLeast80 + summary.secondsBelow80 - summary.observedSeconds) < 1e-9);
    assert.equal(events.filter((value) => value.event === 'file-start').length, cached ? 0 : 3);
  }
});

test('resource observation does not patch admission methods or drive scheduler ticks', async () => {
  const acquire = Admission.prototype.acquire;
  const tick = Admission.prototype.tick;
  const diagnostics = createDiagnostics({ logger: false });
  const admission = new Admission({}, 8, {
    host: { cpus: 8, memoryMiB: 8192 },
    sample: () => ({ busyCpus: 2, pressure: 0, memoryPressure: 0, availableMemoryMiB: 4096 }),
  });
  try {
    diagnostics.observeAdmission(admission);
    await admission.acquire();
    admission.active = admission.limit;
    const initial = admission.limit;
    for (let i = 0; i < 3; i++) admission.tick();
    assert.equal(admission.limit, initial + 1);
    assert.ok(admission.inspect().lastTick);
    assert.equal(Admission.prototype.acquire, acquire);
    assert.equal(Admission.prototype.tick, tick);
  } finally {
    admission.close();
    diagnostics.close(0);
  }
});

test('shared snapshot context outlives individual handles and closes after all callers', async (t) => {
  const f = await fixture(t);
  const context = createSnapshotContext();
  const first = await createFileSnapshot({ ...f.options, snapshotContext: context, files: [f.files[0]] });
  const second = await createFileSnapshot({ ...f.options, snapshotContext: context, files: [f.files[1]] });
  try {
    await first.snapshot();
    await first.close();
    await assert.rejects(first.snapshot(), /closed/);
    assert.deepEqual(Object.keys((await second.snapshot()).units), [f.files[1]]);
    await context.close();
    await assert.rejects(second.snapshot(), /closed/);
  } finally {
    await first.close();
    await second.close();
    await context.close();
  }
});

test('dynamic per-file dependencies preserve exclusions and refresh the import closure on rechecks', async (t) => {
  const f = await fixture(t);
  await put(f.root, 'src/first.mjs', 'first');
  await put(f.root, 'src/second.mjs', 'second');
  await put(f.root, 'src/.cache/output', 'generated');
  let dependency = 'src/first.mjs';
  const inputs = await createFileSnapshot({
    ...f.options,
    ignore: ['**/.cache', '**/.cache/**'],
    testInputs: (id) => (id === f.files[0] ? [dependency] : ['src']),
  });
  try {
    const first = await inputs.snapshot();
    await put(f.root, 'src/.cache/output', 'different generated');
    assert.deepEqual(await inputs.snapshot(), first);
    dependency = 'src/second.mjs';
    const second = await inputs.snapshot();
    assert.equal(second.common, first.common);
    assert.notEqual(second.units[f.files[0]], first.units[f.files[0]]);
    assert.equal(second.units[f.files[1]], first.units[f.files[1]]);
  } finally {
    await inputs.close();
  }
});

test('closing a shared handle drains its in-flight snapshot without closing other handles', async (t) => {
  const f = await fixture(t);
  const context = createSnapshotContext();
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const first = await createFileSnapshot({
    ...f.options,
    snapshotContext: context,
    files: [f.files[0]],
    testInputs: async () => {
      enter();
      await barrier;
      return [];
    },
  });
  const second = await createFileSnapshot({ ...f.options, snapshotContext: context, files: [f.files[1]] });
  try {
    const snapshot = first.snapshot();
    await entered;
    let closed = false;
    const closing = first.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);
    release();
    await snapshot;
    await closing;
    await assert.rejects(first.snapshot(), /closed/);
    await second.snapshot();
  } finally {
    release();
    await first.close();
    await second.close();
    await context.close();
  }
});

test('input changes and cancellation at the final snapshot leave existing duration hints untouched', async (t) => {
  for (const cancel of [false, true]) {
    const f = await fixture(t);
    const controller = new AbortController();
    const path = await put(f.root, '.test-cache/project-checks/durations-checks.json', '{"previous":true}');
    const diagnostics = createDiagnostics({ logger: false });
    diagnostics.suiteStart('checks');
    const event = diagnostics.event;
    diagnostics.event = (name, fields) => {
      event(name, fields);
      if (cancel && name === 'snapshot-final') controller.abort();
    };
    let options = { ...f.options, files: [f.files[0]], durationHints: true, signal: controller.signal, diagnostics };
    if (!cancel) {
      await put(f.root, 'src/value', 'original');
      options = {
        ...options,
        inputs: ['src'],
        command: [process.execPath, '-e', "require('node:fs').writeFileSync('src/value', 'changed')", '{file}'],
      };
    }
    try {
      if (cancel) await assert.rejects(runTests(options), { name: 'AbortError' });
      else assert.equal((await runTests(options)).inputsChanged, true);
      assert.equal(await readFile(path, 'utf8'), '{"previous":true}');
      const { readdir } = await import('node:fs/promises');
      assert.ok(!(await readdir(join(f.root, '.test-cache/project-checks'))).some((name) => name.endsWith('.tmp')));
    } finally {
      diagnostics.close(cancel ? 130 : 1);
    }
  }
});

test('cancellation after the final snapshot also rejects disabled-hint and all-cached runs', async (t) => {
  for (const cached of [false, true]) {
    const f = await fixture(t);
    if (cached) await runTests(f.options);
    const controller = new AbortController();
    const diagnostics = createDiagnostics({ logger: false });
    const event = diagnostics.event;
    diagnostics.event = (name, fields) => {
      event(name, fields);
      if (name === 'snapshot-final') controller.abort();
    };
    try {
      await assert.rejects(runTests({ ...f.options, diagnostics, signal: controller.signal, durationHints: cached }), {
        name: 'AbortError',
      });
    } finally {
      diagnostics.close(130);
    }
  }
});

test('concurrent suites share admission and hashing resources through failures', async (t) => {
  const f = await fixture(t);
  const context = createSnapshotContext();
  const admission = new Admission({}, 3, {
    workers: 1,
    host: { cpus: 4, memoryMiB: 4096 },
    sample: () => ({ busyCpus: 1, pressure: 0, memoryPressure: 0, availableMemoryMiB: 4096 }),
  });
  const shared = { ...f.options, snapshotContext: context, admission };
  try {
    const results = await Promise.allSettled([
      runTests({
        ...shared,
        suite: 'failure',
        files: [f.files[0]],
        command: [process.execPath, '-e', 'process.exitCode = 1', '{file}'],
      }),
      runTests({ ...shared, suite: 'success', files: [f.files[1]] }),
    ]);
    assert.deepEqual(
      results.map((result) => result.value.exitCode),
      [1, 0],
    );
    assert.equal(admission.peak, 1);
    assert.equal(admission.active, 0);
    assert.equal((await runTests({ ...shared, suite: 'success', files: [f.files[1]] })).cached, 1);
  } finally {
    admission.close();
    await context.close();
  }
});

test('diagnostic instances remain distinct within the same millisecond', (t) => {
  t.mock.method(Date.prototype, 'toISOString', () => '2026-10-04T00:00:00.000Z');
  const runs = [];
  const logger = { log: (line) => runs.push(JSON.parse(line.trim().slice('TEST_DIAGNOSTIC '.length)).run) };
  const first = createDiagnostics({ logger });
  const second = createDiagnostics({ logger });
  try {
    assert.notEqual(runs[0], runs[1]);
  } finally {
    first.close(0);
    second.close(0);
  }
});

test('a failing dependency callback drains its blocked sibling before snapshot close completes', async (t) => {
  const f = await fixture(t);
  const context = createSnapshotContext();
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const inputs = await createFileSnapshot({
    ...f.options,
    files: f.files.slice(0, 2),
    snapshotContext: context,
    testInputs: async (id) => {
      if (id === f.files[0]) throw new Error('dependency failed');
      enter();
      await barrier;
      return [];
    },
  });
  try {
    const failed = inputs.snapshot().catch((error) => error);
    await entered;
    let closed = false;
    const closing = inputs.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);
    release();
    assert.equal((await failed).message, 'dependency failed');
    await closing;
  } finally {
    release();
    await inputs.close();
    await context.close();
  }
});
