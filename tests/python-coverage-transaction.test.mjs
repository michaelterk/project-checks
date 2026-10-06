import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import promises from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { normalizeCoverageArtifact, restoreCoverageArtifact, rewriteCoveragePaths } from '../src/coverage-paths.mjs';
import { createSnapshotContext } from '../src/inputs.mjs';
import { put, temporary } from './helpers.mjs';

async function artifact(t, paths) {
  const root = await temporary(t), file = join(root, 'original');
  const database = new DatabaseSync(file);
  try {
    database.exec('CREATE TABLE file (id INTEGER PRIMARY KEY, path TEXT UNIQUE); CREATE TABLE extra (value TEXT); INSERT INTO extra VALUES (\'retained\');');
    const insert = database.prepare('INSERT INTO file(path) VALUES (?)');
    for (const path of paths) insert.run(path);
  } finally { database.close(); }
  return { file, bytes: await readFile(file) };
}
async function inspect(t, bytes) {
  const file = join(await temporary(t), 'result'); await writeFile(file, bytes);
  const database = new DatabaseSync(file);
  try { return { paths: database.prepare('SELECT path FROM file ORDER BY id').all().map(row => row.path),
    extra: database.prepare('SELECT value FROM extra').get().value,
    integrity: database.prepare('PRAGMA integrity_check').get().integrity_check }; }
  finally { database.close(); }
}
function watchPrivateWrites(t) {
  const files = [], original = promises.writeFile;
  promises.writeFile = async (file, ...args) => {
    if (typeof file === 'string' && /project-checks-coverage-[^/]+\/data$/.test(file)) files.push(file);
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => { promises.writeFile = original; syncBuiltinESMExports(); });
  return files;
}

test('Python coverage path rewrite uses one transaction and one update statement for all rows', async t => {
  const input = await artifact(t, ['á/source.py', 'nested/other.py', 'third.py']);
  const exec = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare;
  const commands = []; let updates = 0;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) { commands.push(sql); return exec.call(this, sql); });
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) { if (sql.startsWith('UPDATE file')) updates++; return prepare.call(this, sql); });
  const privateFiles = watchPrivateWrites(t);
  const mapped = await rewriteCoveragePaths(input.bytes, 'python', path => `/moved/${path}`);
  assert.deepEqual(commands, ['BEGIN', 'COMMIT']);
  assert.equal(updates, 1);
  assert.deepEqual(await inspect(t, mapped), { paths: ['/moved/á/source.py', '/moved/nested/other.py', '/moved/third.py'], extra: 'retained', integrity: 'ok' });
  assert.deepEqual(await readFile(input.file), input.bytes, 'original artifact is immutable');
  assert.equal(privateFiles.length, 1);
  await assert.rejects(promises.stat(dirname(privateFiles[0])), { code: 'ENOENT' });
});

test('Python mapper failure rolls back completed updates and preserves the original error through close failure', async t => {
  const input = await artifact(t, ['first.py', 'second.py']);
  const exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close;
  const failure = new Error('mapping failed for second.py'), commands = [];
  let rolledBackPaths;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    commands.push(sql); const value = exec.call(this, sql);
    if (sql === 'ROLLBACK') rolledBackPaths = this.prepare('SELECT path FROM file ORDER BY id').all().map(row => row.path);
    return value;
  });
  t.mock.method(DatabaseSync.prototype, 'close', function () { close.call(this); throw new Error('secondary close failure'); });
  const privateFiles = watchPrivateWrites(t);
  await assert.rejects(rewriteCoveragePaths(input.bytes, 'python', async path => {
    if (path === 'second.py') throw failure;
    return `/changed/${path}`;
  }), error => error === failure);
  assert.deepEqual(commands, ['BEGIN', 'ROLLBACK']);
  assert.deepEqual(rolledBackPaths, ['first.py', 'second.py']);
  assert.deepEqual(await readFile(input.file), input.bytes);
  await assert.rejects(promises.stat(dirname(privateFiles[0])), { code: 'ENOENT' });
});

test('Python rewrite retains database integrity checks and rolls back update constraint failures', async t => {
  let mappings = 0;
  const privateFiles = watchPrivateWrites(t);
  await assert.rejects(rewriteCoveragePaths(Buffer.from('not a database'), 'python', () => { mappings++; return 'unused'; }));
  assert.equal(mappings, 0);
  const input = await artifact(t, ['first.py', 'second.py']);
  await assert.rejects(rewriteCoveragePaths(input.bytes, 'python', () => 'collision.py'), /UNIQUE constraint failed/);
  assert.deepEqual(await readFile(input.file), input.bytes);
  for (const file of privateFiles) await assert.rejects(promises.stat(dirname(file)), { code: 'ENOENT' });
});

test('Python normalization and restoration preserve portable paths and reject source mutation at the fresh gate', async t => {
  const root = await temporary(t), source = await put(root, 'á.py', 'answer = 42\n');
  const input = await artifact(t, [source]);
  const normalized = await normalizeCoverageArtifact(input.bytes, { provider: 'python', sourceRoot: root });
  assert.deepEqual((await inspect(t, normalized.bytes)).paths, ['á.py']);
  const context = createSnapshotContext(); t.after(() => context.close());
  context.beginScanGeneration();
  const restored = await restoreCoverageArtifact(normalized.bytes, { provider: 'python', root, sources: normalized.sources, context });
  assert.deepEqual((await inspect(t, restored)).paths, [source]);
  context.acceptSourceProof(root, normalized.sources);
  await writeFile(source, 'answer = 99\n');
  await assert.rejects(context.finishScanGeneration(), /Covered source changed during cache scan/);
  await assert.rejects(restoreCoverageArtifact(normalized.bytes, { provider: 'python', root, sources: normalized.sources }), /Covered source changed/);
});

test('built-in Python staging validates portable bytes without rewriting and remains isolated from cache replacement', async t => {
  const { createCoverage } = await import('../src/coverage.mjs');
  const { digest } = await import('../src/util.mjs');
  const root = await temporary(t), source = await put(root, 'source.py', 'answer = 42\n');
  const input = await artifact(t, ['source.py']);
  const cacheDirectory = join(root, '.cache');
  const coverage = await createCoverage({ root, suite: 'portable-python', cacheDirectory,
    coverage: { provider: 'python' }, logger: false }, process.env);
  t.after(() => coverage.close());
  const evidence = { files: [input.file], metadata: { format: 'project-checks-python-v2', unit: 'a', sources: { 'source.py': digest('answer = 42\n') } } };
  let writes = 0;
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) { if (/BEGIN|COMMIT|UPDATE/.test(sql)) writes++; return exec.call(this, sql); });
  assert.equal(await coverage.restoreEvidence({ id: 'a' }, evidence), true);
  assert.equal(writes, 0, 'cached scan performs no SQLite transaction or rebase');
  const directory = join(cacheDirectory, 'coverage', 'portable-python');
  const staging = join(directory, (await promises.readdir(directory)).find(name => name.startsWith('.run-')));
  const staged = join(staging, (await promises.readdir(staging))[0]);
  assert.deepEqual(await readFile(staged), input.bytes);
  await writeFile(`${input.file}.replacement`, 'replacement');
  await promises.rename(`${input.file}.replacement`, input.file);
  assert.deepEqual(await readFile(staged), input.bytes);
  assert.equal(await coverage.restoreEvidence({ id: 'a' }, evidence), false, 'corrupt replacement is a cache miss');
  await writeFile(input.file, input.bytes);
  await writeFile(source, 'answer = 99\n');
  assert.equal(await coverage.restoreEvidence({ id: 'a' }, evidence), false, 'changed source rejects portable bytes');
});

test('portable Python validation retains integrity, file-table and source-membership gates', async t => {
  const { validatePortablePythonArtifact } = await import('../src/coverage-paths.mjs');
  const root = await temporary(t);
  const context = { sourceHash: async () => 'hash' };
  const input = await artifact(t, ['unbound.py']);
  await assert.rejects(validatePortablePythonArtifact(input.file, { root, sources: { 'bound.py': 'hash' }, context }), /Unbound coverage source: unbound.py/);
  const nullPath = await artifact(t, [null]);
  await assert.rejects(validatePortablePythonArtifact(nullPath.file, { root, sources: { null: 'hash' }, context }), /Unbound coverage source/);
  const missing = join(root, 'missing-table');
  const database = new DatabaseSync(missing); database.exec('CREATE TABLE unrelated (value TEXT)'); database.close();
  await assert.rejects(validatePortablePythonArtifact(missing, { root, sources: {}, context }), /no such table: file/);
  await writeFile(missing, 'invalid database');
  await assert.rejects(validatePortablePythonArtifact(missing, { root, sources: {}, context }), /not a database/);
});
