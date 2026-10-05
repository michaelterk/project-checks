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
