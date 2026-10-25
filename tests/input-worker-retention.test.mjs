import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createHashPool } from '../src/input-hash-pool.mjs';

function fixture(t, count = 8) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const workers = [];
  const reading = { availableMemoryMiB: 8192, busyCpus: 1, memoryPressure: 0, ioPressure: 0 };
  class Worker extends EventEmitter {
    postMessage(message) { assert.equal(this.job, undefined); this.job = message; }
    complete() {
      const { jobs } = this.job;
      this.job = undefined;
      this.emit('message', { done: true, results: jobs.map(({ id }) => ({ id, value: 'completed' })) });
    }
    async terminate() { assert.equal(this.job, undefined); this.terminated = true; this.emit('exit', 0); }
  }
  const pool = createHashPool({ workers: 4, host: { cpus: 4, memoryMiB: 8192 },
    resources: { cpuQuotaPercent: 100, reserveMemoryMiB: 512, memoryMiBPerWorker: 256 },
    sample: () => ({ ...reading }),
    createWorker: () => { const worker = new Worker(); workers.push(worker); return worker; },
  });
  const definition = {};
  const jobs = Array.from({ length: count }, (_, id) => pool.inputTask(definition, { mode: 'unit', id }));
  const settled = Promise.allSettled(jobs);
  const close = async () => {
    const closing = pool.close(new Error('test cleanup'));
    for (const worker of workers) if (worker.job) worker.complete();
    await Promise.all([settled, closing]);
  };
  return { pool, workers, reading, jobs, settled, close };
}

for (const pressure of ['CPU', 'I/O']) {
  test(`${pressure} admission backoff reuses warm workers when demand recovers`, async t => {
    const state = fixture(t);
    try {
      if (pressure === 'CPU') state.reading.busyCpus = 8;
      else state.reading.ioPressure = 0.1;
      t.mock.timers.tick(1000);
      const reduced = state.pool.state().limit;
      assert.ok(reduced < 4, 'resource pressure must still reduce active admission');
      const completed = 4 - reduced;
      for (const worker of state.workers.slice(0, completed)) worker.complete();
      await Promise.all(state.jobs.slice(0, completed));
      assert.equal(state.pool.state().active, reduced);
      state.reading.busyCpus = 1;
      state.reading.ioPressure = 0;
      t.mock.timers.tick(1000);
      assert.equal(state.pool.state().active, 4, 'healthy queued demand restores the admitted capacity');
      assert.equal(state.workers.length, 4, 'recovery must reuse the original warm processes instead of spawning replacements');
      assert.ok(state.workers.every(worker => !worker.terminated));
    } finally { await state.close(); }
  });
}

for (const pressure of ['low headroom', 'memory pressure']) {
  test(`${pressure} retires idle workers while active work drains`, async t => {
    const state = fixture(t);
    try {
      if (pressure === 'low headroom') state.reading.availableMemoryMiB = 600;
      else state.reading.memoryPressure = 0.1;
      t.mock.timers.tick(1000);
      assert.equal(state.pool.state().limit, 1);
      for (const worker of state.workers.slice(0, 3)) worker.complete();
      await Promise.all(state.jobs.slice(0, 3));
      assert.equal(state.workers.filter(worker => !worker.terminated).length, 1);
      assert.equal(state.pool.state().active, 1, 'active worker must finish before retirement');
    } finally { await state.close(); }
  });
}

test('memory pressure retires excess warm workers during an otherwise idle pause', async t => {
  const state = fixture(t, 4);
  try {
    state.reading.busyCpus = 8;
    t.mock.timers.tick(1000);
    for (const worker of state.workers) worker.complete();
    await state.settled;
    assert.equal(state.pool.state().active, 0);
    assert.equal(state.pool.state().waiting, 0);
    state.reading.busyCpus = 1;
    state.reading.memoryPressure = 0.1;
    t.mock.timers.tick(1000);
    await Promise.resolve();
    assert.equal(state.workers.filter(worker => !worker.terminated).length, 1,
      'idle retained workers must still respond to a later memory-pressure sample');
  } finally { await state.close(); }
});

test('closing after CPU backoff retires warm idle workers and waits for active work', async t => {
  const state = fixture(t);
  try {
    state.reading.busyCpus = 8;
    t.mock.timers.tick(1000);
    state.workers[0].complete();
    state.workers[1].complete();
    await Promise.all(state.jobs.slice(0, 2));
    let closed = false;
    const closing = state.pool.close(new Error('cancel retained pool')).then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false, 'closing must wait for the two active process jobs');
    for (const worker of state.workers) if (worker.job) worker.complete();
    await Promise.all([state.settled, closing]);
    assert.ok(state.workers.every(worker => worker.terminated), 'shutdown must retire every retained process');
    assert.equal(state.pool.state().active, 0);
  } finally { await state.close(); }
});
