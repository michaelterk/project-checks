import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lstat, utimes } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { hashInputSync, inputMetadata } from '../src/input-hash-sync.mjs';
import { digest } from '../src/util.mjs';
import { put, temporary } from './helpers.mjs';

function intercept(t, name, operation) {
  const original = fs[name];
  fs[name] = (...args) => operation(original, ...args);
  syncBuiltinESMExports();
  t.after(() => { fs[name] = original; syncBuiltinESMExports(); });
}

test('worker reader hashes empty, small and large files with one bounded buffer and EOF proof', async t => {
  const root = await temporary(t), buffer = Buffer.alloc(65536);
  let closed = 0;
  intercept(t, 'readSync', (read, descriptor, supplied, ...args) => {
    assert.equal(supplied, buffer);
    return read(descriptor, supplied, ...args);
  });
  intercept(t, 'closeSync', (close, descriptor) => { closed++; return close(descriptor); });
  for (const size of [0, 1, 65536, 65537, 131072]) {
    const bytes = Buffer.alloc(size, size % 251), file = await put(root, `size-${size}`, bytes);
    const metadata = inputMetadata(await lstat(file, { bigint: true }));
    assert.equal(hashInputSync(file, metadata, buffer), digest(bytes));
  }
  assert.equal(closed, 5);
});

test('short successful reads consume every byte and confirm EOF', async t => {
  const root = await temporary(t), file = await put(root, 'source', '1234567890');
  let calls = 0;
  intercept(t, 'readSync', (read, descriptor, buffer, offset, length, position) => {
    calls++; return read(descriptor, buffer, offset, Math.min(length, 3), position);
  });
  assert.equal(hashInputSync(file, inputMetadata(await lstat(file, { bigint: true })), Buffer.alloc(65536)), digest('1234567890'));
  assert.equal(calls, 5);
});

for (const change of ['growth', 'shrink', 'same-size']) test(`post-read metadata rejects ${change} during hashing`, async t => {
  const root = await temporary(t), file = await put(root, 'source', 'first');
  await utimes(file, new Date(0), new Date(0));
  const identity = inputMetadata(await lstat(file, { bigint: true }));
  let mutate = true, closed = 0;
  intercept(t, 'readSync', (read, ...args) => {
    const bytes = read(...args);
    if (mutate) { mutate = false; fs.writeFileSync(file, change === 'growth' ? 'longer contents' : change === 'shrink' ? 'x' : 'later'); }
    return bytes;
  });
  intercept(t, 'closeSync', (close, descriptor) => { closed++; return close(descriptor); });
  assert.throws(() => hashInputSync(file, identity, Buffer.alloc(65536)), /Input changed while hashing/);
  assert.equal(closed, 1);
});

test('close errors cannot replace the original read error', async t => {
  const root = await temporary(t), file = await put(root, 'source', 'first');
  const error = new Error('original read failure');
  intercept(t, 'readSync', () => { throw error; });
  intercept(t, 'closeSync', (close, descriptor) => { close(descriptor); throw Error('secondary close failure'); });
  const identity = inputMetadata(await lstat(file, { bigint: true }));
  assert.throws(() => hashInputSync(file, identity, Buffer.alloc(65536)), cause => cause === error);
});

for (const size of [0, 1]) test(`virtual readable bytes exceeding reported size${size} are retained`, async t => {
  const root = await temporary(t), file = await put(root, 'virtual', Buffer.alloc(size));
  const bytes = Buffer.from('virtual bytes'), buffer = Buffer.alloc(65536);
  let offset = 0;
  intercept(t, 'readSync', (read, descriptor, supplied) => {
    assert.equal(supplied, buffer);
    const length = Math.min(supplied.length, bytes.length - offset);
    bytes.copy(supplied, 0, offset, offset + length); offset += length;
    return length;
  });
  assert.equal(hashInputSync(file, inputMetadata(await lstat(file, { bigint: true })), buffer), digest(bytes));
});
