import assert from 'node:assert/strict';
import test from 'node:test';
import { Admission, resourceSampler } from '../src/admission.mjs';

function fixture(t, policy = {}, host = { cpus: 2, memoryMiB: 8192 }, signal) {
  const reading = { busyCpus: 0.2, pressure: 0, memoryPressure: 0, availableMemoryMiB: host.memoryMiB };
  const admission = new Admission({ maxWorkers: 4, memoryMiBPerWorker: 512, ...policy }, 8, { host, sample: () => ({ ...reading }), signal });
  t.after(() => admission.close());
  return { admission, reading };
}

test('automatically lowers CPU weight one worker at a time after sustained spare capacity', async t => {
  const { admission } = fixture(t);
  assert.equal(admission.limit, 1);
  await admission.acquire();
  admission.tick();
  admission.tick();
  assert.equal(admission.limit, 1);
  admission.tick();
  assert.equal(admission.limit, 2);
  await admission.acquire();
  for (let count = 0; count < 3; count++) admission.tick();
  assert.equal(admission.limit, 3);
  assert.ok(admission.weight < 1);
  await admission.acquire();
  for (let count = 0; count < 12; count++) admission.tick();
  assert.equal(admission.limit, 4);
  assert.equal(admission.active, 3);
});

test('saturation holds; sustained pressure raises the weight without stopping active work', async t => {
  const { admission, reading } = fixture(t);
  await admission.acquire();
  for (let count = 0; count < 3; count++) admission.tick();
  await admission.acquire();
  reading.busyCpus = 1.9;
  for (let count = 0; count < 6; count++) admission.tick();
  assert.equal(admission.limit, 2);
  reading.pressure = 0.2;
  for (let count = 0; count < 3; count++) admission.tick();
  assert.equal(admission.limit, 1);
  assert.equal(admission.active, 2);
  assert.ok(admission.weight > 1);
});

test('memory reservations and explicit suite caps bound automatic growth', async t => {
  for (const policy of [{ maxWorkers: 1 }, { memoryMiBPerWorker: 8192 }, { reserveMemoryMiB: 7680 }]) {
    const { admission } = fixture(t, policy);
    await admission.acquire();
    for (let count = 0; count < 12; count++) admission.tick();
    assert.equal(admission.capacity, 1);
    assert.equal(admission.limit, 1);
  }
  const { admission } = fixture(t, {}, { cpus: 8, memoryMiB: 8192 });
  assert.equal(admission.limit, 3);
});

test('startup uses half the CPU budget, clamped by live free RAM and the reserve', t => {
  for (const [availableMemoryMiB, expected] of [[8192, 3], [2560, 3], [1024, 1]]) {
    const admission = new Admission({ reserveMemoryMiB: 1024, memoryMiBPerWorker: 512, maxWorkers: 16 }, 16, {
      host: { cpus: 8, memoryMiB: 8192 },
      sample: () => ({ availableMemoryMiB, busyCpus: 0, pressure: 0 }),
    });
    t.after(() => admission.close());
    assert.equal(admission.limit, expected);
  }
});

test('live pressure pauses admission until recovery without double-counting active RAM', async t => {
  const reading = { busyCpus: 0, pressure: 0, availableMemoryMiB: 2048 };
  const admission = new Admission({ memoryMiBPerWorker: 1024, reserveMemoryMiB: 512 }, 4, { host: { cpus: 4, memoryMiB: 8192 }, sample: () => ({ ...reading }) });
  t.after(() => admission.close());
  assert.equal(admission.capacity, 4);
  reading.availableMemoryMiB = 1024;
  admission.tick();
  let started = false;
  const waiting = admission.acquire().then(() => { started = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, false);
  reading.availableMemoryMiB = 2048;
  admission.tick();
  await waiting;
  assert.equal(admission.active, 1);
  for (let count = 0; count < 3; count++) admission.tick();
  await admission.acquire();
  assert.equal(admission.active, 2);
});

test('sustained memory pressure stops growth and lowers future admissions even with spare CPU and RAM', async t => {
  const { admission, reading } = fixture(t);
  await admission.acquire();
  for (let count = 0; count < 3; count++) admission.tick();
  await admission.acquire();
  reading.memoryPressure = 0.1;
  for (let count = 0; count < 3; count++) admission.tick();
  assert.equal(admission.limit, 1);
  assert.equal(admission.active, 2);
  admission.release();
  admission.release();
  let started = false;
  const waiting = admission.acquire().then(() => { started = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, false);
  reading.memoryPressure = 0;
  admission.tick();
  await waiting;
  assert.equal(admission.active, 1);
});

test('free-memory reserve blocks growth and admission, then allows recovery', async t => {
  const { admission, reading } = fixture(t, { reserveMemoryMiB: 1024 });
  await admission.acquire();
  reading.availableMemoryMiB = 1400;
  for (let count = 0; count < 6; count++) admission.tick();
  assert.equal(admission.limit, 1);
  admission.release();
  let started = false;
  const waiting = admission.acquire().then(() => { started = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, false);
  reading.availableMemoryMiB = 1536;
  admission.tick();
  await waiting;
  assert.equal(admission.active, 1);
});

test('blocked admissions stop promptly on cancellation or fatal errors and time out without forcing a worker', async t => {
  const controller = new AbortController();
  const { admission, reading } = fixture(t, {}, undefined, controller.signal);
  reading.availableMemoryMiB = 0;
  admission.tick();
  const cancelled = admission.acquire();
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  const other = fixture(t).admission;
  other.reading.availableMemoryMiB = 0;
  const stopped = other.acquire();
  other.close();
  await assert.rejects(stopped, /admission stopped/);

  const second = fixture(t).admission;
  second.reading.availableMemoryMiB = 0;
  second.blockedSince = performance.now() - 30001;
  await assert.rejects(second.acquire(), /Insufficient memory/);
  assert.equal(second.active, 0);
});

test('missing CPU telemetry retains half-CPU startup and sampling reports live RAM', async t => {
  const { admission, reading } = fixture(t);
  reading.busyCpus = NaN;
  reading.pressure = NaN;
  await admission.acquire();
  for (let count = 0; count < 12; count++) admission.tick();
  assert.ok(Math.abs(admission.weight - 1.9) < 0.00001);
  assert.equal(admission.limit, 1);
  const sample = resourceSampler()();
  assert.ok(sample.availableMemoryMiB >= 0);
});


test('fixed shared overrides remain bounded by capacity and do not retune', async t => {
  const admission = new Admission({ reserveMemoryMiB: 512, memoryMiBPerWorker: 512 }, 20, {
    host: { cpus: 8, memoryMiB: 2048 }, workers: 9,
    sample: () => ({ busyCpus: 0, pressure: 0, memoryPressure: 0, availableMemoryMiB: 2048 }),
  });
  t.after(() => admission.close());
  assert.equal(admission.limit, 3);
  for (let i = 0; i < 3; i++) await admission.acquire();
  for (let i = 0; i < 6; i++) admission.tick();
  assert.equal(admission.limit, 3);
  assert.equal(admission.samples, 6);
  assert.ok(admission.capacity * admission.memory <= admission.selected.memoryBudgetMiB);
});

test('CPU ceiling reserves 5% and lowers admissions above it without pressure', async t => {
  for (const cpuPercent of [undefined, 200]) {
    const { admission, reading } = fixture(t, { cpuPercent }, { cpus: 8, memoryMiB: 8192 });
    assert.equal(admission.selected.cpuBudget, 7.6);
    for (let i = 0; i < 3; i++) await admission.acquire();
    reading.busyCpus = 7.6;
    for (let i = 0; i < 3; i++) admission.tick();
    assert.equal(admission.limit, 3);
    reading.busyCpus = 7.7;
    for (let i = 0; i < 3; i++) admission.tick();
    assert.equal(admission.limit, 2);
    assert.equal(admission.active, 3);
  }
});
