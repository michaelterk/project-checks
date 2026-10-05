import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runChecks, cacheRecordName } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

async function fixture(t, count = 3) {
  const root = await realpath(await temporary(t));
  for (let n = 0; n < count; n++) await put(root, `test/${n}.test.mjs`, '');
  return { root, inputs: [], coverage: false };
}
const options = { logger: false, workers: 1 };

test('one file queue preserves definition/file order across suites and cache misses', async t => {
  const base = await fixture(t);
  const order = [];
  const definitions = ['first', 'second'].map(id => ({ id, config: { ...base, suite: id,
    setup: () => ({ execute: command => { order.push(`${id}/${command.at(-1)}`); return 0; } }),
  } }));
  assert.equal((await runChecks(definitions, options)).exitCode, 0);
  assert.deepEqual(order, ['first', 'second'].flatMap(id => [0, 1, 2].map(n => `${id}/test/${n}.test.mjs`)));
  order.length = 0;
  await writeFile(join(base.root, 'test/1.test.mjs'), 'changed');
  const result = await runChecks(definitions, options);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(order, ['first/test/1.test.mjs', 'second/test/1.test.mjs']);
  assert.deepEqual(result.results.map(({ cached, passed }) => [cached, passed]), [[2, 1], [2, 1]]);
});

test('earlier dependency-blocked files cannot occupy workers needed by their prerequisite', async t => {
  const base = await fixture(t, 2);
  const order = [];
  const dependentReady = Promise.withResolvers();
  const definitions = ['dependent', 'prerequisite', 'independent'].map(id => ({ id,
    ...(id === 'dependent' ? { dependsOn: ['prerequisite'] } : {}),
    config: { ...base, suite: id, setup: () => {
      if (id === 'dependent') dependentReady.resolve();
      return { execute: async command => {
        order.push(`${id}/${command.at(-1)}`);
        if (id === 'independent') await dependentReady.promise;
        return 0;
      } };
    } },
  }));
  assert.equal((await runChecks(definitions, options)).exitCode, 0);
  assert.deepEqual(order.slice(0, 2), ['prerequisite/test/0.test.mjs', 'prerequisite/test/1.test.mjs']);
  assert.ok(order.indexOf('dependent/test/0.test.mjs') > order.indexOf('prerequisite/test/1.test.mjs'));
  assert.ok(order.indexOf('dependent/test/0.test.mjs') < order.indexOf('independent/test/1.test.mjs'), 'ready dependents reclaim their earlier queue position');
});

test('a slow earlier fixture keeps its FIFO position without claiming a worker', async t => {
  const base = await fixture(t, 2);
  const release = Promise.withResolvers(), laterReady = Promise.withResolvers();
  const order = [];
  const running = runChecks(['first', 'second'].map(id => ({ id, config: { ...base, suite: id,
    setup: async () => {
      if (id === 'first') await release.promise;
      else laterReady.resolve();
      return { execute: command => { order.push(`${id}/${command.at(-1)}`); return 0; } };
    },
  } })), options);
  await laterReady.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, []);
  release.resolve();
  assert.equal((await running).exitCode, 0);
  assert.deepEqual(order, ['first', 'second'].flatMap(id => [0, 1].map(n => `${id}/test/${n}.test.mjs`)));
});

test('cancellation stops queued files and drains active files before closing fixtures', async t => {
  const base = await fixture(t);
  const controller = new AbortController();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let active = 0, started = 0, closed = 0;
  const running = runChecks(['first', 'second'].map(id => ({ id, config: { ...base, suite: id,
    setup: () => ({ execute: async () => {
      active++; started++; entered.resolve();
      try { await release.promise; return 0; } finally { active--; }
    }, close: () => { if (id === 'first') assert.equal(active, 0); closed++; } }),
  } })), { ...options, signal: controller.signal });
  const rejected = assert.rejects(running, { name: 'AbortError' });
  await entered.promise;
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, 1);
  assert.equal(closed, 1, 'only the inactive suite may close while another suite drains');
  release.resolve();
  await rejected;
  assert.equal(started, 1);
  assert.equal(closed, 2);
});

test('fixture failure releases earlier queued files and allows independent suites to finish', async t => {
  const base = await fixture(t);
  let executed = 0;
  const failure = new Error('fixture failed');
  await assert.rejects(runChecks([
    { id: 'first', config: { ...base, setup: () => { throw failure; } } },
    { id: 'second', config: { ...base, setup: () => ({ execute: () => { executed++; return 0; } }) } },
  ], options), error => error === failure);
  assert.equal(executed, 3);
});

test('each suite retains its own coverage evidence and aggregate gate in the shared queue', async t => {
  const root = await realpath(await temporary(t));
  await put(root, 'source.mjs', 'export function first() { return 1; }\nexport function second() { return 2; }\n');
  await put(root, 'test/a.test.mjs', "import { first } from '../source.mjs'; first();");
  await put(root, 'test/b.test.mjs', "import { second } from '../source.mjs'; second();");
  const config = { root, inputs: ['source.mjs'], stdio: 'ignore', coverage: { include: ['source.mjs'], minimum: { lines: 100, branches: 100, functions: 100 } } };
  const definitions = [
    { id: 'complete', config: { ...config, suite: 'complete' } },
    { id: 'incomplete', config: { ...config, suite: 'incomplete', select: { include: ['test/a.test.mjs'] } } },
  ];
  const result = await runChecks(definitions, options);
  assert.equal(result.results[0].exitCode, 0);
  assert.notEqual(result.results[1].exitCode, 0);
  const records = await Promise.all(['complete', 'incomplete'].map(suite => readFile(join(root, '.test-cache/project-checks', cacheRecordName(suite, 'test/a.test.mjs')), 'utf8').then(JSON.parse)));
  assert.notDeepEqual(records[0].evidence.files, records[1].evidence.files);
  const repeat = await runChecks(definitions, options);
  assert.deepEqual(repeat.results.map(result => result.cached), [2, 1]);
  assert.equal(repeat.results[0].exitCode, 0);
  assert.notEqual(repeat.results[1].exitCode, 0);
});

test('a fatal file error cancels its queued siblings and drains active siblings before fixture close', async t => {
  const base = await fixture(t);
  const twoStarted = Promise.withResolvers(), release = Promise.withResolvers(), failed = Promise.withResolvers();
  let active = 0, closed = false;
  const starts = [];
  const failure = new Error('execution failed');
  const running = runChecks([{ id: 'suite', config: { ...base,
    setup: () => ({ execute: async command => {
      const file = command.at(-1);
      starts.push(file);
      if (++active === 2) twoStarted.resolve();
      try {
        await twoStarted.promise;
        if (file === 'test/0.test.mjs') { failed.resolve(); throw failure; }
        await release.promise;
        return 0;
      } finally { active--; }
    }, close: () => { assert.equal(active, 0); closed = true; } }),
  } }], { ...options, workers: 2 });
  const rejected = assert.rejects(running, error => error === failure);
  await failed.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  assert.deepEqual(starts, ['test/0.test.mjs', 'test/1.test.mjs']);
  release.resolve();
  await rejected;
  assert.equal(closed, true);
});

test('a newly ready earlier dependency runs while a later fixture is still preparing', { timeout: 5000 }, async t => {
  const base = await fixture(t, 1);
  const preparing = Promise.withResolvers(), release = Promise.withResolvers(), dependentRan = Promise.withResolvers();
  const order = [];
  const running = runChecks([
    { id: 'dependent', dependsOn: ['prerequisite'], config: { ...base, suite: 'dependent',
      setup: () => ({ execute: () => { order.push('dependent'); dependentRan.resolve(); return 0; } }),
    } },
    { id: 'prerequisite', config: { ...base, suite: 'prerequisite',
      setup: () => ({ execute: async () => { await preparing.promise; order.push('prerequisite'); return 0; } }),
    } },
    { id: 'later', config: { ...base, suite: 'later', setup: async () => {
      preparing.resolve();
      await release.promise;
      return { execute: () => { order.push('later'); return 0; } };
    } } },
  ], options);
  t.after(async () => { release.resolve(); await running; });
  await dependentRan.promise;
  assert.deepEqual(order, ['prerequisite', 'dependent']);
  release.resolve();
  assert.equal((await running).exitCode, 0);
  assert.deepEqual(order, ['prerequisite', 'dependent', 'later']);
});
