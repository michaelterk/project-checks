import assert from 'node:assert/strict';
import { rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createSnapshotContext, runTests, runChecks } from '../src/index.mjs';
import { digest } from '../src/util.mjs';
import { interceptReads } from './input-read-helpers.mjs';
import { put, temporary } from './helpers.mjs';

test('scan generation shares source promises including missing paths and ends with fresh checks', async t => {
  const root = await temporary(t), source = await put(root, 'source', 'first'), missing = join(root, 'missing');
  await utimes(source, new Date(0), new Date(0));
  const context = createSnapshotContext();
  t.after(() => context.close());
  context.beginScanGeneration();
  const first = context.sourceHash(source);
  assert.equal(context.sourceHash(source), first);
  const absent = context.sourceHash(missing);
  assert.equal(context.sourceHash(missing), absent);
  assert.equal(await absent, null);
  assert.equal(await first, digest('first'));
  context.acceptSourceProof(root, { source: digest('first'), missing: null });
  await context.finishScanGeneration();
  await writeFile(source, 'later');
  assert.equal(await context.sourceHash(source), digest('later'));
  await writeFile(missing, 'created');
  assert.equal(await context.sourceHash(missing), digest('created'));
});

for (const kind of ['write', 'missing', 'symlink']) test(`scan freshness gate rejects accepted source ${kind} changes`, async t => {
  const root = await temporary(t), source = await put(root, 'source', 'first');
  // Make the rewrite observable even within one filesystem clock tick.
  if (kind === 'write') await utimes(source, new Date(0), new Date(0));
  const path = kind === 'missing' ? join(root, 'missing') : kind === 'symlink' ? join(root, 'alias') : source;
  if (kind === 'symlink') await symlink(source, path);
  const context = createSnapshotContext();
  t.after(() => context.close());
  context.beginScanGeneration();
  const hash = await context.sourceHash(path);
  context.acceptSourceProof(root, { [path]: hash });
  if (kind === 'symlink') {
    await rm(path);
    await symlink(await put(root, 'other', 'later'), path);
  } else await writeFile(path, 'later');
  assert.equal(await context.sourceHash(path), hash, 'initial generation owns a stable proof');
  await assert.rejects(context.finishScanGeneration(), /Covered source changed during cache scan/);
  assert.equal(await context.sourceHash(path), digest('later'), 'failed gate still disables the memo');
});

test('unaccepted source attempts do not poison the acceptance gate and rejected reads can retry', async t => {
  const root = await temporary(t), source = await put(root, 'source', 'first');
  await utimes(source, new Date(0), new Date(0));
  const context = createSnapshotContext();
  t.after(() => context.close());
  let fail = true;
  interceptReads(t, (file, read) => { if (fail) throw new Error('temporary read failure'); return read(); });
  context.beginScanGeneration();
  await assert.rejects(context.sourceHash(source), /temporary read failure/);
  fail = false;
  assert.equal(await context.sourceHash(source), digest('first'));
  await writeFile(source, 'later');
  await context.finishScanGeneration();
  assert.equal(await context.sourceHash(source), digest('later'));
});

test('scan cancellation rejects shared reads, drains active work and discards memoized proofs', async t => {
  const root = await temporary(t), source = await put(root, 'source', 'first');
  const controller = new AbortController(), context = createSnapshotContext({ signal: controller.signal });
  t.after(() => context.close());
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  interceptReads(t, async (file, read) => { entered.resolve(); await release.promise; return read(); });
  context.beginScanGeneration();
  const reading = context.sourceHash(source), reason = new Error('cancel scan generation');
  assert.equal(reading, context.sourceHash(source));
  const rejected = assert.rejects(reading, error => error === reason);
  await entered.promise;
  controller.abort(reason);
  let closed = false;
  const closing = context.close().then(() => { closed = true; });
  assert.equal(closed, false);
  release.resolve();
  await Promise.all([rejected, closing]);
  await assert.rejects(context.sourceHash(source), error => error === reason);
});

test('normal final and retained checks reject covered sources omitted from declared inputs', async t => {
  const root = await temporary(t);
  const source = await put(root, 'source.mjs', 'export const value = 1;\n');
  await put(root, 'test/a.test.mjs', "import { value } from '../source.mjs'; if (value !== 1) throw Error('bad value');\n");
  const config = { root, suite: 'source-proof', testDirectory: 'test', pattern: '**/*.test.mjs', inputs: [],
    cacheDirectory: join(root, '.cache'), coverage: { include: ['source.mjs'], minimum: { lines: 100, branches: 100, functions: 100 } },
    logger: false, progress: false, stdio: 'ignore' };
  assert.equal((await runTests(config)).exitCode, 0);
  await assert.rejects(runTests(config, { cacheScan: async plan => {
    assert.equal(plan.cached, 1);
    await writeFile(source, 'export const value = 2;\n');
  } }), /Covered source changed/);
  await writeFile(source, 'export const value = 1;\n');
  await assert.rejects(runChecks([
    { id: 'tests', config },
    { id: 'mutate', dependsOn: ['tests'], cwd: root, command: [process.execPath, '-e', "require('node:fs').writeFileSync('source.mjs','export const value = 2;\\n')"] },
  ], { logger: false, progress: false }), /Covered source changed/);
});
