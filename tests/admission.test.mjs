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

test('20% CPU pressure independently reduces admissions while lower pressure permits growth', async t => {
  const { admission, reading } = fixture(t, { maxWorkers: 8 }, { cpus: 8, memoryMiB: 8192 });
  for (let i = 0; i < 6; i++) await admission.acquire();
  reading.busyCpus = 6.4;
  reading.pressure = 0.199;
  for (let i = 0; i < 3; i++) admission.tick();
  assert.equal(admission.limit, 7);
  await admission.acquire();
  reading.pressure = 0.20;
  admission.tick();
  assert.equal(admission.limit, 6);
  assert.equal(admission.active, 7);
  for (let i = 0; i < 3; i++) admission.tick();
  assert.equal(admission.limit, 6);
  admission.release();
  admission.tick();
  assert.equal(admission.limit, 5);
  admission.release();
  reading.pressure = 0.199;
  for (let i = 0; i < 3; i++) admission.tick();
  assert.equal(admission.limit, 6);
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
  assert.equal(admission.limit, 4);
});

test('startup uses three quarters of available cores, clamped by live free RAM and the reserve', t => {
  for (const [availableMemoryMiB, expected] of [[8192, 6], [2560, 3], [1024, 1]]) {
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

test('missing CPU telemetry retains three-quarter-core startup and sampling reports live RAM', async t => {
  const { admission, reading } = fixture(t);
  reading.busyCpus = NaN;
  reading.pressure = NaN;
  await admission.acquire();
  for (let count = 0; count < 12; count++) admission.tick();
  assert.ok(Math.abs(admission.weight - 1.8) < 0.00001);
  assert.equal(admission.limit, 1);
  const sample = resourceSampler()();
  assert.ok(sample.availableMemoryMiB >= 0);
});


test('explicit worker caps remain resource-bounded under spare CPU', async t => {
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

test('CPU usage reaches 90% then backs off until below 85% without stopping active work', async t => {
  for (const workers of [undefined, 4]) for (const cpuPercent of [undefined, 200]) {
    const reading = { busyCpus: 0, pressure: 0, memoryPressure: 0, availableMemoryMiB: 8192 };
    const admission = new Admission({ cpuPercent, maxWorkers: 4 }, 8, {
      workers, host: { cpus: 8, memoryMiB: 8192 }, sample: () => ({ ...reading }),
    });
    t.after(() => admission.close());
    assert.equal(admission.selected.cpuBudget, 7.2);
    const initial = admission.limit;
    for (let i = 0; i < initial; i++) await admission.acquire();
    reading.busyCpus = 7.2;
    admission.tick();
    assert.equal(admission.limit, initial - 1);
    assert.equal(admission.active, initial);
    for (let i = 0; i < 3; i++) admission.tick();
    assert.equal(admission.limit, initial - 1);
    admission.release();
    reading.busyCpus = 6.8;
    admission.tick();
    assert.equal(admission.limit, initial - 2);
    assert.equal(admission.cpuBackoff, true);
    admission.release();
    reading.busyCpus = 6.7;
    for (let i = 0; i < 3; i++) admission.tick();
    assert.equal(admission.cpuBackoff, false);
    assert.equal(admission.limit, initial - 1);
  }
});

test('growth uses measured CPU usage rather than predicting the next worker cost', async t => {
  const { admission, reading } = fixture(t, { maxWorkers: 8 }, { cpus: 8, memoryMiB: 8192 });
  for (let i = 0; i < 6; i++) await admission.acquire();
  reading.busyCpus = 7;
  for (let i = 0; i < 3; i++) admission.tick();
  assert.equal(admission.limit, 7);
});

test('fixed worker count bounds lookup capacity as well as execution', t => {
  for (const [workers, expected] of [[1, 1], [2, 2], [20, 4]]) {
    const admission = new Admission({ maxWorkers: 4 }, 8, {
      workers, host: { cpus: 8, memoryMiB: 8192 },
      sample: () => ({ busyCpus: 0, pressure: 0, availableMemoryMiB: 8192 }),
    });
    t.after(() => admission.close());
    assert.equal(admission.capacity, expected);
    assert.equal(admission.limit, expected);
  }
});


test('configured quota percent defines admission CPU headroom', t => {
  for (const cpuQuotaPercent of [80, 90, 95, 100]) {
    const admission = new Admission({ cpuQuotaPercent }, 8, {
      host: { cpus: 8, memoryMiB: 8192 }, sample: () => ({ busyCpus: 0, availableMemoryMiB: 8192 }),
    });
    t.after(() => admission.close());
    assert.equal(admission.selected.cpuBudget, 8 * cpuQuotaPercent / 100);
  }
});


test('adaptive capacity is four times host cores, with lower workload, RAM and explicit caps', t => {
  for (const [cores, policy, units, capacity, initial] of [
    [32, {}, 1000, 128, 24], [64, {}, 1000, 256, 48],
    [32, { maxWorkers: 10 }, 1000, 10, 10], [32, { maxWorkers: 100 }, 1000, 100, 24],
    [32, {}, 5, 5, 5], [32, { memoryMiBPerWorker: 16384 }, 1000, 8, 8],
  ]) {
    const admission = new Admission(policy, units, { host: { cpus: cores, memoryMiB: 131072 },
      sample: () => ({ availableMemoryMiB: 131072 }) });
    t.after(() => admission.close());
    assert.equal(admission.capacity, capacity);
    assert.equal(admission.limit, initial);
  }
});


test('adaptive growth can reach four times host cores and still backs off under CPU pressure', async t => {
  const { admission, reading } = fixture(t, { maxWorkers: 20 });
  assert.equal(admission.capacity, 8);
  assert.equal(admission.limit, 1);
  await admission.acquire();
  for (let expected = 2; expected <= 8; expected++) {
    for (let tick = 0; tick < 3; tick++) admission.tick();
    assert.equal(admission.limit, expected);
    await admission.acquire();
  }
  for (let tick = 0; tick < 3; tick++) admission.tick();
  assert.equal(admission.limit, 8);
  reading.pressure = 0.20;
  admission.tick();
  assert.equal(admission.limit, 7);
  assert.equal(admission.active, 8);
  for (let worker = 0; worker < 8; worker++) admission.release();
});
