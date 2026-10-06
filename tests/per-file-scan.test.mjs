import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createSnapshotContext, runCachedUnits, runChecks, runTests } from '../src/index.mjs';
import { createSnapshot } from '../src/inputs.mjs';
import { defaultIgnore, defaultDirectoryIgnore } from '../src/config.mjs';
import { put, temporary } from './helpers.mjs';

async function fixture(t) {
  const root = await temporary(t);
  for (const name of ['a', 'b']) await put(root, `test/${name}.test.mjs`, `// ${name}`);
  await put(root, 'source', 'original');
  return { root, suite: 'queued', testDirectory: 'test', pattern: '**/*.test.mjs', inputs: [],
    ignore: defaultIgnore, directoryIgnore: defaultDirectoryIgnore,
    cacheDirectory: join(root, '.cache'), coverage: false, logger: false, progress: false,
    setup: () => ({ execute: () => 0 }) };
}

test('each queued file discovers and fingerprints its inputs before cache comparison', async t => {
  const config = await fixture(t);
  const discovered = [];
  config.durationHints = true;
  config.testInputs = id => { discovered.push(id); return ['source']; };
  assert.equal((await runTests(config)).exitCode, 0);
  discovered.length = 0;
  const result = await runTests(config, {
    queueScan: async jobs => {
      assert.deepEqual(discovered, [], 'registration does not fingerprint every file');
      await jobs[0]();
      assert.deepEqual(discovered, ['test/a.test.mjs']);
      await jobs[1]();
      assert.deepEqual(discovered, ['test/a.test.mjs', 'test/b.test.mjs']);
    },
  });
  assert.equal(result.cached, 2);
  assert.equal(result.exitCode, 0);
});

test('one generation shares dependency identity and subsequent generations recheck it', async t => {
  const config = await fixture(t);
  config.testInputs = () => ['source'];
  const context = createSnapshotContext({ inputConcurrency: 2 });
  t.after(() => context.close());
  const identify = context.identify;
  let sourceReads = 0;
  context.identify = (paths, ...args) => {
    sourceReads += paths.filter(path => path === join(config.root, 'source')).length;
    return identify(paths, ...args);
  };
  const snapshot = createSnapshot(config, context);
  const prepared = await snapshot.prepare();
  assert.equal(sourceReads, 0);
  await Promise.all(prepared.files.map(prepared.unit));
  assert.equal(sourceReads, 1);
  const first = structuredClone(prepared.value);
  assert.deepEqual(await snapshot(), first);
  assert.equal(sourceReads, 2);
  await writeFile(join(config.root, 'source'), 'changed');
  const changed = await snapshot();
  assert.notEqual(changed.units['test/a.test.mjs'], first.units['test/a.test.mjs']);
  assert.notEqual(changed.units['test/b.test.mjs'], first.units['test/b.test.mjs']);
});

test('queued dependency failures identify suite file stage and underlying cause', async t => {
  const config = await fixture(t);
  config.testInputs = () => { throw new Error('dependency adapter unavailable'); };
  await assert.rejects(runTests(config), /queued\/test\/[ab]\.test\.mjs: .*dependency discovery: dependency adapter unavailable/);
});

test('input changes during execution cannot certify queued fingerprints', async t => {
  const config = await fixture(t);
  config.testInputs = () => ['source'];
  config.setup = () => ({ execute: async () => { await writeFile(join(config.root, 'source'), 'changed'); return 0; } });
  const result = await runTests({ ...config, workers: 1 });
  assert.equal(result.exitCode, 1);
  assert.equal(result.inputsChanged, true);
});

test('configuration failure cancels promptly and drains concurrent callbacks before returning', async t => {
  const config = await fixture(t);
  const entered = Promise.withResolvers(), released = Promise.withResolvers(), aborted = Promise.withResolvers();
  let closed = false, returned = false;
  const failure = new Error('invalid configuration');
  const running = runChecks([
    { id: 'slow', config: async ({ signal }) => {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      entered.resolve();
      await released.promise;
      closed = true;
      return config;
    } },
    { id: 'broken', config: async () => { await entered.promise; throw failure; } },
  ], { logger: false, progress: false }).finally(() => { returned = true; });
  const rejection = assert.rejects(running, error => error === failure);
  await aborted.promise;
  assert.equal(returned, false);
  assert.equal(closed, false);
  released.resolve();
  await rejection;
  assert.equal(closed, true);
});

test('pre-aborted checks invoke neither verification nor configuration callbacks', async () => {
  const controller = new AbortController();
  const reason = new Error('already cancelled');
  controller.abort(reason);
  let invoked = 0;
  await assert.rejects(runChecks([{ id: 'cancelled', verify: () => { invoked++; }, config: () => { invoked++; return {}; } }], {
    signal: controller.signal, logger: false, progress: false,
  }), error => error === reason);
  assert.equal(invoked, 0);
});


test('queued fingerprints preserve stable source-bound duration ordering', async t => {
  const config = await fixture(t);
  const { createHash } = await import('node:crypto');
  await put(config.root, '.cache/durations-queued.json', JSON.stringify({
    'test/a.test.mjs': { hash: createHash('sha256').update('// a').digest('hex'), seconds: 1 },
    'test/b.test.mjs': { hash: createHash('sha256').update('// b').digest('hex'), seconds: 10 },
  }));
  const order = [];
  config.setup = () => ({ execute: command => { order.push(command.at(-1)); return 0; } });
  assert.equal((await runTests({ ...config, cache: false, workers: 1, durationHints: true })).exitCode, 0);
  assert.deepEqual(order, ['test/b.test.mjs', 'test/a.test.mjs']);
});


test('a queued cache hit restores bound evidence before the next file starts; corrupted artifacts rerun', async t => {
  const root = await temporary(t);
  const artifact = await put(root, 'artifact', 'valid contribution');
  const units = ['a', 'b'].map(id => ({ id, identity: 'fixture' }));
  const value = { common: 'shared', units: { a: 'first', b: 'second' } };
  const restored = [], executed = [];
  const options = {
    suite: 'evidence', cacheDirectory: join(root, '.cache'), units, logger: null, progress: false,
    snapshot: () => value, execute: unit => { executed.push(unit.id); return 0; },
    saveEvidence: () => ({ files: [artifact] }), restoreEvidence: unit => { restored.push(unit.id); return true; },
  };
  assert.equal((await runCachedUnits(options)).passed, 2);
  executed.length = 0;
  const initialSnapshot = { files: ['a', 'b'], value: { common: '', units: {} }, unit: async id => {
    initialSnapshot.value.common = value.common;
    initialSnapshot.value.units[id] = value.units[id];
  } };
  const result = await runCachedUnits(options, { initialSnapshot, queueScan: async jobs => {
    await jobs[0]();
    assert.deepEqual(restored, ['a']);
    assert.deepEqual(Object.keys(initialSnapshot.value.units), ['a']);
    await jobs[1]();
    assert.deepEqual(restored, ['a', 'b']);
  } });
  assert.equal(result.cached, 2);
  assert.deepEqual(executed, []);
  await writeFile(artifact, 'corrupted contribution');
  restored.length = 0;
  assert.equal((await runCachedUnits(options)).passed, 2);
  assert.deepEqual(restored, []);
  assert.deepEqual(executed, ['a', 'b']);
});

test('normal queued runs still aggregate real coverage and detect mutation after cached planning', async t => {
  const config = await fixture(t);
  await put(config.root, 'source.mjs', 'export const value = 1;\n');
  for (const name of ['a', 'b']) await put(config.root, `test/${name}.test.mjs`, "import { value } from '../source.mjs'; if (value !== 1) throw Error('bad value');\n");
  delete config.setup;
  config.inputs = ['source.mjs'];
  config.coverage = { include: ['source.mjs'], minimum: { lines: 100, branches: 100, functions: 100 } };
  config.stdio = 'ignore';
  const fresh = await runTests(config);
  assert.equal(fresh.exitCode, 0);
  assert.equal(fresh.passed, 2);
  const cached = await runTests(config);
  assert.equal(cached.exitCode, 0);
  assert.equal(cached.cached, 2);
  await assert.rejects(runTests(config, { queueScan: async jobs => {
    for (const job of jobs) await job();
    await writeFile(join(config.root, 'source.mjs'), 'export const value = 2;\n');
  } }), /Covered source changed during cache scan/);
});


test('initial generation reuses its discovered inventory and later snapshots rediscover membership', async t => {
  const config = await fixture(t), context = createSnapshotContext();
  t.after(() => context.close());
  let operations = 0;
  const discover = context.discoverInventory;
  context.discoverInventory = options => { operations++; return discover(options); };
  const snapshot = createSnapshot(config, context);
  const initial = await snapshot.prepare(['test/a.test.mjs', 'test/b.test.mjs']);
  assert.equal(operations, 0, 'the already-discovered inventory is not walked again');
  await Promise.all(initial.files.map(initial.unit));
  await put(config.root, 'test/c.test.mjs', '// c');
  const next = await snapshot();
  assert.ok(Object.hasOwn(next.units, 'test/c.test.mjs'));
  assert.ok(operations > 0, 'later generations always discover a fresh inventory');
});


test('scan generation shares exact root projections across suites and clears them before fresh snapshots', async t => {
  const config = await fixture(t), context = createSnapshotContext();
  t.after(() => context.close());
  await put(config.root, 'dependency/keep', 'keep');
  await put(config.root, 'dependency/omit', 'omit');
  config.testInputs = () => ['dependency'];
  let dependencyWalks = 0;
  const identify = context.identify;
  context.identify = (paths, ...args) => {
    dependencyWalks += paths.filter(path => path === join(config.root, 'dependency')).length;
    return identify(paths, ...args);
  };
  context.beginScanGeneration();
  const first = createSnapshot(config, context), second = createSnapshot({ ...config, suite: 'other' }, context);
  const [a, b] = await Promise.all([first(), second()]);
  assert.deepEqual(a, b);
  assert.equal(dependencyWalks, 1);
  const different = await createSnapshot({ ...config, ignore: ['dependency/omit'] }, context)();
  assert.notDeepEqual(different, a);
  assert.equal(dependencyWalks, 2, 'different projections never share an identity');
  await context.finishScanGeneration();
  await writeFile(join(config.root, 'dependency/keep'), 'changed');
  assert.notDeepEqual(await first(), a);
  assert.equal(dependencyWalks, 3, 'a later generation starts fresh');
});


test('concurrent standalone suites leave a caller-owned context and generation lifecycle intact', async t => {
  const config = await fixture(t), context = createSnapshotContext();
  const close = context.close;
  t.after(() => close());
  for (const name of ['beginScanGeneration', 'finishScanGeneration', 'cancelScanGeneration', 'close']) {
    context[name] = () => { throw new Error(`caller owns ${name}`); };
  }
  const first = { ...config, snapshotContext: context, suite: 'first' };
  const second = { ...config, snapshotContext: context, suite: 'second' };
  const initial = await Promise.all([runTests(first), runTests(second)]);
  initial.forEach(result => assert.equal(result.passed, 2));
  const settled = await Promise.allSettled([
    runTests({ ...first, testInputs: () => { throw new Error('one suite failed'); } }),
    runTests(second),
  ]);
  assert.equal(settled[0].status, 'rejected');
  assert.match(settled[0].reason.message, /one suite failed/);
  assert.equal(settled[1].status, 'fulfilled');
  assert.equal(settled[1].value.cached, 2);
  await writeFile(join(config.root, 'source'), 'later');
  assert.equal(await context.sourceHash(join(config.root, 'source')), (await import('../src/util.mjs')).digest('later'));
});


test('scan inventory has one owner per discovery definition and later generations are fresh', async t => {
  const config = await fixture(t), context = createSnapshotContext();
  t.after(() => context.close());
  context.beginScanGeneration();
  const first = context.discoverInventory(config);
  assert.equal(context.discoverInventory({ ...config, suite: 'other' }), first);
  assert.deepEqual(await first, ['test/a.test.mjs', 'test/b.test.mjs']);
  assert.deepEqual(await context.discoverInventory({ ...config, pattern: 'a.test.mjs' }), ['test/a.test.mjs']);
  await context.finishScanGeneration();
  await put(config.root, 'test/c.test.mjs', '// c');
  assert.deepEqual(await context.discoverInventory(config), ['test/a.test.mjs', 'test/b.test.mjs', 'test/c.test.mjs']);
});


test('concurrent standalone suites sharing Admission do not create private hash pools', async t => {
  const { Admission } = await import('../src/admission.mjs');
  const { interceptReads } = await import('./input-read-helpers.mjs');
  const config = await fixture(t);
  const admission = new Admission({}, 4, {
    host: { cpus: 4, cpuQuotaCpus: 4, memoryMiB: 4096 }, workers: 1,
    sample: () => ({ availableMemoryMiB: 4096, busyCpus: 0, pressure: 0, memoryPressure: 0, ioPressure: 0 }),
  });
  t.after(() => admission.close());
  const reads = new Map();
  interceptReads(t, (file, read) => { reads.set(file, (reads.get(file) ?? 0) + 1); return read(); });
  const results = await Promise.all([
    runTests({ ...config, suite: 'shared-first', admission }),
    runTests({ ...config, suite: 'shared-second', admission }),
  ]);
  results.forEach(result => assert.equal(result.passed, 2));
  for (const name of ['a', 'b']) assert.equal(reads.get(join(config.root, `test/${name}.test.mjs`)), 2,
    'each private context uses the inline reader under caller-owned Admission');
  assert.equal(admission.active, 0);
});
