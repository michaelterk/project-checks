import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chmod, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join, matchesGlob, relative, resolve } from 'node:path';
import test from 'node:test';
import { contentFingerprint, createSnapshot, createSnapshotContext } from '../src/inputs.mjs';
import { digest } from '../src/util.mjs';
import { interceptReads } from './input-read-helpers.mjs';
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

test('sorted identities ignore permissions and retain external symlink contents and ancestor cycles', async t => {
  const config = await fixture(t);
  await put(config.root, 'src/b', 'b');
  const a = await put(config.root, 'src/a', 'a');
  const external = await temporary(t);
  const target = await put(external, 'input', 'outside');
  const directory = join(config.root, 'src');
  await symlink(directory, join(directory, 'cycle'));
  await symlink(target, join(directory, 'external'));
  const entries = [
    ['a', ['file', digest('a')]],
    ['b', ['file', digest('b')]],
    ['cycle', ['symlink', directory, ['cycle', directory]]],
    ['external', ['symlink', target, ['file', digest('outside')]]],
  ];
  const snapshot = createSnapshot(config, createSnapshotContext());
  t.after(() => snapshot.close());
  const before = await snapshot();
  assert.equal(before.common, contentFingerprint([['directory', entries]]));
  assert.deepEqual(await snapshot(), before);
  await chmod(a, 0o600);
  await chmod(target, 0o600);
  await chmod(join(config.root, 'test/a.test.mjs'), 0o600);
  assert.deepEqual(await snapshot(), before);
  await writeFile(target, 'changed');
  const changed = await snapshot();
  await rm(join(directory, 'external'));
  await symlink(a, join(directory, 'external'));
  assert.notEqual((await snapshot()).common, changed.common);
});

for (const mode of ['relative', 'absolute']) {
  test(`dangling ${mode} symlinks retain missing inputs and detect target changes`, async t => {
    const config = await fixture(t);
    await put(config.root, 'src/stable', 'stable');
    const target = join(config.root, 'optional/input');
    const link = join(config.root, 'src/optional-link');
    const linkTarget = mode === 'relative' ? '../optional/input' : target;
    await symlink(linkTarget, link);
    const context = createSnapshotContext();
    const snapshot = createSnapshot(config, context);
    t.after(() => context.close());

    assert.deepEqual(await context.identify([link], { ...config, allowMissing: true }), [
      ['symlink', linkTarget, ['missing']],
    ]);
    const missing = await snapshot();
    assert.deepEqual(await snapshot(), missing);
    await put(config.root, 'optional/input', 'first');
    const present = await snapshot();
    assert.notEqual(present.common, missing.common);
    await writeFile(target, 'second');
    assert.notEqual((await snapshot()).common, present.common);
    await rm(target);
    assert.deepEqual(await snapshot(), missing);
    await assert.rejects(context.identify([link], config), { code: 'ENOENT' });
  });
}

test('concurrent factories share digest reads, recheck metadata and retry failed hashes', async t => {
  const config = await fixture(t);
  for (let i = 0; i < 16; i++) await put(config.root, `src/${i}`, 'input');
  const context = createSnapshotContext();
  const first = createSnapshot(config, context);
  const second = createSnapshot(config, context);
  const reads = new Map();
  let active = 0;
  let peak = 0;
  let mutate;
  interceptReads(t, async (file, read) => {
    reads.set(file, (reads.get(file) ?? 0) + 1);
    peak = Math.max(peak, ++active);
    try {
      const result = await read();
      if (file === mutate) { fs.appendFileSync(file, 'mutation'); mutate = undefined; }
      return result;
    } finally { active--; }
  });
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
  const snapshot = createSnapshot(config, context);
  let release;
  let reached;
  const blocked = new Promise(resolve => { reached = resolve; });
  const finish = new Promise(resolve => { release = resolve; });
  let reads = 0;
  interceptReads(t, async (path, read) => {
    if (path !== file || ++reads !== 1) return read();
    const result = await read();
    reached();
    await finish;
    return result;
  });
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
  const snapshot = createSnapshot(config, context);
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


test('validity contains only existence and content hashes across paths and runtime metadata', async t => {
  const config = await fixture(t);
  const file = await put(config.root, 'src/first', 'same bytes');
  await put(config.root, 'src/second', 'other bytes');
  config.testFixtureInputs = () => [join(config.root, 'optional')];
  const snapshot = createSnapshot(config);
  t.after(() => snapshot.close());
  const before = await snapshot();
  await chmod(file, 0o700);
  await utimes(file, new Date(0), new Date(0));
  await rename(file, join(config.root, 'src/z-renamed'));
  await rename(join(config.root, 'src'), join(config.root, 'renamed-directory'));
  config.inputs = ['renamed-directory'];
  assert.deepEqual(await snapshot(), before);
  await put(config.root, 'optional', '');
  const present = await snapshot();
  assert.notEqual(present.units['test/a.test.mjs'], before.units['test/a.test.mjs']);
  await rm(join(config.root, 'optional'));
  assert.deepEqual(await snapshot(), before);
  await put(config.root, 'renamed-directory/duplicate', 'same bytes');
  assert.notEqual((await snapshot()).common, before.common);
  await rm(join(config.root, 'renamed-directory/duplicate'));
  assert.deepEqual(await snapshot(), before);
  await put(config.root, 'renamed-directory/z-renamed', 'changed bytes');
  assert.notEqual((await snapshot()).common, before.common);
});

test('ancestor symlink cycles contribute existence without their names or targets', async t => {
  const config = await fixture(t);
  await put(config.root, 'src/input', 'content');
  const snapshot = createSnapshot(config);
  t.after(() => snapshot.close());
  const before = await snapshot();
  await symlink(join(config.root, 'src'), join(config.root, 'src/cycle'));
  const present = await snapshot();
  assert.notEqual(present.common, before.common);
  await rename(join(config.root, 'src/cycle'), join(config.root, 'src/renamed'));
  assert.deepEqual(await snapshot(), present);
  await rm(join(config.root, 'src/renamed'));
  assert.deepEqual(await snapshot(), before);
});


test('directory policies prune incidental folders and files while explicit dependency and output roots remain bound', async t => {
  const config = await fixture(t);
  const directories = ['.venv', 'test-cache', '.test-cache', 'node_modules', '.coverage', '.data', 'tmp', 'output', 'stage', '.local', '.astro', 'temp', 'dist', 'runtime'];
  config.inputs = ['.'];
  config.directoryIgnore = { directories: directories.map(name => `**/${name}`), files: ['**/.gitignore', '**/*.[mM][dD]', '**/.env', '**/.env.*'] };
  await put(config.root, 'src/module.mjs', 'source');
  const snapshot = createSnapshot(config);
  t.after(() => snapshot.close());
  const before = await snapshot();
  for (const directory of directories) await put(config.root, `${directory}/ignored.bin`, 'incidental');
  for (const file of ['README.md', 'NOTES.MD', '.gitignore', '.env', '.env.local']) await put(config.root, file, 'incidental');
  assert.deepEqual(await snapshot(), before);
  await put(config.root, 'src/template.mjs', 'meaningful');
  assert.notDeepEqual(await snapshot(), before, 'directory names are not substring matches');

  const dependency = await put(config.root, 'node_modules/example/index.mjs', 'dependency');
  const nested = await put(config.root, 'node_modules/example/node_modules/nested/index.mjs', 'nested dependency');
  const output = await put(config.root, 'dist/server/entry.mjs', 'built output');
  const packageBuild = await put(config.root, 'node_modules/example/dist/esm/index.mjs', 'actual runtime entrypoint');
  const packageData = await put(config.root, 'node_modules/example/runtime/data.bin', 'meaningful runtime data');
  config.inputs.push('node_modules/example', 'dist/server');
  const selected = createSnapshot(config);
  t.after(() => selected.close());
  for (const file of [dependency, nested, output, packageBuild, packageData]) {
    const before = await selected();
    await writeFile(file, 'changed meaningful bytes');
    assert.notDeepEqual(await selected(), before, file);
  }
  const markdown = await selected();
  await put(config.root, 'node_modules/example/README.md', 'new documentation');
  assert.deepEqual(await selected(), markdown, 'unrelated directory rules still apply inside an explicit package');
});

test('directory policies leave test discovery and external fixture binding unchanged', async t => {
  const config = await fixture(t);
  config.directoryIgnore = { directories: ['**/test', '**/runtime'] };
  const runtime = await temporary(t);
  const input = await put(runtime, 'runtime/input.bin', 'fixture');
  config.inputs = [];
  config.testFixtureInputs = () => [runtime];
  const snapshot = createSnapshot(config);
  t.after(() => snapshot.close());
  const before = await snapshot();
  assert.deepEqual(Object.keys(before.units), ['test/a.test.mjs']);
  await writeFile(input, 'changed fixture');
  assert.notDeepEqual(await snapshot(), before);
});


test('packaged JSON directory defaults apply to raw snapshots and explicit overrides replace them', async t => {
  const config = await fixture(t);
  const file = await put(config.root, 'src/node_modules/package/index.mjs', 'first');
  const defaults = createSnapshot(config);
  t.after(() => defaults.close());
  const before = await defaults();
  await writeFile(file, 'changed dependency');
  assert.deepEqual(await defaults(), before);
  const explicit = createSnapshot({ ...config, directoryIgnore: {} });
  t.after(() => explicit.close());
  const bound = await explicit();
  await writeFile(file, 'another dependency');
  assert.notDeepEqual(await explicit(), bound);
});
