import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Admission } from '../src/admission.mjs';
import { createFileQueue } from '../src/file-queue.mjs';
import { loadChecks, runChecks, runTests } from '../src/index.mjs';
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
