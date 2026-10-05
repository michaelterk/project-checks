import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Admission, cacheKey, cacheRecordName, runCachedUnits } from '../src/index.mjs';
import { temporary } from './helpers.mjs';

async function fixture(t) {
  const directory = await temporary(t);
  const inputs = { common: 'source-v1', units: { first: 'v1', second: 'v1' } };
  const calls = [];
  const options = {
    cacheDirectory: directory, suite: 'fixture', workers: 1, logger: null,
    units: ['first', 'second'].map(id => ({ id, command: ['test', id] })),
    snapshot: () => inputs,
    execute: async unit => { calls.push(unit.id); return unit.id === 'second' ? 17 : 0; },
  };
  return { directory, calls, options, inputs };
}

function observeRecordReads(t, directory, observe) {
  const original = fs.readFile;
  t.mock.method(fs, 'readFile', (file, ...args) =>
    typeof file === 'string' && file.startsWith(`${directory}/`) && file.endsWith('.json')
      ? observe(file, () => original(file, ...args)) : original(file, ...args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test('upfront plans share 32 concurrent reads and never reread records during execution', async t => {
  const directory = await temporary(t);
  const ids = Array.from({ length: 40 }, (_, index) => `file-${index}`);
  const inputs = { common: 'shared', units: Object.fromEntries(ids.map(id => [id, 'v1'])) };
  const options = suite => ({
    suite, cacheDirectory: directory, workers: 1, logger: null,
    units: ids.map(id => ({ id, identity: 'fixture' })), snapshot: () => inputs,
  });
  for (const suite of ['one', 'two']) await runCachedUnits({ ...options(suite), execute: () => 0 });
  const changed = ids.filter((_, index) => index % 2);
  for (const id of changed) inputs.units[id] = 'v2';
  const owners = new Map(['one', 'two'].flatMap(suite => ids.map(id =>
    [join(directory, cacheRecordName(suite, id)), suite])));
  const reads = new Map();
  const active = { one: 0, two: 0 };
  let peak = 0;
  observeRecordReads(t, directory, async (file, read) => {
    const suite = owners.get(file);
    active[suite]++;
    peak = Math.max(peak, active.one + active.two);
    reads.set(file, (reads.get(file) ?? 0) + 1);
    try { await delay(5); return await read(); }
    finally { active[suite]--; }
  });
  const calls = { one: [], two: [] };
  const lines = { one: [], two: [] };
  const results = await Promise.all(['one', 'two'].map(suite => runCachedUnits({
    ...options(suite), logger: { log: line => lines[suite].push(line) },
    execute: unit => {
      assert.equal(ids.every(id => reads.has(join(directory, cacheRecordName(suite, id)))), true);
      assert.equal(active[suite], 0);
      assert.ok(lines[suite].some(line => /Will run: 20 \| Will skip: 20/.test(line)));
      calls[suite].push(unit.id);
      return 0;
    },
  })));
  assert.equal(peak, 32);
  assert.equal(reads.size, 80);
  assert.ok([...reads.values()].every(count => count === 1));
  for (let index = 0; index < results.length; index++) {
    assert.deepEqual([results[index].passed, results[index].cached], [20, 20]);
    assert.deepEqual(results[index].results.map(result => result.id), ids);
    assert.deepEqual(calls[['one', 'two'][index]], changed);
  }
});

test('cache scan errors drain concurrent reads before rejection and start no commands', async t => {
  const f = await fixture(t);
  let active = 0;
  let completed = 0;
  observeRecordReads(t, f.directory, async (file, read) => {
    active++;
    try {
      await delay(file.endsWith(cacheRecordName('fixture', 'first')) ? 5 : 20);
      if (file.endsWith(cacheRecordName('fixture', 'first'))) throw new Error('cache scan failed');
      return await read();
    } finally { active--; completed++; }
  });
  await assert.rejects(runCachedUnits(f.options), /cache scan failed/);
  assert.equal(active, 0);
  assert.equal(completed, 2);
  assert.deepEqual(f.calls, []);
});

test('cancellation drains an active cache scan and leaves the shared read queue reusable', async t => {
  const f = await fixture(t);
  f.options.execute = () => 0;
  await runCachedUnits(f.options);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let active = 0;
  observeRecordReads(t, f.directory, async (_file, read) => {
    if (++active === 2) entered.resolve();
    try { await release.promise; return await read(); }
    finally { active--; }
  });
  const controller = new AbortController();
  const reason = new Error('cancelled during cache scan');
  let settled = false;
  const running = runCachedUnits({ ...f.options, signal: controller.signal, execute: () => {
    throw new Error('cancelled scan must never execute');
  } }).finally(() => { settled = true; });
  const rejected = assert.rejects(running, error => error === reason);
  await entered.promise;
  controller.abort(reason);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release.resolve();
  await rejected;
  assert.equal(active, 0);
  assert.equal((await runCachedUnits(f.options)).cached, 2);
});

test('retains passes after failure and runs only failed, changed or newly discovered units', async t => {
  const f = await fixture(t);
  const first = await runCachedUnits(f.options);
  assert.equal(first.exitCode, 17);
  assert.deepEqual([first.passed, first.failed, first.cached], [1, 1, 0]);
  f.calls.length = 0;
  f.options.execute = async unit => { f.calls.push(unit.id); return 0; };
  assert.equal((await runCachedUnits(f.options)).exitCode, 0);
  assert.deepEqual(f.calls, ['second']);
  f.calls.length = 0;
  f.inputs.units.second = 'v2';
  await runCachedUnits(f.options);
  assert.deepEqual(f.calls, ['second']);
  f.calls.length = 0;
  f.inputs.units.third = 'v1';
  f.options.units.push({ id: 'third', command: ['test', 'third'] });
  await runCachedUnits(f.options);
  assert.deepEqual(f.calls, ['third']);
  f.calls.length = 0;
  f.inputs.common = 'source-v2';
  await runCachedUnits(f.options);
  assert.deepEqual(f.calls, ['first', 'second', 'third']);
});

test('keeps completed evidence when a later unit throws', async t => {
  const f = await fixture(t);
  f.options.execute = async unit => {
    if (unit.id === 'second') throw new Error('interrupted');
    return 0;
  };
  await assert.rejects(runCachedUnits(f.options), /interrupted/);
  f.options.execute = async unit => { f.calls.push(unit.id); return 0; };
  await runCachedUnits(f.options);
  assert.deepEqual(f.calls, ['second']);
});

test('input mutation is detected even when the snapshot callback returns the same object', async t => {
  const f = await fixture(t);
  f.options.execute = async () => { f.inputs.common = 'changed-mid-run'; return 0; };
  const result = await runCachedUnits(f.options);
  assert.equal(result.exitCode, 1);
  assert.equal(result.inputsChanged, true);
  assert.deepEqual(await readdir(f.directory), []);
  f.options.execute = async unit => { f.calls.push(unit.id); return 0; };
  await runCachedUnits(f.options);
  assert.deepEqual(f.calls, ['first', 'second']);
});

test('corrupt evidence reruns and cache stores only hashes, without environment secrets', async t => {
  const f = await fixture(t);
  f.options.execute = async () => 0;
  f.options.environment = { TOKEN: 'do-not-store-this-secret' };
  await runCachedUnits(f.options);
  for (const file of await readdir(f.directory)) {
    const value = await readFile(join(f.directory, file), 'utf8');
    assert.doesNotMatch(value, /do-not-store-this-secret/);
    await writeFile(join(f.directory, file), 'corrupt');
  }
  const result = await runCachedUnits(f.options);
  assert.equal(result.cached, 0);
  assert.equal(result.passed, 2);
});

test('environment, command, unit identity and retry policy do not alter content validity', async t => {
  const f = await fixture(t);
  f.options.execute = async () => 0;
  f.options.environment = { RUN_AXE: '0' };
  await runCachedUnits(f.options);
  assert.equal((await runCachedUnits(f.options)).cached, 2);
  f.options.environment = { RUN_AXE: '1', SECRET: 'changed-secret' };
  assert.equal((await runCachedUnits(f.options)).cached, 2);
  f.options.units[0].command = ['different-runtime', '--new-option', 'first'];
  f.options.units[0].identity = 'different-adapter';
  f.options.retryTimeouts = true;
  assert.equal((await runCachedUnits(f.options)).cached, 2);
  assert.equal(cacheKey(f.inputs, 'first'), cacheKey(f.inputs, 'second'));
  assert.notEqual(cacheRecordName('suite-a', 'first'), cacheRecordName('suite-b', 'first'));
  assert.notEqual(cacheRecordName('suite-a', 'first'), cacheRecordName('suite-a', 'second'));
  const records = await Promise.all((await readdir(f.directory)).map(async file => JSON.parse(await readFile(join(f.directory, file), 'utf8'))));
  assert.ok(records.every(record => record.key === cacheKey(f.inputs, 'first')));
});

test('discovery mismatches and malformed worker limits fail before execution', async t => {
  const f = await fixture(t);
  f.inputs.units.third = 'new';
  await assert.rejects(runCachedUnits(f.options), /discovery changed/);
  assert.deepEqual(f.calls, []);
  for (const workers of [0, -1, 1.5, NaN, Infinity]) await assert.rejects(runCachedUnits({ ...f.options, workers }), /workers/);
});

test('bounded scheduling drains failures, preserves input order, and waits for active jobs on errors', async t => {
  const f = await fixture(t);
  f.options.workers = 2;
  f.inputs.units.third = 'v1';
  f.options.units.push({ id: 'third', command: ['test', 'third'] });
  let active = 0;
  let peak = 0;
  let ended = 0;
  f.options.execute = async unit => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, unit.id === 'first' ? 80 : 5));
    active--;
    ended++;
    return unit.id === 'second' ? 17 : 0;
  };
  const result = await runCachedUnits(f.options);
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(ended, 3);
  assert.equal(result.exitCode, 17);
  assert.deepEqual(result.results.map(result => result.id), ['first', 'second', 'third']);
  f.inputs.common = 'new';
  let siblingEnded = false;
  f.options.execute = async unit => {
    if (unit.id === 'first') { await new Promise(resolve => setTimeout(resolve, 10)); throw new Error('fatal'); }
    await new Promise(resolve => setTimeout(resolve, 80));
    siblingEnded = true;
    return 0;
  };
  await assert.rejects(runCachedUnits(f.options), /fatal/);
  assert.equal(siblingEnded, true);
});

test('resource admission preserves cache evidence, input fencing and fixed worker overrides', async t => {
  const f = await fixture(t);
  delete f.options.workers;
  f.options.resources = { maxWorkers: 1, memoryMiBPerWorker: 1 };
  let active = 0;
  let peak = 0;
  f.options.execute = async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return 0;
  };
  assert.equal((await runCachedUnits(f.options)).passed, 2);
  assert.equal(peak, 1);
  assert.equal((await runCachedUnits(f.options)).cached, 2);
  f.inputs.common = 'changed';
  f.options.workers = 2;
  assert.equal((await runCachedUnits(f.options)).workers, 1);
  f.options.resources.maxWorkers = 2;
  f.inputs.common = 'fixed-two';
  assert.equal((await runCachedUnits(f.options)).workers, 2);
  assert.equal(peak, 2);
  delete f.options.workers;
  f.inputs.common = 'new';
  f.options.execute = async () => { f.inputs.common = 'mutated'; return 0; };
  assert.equal((await runCachedUnits(f.options)).inputsChanged, true);
  assert.deepEqual(await readdir(f.directory), []);
});


test('shared admission globally bounds suites and survives one suite failing', async t => {
  const directory = await temporary(t);
  const pool = new Admission({ memoryMiBPerWorker: 512, reserveMemoryMiB: 512 }, 6, {
    workers: 2, host: { cpus: 8, memoryMiB: 8192 },
    sample: () => ({ busyCpus: 0, pressure: 0, memoryPressure: 0, availableMemoryMiB: 8192 }),
  });
  t.after(() => pool.close());
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const options = suite => ({
    suite, admission: pool, cacheDirectory: directory, cache: false, logger: null,
    units: ['a', 'b', 'c'].map(id => ({ id, identity: id })),
    snapshot: () => ({ common: suite, units: { a: 'a', b: 'b', c: 'c' } }),
  });
  const bad = runCachedUnits({ ...options('bad'), execute: async unit => {
    if (unit.id === 'a') throw new Error('fixture fatal');
    if (unit.id === 'b') await held;
    return 0;
  } });
  const good = runCachedUnits({ ...options('good'), execute: async () => { release(); return 0; } });
  const [failed, healthy] = await Promise.allSettled([bad, good]);
  assert.equal(failed.status, 'rejected');
  assert.match(failed.reason.message, /fixture fatal/);
  assert.equal(healthy.status, 'fulfilled');
  assert.equal(healthy.value.passed, 3);
  assert.equal(pool.closed, undefined);
  assert.equal(pool.active, 0);
  assert.ok(pool.peak <= 2);
});


test('serial shared admission bounds work queued before acquisition', async t => {
  const f = await fixture(t);
  const pool = new Admission({ maxWorkers: 4 }, 2, {
    workers: 1, host: { cpus: 8, memoryMiB: 8192 },
    sample: () => ({ busyCpus: 0, pressure: 0, availableMemoryMiB: 8192 }),
  });
  t.after(() => pool.close());
  let release;
  let entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const acquire = pool.acquire.bind(pool);
  let attempts = 0;
  pool.acquire = async options => {
    attempts++;
    entered();
    await held;
    return acquire(options);
  };
  const running = runCachedUnits({ ...f.options, admission: pool, cache: false, execute: () => 0 });
  await started;
  const queued = attempts;
  release();
  const result = await running;
  assert.equal(queued, 1);
  assert.equal(result.passed, 2);
  assert.equal(pool.peak, 1);
});
