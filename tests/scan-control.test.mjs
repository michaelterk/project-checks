import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createHashPool } from '../src/input-hash-pool.mjs';

test('ready cache comparisons pass queued input work without exceeding scanner admission', async t => {
  let worker;
  class Fake extends EventEmitter {
    postMessage(message) { this.jobs = message.jobs; }
    complete() {
      const jobs = this.jobs; this.jobs = undefined;
      this.emit('message', { results: jobs.map(({ id }) => ({ id, hash: 'digest', metrics: {} })), done: true });
    }
    async terminate() { this.emit('exit', 0); }
  }
  const pool = createHashPool({ workers: 1, createWorker: () => worker = new Fake() });
  const first = pool.hash('first', 'identity');
  const pending = Array.from({ length: 20 }, (_, id) => pool.hash(`pending-${id}`, 'identity'));
  const order = [];
  const controls = [1, 2].map(id => pool.run(() => {
    assert.equal(pool.state().active, 1);
    order.push(id);
  }, { priority: true }));
  const drained = Promise.allSettled([...pending, ...controls]);
  t.after(async () => {
    const closing = pool.close();
    if (worker.jobs) worker.complete();
    await Promise.all([closing, drained]);
  });
  worker.complete();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, [1, 2], 'completed inputs must not wait for every unrelated input task');
  assert.equal(pool.state().active, 1, 'remaining input work retains the same bound');
});
