import assert from 'node:assert/strict';
import test from 'node:test';
import { createScanQueue } from '../src/scan-queue.mjs';

const host = { cpus: 16, cpuQuotaCpus: 16, memoryMiB: 16384 };
const reading = () => ({ busyCpus: 2, pressure: 0, memoryPressure: 0, ioPressure: 0, availableMemoryMiB: 8192 });
const flush = () => new Promise(resolve => setImmediate(resolve));

async function pool(t, telemetry = reading()) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const queue = createScanQueue({ host, sample: () => telemetry });
  const release = Promise.withResolvers();
  let active = 0, started = 0;
  const operations = Array.from({ length: 80 }, () => async () => {
    active++; started++;
    try { await release.promise; } finally { active--; }
  });
  const settled = Promise.allSettled(queue.enqueue(operations));
  t.after(async () => { release.resolve(); await settled; });
  await flush();
  return { telemetry, queue, release, settled, active: () => active, started: () => started };
}

test('cache scan starts 32 workers and grows by eight each second of spare CPU', async t => {
  const p = await pool(t);
  assert.equal(p.active(), 32);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(p.active(), 40);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(p.active(), 48);
  p.release.resolve();
  assert.ok((await p.settled).every(result => result.status === 'fulfilled'));
  assert.equal(p.started(), 80);
  const hold = Promise.withResolvers();
  let started = 0;
  const next = Promise.all(p.queue.enqueue(Array.from({ length: 50 }, () => async () => { started++; await hold.promise; })));
  await flush();
  assert.equal(started, 32, 'an idle pool restarts at 32');
  hold.resolve();
  await next;
});

test('CPU, memory and I/O pressure each prevent cache-scan growth', async t => {
  const p = await pool(t);
  for (const change of [
    { busyCpus: 12 }, // Eight more workers would exceed the 90% CPU budget.
    { busyCpus: NaN },
    { pressure: 0.1 },
    { memoryPressure: 0.1 },
    { availableMemoryMiB: 1 },
    { availableMemoryMiB: NaN },
    { ioPressure: 0.1 },
  ]) {
    Object.assign(p.telemetry, reading(), change);
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(p.active(), 32, JSON.stringify(change));
  }
  Object.assign(p.telemetry, reading(), { ioPressure: NaN });
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(p.active(), 40, 'missing I/O pressure data falls back to CPU and memory guards');
});

test('shared scans respect the strictest active CPU budget', async t => {
  const p = await pool(t);
  const sibling = Promise.all(p.queue.enqueue([() => p.release.promise], { cpuPercent: 10 }));
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(p.active(), 32);
  p.release.resolve();
  await Promise.all([p.settled, sibling]);
});

test('pressure reduces future admissions without interrupting active scans', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const telemetry = reading();
  const queue = createScanQueue({ host, sample: () => telemetry });
  const holds = Array.from({ length: 60 }, () => Promise.withResolvers());
  let started = 0;
  const done = Promise.all(queue.enqueue(holds.map(hold => async () => { started++; await hold.promise; })));
  t.after(async () => { holds.forEach(hold => hold.resolve()); await done; });
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(started, 40);
  telemetry.ioPressure = 0.2;
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(started, 40);
  holds.slice(0, 8).forEach(hold => hold.resolve());
  await flush();
  assert.equal(started, 40, 'the raised pool drains back to 32 before admitting more jobs');
  holds[8].resolve();
  await flush();
  assert.equal(started, 41);
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
  total += 200000;
  now += 1000;
  assert.equal(sample().ioPressure, 0.2);
  unsupported = true;
  now += 1000;
  assert.ok(Number.isNaN(sample().ioPressure));
});

test('configured scan startup also defines the adaptive floor and resets between runs', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const telemetry = reading();
  const queue = createScanQueue({ host, sample: () => telemetry });
  const holds = Array.from({ length: 40 }, () => Promise.withResolvers());
  const states = [];
  let active = 0;
  const done = Promise.all(queue.enqueue(holds.map(hold => async () => {
    active++;
    try { await hold.promise; } finally { active--; }
  }), {}, 4, state => states.push(state)));
  t.after(async () => { holds.forEach(hold => hold.resolve()); await done; });
  await flush();
  assert.equal(active, 4);
  assert.deepEqual(states.at(-1), { total: 40, scanned: 0, active: 4 });
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(active, 12, 'growth keeps the existing eight-worker increment');
  assert.equal(states.at(-1).active, 12);
  telemetry.ioPressure = 0.2;
  t.mock.timers.tick(1000);
  holds.slice(0, 8).forEach(hold => hold.resolve());
  await flush();
  assert.equal(active, 4, 'pressure drains back to the configured floor');
  assert.deepEqual(states.at(-1), { total: 40, scanned: 8, active: 4 });
  holds.forEach(hold => hold.resolve());
  await done;
  assert.deepEqual(states.at(-1), { total: 40, scanned: 40, active: 0 });
  const release = Promise.withResolvers();
  const next = Promise.all(queue.enqueue(Array.from({ length: 8 }, () => async () => {
    active++;
    try { await release.promise; } finally { active--; }
  }), {}, 2));
  t.after(async () => { release.resolve(); await next; });
  await flush();
  assert.equal(active, 2, 'the next project uses its own startup value');
  release.resolve();
  await next;
});

test('concurrent scan batches share the smaller configured startup without interrupting work', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const queue = createScanQueue({ host, sample: reading });
  const releaseFirst = Promise.withResolvers(), releaseSecond = Promise.withResolvers();
  let active = 0;
  const jobs = release => Array.from({ length: 12 }, () => async () => {
    active++;
    try { await release.promise; } finally { active--; }
  });
  const first = Promise.all(queue.enqueue(jobs(releaseFirst), {}, 2));
  const second = Promise.all(queue.enqueue(jobs(releaseSecond), {}, 6));
  t.after(async () => { releaseFirst.resolve(); releaseSecond.resolve(); await Promise.all([first, second]); });
  await flush();
  assert.equal(active, 2);
  releaseFirst.resolve();
  await first;
  await flush();
  assert.equal(active, 6, 'the remaining batch gets its configured startup once the smaller batch drains');
  releaseSecond.resolve();
  await second;
});

test('a new batch with the same startup value preserves adaptive growth', async t => {
  const p = await pool(t);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(p.active(), 40);
  const sibling = Promise.all(p.queue.enqueue([() => p.release.promise]));
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(p.active(), 48, 'joining a default batch does not reset the learned scan limit');
  p.release.resolve();
  await Promise.all([p.settled, sibling]);
});
