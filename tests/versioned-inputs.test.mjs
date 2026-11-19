import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createSnapshot, createSnapshotContext } from '../src/inputs.mjs';
import { put, temporary } from './helpers.mjs';
import { interceptReads } from './input-read-helpers.mjs';

test('installed package selections trust versions, including aliases, nested installations and explicit leaves', async t => {
  const root = await temporary(t);
  await put(root, 'test/a.test.mjs', 'source');
  const pkg = 'node_modules/@scope/alias';
  const nested = pkg + '/node_modules/child';
  const manifest = (dir, name, version) => put(root, dir + '/package.json', JSON.stringify({ name, version }));
  await manifest(pkg, 'published-name', '1');
  await manifest(nested, 'child', '1');
  const payload = await put(root, pkg + '/lib/loaded.js', 'payload');
  const nestedPayload = await put(root, nested + '/loaded.js', 'nested payload');
  await put(root, pkg + '/node_modules/.bin/stub', 'generated launcher');
  const reads = [];
  interceptReads(t, (file, read) => { reads.push(file); return read(); });
  const context = createSnapshotContext();
  t.after(() => context.close());
  const config = { root, testDirectory: 'test', pattern: '*.test.mjs', inputs: [pkg], ignore: [],
    testInputs: { 'test/a.test.mjs': [pkg + '/lib/loaded.js'] }, cacheDirectory: join(root, '.test-cache') };
  const trusted = createSnapshot({ ...config, trustPackageVersions: true }, context);
  const ordinary = createSnapshot(config, context);
  context.beginScanGeneration();
  const first = await trusted();
  assert.ok(!reads.includes(payload) && !reads.includes(nestedPayload));
  assert.ok(!reads.includes(join(root, pkg, 'node_modules/.bin/stub')));
  const raw = await ordinary();
  await context.finishScanGeneration();
  assert.ok(reads.includes(payload) && reads.includes(nestedPayload));
  await writeFile(payload, 'same package version');
  assert.deepEqual(await trusted(), first);
  assert.notDeepEqual(await ordinary(), raw);
  await manifest(nested, 'child', '2');
  const next = await trusted();
  assert.notEqual(next.common, first.common);
  assert.deepEqual(next.units, first.units);
  await manifest(pkg, 'different-published-name', '1');
  assert.notDeepEqual((await trusted()).units, next.units);
  const overlapping = createSnapshot({ ...config, trustPackageVersions: true, inputs: [pkg, pkg + '/lib/loaded.js'] }, context);
  const withLeaf = await overlapping();
  await rm(payload);
  assert.notEqual((await overlapping()).common, withLeaf.common);
  const removed = await trusted();
  await put(root, pkg + '/lib/loaded.js', 'restored');
  assert.notDeepEqual((await trusted()).units, removed.units);
  const workspace = await put(root, 'workspace/package.json', '{"name":"workspace","version":"1"}');
  await symlink(join(root, 'workspace'), join(root, 'node_modules/workspace'));
  const local = createSnapshot({ ...config, inputs: ['node_modules/workspace'], trustPackageVersions: true }, context);
  const linked = await local();
  await put(root, 'workspace/source.js', 'edit');
  assert.notEqual((await local()).common, linked.common);
  assert.ok(reads.includes(workspace));
});

test('a versioned executable follows version and presence while ordinary inputs retain byte evidence', async t => {
  const root = await temporary(t), runtime = await temporary(t);
  const testFile = await put(root, 'test/a.test.mjs', 'source');
  const binary = await put(runtime, 'browser', 'payload');
  let version = 'browser-1';
  const context = createSnapshotContext({ local: true });
  t.after(() => context.close());
  const snapshot = createSnapshot({ root, testDirectory: 'test', pattern: '*.test.mjs', inputs: [], ignore: [],
    testFixtureInputs: () => [{ path: binary, version }], cacheDirectory: join(root, '.cache') }, context);
  const first = await snapshot();
  await writeFile(binary, 'same revision');
  assert.deepEqual(await snapshot(), first);
  version = 'browser-2';
  const updated = await snapshot();
  assert.notDeepEqual(updated.units, first.units);
  await rm(binary);
  assert.notDeepEqual((await snapshot()).units, updated.units);
  await put(runtime, 'browser', 'reinstalled');
  assert.deepEqual(await snapshot(), updated);
  await writeFile(testFile, 'source change');
  assert.notDeepEqual((await snapshot()).units, updated.units);
});

test('installed aliases and explicitly selected leaves retain their individual slots', async t => {
  const root = await temporary(t), context = createSnapshotContext({ local: true });
  t.after(() => context.close());
  await put(root, 'test/a.test.mjs', 'test');
  const config = { root, testDirectory: 'test', pattern: '*.test.mjs', ignore: [],
    trustPackageVersions: true, cacheDirectory: join(root, '.cache') };
  const a = 'node_modules/a', b = 'node_modules/b';
  const install = (slot, version) => put(root, slot + '/package.json', JSON.stringify({ name: 'same', version }));
  await install(a, '1');
  await install(b, '2');
  await install(a + '/node_modules/nested', 'v1');
  await install(b + '/node_modules/nested', 'v2');
  const deps = createSnapshot({ ...config, inputs: [a, b] }, context);
  const baseline = await deps();
  await install(a, '2');
  await install(b, '1');
  const swapped = await deps();
  assert.notEqual(swapped.common, baseline.common);
  await install(a + '/node_modules/nested', 'v2');
  await install(b + '/node_modules/nested', 'v1');
  assert.notEqual((await deps()).common, swapped.common);
  const leaves = createSnapshot({ ...config, inputs: [a + '/a.js', a + '/b.js'] }, context);
  await put(root, a + '/a.js', 'bytes');
  const left = await leaves();
  await rm(join(root, a, 'a.js'));
  await put(root, a + '/b.js', 'bytes');
  assert.notEqual((await leaves()).common, left.common);
});

test('package links retain version evidence and only a same-install payload can skip byte reads', async t => {
  const root = await temporary(t), context = createSnapshotContext({ local: true });
  t.after(() => context.close());
  await put(root, 'test/a.test.mjs', 'test');
  const pkg = 'node_modules/alias';
  const install = version => put(root, pkg + '/package.json', JSON.stringify({ name: 'installed', version }));
  await install('1');
  const payload = await put(root, pkg + '/payload', 'installed');
  const outside = await put(root, 'author/source', 'workspace');
  await symlink(payload, join(root, pkg, 'internal'));
  await symlink(outside, join(root, pkg, 'external'));
  const config = { root, testDirectory: 'test', pattern: '*.test.mjs', ignore: [],
    trustPackageVersions: true, cacheDirectory: join(root, '.cache') };
  const internal = createSnapshot({ ...config, inputs: [pkg + '/internal'] }, context);
  const external = createSnapshot({ ...config, inputs: [pkg + '/external'] }, context);
  const initial = await internal(), externalInitial = await external();
  await writeFile(payload, 'repacked');
  assert.deepEqual(await internal(), initial);
  await install('2');
  assert.notDeepEqual(await internal(), initial);
  const bumped = await external();
  assert.notDeepEqual(bumped, externalInitial);
  await writeFile(outside, 'edited source');
  assert.notDeepEqual(await external(), bumped);
  await mkdir(join(root, 'node_modules/.bin'));
  await symlink(payload, join(root, 'node_modules/.bin/command'));
  const tree = createSnapshot({ ...config, inputs: ['node_modules'] }, context);
  const explicit = createSnapshot({ ...config, inputs: ['node_modules', 'node_modules/.bin/command'] }, context);
  const implicitBefore = await tree(), explicitBefore = await explicit();
  await writeFile(payload, 'new CLI bytes');
  assert.deepEqual(await tree(), implicitBefore);
  assert.notDeepEqual(await explicit(), explicitBefore);
});

test('fixture and projection selections of sibling package roots trust versions while payloads retain byte evidence', async t => {
  const tmp = await temporary(t), root = join(tmp, 'owner'), context = createSnapshotContext({ local: true });
  t.after(() => context.close());
  await put(root, 'test/a.test.mjs', 'test');
  const pkg = join(tmp, 'sibling/node_modules/dep');
  const install = version => put(pkg, 'package.json', JSON.stringify({ name: 'dep', version }));
  await install('1');
  const payload = await put(pkg, 'payload', 'old');
  const config = { root, testDirectory: 'test', pattern: '*.test.mjs', inputs: [], ignore: [],
    trustPackageVersions: true, cacheDirectory: join(root, '.cache') };
  const dependency = createSnapshot({ ...config, testFixtureInputs: () => [pkg] }, context);
  const artifact = createSnapshot({ ...config, testFixtureInputs: () => [payload] }, context);
  const projected = createSnapshot({ ...config, inputProjection: async (entries, { kind, identify }) =>
    kind === 'unit' ? [...entries, ...await identify([pkg])] : entries }, context);
  const installed = await dependency(), original = await artifact(), projection = await projected();
  await writeFile(payload, 'new');
  assert.deepEqual(await dependency(), installed);
  assert.deepEqual(await projected(), projection);
  assert.notDeepEqual(await artifact(), original);
  await install('2');
  assert.notDeepEqual(await dependency(), installed);
  assert.notDeepEqual(await projected(), projection);
});
