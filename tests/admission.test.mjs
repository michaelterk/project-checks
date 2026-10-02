import assert from 'node:assert/strict';
import test from 'node:test';
import { Admission, resourceSampler } from '../src/admission.mjs';

function fixture(t, policy = {}, host = { cpus: 2, memoryMiB: 8192 }, signal) {
  const reading = { busyCpus: 0.2, pressure: 0, availableMemoryMiB: host.memoryMiB };
  const admission = new Admission({ maxWorkers: 4, memoryMiBPerWorker: 512, ...policy }, 8, { host, sample: () => ({ ...reading }), signal });
  t.after(() => admission.close());
  return { admission, reading };
}

test('automatically lowers CPU weight one worker at a time after sustained spare capacity', async t => {
  const { admission } = fixture(t);
  await admission.acquire();
  await admission.acquire();
  admission.tick();
  admission.tick();
  assert.equal(admission.limit, 2);
  admission.tick();
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
  await admission.acquire();
  reading.busyCpus = 2;
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
  assert.equal(admission.limit, 4);
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
  await admission.acquire();
  assert.equal(admission.active, 2);
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

test('missing telemetry retains configured CPU weights and sampling reports live RAM', async t => {
  const { admission, reading } = fixture(t);
  reading.busyCpus = NaN;
  reading.pressure = NaN;
  await admission.acquire();
  await admission.acquire();
  for (let count = 0; count < 12; count++) admission.tick();
  assert.equal(admission.weight, 1);
  assert.equal(admission.limit, 2);
  const sample = resourceSampler()();
  assert.ok(sample.availableMemoryMiB >= 0);
});
