import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Admission } from '../src/admission.mjs';
import { createFileQueue } from '../src/file-queue.mjs';
import { fileReadyOptions, loadChecks, runChecks, runTests } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

const options = { schedule: 'ready', workers: 2, inputConcurrency: 2, verificationConcurrency: 2, logger: false };

test('independent commands and suites start while another prerequisite, scan and fixture wait', { timeout: 10000 }, async t => {
  const root = await temporary(t);
  await put(root, 'test/one.test.mjs', '');
  const base = { root, inputs: [], coverage: false, cache: false };
  const fastRan = Promise.withResolvers(), scan = Promise.withResolvers(), fixture = Promise.withResolvers();
  const config = (suite, more = {}) => ({ ...base, suite, setup: () => ({ execute: () => 0 }), ...more });
  let dependencyRan = false;
  const result = await runChecks([
    { id: 'build', command: [process.execPath, '-e', ''], verify: () => fastRan.promise },
    { id: 'slow-scan', config: config('slow-scan', {
      testInputs: async () => { scan.resolve(); await fastRan.promise; return []; },
    }) },
    { id: 'slow-fixture', config: config('slow-fixture', {
      setup: async () => { fixture.resolve(); await fastRan.promise; return { execute: () => 0 }; },
    }) },
    { id: 'fast', config: config('fast', {
      setup: () => ({ execute: async () => {
        await Promise.all([scan.promise, fixture.promise]); fastRan.resolve(); return 0;
      } }),
    }) },
    { id: 'after-build', dependsOn: ['build'], config: () => {
      dependencyRan = true; return config('after-build');
    } },
  ], options);
  assert.equal(result.exitCode, 0);
  assert.equal(dependencyRan, true);
});

test('ready scheduling skips failed consumers without loading them and drains cancellation', async t => {
  const root = await temporary(t);
  await put(root, 'test/one.test.mjs', '');
  const config = { root, inputs: [], coverage: false };
  const result = await runChecks([
    { id: 'fail', command: [process.execPath, '-e', 'process.exit(7)'] },
    { id: 'skip', dependsOn: ['fail'], config: () => assert.fail('loaded failed consumer') },
  ], options);
  assert.equal(result.exitCode, 7);
  assert.equal(result.results[1].skipped, true);

  const controller = new AbortController(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let closed = false;
  const running = runChecks([{ id: 'active', config: { ...config,
    setup: () => ({ execute: async () => { entered.resolve(); await release.promise; return 0; }, close: () => { closed = true; } }),
  } }], { ...options, signal: controller.signal });
  const rejected = assert.rejects(running, { name: 'AbortError' });
  await entered.promise;
  controller.abort();
  assert.equal(closed, false);
  release.resolve();
  await rejected;
  assert.equal(closed, true);
});

test('ready scan rejection cancels a sibling waiting for the invocation signal', { timeout: 5000 }, async t => {
  const root = await temporary(t);
  await put(root, 'test/fail.test.mjs', '');
  await put(root, 'test/wait.test.mjs', '');
  const waiting = Promise.withResolvers();
  let drained = false;
  const config = ({ signal }) => ({ root, inputs: [], coverage: false, testInputs: async id => {
    if (id.endsWith('fail.test.mjs')) {
      await waiting.promise;
      throw new Error('input scan failed');
    }
    const stopped = Promise.withResolvers();
    signal.addEventListener('abort', stopped.resolve, { once: true });
    waiting.resolve();
    await stopped.promise;
    drained = true;
    signal.throwIfAborted();
  } });
  await assert.rejects(runChecks([{ id: 'scan', config }], { ...options, signal: t.signal }), /input scan failed/);
  assert.equal(drained, true);
});

test('ready dispatch admits a smaller waiting file using its own reservation', async t => {
  const admission = new Admission({ memoryMiBPerWorker: 128, reserveMemoryMiB: 1024 }, 8, {
    host: { cpus: 8, memoryMiB: 1664 }, workers: 5, sample: () => ({ availableMemoryMiB: 1664 }),
  });
  t.after(() => admission.close());
  await admission.acquire({ memoryMiB: 512 });
  const smallRan = Promise.withResolvers();
  const sizes = [];
  const jobs = [512, 128].map(size => Object.assign(async () => {
    sizes.push([size, admission.inspect().reservedMemoryMiB]);
    if (size === 128) smallRan.resolve();
  }, { memoryMiB: size }));
  const queue = createFileQueue([{ id: 'mixed', jobs }], admission, new AbortController().signal, { readyFirst: true });
  t.after(() => queue.close());
  queue.enable('mixed');
  const running = queue.run('mixed');
  await smallRan.promise;
  admission.release({ memoryMiB: 512 });
  await running;
  assert.deepEqual(sizes[0], [128, 640]);
  assert.equal(sizes[1][0], 512);
  assert.ok([512, 640].includes(sizes[1][1]));
  assert.equal(admission.inspect().reservedMemoryMiB, 0);
  assert.equal(admission.active, 0);
});

test('fixture inputs receive a shared snapshot key and rediscover fixtures during validation', async t => {
  const root = await temporary(t);
  for (const name of ['a', 'b']) await put(root, `test/${name}.test.mjs`, '');
  const batches = new Map();
  const config = { root, inputs: [], coverage: false, cache: false, setup: () => ({ execute: () => 0 }),
    testFixtureInputs(id, { generation }) {
      if (!batches.has(generation)) batches.set(generation, new Set());
      batches.get(generation).add(id);
      return [];
    },
  };
  assert.equal((await runChecks([{ id: 'suite', config }], options)).exitCode, 0);
  const values = [...batches.values()];
  assert.ok(values.length >= 2);
  assert.deepEqual([...values[0]].sort(), ['test/a.test.mjs', 'test/b.test.mjs']);
  assert.deepEqual([...values.at(-1)].sort(), ['test/a.test.mjs', 'test/b.test.mjs']);
});

test('process-backed suites provide a fresh coordinator fixture key during final verification', async t => {
  const root = await temporary(t);
  await put(root, 'test/a.test.mjs', '');
  await put(root, 'test/b.test.mjs', '');
  await put(root, 'fixture.mjs', `
    export const processInputs = true;
    export default () => ({ setup: () => ({ execute: () => 0 }) });
  `);
  await put(root, 'suite.json', JSON.stringify({ inputs: [], coverage: false, cache: false }));
  const file = await put(root, 'checks.json', JSON.stringify({ checks: { suite: { config: 'suite.json', fixture: 'fixture.mjs' } }, targets: { default: ['suite'] } }));
  const [check] = await loadChecks(file);
  const factory = check.config, seen = new Map();
  check.config = async context => ({ ...await factory(context),
    testFixtureInputs(id, { generation }) {
      if (!seen.has(generation)) seen.set(generation, new Set());
      seen.get(generation).add(id);
      return [];
    },
  });
  assert.equal((await runChecks([check], options)).exitCode, 0);
  assert.ok(seen.size >= 2);
  assert.deepEqual([...seen.values()].at(-1), new Set(['test/a.test.mjs', 'test/b.test.mjs']));
});

test('cached coverage leaves take one final snapshot and publish only after configuration verification', async t => {
  const root = await temporary(t);
  await put(root, 'source.mjs', 'export const n = 1;');
  await put(root, 'test/a.test.mjs', "import '../source.mjs';");
  const config = { root, inputs: ['source.mjs'], coverage: { include: ['source.mjs'] }, stdio: 'ignore' };
  const report = join(root, '.test-cache/project-checks/coverage/tests/latest.json');
  assert.equal((await runTests({ ...config, logger: false })).exitCode, 0);
  await rm(report);
  const snapshots = new Set();
  config.testFixtureInputs = (_id, { generation }) => { snapshots.add(generation); return []; };
  let verify = 0;
  await assert.rejects(runChecks([{ id: 'coverage', config, verify: () => {
    if (++verify === 2) throw new Error('configuration changed');
  } }], options), /configuration changed/);
  assert.equal(snapshots.size, 2, 'initial scan plus a single fresh whole-suite snapshot');
  await assert.rejects(readFile(report), { code: 'ENOENT' });
});

test('a verified passing coverage leaf publishes its summary when a sibling test fails', async t => {
  const root = await temporary(t);
  await put(root, 'source.mjs', 'export const n = 1;');
  await put(root, 'test/pass.test.mjs', "import '../source.mjs';");
  await put(root, 'test/fail.test.mjs', "import assert from 'node:assert/strict'; assert.equal(1, 2);");
  const base = { root, inputs: ['source.mjs'], stdio: 'ignore' };
  const report = join(root, '.test-cache/project-checks/coverage/passing/latest.json');
  const result = await runChecks([
    { id: 'passing', config: { ...base, suite: 'passing', pattern: 'pass.test.mjs', coverage: { include: ['source.mjs'] } } },
    { id: 'failing', config: { ...base, suite: 'failing', pattern: 'fail.test.mjs', coverage: false } },
  ], options);
  assert.deepEqual(result.results.map(check => check.exitCode), [0, 1]);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(await readFile(report, 'utf8')).actual, { lines: 100, branches: 100, functions: 100 });
});

test('V8 aggregate reuse verifies measurements, binds rules, and enforces the current fractional floor', async t => {
  const root = await temporary(t);
  await put(root, 'source.mjs', 'export function used() { return 1; }\nexport function unused() { return 2; }\n');
  await put(root, 'test/one.test.mjs', "import { used } from '../source.mjs'; used();");
  const lines = [];
  const config = { root, inputs: [], stdio: 'ignore', logger: { log: line => lines.push(line), error: line => lines.push(line) },
    coverage: { include: ['source.mjs'], minimum: { lines: 0, branches: 0, functions: 50 } } };
  assert.equal((await runTests(config)).exitCode, 0);
  config.coverage.minimum.functions = 50.5;
  const stricter = await runTests(config);
  assert.equal(stricter.cached, 1);
  assert.equal(stricter.exitCode, 1);
  assert.ok(lines.some(line => line.includes('Verified V8 coverage')));
  lines.length = 0;
  const report = join(root, '.test-cache/project-checks/coverage/tests/latest.json');
  const saved = JSON.parse(await readFile(report, 'utf8'));
  saved.actual.functions = 100;
  await writeFile(report, JSON.stringify(saved));
  assert.notEqual((await runTests(config)).exitCode, 0);
  assert.ok(!lines.some(line => line.includes('Verified V8 coverage')));
  config.coverage.include = ['absent.mjs'];
  await assert.rejects(runTests(config), /No source files in coverage domain/);
});

test('a verified miss completes while a sibling coverage hit is still scanning', { timeout: 15000 }, async t => {
  const root = await temporary(t);
  await put(root, 'source.mjs', 'export const n = 1;');
  const cached = 'test/cached.test.mjs', fresh = 'test/fresh.test.mjs';
  for (const file of [cached, fresh]) await put(root, file, "import '../source.mjs';");
  const base = { root, inputs: ['source.mjs'], coverage: { include: ['source.mjs'] }, stdio: 'ignore' };
  assert.equal((await runTests({ ...base, files: [cached], logger: false })).exitCode, 0);

  const early = Promise.withResolvers();
  t.signal.addEventListener('abort', early.resolve, { once: true });
  const ran = [];
  let setups = 0, closes = 0;
  const result = await runChecks([{ id: 'mixed', config: {
    ...base, setup() { setups++; return { close() { closes++; } }; },
    testInputs: async id => { if (id === cached) await early.promise; return []; },
  } }], { ...options, ...fileReadyOptions, signal: t.signal, progress: { files() {}, file(_suite, id, state) {
    if (state === 'file-start') ran.push(id);
    if (id === fresh && state === 'file-end') early.resolve();
  } } });
  assert.deepEqual([result.exitCode, result.results[0].cached, setups, closes], [0, 1, 1, 1]);
  assert.deepEqual(ran, [fresh]);
  const report = JSON.parse(await readFile(join(root, '.test-cache/project-checks/coverage/tests/latest.json')));
  assert.deepEqual(report.actual, { lines: 100, branches: 100, functions: 100 });
});

test('an early command checks fresh inputs even when its mutation is reverted before scan completion', { timeout: 10000 }, async t => {
  const root = await temporary(t);
  const first = 'test/early.test.mjs', last = 'test/late.test.mjs';
  await put(root, first, 'original'); await put(root, last, '');
  const checked = Promise.withResolvers();
  t.signal.addEventListener('abort', checked.resolve, { once: true });
  const ran = [];
  let mutate = true, initialLateScan = true;
  const config = { root, inputs: [], coverage: false, testInputs: async id => {
    if (id === last && initialLateScan) {
      initialLateScan = false;
      await checked.promise;
      await put(root, first, 'original');
    }
    return [];
  }, setup: () => ({ execute: async command => {
    const file = command.at(-1);
    ran.push(file);
    if (file === first && mutate) await put(root, first, 'changed');
    return 0;
  } }) };
  const settings = { ...options, ...fileReadyOptions, signal: t.signal, progress: { files() {}, file(_suite, id, state) {
    if (id === first && state === 'file-end') checked.resolve();
  } } };
  const run = () => runChecks([{ id: 'files', config }], settings);
  const result = await run();
  assert.equal(result.results[0].inputsChanged, true);
  assert.equal(result.exitCode, 1);
  mutate = false;
  ran.length = 0;
  assert.equal((await run()).exitCode, 0);
  assert.deepEqual(ran, [first]);
});

test('a late scan failure cancels and drains a running file before closing its fixture', { timeout: 10000 }, async t => {
  const root = await temporary(t);
  const first = 'test/a.test.mjs', last = 'test/b.test.mjs';
  for (const file of [first, last]) await put(root, file, '');
  const entered = Promise.withResolvers(), aborted = Promise.withResolvers(), released = Promise.withResolvers();
  t.signal.addEventListener('abort', () => { entered.resolve(); aborted.resolve(); released.resolve(); }, { once: true });
  let closed = false;
  const running = runChecks([{ id: 'files', config: { root, inputs: [], coverage: false, testInputs: async id => {
    if (id === last) { await entered.promise; throw new Error('late scan failure'); }
    return [];
  }, setup: ({ signal }) => ({ execute: async () => {
    signal.addEventListener('abort', aborted.resolve, { once: true });
    entered.resolve();
    await released.promise;
    assert.equal(closed, false);
    return 0;
  }, close() { closed = true; } }) } }], { ...options, ...fileReadyOptions, signal: t.signal });
  const failure = assert.rejects(running, /late scan failure/);
  await aborted.promise;
  assert.equal(closed, false);
  released.resolve();
  await failure;
  assert.equal(closed, true);
});

test('file-ready dispatch ranks the remaining backlog and long files within the current memory budget', { timeout: 5000 }, async t => {
  const admission = new Admission({ memoryMiBPerWorker: 128, reserveMemoryMiB: 1024 }, 2, {
    workers: 2, host: { cpus: 8, memoryMiB: 1664 }, sample: () => ({ availableMemoryMiB: 1664 }),
  });
  t.after(() => admission.close());
  await admission.acquire({ memoryMiB: 512 });
  await admission.acquire();
  const suites = ['blocked', 'cold-a', 'cold-b', 'single', 'batch'];
  const queue = createFileQueue(suites.map(id => ({ id, jobs: [] })), admission, t.signal, { readyFirst: true, prioritizeSuites: true });
  t.after(() => queue.close());
  const ran = [];
  const offer = (suite, fileIndex, priority, memoryMiB = 128) => queue.offer(suite,
    Object.assign(() => ran.push(`${suite}/${fileIndex}`), { fileIndex, priority, memoryMiB }));
  offer('blocked', 0, 100, 512);
  offer('cold-b', 2, 0);
  for (const suite of ['cold-a', 'cold-b']) for (const index of [1, 0]) offer(suite, index, 0);
  offer('single', 0, 10);
  for (const [index, seconds] of [6, 6, 7, 7, 8].entries()) offer('batch', index, seconds);
  const blocked = queue.run('blocked');
  const rest = Promise.all(suites.slice(1).map(id => queue.run(id)));
  admission.release();
  await rest;
  admission.release({ memoryMiB: 512 });
  await blocked;
  // Two-worker backlog estimate falls from 17 to 13 to 9.5 seconds.
  // The individual 10-second file becomes critical at that third dispatch.
  assert.deepEqual(ran, ['batch/4', 'batch/2', 'single/0', 'batch/3', 'batch/0', 'batch/1',
    'cold-b/0', 'cold-a/0', 'cold-b/1', 'cold-a/1', 'cold-b/2', 'blocked/0']);
  assert.equal(admission.inspect().reservedMemoryMiB, 0);
});

test('file-ready scan-only reports misses without setting up or executing a fixture', async t => {
  const root = await temporary(t);
  for (const file of ['a', 'b']) await put(root, `test/${file}.test.mjs`, '');
  const previous = process.env.PROJECT_CHECKS_SCAN_ONLY;
  process.env.PROJECT_CHECKS_SCAN_ONLY = '1';
  try {
    const result = await runChecks([{ id: 'files', config: { root, inputs: [], coverage: false,
      setup: () => assert.fail('scan-only started a fixture'),
    } }], { ...options, ...fileReadyOptions });
    assert.deepEqual(result, { exitCode: 0, scanOnly: true, total: 2, cached: 0 });
  } finally {
    if (previous === undefined) delete process.env.PROJECT_CHECKS_SCAN_ONLY;
    else process.env.PROJECT_CHECKS_SCAN_ONLY = previous;
  }
});
