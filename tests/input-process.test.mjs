import assert from 'node:assert/strict';
import children from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { createHashPool } from '../src/input-hash-pool.mjs';
import { createInputProcess } from '../src/input-process.mjs';

function poolFixture() {
  const children = [], messages = [];
  const pool = createHashPool({ workers: 2, createWorker: () => {
    const child = createInputProcess();
    const post = child.postMessage;
    child.postMessage = message => { messages.push(message); return post(message); };
    children.push(child);
    return child;
  } });
  return { pool, children, messages };
}

test('directory validation runs in separate processes and preserves logical and physical exclusions', async () => {
  const { pool, children, messages } = poolFixture();
  const config = { root: '/project', cacheDirectory: '/project/cache', ignore: ['**/*.tmp'],
    directoryIgnore: { directories: ['**/node_modules'], files: ['**/*.md'] } };
  const filter = { file: '/elsewhere/installed', logical: '/project/node_modules/runtime',
    root: '/project/node_modules/runtime', config,
    names: ['README.md', 'keep.js', 'physical.js', 'scratch.tmp', 'test.js'],
    excludedFiles: ['/elsewhere/installed/physical.js', '/project/node_modules/runtime/test.js'] };
  try {
    const pending = [pool.filterDirectory(filter), pool.filterDirectory(filter)];
    assert.equal(children.length, 2);
    assert.equal(new Set(children.map(child => child.pid)).size, 2);
    assert.ok(children.every(child => child.pid !== process.pid));
    assert.deepEqual(await Promise.all(pending), [['keep.js'], ['keep.js']]);
    assert.deepEqual(await Promise.all([pool.filterDirectory(filter), pool.filterDirectory(filter)]), [['keep.js'], ['keep.js']]);
    assert.equal(messages.flatMap(message => message.policies ?? []).length, 2,
      'each process receives the shared policy only once');
    assert.ok(messages.flatMap(message => message.jobs).every(job => !job.filter.config && !job.filter.excludedFiles));
    assert.deepEqual(await pool.filterDirectory({ ...filter, excludedFiles: [] }), ['keep.js', 'physical.js', 'test.js']);
    assert.deepEqual(await pool.filterDirectory(filter), ['keep.js'], 'a newer policy does not overwrite an older snapshot policy');
  } finally { await pool.close(); }
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
});

test('closing active validation processes drains their exits and preserves the cancellation reason', async () => {
  const { pool, children } = poolFixture();
  const reason = new Error('cancel process validation');
  const pending = pool.inspect('/not-started-yet');
  const rejected = assert.rejects(pending, error => error === reason);
  await Promise.all([rejected, pool.close(reason)]);
  assert.equal(children.length, 1);
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
});

test('a failed process spawn closes without waiting for an exit event', async t => {
  const failure = Object.assign(new Error('process resources exhausted'), { code: 'EAGAIN' });
  let closed = false;
  t.mock.method(children, 'fork', () => {
    const child = new EventEmitter();
    child.exitCode = child.signalCode = null;
    child.ref = child.unref = () => {};
    child.kill = () => false;
    child.send = (message, callback) => { queueMicrotask(() => callback(failure)); };
    queueMicrotask(() => { child.emit('error', failure); closed = true; child.emit('close', null); });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const pool = createHashPool({ workers: 1 });
  await assert.rejects(pool.inspect('/not-started'), error => error === failure);
  await pool.close();
  assert.equal(closed, true);
});
