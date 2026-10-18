import assert from 'node:assert/strict';
import test from 'node:test';
import { Admission, resourceSampler } from '../src/admission.mjs';
import { createDiagnostics } from '../src/diagnostics.mjs';
import { createDashboardState } from '../src/dashboard-state.mjs';

function fixture() {
  const counters = { time: 0, total: 0, idle: 0, count: 8, pressure: 0,
    memoryPressure: 0, ioPressure: 0, availableMemoryMiB: 8192 };
  const sample = resourceSampler({ read: () => ({ ...counters }) });
  return { counters, sample, advance(ms, busy, pressure) {
    counters.time += ms;
    counters.total += ms * counters.count;
    counters.idle += ms * counters.count * (1 - busy);
    counters.pressure += ms * 1000 * pressure;
    return sample();
  } };
}

test('five-second counters handle warmup, uneven sampling and cutoff interpolation', () => {
  const f = fixture();
  assert.ok(Number.isNaN(f.sample().busyCpus));
  const warm = f.advance(1000, 1, 0.5);
  assert.equal(warm.cpuObservedSeconds, 1);
  assert.equal(warm.busyCpus, 8);
  assert.equal(warm.pressure, 0.5);
  const uneven = f.advance(4000, 0, 0);
  assert.ok(Math.abs(uneven.busyCpus - 1.6) < 1e-9);
  assert.equal(uneven.pressure, 0.1);
  const clipped = f.advance(2500, 1, 0.4);
  // Window [2500,7500]: 2500ms idle + 2500ms busy; the first spike has expired.
  assert.equal(clipped.cpuWindowSeconds, 5);
  assert.equal(clipped.cpuObservedSeconds, 5);
  assert.equal(clipped.busyCpus, 4);
  assert.equal(clipped.pressure, 0.2);
});

test('CPU spikes age out, while live RAM does not get averaged', () => {
  const f = fixture();
  f.advance(1000, 1, 0.8);
  f.counters.availableMemoryMiB = 256;
  const low = f.advance(4000, 0, 0);
  assert.equal(low.availableMemoryMiB, 256);
  assert.ok(low.busyCpus > 0 && low.pressure > 0);
  const expired = f.advance(1000, 0, 0);
  assert.equal(expired.busyCpus, 0);
  assert.equal(expired.pressure, 0);
});

test('counter rollback, CPU changes and missing PSI never fabricate pressure', () => {
  for (const reset of [c => { c.time = -1; }, c => { c.total = -1; },
    c => { c.idle = -1; }, c => { c.count = 4; }, c => { c.pressure = -1; }]) {
    const f = fixture();
    f.advance(1000, 0.5, 0.1);
    reset(f.counters);
    assert.ok(Number.isNaN(f.sample().busyCpus));
    assert.equal(f.sample().cpuObservedSeconds, 0);
  }
  const f = fixture();
  f.counters.pressure = NaN;
  assert.ok(Number.isNaN(f.advance(1000, 1, 0).pressure));
});

test('admission uses rolling load when the newest interval is below backoff', t => {
  const f = fixture();
  const admission = new Admission({ maxWorkers: 8 }, 8,
    { host: { cpus: 8, memoryMiB: 8192 }, sample: f.sample });
  t.after(() => admission.close());
  for (let i = 0; i < 5; i++) f.advance(1000, 1, 0.25);
  admission.active = admission.peak = 1;
  f.advance(1000, 0.6, 0);
  // A status read and admission tick at the same timestamp must not erase the window.
  admission.tick();
  assert.ok(Math.abs(admission.reading.busyCpus - 7.36) < 1e-9);
  assert.equal(admission.reading.pressure, 0.2);
  assert.equal(admission.cpuBackoff, true);
  assert.equal(admission.limit, 5);
  const lines = [];
  admission.report({ log: line => lines.push(line) }, 'suite');
  assert.match(lines[0], /92% CPU capacity used \(5s\)/);
});

test('diagnostic logging, event callbacks and dashboard preserve rolling telemetry', () => {
  const f = fixture();
  f.advance(5000, 0.75, 0.3);
  const reading = f.advance(1000, 0, 0);
  const events = [], logs = [];
  const dashboard = createDashboardState({ root: '/project', target: 'test' });
  const diagnostic = createDiagnostics({ sample: () => reading, cpuCount: 8, progress: false,
    processSample: () => null, onEvent: event => { events.push(event); dashboard.event(event); },
    logger: { log: line => logs.push(line) } });
  diagnostic.close(0);
  const sample = events.find(event => event.event === 'sample');
  const logged = logs.map(line => JSON.parse(line.trim().slice('TEST_DIAGNOSTIC '.length)))
    .find(event => event.event === 'sample');
  assert.ok(Math.abs(sample.cpuPercent - 60) < 1e-9);
  assert.equal(sample.cpuPressure, 0.24);
  assert.equal(sample.cpuWindowSeconds, 5);
  assert.equal(sample.cpuObservedSeconds, 5);
  assert.equal(logged.cpuPercent, sample.cpuPercent);
  assert.equal(logged.cpuPressure, sample.cpuPressure);
  assert.equal(dashboard.snapshot().resources.cpuPressure, sample.cpuPressure);
  assert.equal(dashboard.snapshot().resources.cpuWindowSeconds, 5);
});
