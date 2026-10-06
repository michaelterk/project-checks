import assert from 'node:assert/strict';
import { lstat, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { createSnapshot, createSnapshotContext } from '../src/inputs.mjs';
import { defaultIgnore, defaultDirectoryIgnore } from '../src/config.mjs';
import { restoreCoverageArtifact } from '../src/coverage-paths.mjs';
import { digest } from '../src/util.mjs';
import { put, temporary } from './helpers.mjs';

import { interceptReads } from './input-read-helpers.mjs';

const coverage = path => gzipSync(JSON.stringify([{ result: [{ url: path, functions: [] }] }]));

test('coverage sources share one read across concurrent units and input fingerprinting', async t => {
  const root = await temporary(t);
  const source = await put(root, 'source.mjs', 'export const value = 1;');
  const context = createSnapshotContext({ inputConcurrency: 4 });
  t.after(() => context.close());
  let reads = 0;
  interceptReads(t, (file, read) => { if (file === source) reads++; return read(); });
  const options = { provider: 'v8', root, sources: { 'source.mjs': digest('export const value = 1;') }, context };
  const outputs = await Promise.all(Array.from({ length: 12 }, () => restoreCoverageArtifact(coverage('source.mjs'), options)));
  outputs.forEach(bytes => assert.deepEqual(bytes, outputs[0]));
  assert.equal(reads, 1);
  const [identity] = await context.identify([source], { root, cacheDirectory: join(root, '.cache'), ignore: [] });
  assert.equal(identity[1], options.sources['source.mjs']);
  assert.equal(reads, 1, 'input hashing reuses the same verified digest');
});

test('fresh metadata invalidates same-size writes, deletion, recreation and symlink retargeting', async t => {
  const root = await temporary(t);
  const source = await put(root, 'source', 'first');
  const other = await put(root, 'other', 'other');
  const alias = join(root, 'alias');
  await symlink(source, alias);
  const context = createSnapshotContext();
  t.after(() => context.close());
  assert.equal(await context.sourceHash(alias), digest('first'));
  const before = await lstat(source);
  await writeFile(source, 'later');
  await utimes(source, before.atime, before.mtime);
  assert.equal(await context.sourceHash(source), digest('later'));
  await assert.rejects(restoreCoverageArtifact(coverage('source'), {
    provider: 'v8', root, sources: { source: digest('first') }, context,
  }), /Covered source changed/);
  await rm(source);
  assert.equal(await context.sourceHash(source), null);
  await writeFile(source, 'third');
  assert.equal(await context.sourceHash(source), digest('third'));
  await rm(alias);
  await symlink(other, alias);
  assert.equal(await context.sourceHash(alias), digest('other'));
});

test('failed reads are evicted and mutations during hashing cannot become trusted digests', async t => {
  const root = await temporary(t);
  const source = await put(root, 'source', 'first');
  const context = createSnapshotContext();
  t.after(() => context.close());
  let mode = 'fail';
  interceptReads(t, async (file, read) => {
    if (file !== source || mode === 'normal') return read();
    if (mode === 'fail') throw Object.assign(new Error('read rejected'), { code: 'EIO' });
    const result = await read();
    await writeFile(source, 'second');
    return result;
  });
  await assert.rejects(context.sourceHash(source), /read rejected/);
  assert.equal(context.digests.has(source), false);
  mode = 'mutate';
  await assert.rejects(context.sourceHash(source), /Input changed while hashing/);
  assert.equal(context.digests.has(source), false);
  mode = 'normal';
  assert.equal(await context.sourceHash(source), digest('second'));
});

test('cancellation rejects queued source reads and drains the active read before close', async t => {
  const root = await temporary(t);
  const source = await put(root, 'source', 'first');
  const controller = new AbortController();
  const context = createSnapshotContext({ inputConcurrency: 1, signal: controller.signal });
  t.after(() => context.close());
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  interceptReads(t, async (file, read) => {
    if (file === source) { entered.resolve(); await release.promise; }
    return read();
  });
  const reason = new Error('cancel source scan');
  const active = context.sourceHash(source);
  const activeRejection = assert.rejects(active, error => error === reason);
  await entered.promise;
  const queued = context.sourceHash(source);
  const queuedRejection = assert.rejects(queued, error => error === reason);
  controller.abort(reason);
  await queuedRejection;
  let closed = false;
  const closing = context.close().then(() => { closed = true; });
  assert.equal(closed, false);
  release.resolve();
  await Promise.all([activeRejection, closing]);
  assert.equal(closed, true);
  await assert.rejects(context.sourceHash(source), error => error === reason);
});

test('shared dependency records serialize once per generation and are fresh in the next', async t => {
  const root = await temporary(t);
  for (const name of ['a', 'b', 'c']) await put(root, `test/${name}.test.mjs`, '');
  const source = await put(root, 'source', 'first');
  const context = createSnapshotContext();
  t.after(() => context.close());
  const identify = context.identify;
  let serialized = 0;
  context.identify = async (paths, ...args) => {
    const values = await identify(paths, ...args);
    return values.map((identity, index) => {
      if (paths[index] !== source) return identity;
      const hash = identity[1];
      Object.defineProperty(identity, 1, { get() { serialized++; return hash; } });
      return identity;
    });
  };
  const snapshot = createSnapshot({ root, suite: 'records', testDirectory: 'test', pattern: '**/*.test.mjs', inputs: [],
    testInputs: () => ['source'], ignore: defaultIgnore, directoryIgnore: defaultDirectoryIgnore,
    cacheDirectory: join(root, '.cache') }, context);
  const first = await snapshot();
  assert.equal(serialized, 1);
  assert.deepEqual(await snapshot(), first);
  assert.equal(serialized, 2);
  await writeFile(source, 'second');
  assert.notDeepEqual(await snapshot(), first);
  assert.equal(serialized, 3);
});


test('each artifact validates at most eight sources concurrently', async t => {
  const root = await temporary(t);
  const sources = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`source-${i}`, 'expected']));
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let active = 0, peak = 0, calls = 0;
  const context = { sourceHash: async () => {
    calls++;
    peak = Math.max(peak, ++active);
    if (active === 8) entered.resolve();
    await release.promise;
    active--;
    return 'expected';
  } };
  const running = restoreCoverageArtifact(coverage('source-0'), { provider: 'v8', root, sources, context });
  await entered.promise;
  assert.equal(calls, 8);
  assert.equal(active, 8);
  release.resolve();
  await running;
  assert.equal(peak, 8);
  assert.equal(calls, 24);
  assert.equal(active, 0);
});

test('parallel artifacts retain the invocation-wide filesystem cap', async t => {
  const root = await temporary(t);
  const names = Array.from({ length: 24 }, (_, i) => `source-${i}`);
  await Promise.all(names.map(name => put(root, name, 'source')));
  const context = createSnapshotContext({ inputConcurrency: 3 });
  t.after(() => context.close());
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let active = 0, peak = 0;
  interceptReads(t, async (file, read) => {
    peak = Math.max(peak, ++active);
    if (active === 3) entered.resolve();
    try { await release.promise; return await read(); }
    finally { active--; }
  });
  const restore = subset => restoreCoverageArtifact(coverage(subset[0]), {
    provider: 'v8', root, sources: Object.fromEntries(subset.map(name => [name, digest('source')])), context,
  });
  const running = Promise.all([restore(names.slice(0, 12)), restore(names.slice(12))]);
  await entered.promise;
  assert.equal(active, 3);
  release.resolve();
  await running;
  assert.equal(peak, 3);
  assert.equal(active, 0);
});

for (const kind of ['mismatch', 'read error']) test(`parallel source ${kind} stops scheduling and drains active validations`, async t => {
  const root = await temporary(t);
  const sources = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`source-${i}`, 'expected']));
  const entered = Promise.withResolvers(), fail = Promise.withResolvers(), release = Promise.withResolvers();
  const error = new Error('source read failed');
  let calls = 0, active = 0, settled = false;
  const context = { sourceHash: async file => {
    calls++;
    if (++active === 8) entered.resolve();
    try {
      if (file === join(root, 'source-0')) {
        await fail.promise;
        if (kind === 'read error') throw error;
        return 'changed';
      }
      await release.promise;
      return 'expected';
    } finally { active--; }
  } };
  const running = restoreCoverageArtifact(coverage('source-0'), { provider: 'v8', root, sources, context })
    .finally(() => { settled = true; });
  const rejected = assert.rejects(running, kind === 'read error' ? cause => cause === error : /Covered source changed: source-0/);
  await entered.promise;
  fail.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(calls, 8);
  assert.equal(active, 7);
  release.resolve();
  await rejected;
  assert.equal(calls, 8);
  assert.equal(active, 0);
});

test('aborting an artifact drains its active source reads and preserves the abort reason', async t => {
  const root = await temporary(t);
  const names = Array.from({ length: 16 }, (_, i) => `source-${i}`);
  await Promise.all(names.map(name => put(root, name, 'source')));
  const controller = new AbortController();
  const context = createSnapshotContext({ inputConcurrency: 2, signal: controller.signal });
  t.after(() => context.close());
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let active = 0, reads = 0, settled = false;
  interceptReads(t, async (file, read) => {
    reads++;
    if (++active === 2) entered.resolve();
    try { await release.promise; return await read(); }
    finally { active--; }
  });
  const reason = new Error('cancel coverage restoration');
  const running = restoreCoverageArtifact(coverage(names[0]), {
    provider: 'v8', root, sources: Object.fromEntries(names.map(name => [name, digest('source')])), context,
  }).finally(() => { settled = true; });
  const rejected = assert.rejects(running, error => error === reason);
  await entered.promise;
  controller.abort(reason);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release.resolve();
  await rejected;
  assert.equal(reads, 2);
  assert.equal(active, 0);
});
