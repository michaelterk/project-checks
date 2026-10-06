import assert from 'node:assert/strict';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createSnapshotContext } from '../src/inputs.mjs';
import { digest } from '../src/util.mjs';
import { put, temporary } from './helpers.mjs';

function handles(t, wrap) {
  const original = promises.open;
  promises.open = async (file, ...args) => wrap(file, await original(file, ...args));
  syncBuiltinESMExports();
  t.after(() => { promises.open = original; syncBuiltinESMExports(); });
}

test('empty, bounded and stream readers produce identical hashes without excess reads or buffers', async t => {
  const root = await temporary(t), context = createSnapshotContext();
  t.after(() => context.close());
  const files = new Map();
  for (const size of [0, 1, 65536, 65537]) files.set(await put(root, `source-${size}`, Buffer.alloc(size, size % 251)), size);
  const sizes = [], reads = new Map(), closed = new Map();
  handles(t, (file, handle) => ({
    async read(buffer, ...args) {
      sizes.push(buffer.length);
      reads.set(file, (reads.get(file) ?? 0) + 1);
      return handle.read(buffer, ...args);
    },
    async close() { closed.set(file, (closed.get(file) ?? 0) + 1); await handle.close(); },
  }));
  const original = fs.createReadStream;
  let streams = 0;
  fs.createReadStream = (...args) => { streams++; return original(...args); };
  syncBuiltinESMExports();
  t.after(() => { fs.createReadStream = original; syncBuiltinESMExports(); });
  for (const [file, size] of files) {
    const values = await Promise.all([context.sourceHash(file), context.sourceHash(file)]);
    values.forEach(hash => assert.equal(hash, digest(Buffer.alloc(size, size % 251))));
    assert.equal(reads.get(file) ?? 0, size > 0 && size <= 65536 ? 2 : 0);
    assert.equal(closed.get(file) ?? 0, size > 0 && size <= 65536 ? 1 : 0);
  }
  assert.deepEqual(sizes, [1, 1, 65536, 65536]);
  assert.equal(streams, 2);
});

test('short successful reads hash every byte and confirm EOF with bounded buffers', async t => {
  const root = await temporary(t), file = await put(root, 'source', '1234567890');
  const context = createSnapshotContext();
  t.after(() => context.close());
  let calls = 0, closed = 0;
  handles(t, (_, handle) => ({
    read(buffer, offset, length, position) { calls++; return handle.read(buffer, offset, Math.min(length, 3), position); },
    async close() { closed++; await handle.close(); },
  }));
  assert.equal(await context.sourceHash(file), digest('1234567890'));
  assert.equal(calls, 5);
  assert.equal(closed, 1);
});

for (const change of ['growth', 'shrink', 'same-size']) test(`bounded reads reject ${change} during hashing`, async t => {
  const root = await temporary(t), file = await put(root, 'source', 'first');
  // Make the rewrite observable even within one filesystem clock tick.
  if (change === 'same-size') await promises.utimes(file, new Date(0), new Date(0));
  const context = createSnapshotContext();
  t.after(() => context.close());
  let mutate = true, closed = 0;
  handles(t, (_, handle) => ({
    async read(...args) {
      const result = await handle.read(...args);
      if (mutate) { mutate = false; await writeFile(file, change === 'growth' ? 'longer contents' : change === 'shrink' ? 'x' : 'later'); }
      return result;
    },
    async close() { closed++; await handle.close(); },
  }));
  await assert.rejects(context.sourceHash(file), error => error.message.includes('Input changed while hashing') && error.message.includes(file));
  assert.equal(context.digests.has(file), false);
  assert.equal(closed, 1);
  assert.equal(await context.sourceHash(file), digest(change === 'growth' ? 'longer contents' : change === 'shrink' ? 'x' : 'later'));
});

test('premature EOF fails with its path, closes the handle and permits a fresh retry', async t => {
  const root = await temporary(t), file = await put(root, 'source', 'first');
  const context = createSnapshotContext();
  t.after(() => context.close());
  let fail = true, closed = 0;
  handles(t, (_, handle) => ({
    async read(...args) { if (fail) { fail = false; await writeFile(file, ''); } return handle.read(...args); },
    async close() { closed++; await handle.close(); },
  }));
  await assert.rejects(context.sourceHash(file), error => error.message.includes(file) && /Input changed while hashing/.test(error.message));
  assert.equal(closed, 1);
  assert.equal(context.digests.has(file), false);
  await writeFile(file, 'first');
  assert.equal(await context.sourceHash(file), digest('first'));
});

test('handle close errors cannot replace the original read error or retain failed digests', async t => {
  const root = await temporary(t), file = await put(root, 'source', 'first');
  const context = createSnapshotContext();
  t.after(() => context.close());
  const readError = new Error('original read failed'), closeError = new Error('close failed');
  let failRead = true, closed = 0;
  handles(t, (_, handle) => ({
    read(...args) { if (failRead) throw readError; return handle.read(...args); },
    async close() { closed++; await handle.close(); throw closeError; },
  }));
  await assert.rejects(context.sourceHash(file), error => error === readError);
  assert.equal(context.digests.has(file), false);
  failRead = false;
  await assert.rejects(context.sourceHash(file), error => error === closeError);
  assert.equal(context.digests.has(file), false);
  assert.equal(closed, 2);
});


test('zero-size virtual regular files retain the actual readable-byte digest', async t => {
  const root = await temporary(t), file = await put(root, 'virtual', '');
  const context = createSnapshotContext();
  t.after(() => context.close());
  const original = fs.createReadStream;
  fs.createReadStream = path => path === file ? Readable.from([Buffer.from('virtual bytes')]) : original(path);
  syncBuiltinESMExports();
  t.after(() => { fs.createReadStream = original; syncBuiltinESMExports(); });
  assert.equal(await context.sourceHash(file), digest('virtual bytes'));
});

test('bounded reader hashes bytes beyond a virtual file reported size without growing its buffer', async t => {
  const root = await temporary(t), file = await put(root, 'virtual', 'x');
  const context = createSnapshotContext();
  t.after(() => context.close());
  const contents = Buffer.from('virtual bytes');
  let offset = 0;
  handles(t, (_, handle) => ({
    read(buffer) {
      assert.equal(buffer.length, 1);
      const bytesRead = Math.min(buffer.length, contents.length - offset);
      contents.copy(buffer, 0, offset, offset + bytesRead);
      offset += bytesRead;
      return { bytesRead };
    },
    close: () => handle.close(),
  }));
  assert.equal(await context.sourceHash(file), digest(contents));
});
