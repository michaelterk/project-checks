import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chmod, lstat, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, matchesGlob, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createSnapshot, createSnapshotContext } from '../src/inputs.mjs';
import { digest } from '../src/util.mjs';
import { put, temporary } from './helpers.mjs';

async function fixture(t) {
  const root = await temporary(t);
  await put(root, 'test/a.test.mjs', 'test');
  return { root, testDirectory: 'test', pattern: '*.test.mjs', inputs: ['src'], ignore: [], cacheDirectory: join(root, '.test-cache') };
}

test('bounded context releases failed work and admits at most eight operations', async () => {
  const context = createSnapshotContext();
  let active = 0;
  let peak = 0;
  const release = [];
  const jobs = Array.from({ length: 16 }, (_, i) => context.run(async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => release.push(resolve));
    active--;
    if (i === 0) throw new Error('fixture failure');
    return i;
  }));
  const settled = Promise.allSettled(jobs);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(release.length, 8);
  release.splice(0).forEach(resolve => resolve());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(release.length, 8);
  release.splice(0).forEach(resolve => resolve());
  const results = await settled;
  assert.equal(peak, 8);
  assert.equal(results[0].status, 'rejected');
  assert.equal(await context.run(() => 17), 17);
});

test('sorted identities retain modes, external symlink contents and ancestor cycles', async t => {
  const config = await fixture(t);
  const b = await put(config.root, 'src/b', 'b');
  const a = await put(config.root, 'src/a', 'a');
  const external = await temporary(t);
  const target = await put(external, 'input', 'outside');
  const directory = join(config.root, 'src');
  await symlink(directory, join(directory, 'cycle'));
  await symlink(target, join(directory, 'external'));
  const mode = async file => Number((await lstat(file)).mode & 0o777);
  const entries = [
    ['a', ['file', await mode(a), digest('a')]],
    ['b', ['file', await mode(b), digest('b')]],
    ['cycle', ['symlink', directory, ['cycle', directory]]],
    ['external', ['symlink', target, ['file', await mode(target), digest('outside')]]],
  ];
  const snapshot = createSnapshot(config, () => 'implementation', createSnapshotContext());
  t.after(() => snapshot.close());
  const before = await snapshot();
  assert.equal(before.common, digest(JSON.stringify([config.root, 'implementation', [['src', ['directory', entries]]], null])));
  assert.deepEqual(await snapshot(), before);
  await chmod(a, 0o600);
  assert.notEqual((await snapshot()).common, before.common);
  await writeFile(target, 'changed');
  const changed = await snapshot();
  await rm(join(directory, 'external'));
  await symlink(a, join(directory, 'external'));
  assert.notEqual((await snapshot()).common, changed.common);
});

test('concurrent factories share digest reads, recheck metadata and retry failed hashes', async t => {
  const config = await fixture(t);
  for (let i = 0; i < 16; i++) await put(config.root, `src/${i}`, 'input');
  const context = createSnapshotContext();
  const first = createSnapshot(config, () => 'implementation', context);
  const second = createSnapshot(config, () => 'implementation', context);
  const original = fs.createReadStream;
  const reads = new Map();
  let active = 0;
  let peak = 0;
  let mutate;
  fs.createReadStream = function (file, ...args) {
    reads.set(file, (reads.get(file) ?? 0) + 1);
    peak = Math.max(peak, ++active);
    const stream = original(file, ...args);
    stream.once('close', () => active--);
    if (file === mutate) stream.once('data', () => { fs.appendFileSync(file, 'mutation'); mutate = undefined; });
    return stream;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.createReadStream = original; syncBuiltinESMExports(); });
  const [left, right] = await Promise.all([first(), second()]);
  assert.deepEqual(left, right);
  assert.ok(peak <= 8 && peak > 1);
  assert.equal(reads.size, 17);
  assert.ok([...reads.values()].every(count => count === 1));
  assert.deepEqual(await second(), left);
  assert.ok([...reads.values()].every(count => count === 1));
  mutate = join(config.root, 'src/0');
  await writeFile(mutate, 'new contents');
  await assert.rejects(first(), /Input changed while hashing/);
  assert.equal(context.digests.has(join(config.root, 'src/0')), false);
  assert.notEqual((await second()).common, left.common);
  assert.equal(reads.get(join(config.root, 'src/0')), 3);
});


test('a failed older hash cannot overwrite or delete a newer metadata generation', async t => {
  const config = await fixture(t);
  const file = await put(config.root, 'src/input', 'old contents');
  const context = createSnapshotContext();
  const snapshot = createSnapshot(config, () => 'implementation', context);
  const original = fs.createReadStream;
  let release;
  let reached;
  const blocked = new Promise(resolve => { reached = resolve; });
  const finish = new Promise(resolve => { release = resolve; });
  let reads = 0;
  fs.createReadStream = function (path, ...args) {
    if (path !== file || ++reads !== 1) return original(path, ...args);
    const contents = fs.readFileSync(path);
    return Readable.from((async function* () { yield contents; reached(); await finish; })());
  };
  syncBuiltinESMExports();
  t.after(() => { fs.createReadStream = original; syncBuiltinESMExports(); });
  const old = assert.rejects(snapshot(), /Input changed while hashing/);
  await blocked;
  await writeFile(file, 'new contents');
  const updated = await snapshot();
  const newer = context.digests.get(file);
  release();
  await old;
  assert.equal(context.digests.get(file), newer);
  assert.deepEqual(await snapshot(), updated);
  assert.equal(reads, 2);
});


test('cached exclusion rules still detect new paths and changed ignore lists', async t => {
  const config = await fixture(t);
  await put(config.root, 'src/first', 'first');
  const context = createSnapshotContext();
  const snapshot = createSnapshot(config, () => 'implementation', context);
  const first = await snapshot();
  const rules = context.exclusions.values().next().value;
  assert.deepEqual(await snapshot(), first);
  assert.equal(context.exclusions.values().next().value, rules);
  await put(config.root, 'src/new', 'new');
  assert.notEqual((await snapshot()).common, first.common);
  config.ignore.push('src/new');
  assert.deepEqual(await snapshot(), first);
  assert.equal(context.exclusions.size, 2);
});


test('canonical literal exclusions retain native glob behavior for noncanonical patterns', async t => {
  const config = await fixture(t);
  const context = createSnapshotContext();
  for (const pattern of ['deploy/test-all.mjs', './deploy/test-all.mjs', 'deploy/../deploy/test-all.mjs',
                         'src/', 'src/[ab]', '**/a', 'x(y)', 'star*', 'src\\a']) {
    config.ignore = [pattern];
    const exclude = context.excluded(config);
    for (const name of ['deploy/test-all.mjs', 'src/a', 'src/b', 'star-value', 'x(y)', 'other']) {
      const file = resolve(config.root, name);
      assert.equal(exclude(file), matchesGlob(relative(config.root, file), pattern), `${pattern}: ${name}`);
    }
  }
  await context.close();
});


test('active cancellation preserves its reason and drains active input work', async () => {
  const controller = new AbortController();
  const context = createSnapshotContext({ signal: controller.signal });
  let started;
  let release;
  const reached = new Promise(resolve => { started = resolve; });
  const finish = new Promise(resolve => { release = resolve; });
  const work = context.run(async () => { started(); await finish; return 17; });
  await reached;
  const reason = new Error('fixture abort');
  const rejection = assert.rejects(work, error => error === reason);
  controller.abort(reason);
  release();
  await rejection;
  await context.close();
  await assert.rejects(context.run(() => 0), error => error === reason);
});

test('missing roots drain active work without poisoning the context', async t => {
  const config = await fixture(t);
  await put(config.root, 'src/package/input', 'input');
  const context = createSnapshotContext();
  try {
    await assert.rejects(context.identify([join(config.root, 'src'), join(config.root, 'missing')], config), /ENOENT/);
    assert.equal((await context.identify([join(config.root, 'src')], config))[0][0], 'directory');
  } finally { await context.close(); }
});
