import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createHashPool } from '../src/input-hash-pool.mjs';
import { createSnapshotContext } from '../src/inputs.mjs';
import { digest } from '../src/util.mjs';
import { put, temporary } from './helpers.mjs';
import { join } from 'node:path';

const host = { cpus: 16, cpuQuotaCpus: 16, memoryMiB: 16384 };
const telemetry = () => ({ busyCpus: 2, pressure: 0, memoryPressure: 0, ioPressure: 0, availableMemoryMiB: 8192 });
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, initial = 32, overrides = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const reading = { ...telemetry(), ...overrides }, workers = [];
  class Fake extends EventEmitter {
    constructor() { super(); workers.push(this); }
    postMessage(message) { assert.equal(this.job, undefined); this.jobs = message.jobs; [this.job] = message.jobs; }
    complete() { const jobs = this.jobs; this.job = this.jobs = undefined; this.emit('message', { results: jobs.map(({ id }) => ({ id, hash: 'digest', metrics: {} })), done: true }); }
    async terminate() { assert.equal(this.job, undefined); this.retired = true; this.emit('exit', 1); }
  }
  const pool = createHashPool({ workers: initial, host, sample: () => reading, createWorker: () => new Fake() });
  const jobs = Array.from({ length: 80 }, (_, index) => pool.inspect(`file-${index}`));
  const settled = Promise.allSettled(jobs);
  t.after(async () => {
    const closing = pool.close();
    workers.filter(worker => worker.job).forEach(worker => worker.complete());
    await Promise.all([settled, closing]);
  });
  return { pool, workers, reading, active: () => workers.filter(worker => worker.job).length };
}

test('input scanner starts32 readers and does not grow beyond startup above its CPU budget', async t => {
  const f = fixture(t);
  assert.equal(f.active(), 32);
  t.mock.timers.tick(1000);
  assert.equal(f.active(), 32);
  t.mock.timers.tick(1000);
  assert.equal(f.active(), 32);
  assert.ok(f.workers.every(worker => worker.job.id > 0));
});

test('CPU and memory pressure shrink BELOW startup without interrupting owned files', async t => {
  for (const pressure of ['busyCpus', 'memoryPressure', 'ioPressure']) await t.test(pressure, async t => {
    const f = fixture(t);
    f.reading[pressure] = pressure === 'busyCpus' ? 16 : 0.2;
    t.mock.timers.tick(1000);
    const firstLimit = pressure === 'busyCpus' ? 28 : 24;
    const nextLimit = pressure === 'busyCpus' ? 25 : 16;
    assert.equal(f.pool.state().limit, firstLimit);
    assert.equal(f.active(), 32, 'active files finish under their original ownership');
    f.workers.slice(0, 32 - firstLimit).forEach(worker => worker.complete());
    await flush();
    assert.equal(f.active(), firstLimit, 'the reduced pool admits no replacements at capacity');
    assert.equal(f.workers.filter(worker => worker.retired).length, 32 - firstLimit);
    t.mock.timers.tick(1000);
    assert.equal(f.pool.state().limit, nextLimit);
    f.workers.filter(worker => worker.job).slice(0, firstLimit - nextLimit).forEach(worker => worker.complete());
    await flush();
    assert.equal(f.active(), nextLimit);
    // Close before the next iteration: mocks and every worker retain one owner.
    const closing = f.pool.close();
    f.workers.filter(worker => worker.job).forEach(worker => worker.complete());
    await closing;
  });
});

test('CPU pressure alone does not shrink validation while the CPU budget has headroom', async t => {
  const f = fixture(t, 32, { pressure: 0.75 });
  t.mock.timers.tick(1000);
  assert.equal(f.pool.state().limit, 32);
  f.reading.busyCpus = 16;
  t.mock.timers.tick(1000);
  assert.equal(f.pool.state().limit, 28, 'measured CPU saturation reduces admission proportionally');
});

test('a reduced scanner recovers when positive CPU headroom rounds below one worker', async t => {
  const f = fixture(t, 1, { busyCpus: 12 });
  assert.equal(f.pool.state().limit, 1);
  t.mock.timers.tick(1000);
  assert.equal(f.pool.state().limit, 2);
  assert.equal(f.active(), 2);
});

test('metadata tasks and file hashing consume the SAME scanner admission', async t => {
  const f = fixture(t, 2), release = Promise.withResolvers();
  f.workers.forEach(worker => worker.complete());
  const metadata = f.pool.run(() => release.promise);
  // Earlier file work remains queued; no separate filesystem pool can bypass it.
  assert.equal(f.pool.state().active, 2);
  assert.equal(f.pool.state().waiting, 47);
  const closing = f.pool.close();
  const rejected = assert.rejects(metadata, /Input scanner pool closed/);
  f.workers.filter(worker => worker.job).forEach(worker => worker.complete());
  release.resolve();
  await Promise.all([rejected, closing]);
});

test('deep directories aggregate child work without holding a scanner slot', async t => {
  const root = await temporary(t), path = 'tree/a/b/c/d/e/f/file';
  await put(root, path, 'leaf');
  await put(root, 'tree/other', 'other');
  const context = createSnapshotContext({ inputConcurrency: 1 });
  t.after(() => context.close());
  context.beginScanGeneration();
  const identities = await context.identify([join(root, 'tree')], { root, cacheDirectory: join(root, '.cache'), ignore: [] });
  assert.equal(context.digests.size, 2);
  assert.ok(JSON.stringify(identities).includes(digest('leaf')));
  assert.ok(JSON.stringify(identities).includes(digest('other')));
  assert.deepEqual(context.scanState(), { active: 0, waiting: 0, limit: 1 });
  await context.finishScanGeneration();
});

test('I/O telemetry measures stall fractions and tolerates unsupported pressure files', async t => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { resourceSampler } = await import('../src/admission.mjs');
  const original = fs.readFileSync;
  let total = 1000000, now = 0, unsupported = false;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file !== '/proc/pressure/io') return original(file, ...args);
    if (unsupported) throw Object.assign(new Error('unsupported'), { code: 'ENOENT' });
    return `some avg10=0.00 avg60=0.00 avg300=0.00 total=${total}`;
  });
  t.mock.method(performance, 'now', () => now);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const sample = resourceSampler();
  total += 200000; now += 1000;
  assert.equal(sample().ioPressure, 0.2);
  unsupported = true; now += 1000;
  assert.ok(Number.isNaN(sample().ioPressure));
});

test('initial low memory clamps admission before any file worker starts', t => {
  const f = fixture(t, 32, { availableMemoryMiB: 96 });
  assert.equal(f.pool.state().limit, 1);
  assert.equal(f.active(), 1);
});

test('an explicit scanner startup above32 has no hidden lower hash or filesystem cap', t => {
  const f = fixture(t, 64, { availableMemoryMiB: 16384 });
  assert.equal(f.pool.state().limit, 64);
  assert.equal(f.active(), 64);
});

test('a pool reduced to one recovers using a smaller safe growth increment', async t => {
  const f = fixture(t, 32);
  f.reading.memoryPressure = 0.2;
  t.mock.timers.tick(4000);
  assert.equal(f.pool.state().limit, 1);
  f.workers.slice(0, 31).forEach(worker => worker.complete());
  await flush();
  assert.equal(f.active(), 1);
  f.reading.memoryPressure = 0;
  f.reading.busyCpus = 2;
  t.mock.timers.tick(1000);
  // CPU budget14.4 allows six extra files, but would reject an all-eight jump.
  assert.equal(f.pool.state().limit, 7);
  assert.equal(f.active(), 4, 'three batches cover the remaining 48 files');
});
