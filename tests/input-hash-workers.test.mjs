import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { lstat, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { createHashPool } from '../src/input-hash-pool.mjs';
import { hashInputSync, inputMetadata } from '../src/input-hash-sync.mjs';
import { createSnapshotContext } from '../src/inputs.mjs';
import { digest } from '../src/util.mjs';
import { put, temporary } from './helpers.mjs';

function fakeWorkers() {
  const workers = [];
  class Fake extends EventEmitter {
    constructor() { super(); this.dispatched = 0; this.terminated = false; workers.push(this); }
    postMessage(job) { assert.equal(this.job, undefined); this.job = job; this.dispatched += job.jobs.length; }
    complete() { const { jobs } = this.job; this.job = undefined; this.emit('message', { results: jobs.map(({ id }) => ({ id, hash: 'digest', metrics: {} })), done: true }); }
    async terminate() { assert.equal(this.job, undefined); this.terminated = true; this.emit('exit', 1); return 1; }
  }
  return { workers, createWorker: options => new Fake(options) };
}

test('pool starts lazily, caps jobs, rejects queued cancellation and drains active workers before termination', async () => {
  const fake = fakeWorkers(), pool = createHashPool({ workers: 2, createWorker: fake.createWorker });
  assert.equal(fake.workers.length, 0);
  const first = pool.hash('one', 'identity'), second = pool.hash('two', 'identity'), queued = pool.hash('three', 'identity');
  assert.equal(fake.workers.length, 2);
  assert.equal(fake.workers.reduce((sum, worker) => sum + worker.dispatched, 0), 2);
  const reason = new Error('cancel owned scan');
  let activeSettled = false, closed = false;
  const active = Promise.all([assert.rejects(first, error => error === reason), assert.rejects(second, error => error === reason)]).then(() => { activeSettled = true; });
  const pending = assert.rejects(queued, error => error === reason);
  const closing = pool.close(reason).then(() => { closed = true; });
  await pending;
  assert.equal(activeSettled, false);
  assert.equal(closed, false);
  fake.workers.forEach(worker => { assert.equal(worker.terminated, false); worker.complete(); });
  await Promise.all([active, closing]);
  assert.ok(fake.workers.every(worker => worker.terminated));
  await assert.rejects(pool.hash('after-close', 'identity'), error => error === reason);
});

test('unexpected worker failure rejects queued and active jobs without retrying', async () => {
  const fake = fakeWorkers(), pool = createHashPool({ workers: 2, createWorker: fake.createWorker });
  const failure = new Error('worker crashed');
  const jobs = [pool.hash('one', 'identity'), pool.hash('two', 'identity'), pool.hash('three', 'identity')];
  const rejected = jobs.map(job => assert.rejects(job, error => error === failure));
  fake.workers[0].job = undefined; // The failed thread cannot retain its descriptor.
  fake.workers[0].emit('error', failure);
  fake.workers[1].complete();
  await Promise.all(rejected);
  await pool.close();
  assert.equal(fake.workers.reduce((sum, worker) => sum + worker.dispatched, 0), 2);
  assert.ok(fake.workers.every(worker => worker.terminated));
});

test('waiting leaf batches remain bounded and queued operations retain their position', async () => {
  const fake = fakeWorkers(), pool = createHashPool({ workers: 1, createWorker: fake.createWorker });
  const first = pool.hash('first', 'identity');
  const leaves = Array.from({ length: 20 }, (_, index) => pool.inspect(`leaf-${index}`));
  let operated = false;
  const operation = pool.run(() => { operated = true; });
  const last = pool.hash('last', 'identity');
  const worker = fake.workers[0];
  worker.complete(); await first;
  assert.equal(worker.job.jobs.length, 16);
  assert.equal(operated, false);
  worker.complete();
  assert.equal(worker.job.jobs.length, 4);
  assert.equal(operated, false);
  worker.complete(); await operation;
  assert.equal(operated, true);
  assert.equal(worker.job.jobs.length, 1);
  worker.complete();
  await Promise.all([...leaves, last]);
  await pool.close();
});

test('cancellation rejects queued jobs and drains an entire active leaf batch', async () => {
  const fake = fakeWorkers(), pool = createHashPool({ workers: 1, createWorker: fake.createWorker });
  const first = pool.hash('first', 'identity');
  const leaves = Array.from({ length: 20 }, (_, index) => pool.inspect(`leaf-${index}`));
  const worker = fake.workers[0];
  worker.complete(); await first;
  const reason = new Error('cancel batch');
  const rejected = leaves.map(job => assert.rejects(job, error => error === reason));
  let closed = false;
  const closing = pool.close(reason).then(() => { closed = true; });
  await Promise.all(rejected.slice(16));
  assert.equal(closed, false);
  assert.equal(worker.terminated, false);
  worker.complete();
  await Promise.all([...rejected, closing]);
  assert.equal(worker.terminated, true);
});

test('idle samples cannot grow reader threads past the CPU budget or requested startup count', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fake = fakeWorkers(), pool = createHashPool({ workers: 2, createWorker: fake.createWorker,
    host: { cpus: 4, memoryMiB: 4096 },
    sample: () => ({ availableMemoryMiB: 4096, busyCpus: 1, pressure: 0, memoryPressure: 0, ioPressure: 0 }) });
  const jobs = Array.from({ length: 200 }, (_, index) => pool.inspect(`leaf-${index}`));
  t.mock.timers.tick(1000);
  assert.equal(fake.workers.length, 4);
  t.mock.timers.tick(5000);
  assert.equal(fake.workers.length, 4);
  const reason = new Error('done');
  const rejected = jobs.map(job => assert.rejects(job, error => error === reason));
  const closing = pool.close(reason);
  fake.workers.forEach(worker => worker.complete());
  await Promise.all([...rejected, closing]);
});

test('a batched filesystem failure preserves sibling results and paths', async t => {
  const root = await temporary(t), file = await put(root, 'present', 'contents');
  const pool = createHashPool({ workers: 1 });
  t.after(() => pool.close());
  const results = await Promise.allSettled([pool.inspect(file), pool.inspect(join(root, 'missing')), pool.inspect(file)]);
  assert.equal(results[0].value.hash, digest('contents'));
  assert.equal(results[1].reason.code, 'ENOENT');
  assert.equal(results[1].reason.path, join(root, 'missing'));
  assert.deepEqual(results[2], results[0]);
});

test('worker hashes match the inline reader across sizes, Unicode paths, symlinks and missing sources', async t => {
  const root = await temporary(t), context = createSnapshotContext({ inputConcurrency: 3 });
  t.after(() => context.close());
  context.beginScanGeneration({ hashWorkers: 2 });
  for (const size of [0, 1, 65536, 65537, 262144]) {
    const contents = Buffer.alloc(size, size % 251), file = await put(root, `á-${size}`, contents);
    const first = context.sourceHash(file);
    assert.equal(context.sourceHash(file), first, 'one parent-owned promise per path');
    assert.equal(await first, digest(contents));
    context.acceptSourceProof(root, { [`á-${size}`]: digest(contents) });
  }
  const target = join(root, 'á-1'), alias = join(root, 'alias');
  await symlink(target, alias);
  assert.equal(await context.sourceHash(alias), digest(Buffer.alloc(1, 1)));
  assert.equal(await context.sourceHash(join(root, 'missing')), null);
  context.acceptSourceProof(root, { alias: digest(Buffer.alloc(1, 1)), missing: null });
  await context.finishScanGeneration();
  await writeFile(target, 'fresh');
  assert.equal(await context.sourceHash(alias), digest('fresh'));
});

test('worker failures retain filesystem code and path and a subsequent explicit request can succeed', async t => {
  const root = await temporary(t), file = await put(root, 'source', 'first');
  const pool = createHashPool({ workers: 1 });
  t.after(() => pool.close());
  const identity = inputMetadata(await lstat(file, { bigint: true }));
  await rm(file);
  await assert.rejects(pool.hash(file, identity), error => error.code === 'ENOENT' && error.path === file);
  await writeFile(file, 'later');
  assert.equal(await pool.hash(file, inputMetadata(await lstat(file, { bigint: true }))), digest('later'));
});

test('synchronous post-read proof rejects changed bytes rather than publishing a digest', async t => {
  const root = await temporary(t), file = await put(root, 'source', 'first');
  await promises.utimes(file, new Date(0), new Date(0));
  const identity = inputMetadata(await lstat(file, { bigint: true }));
  await writeFile(file, 'later');
  assert.throws(() => hashInputSync(file, identity, Buffer.alloc(65536)), /Input changed while hashing/);
});

test('synchronous worker cancellation closes the descriptor between bounded chunks', async t => {
  const root = await temporary(t), file = await put(root, 'source', Buffer.alloc(131072, 1));
  const identity = inputMetadata(await lstat(file, { bigint: true }));
  const originalRead = fs.readSync, originalClose = fs.closeSync;
  let cancelled = false, closed = 0;
  fs.readSync = (...args) => { const value = originalRead(...args); cancelled = true; return value; };
  fs.closeSync = descriptor => { closed++; return originalClose(descriptor); };
  syncBuiltinESMExports();
  t.after(() => { fs.readSync = originalRead; fs.closeSync = originalClose; syncBuiltinESMExports(); });
  const metrics = {};
  assert.throws(() => hashInputSync(file, identity, Buffer.alloc(65536), () => cancelled, metrics), error => error.code === 'INPUT_HASH_CANCELLED');
  assert.equal(metrics.bytes, 65536);
  assert.equal(closed, 1);
  assert.equal(metrics.postStat, undefined);
});

test('synchronous worker read failure survives a close failure', async t => {
  const root = await temporary(t), file = await put(root, 'source', 'first');
  const identity = inputMetadata(await lstat(file, { bigint: true }));
  const originalRead = fs.readSync, originalClose = fs.closeSync;
  const failure = new Error('original read error');
  fs.readSync = () => { throw failure; };
  fs.closeSync = descriptor => { originalClose(descriptor); throw new Error('secondary close error'); };
  syncBuiltinESMExports();
  t.after(() => { fs.readSync = originalRead; fs.closeSync = originalClose; syncBuiltinESMExports(); });
  assert.throws(() => hashInputSync(file, identity, Buffer.alloc(65536)), error => error === failure);
});

test('worker inspection freshly checks cached metadata and returns changed non-file types to traversal', async t => {
  const root = await temporary(t), file = await put(root, 'á-source', 'first');
  const pool = createHashPool({ workers: 1 });
  t.after(() => pool.close());
  const first = await pool.inspect(file);
  assert.deepEqual(first, { kind: 'file', identity: inputMetadata(await lstat(file, { bigint: true })), hash: digest('first') });
  assert.deepEqual(await pool.inspect(file, first), first);
  await writeFile(file, 'later');
  assert.equal((await pool.inspect(file, first)).hash, digest('later'));
  await rm(file);
  await assert.rejects(pool.inspect(file, first), error => error.code === 'ENOENT' && error.path === file);
  await symlink(root, file);
  assert.deepEqual(await pool.inspect(file, first), { kind: 'symlink' });
});

test('worker leaf inspection shares overlapping projections and preserves legacy directory order and fresh generations', async t => {
  const root = await temporary(t);
  await put(root, 'tree/Z', 'z'); await put(root, 'tree/á', 'unicode');
  const leaf = await put(root, 'tree/nested/one', 'one');
  await symlink('nested', join(root, 'tree/link'));
  const config = { root, cacheDirectory: join(root, '.cache'), ignore: [] };
  const inline = createSnapshotContext(), context = createSnapshotContext({ inputConcurrency: 4 });
  t.after(() => Promise.all([inline.close(), context.close()]));
  const expected = await inline.identify([join(root, 'tree'), join(root, 'tree/nested')], config);
  context.beginScanGeneration({ hashWorkers: 2 });
  const original = promises.lstat;
  let parentLeafStats = 0;
  promises.lstat = async (file, ...args) => { if (file === leaf) parentLeafStats++; return original(file, ...args); };
  syncBuiltinESMExports();
  t.after(() => { promises.lstat = original; syncBuiltinESMExports(); });
  const actual = await Promise.all([context.identify([join(root, 'tree')], config), context.identify([join(root, 'tree/nested')], config)]);
  assert.deepEqual(actual.flat(), expected);
  assert.equal(parentLeafStats, 0, 'regular leaves are inspected in the worker');
  assert.equal(context.digests.size, 3, 'one digest owner per real leaf across projections and symlink aliases');
  const first = context.digests.get(leaf);
  assert.equal(await context.sourceHash(leaf), digest('one'));
  assert.equal(context.digests.get(leaf), first, 'fresh source proof shares the leaf digest');
  await context.finishScanGeneration();
  await writeFile(leaf, 'two');
  context.beginScanGeneration({ hashWorkers: 2 });
  assert.deepEqual(await context.identify([join(root, 'tree/nested')], config), [['directory', [['one', ['file', digest('two')]]]]]);
  await context.finishScanGeneration();
});

test('worker leaf type changes after readdir fall back to symlink traversal and missing policy', async t => {
  const root = await temporary(t), leaf = await put(root, 'tree/file', 'first');
  const target = await put(root, 'target', 'target');
  const context = createSnapshotContext();
  t.after(() => context.close());
  context.beginScanGeneration({ hashWorkers: 1 });
  const original = promises.readdir;
  let replacement = 'symlink';
  promises.readdir = async (file, ...args) => {
    const entries = await original(file, ...args);
    if (file === join(root, 'tree')) {
      await rm(leaf);
      if (replacement === 'symlink') await symlink(target, leaf);
    }
    return entries;
  };
  syncBuiltinESMExports();
  t.after(() => { promises.readdir = original; syncBuiltinESMExports(); });
  const config = { root, cacheDirectory: join(root, '.cache'), ignore: [], allowMissing: true };
  assert.deepEqual(await context.identify([join(root, 'tree')], config), [['directory', [['file', ['symlink', target, ['file', digest('target')]]]]]]);
  await context.finishScanGeneration();
  await rm(leaf); await writeFile(leaf, 'second'); replacement = 'missing';
  context.beginScanGeneration({ hashWorkers: 1 });
  assert.deepEqual(await context.identify([join(root, 'tree')], config), [['directory', [['file', ['missing']]]]]);
  await context.finishScanGeneration();
});

test('every input file completes once across bounded worker batches', async () => {
  const fake = fakeWorkers(), pool = createHashPool({ workers: 1, createWorker: fake.createWorker });
  const jobs = Array.from({ length: 10 }, (_, index) => pool.inspect(`file-${index}`));
  for (let index = 0; index < jobs.length;) {
    const count = fake.workers[0].job.jobs.length;
    assert.ok(count > 0 && count <= 16);
    fake.workers[0].complete();
    await Promise.all(jobs.slice(index, index + count));
    index += count;
  }
  await pool.close();
  assert.equal(fake.workers[0].dispatched, 10);
});

test('worker protocol rejects unknown IDs and duplicate results without retry', async () => {
  for (const kind of ['unknown', 'duplicate', 'incomplete']) {
    const fake = fakeWorkers(), pool = createHashPool({ workers: 1, createWorker: fake.createWorker });
    const first = pool.hash('first', 'identity');
    const rejected = assert.rejects(first, /Invalid input scanner worker response/);
    const worker = fake.workers[0], [job] = worker.job.jobs;
    worker.job = undefined;
    const value = { id: job.id, hash: 'invalid', metrics: {} };
    worker.emit('message', { done: true, results: kind === 'unknown' ? [{ ...value, id: -1 }]
      : kind === 'duplicate' ? [value, value] : [] });
    await rejected; await pool.close();
    assert.equal(worker.dispatched, 1);
    assert.equal(worker.terminated, true);
  }
});

test('real workers isolate per-file errors and release ownership before another file', async t => {
  const root = await temporary(t), small = await put(root, 'small', 'small');
  const bytes = Buffer.alloc(4 * 1024 * 1024, 1), large = await put(root, 'large', bytes);
  const pool = createHashPool({ workers: 1 });
  t.after(() => pool.close());
  const results = await Promise.allSettled([pool.inspect(small), pool.inspect(join(root, 'missing')), pool.inspect(large)]);
  assert.equal(results[0].value.hash, digest('small'));
  assert.equal(results[1].reason.code, 'ENOENT');
  assert.equal(results[2].value.hash, digest(bytes));
});

test('borrowed file worker cancellation drains its one outer admission exactly once', async () => {
  const fake = fakeWorkers(), pool = createHashPool({ workers: 1, createWorker: fake.createWorker });
  const file = pool.runWithWorker(hash => hash('owned-file', 'identity'));
  await new Promise(resolve => setImmediate(resolve));
  const queued = pool.inspect('queued-file'), reason = new Error('cancel borrowed reader');
  const rejected = assert.rejects(file, error => error === reason);
  const pending = assert.rejects(queued, error => error === reason);
  let closed = false;
  const closing = pool.close(reason).then(() => { closed = true; });
  await pending;
  assert.equal(pool.state().active, 1);
  assert.equal(closed, false);
  fake.workers[0].complete();
  await Promise.all([rejected, closing]);
  assert.equal(pool.state().active, 0);
  assert.equal(fake.workers[0].dispatched, 1);
  assert.equal(fake.workers[0].terminated, true);
});

test('borrowed worker failure releases the outer file admission without retry', async () => {
  const fake = fakeWorkers(), pool = createHashPool({ workers: 1, createWorker: fake.createWorker });
  const file = pool.runWithWorker(hash => hash('owned-file', 'identity'));
  await new Promise(resolve => setImmediate(resolve));
  const failure = new Error('owned worker failed'), rejected = assert.rejects(file, error => error === failure);
  fake.workers[0].job = undefined;
  fake.workers[0].emit('error', failure);
  await rejected; await pool.close();
  assert.equal(pool.state().active, 0);
  assert.equal(fake.workers[0].dispatched, 1);
  assert.equal(fake.workers[0].terminated, true);
});

test('CPU backoff waits for long tasks to shed load instead of collapsing parallel scans to one', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fake = fakeWorkers();
  let busyCpus = 16;
  const pool = createHashPool({ workers: 16, createWorker: fake.createWorker,
    host: { cpus: 16, memoryMiB: 32768 }, resources: { cpuQuotaPercent: 95 },
    sample: () => ({ availableMemoryMiB: 32768, busyCpus, memoryPressure: 0, ioPressure: 0 }) });
  const definition = {};
  const jobs = Array.from({ length: 64 }, (_, id) => pool.inputTask(definition, { mode: 'unit', id }));
  assert.equal(pool.state().active, 16);
  t.mock.timers.tick(1000);
  assert.equal(pool.state().limit, 15, '5% CPU overshoot needs one fewer worker');
  t.mock.timers.tick(5000);
  assert.equal(pool.state().limit, 15, 'active work has not yet shed the requested load');
  fake.workers[0].complete();
  await jobs[0];
  assert.equal(pool.state().active, 15);
  assert.equal(fake.workers.filter(worker => worker.terminated).length, 1);
  t.mock.timers.tick(1000);
  assert.equal(pool.state().limit, 14);
  t.mock.timers.tick(5000);
  assert.equal(pool.state().limit, 14);
  busyCpus = 8;
  t.mock.timers.tick(1000);
  assert.equal(pool.state().limit, 16);
  assert.equal(pool.state().active, 16);
  const reason = new Error('done');
  const rejected = jobs.slice(1).map(job => assert.rejects(job, error => error === reason));
  const closing = pool.close(reason);
  fake.workers.filter(worker => worker.job).forEach(worker => worker.complete());
  await Promise.all([...rejected, closing]);
});
