import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { lstat, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { createHashPool, scanHashWorkers } from '../src/input-hash-pool.mjs';
import { hashInputSync, inputMetadata } from '../src/input-hash-sync.mjs';
import { createSnapshotContext } from '../src/inputs.mjs';
import { digest } from '../src/util.mjs';
import { put, temporary } from './helpers.mjs';

function fakeWorkers() {
  const workers = [];
  class Fake extends EventEmitter {
    constructor(options) { super(); this.flag = new Int32Array(options.workerData.cancellation); this.dispatched = 0; this.terminated = false; workers.push(this); }
    postMessage(job) { assert.equal(this.job, undefined); this.job = job; this.dispatched += job.jobs.length; }
    complete() { const { jobs } = this.job; this.job = undefined; this.emit('message', { results: jobs.map(({ id }) => ({ id, hash: 'digest', metrics: {} })), done: true }); }
    async terminate() { assert.equal(this.job, undefined); this.terminated = true; this.emit('exit', 1); return 1; }
  }
  return { workers, createWorker: options => new Fake(options) };
}

test('hash worker count leaves a coordinator CPU and honors resource and memory caps', () => {
  assert.equal(scanHashWorkers({ selected: { cpuBudget: 8, workers: 8 } }), 4);
  assert.equal(scanHashWorkers({ selected: { cpuBudget: 3.9, workers: 8 } }), 2);
  assert.equal(scanHashWorkers({ selected: { cpuBudget: 8, workers: 1 } }), 1);
  assert.equal(scanHashWorkers({ selected: { cpuBudget: 1, workers: 1 } }), 0);
});

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
  fake.workers.forEach(worker => { assert.equal(Atomics.load(worker.flag, 0), 1); assert.equal(worker.terminated, false); worker.complete(); });
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

test('worker post-read proof rejects file races and parent evicts the failed digest', async t => {
  const root = await temporary(t), file = await put(root, 'source', 'first');
  const context = createSnapshotContext();
  t.after(() => context.close());
  context.beginScanGeneration({ hashWorkers: 1 });
  const original = promises.lstat;
  let mutate = true;
  promises.lstat = async (path, ...args) => {
    const info = await original(path, ...args);
    if (path === file && mutate) { mutate = false; await writeFile(file, 'later'); }
    return info;
  };
  syncBuiltinESMExports();
  t.after(() => { promises.lstat = original; syncBuiltinESMExports(); });
  await assert.rejects(context.sourceHash(file), error => error.message.includes('Input changed while hashing') && error.message.includes(file));
  assert.equal(context.digests.has(file), false);
  assert.equal(await context.sourceHash(file), digest('later'));
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
  assert.deepEqual(await pool.inspect(file, first), { kind: 'other' });
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

test('worker batches cap eight owned jobs, publish partial results and drain cancellation before termination', async () => {
  const fake = fakeWorkers(), pool = createHashPool({ workers: 1, createWorker: fake.createWorker });
  const first = pool.hash('first', 'identity');
  const jobs = Array.from({ length: 10 }, (_, index) => pool.hash(`queued-${index}`, 'identity'));
  fake.workers[0].complete();
  await first;
  const worker = fake.workers[0];
  assert.equal(worker.job.jobs.length, 8);
  const completed = worker.job.jobs.splice(0, 2);
  worker.emit('message', { results: completed.map(({ id }) => ({ id, hash: 'partial', metrics: {} })), done: false });
  assert.deepEqual(await Promise.all(jobs.slice(0, 2)), ['partial', 'partial']);
  const reason = new Error('abort partial batch');
  const rejected = jobs.slice(2).map(job => assert.rejects(job, error => error === reason));
  let closed = false;
  const closing = pool.close(reason).then(() => { closed = true; });
  await Promise.all(rejected.slice(6));
  assert.equal(closed, false);
  assert.equal(worker.terminated, false);
  worker.complete();
  await Promise.all([...rejected, closing]);
  assert.equal(worker.dispatched, 9, 'two still-queued jobs never ran');
  assert.equal(worker.terminated, true);
});

test('worker batch protocol rejects unknown IDs, duplicates and incomplete final messages without retry', async () => {
  for (const kind of ['unknown', 'duplicate', 'incomplete']) {
    const fake = fakeWorkers(), pool = createHashPool({ workers: 1, createWorker: fake.createWorker });
    const first = pool.hash('first', 'identity');
    const jobs = [pool.hash('second', 'identity'), pool.hash('third', 'identity')];
    const rejected = jobs.map(job => assert.rejects(job, /Invalid input hash worker response/));
    fake.workers[0].complete(); await first;
    const worker = fake.workers[0], [second] = worker.job.jobs;
    worker.job = undefined;
    const value = { id: second.id, hash: 'invalid', metrics: {} };
    worker.emit('message', { done: true, results: kind === 'unknown' ? [{ ...value, id: -1 }]
      : kind === 'duplicate' ? [value, value] : [value] });
    await Promise.all(rejected); await pool.close();
    assert.equal(worker.dispatched, 3);
    assert.equal(worker.terminated, true);
  }
});

test('real worker batches isolate per-file errors and flush completed results before a fresh large-file read', async t => {
  const { Worker } = await import('node:worker_threads');
  const root = await temporary(t);
  const small = await put(root, 'small', 'small'), largeBytes = Buffer.alloc(4 * 1024 * 1024, 1);
  const large = await put(root, 'large', largeBytes);
  const worker = new Worker(new URL('../src/input-hash-worker.mjs', import.meta.url), {
    workerData: { cancellation: new SharedArrayBuffer(4) }, execArgv: [],
  });
  t.after(() => worker.terminate());
  const messages = [], finished = Promise.withResolvers();
  worker.on('error', finished.reject);
  worker.on('message', message => { messages.push(message); if (message.done) finished.resolve(); });
  worker.postMessage({ jobs: [
    { id: 1, file: small, inspect: true }, { id: 2, file: join(root, 'missing'), inspect: true },
    { id: 3, file: large, inspect: true, cached: { identity: 'stale-small-size-hint', hash: 'invalid' } },
    { id: 4, file: small, inspect: true },
  ] });
  await finished.promise;
  const results = messages.flatMap(message => message.results);
  assert.deepEqual(results.map(value => value.id), [1, 2, 3, 4]);
  assert.equal(results[0].hash.hash, digest('small'));
  assert.equal(results[1].error.code, 'ENOENT');
  assert.equal(results[2].hash.hash, digest(largeBytes));
  assert.equal(results[3].hash.hash, digest('small'));
  assert.ok(messages.findIndex(message => message.results.some(value => value.id === 1))
    < messages.findIndex(message => message.results.some(value => value.id === 3)), 'large actual size flushes preceding small results before its hash');
});
