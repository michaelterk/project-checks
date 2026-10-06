import assert from 'node:assert/strict';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { createCoverage } from '../src/coverage.mjs';
import { readV8Reports, mapV8CoveragePaths, restoreCoverageArtifact, validatePortableV8Artifact } from '../src/coverage-paths.mjs';
import { createSnapshotContext } from '../src/inputs.mjs';
import { digest } from '../src/util.mjs';
import { put, temporary } from './helpers.mjs';

async function fixture(t) {
  const root = await temporary(t);
  await put(root, 'source.mjs', 'export const value = 1;');
  const reports = [{ result: [{ url: 'source.mjs', functions: [] }],
    'source-map-cache': { 'source.mjs': { data: { sources: ['source.mjs'] }, url: 'source.mjs' } } }];
  return { root, bytes: gzipSync(JSON.stringify(reports)), sources: { 'source.mjs': digest('export const value = 1;') } };
}

test('portable staging retains independent exact bytes after shared cache replacement', async t => {
  const f = await fixture(t);
  const artifact = await put(f.root, 'artifact.gz', f.bytes);
  const cacheDirectory = join(f.root, '.cache');
  const coverage = await createCoverage({ root: f.root, suite: 'portable', cacheDirectory, coverage: {}, logger: false }, process.env);
  t.after(() => coverage.close());
  const evidence = { files: [artifact], metadata: { format: 'project-checks-v8-v2', unit: 'a', sources: f.sources } };
  assert.equal(await coverage.restoreEvidence({ id: 'a' }, evidence), true);
  const directory = join(cacheDirectory, 'coverage', 'portable');
  const staging = join(directory, (await readdir(directory)).find(name => name.startsWith('.run-')));
  const staged = join(staging, (await readdir(staging))[0]);
  assert.deepEqual(await readFile(staged), f.bytes);
  await writeFile(`${artifact}.replacement`, 'replaced artifact');
  await rename(`${artifact}.replacement`, artifact);
  assert.deepEqual(await readFile(staged), f.bytes);
  await writeFile(artifact, f.bytes);
  await writeFile(join(f.root, 'source.mjs'), 'export const value = 2;');
  assert.equal(await coverage.restoreEvidence({ id: 'a' }, evidence), false, 'changed source rejects portable contribution');
});

test('portable aggregate traversal matches public native restoration including source maps', async t => {
  const f = await fixture(t);
  await validatePortableV8Artifact(f.bytes, { root: f.root, sources: f.sources });
  const native = readV8Reports(await restoreCoverageArtifact(f.bytes, { provider: 'v8', root: f.root, sources: f.sources }));
  const portable = readV8Reports(f.bytes);
  await mapV8CoveragePaths(portable, path => pathToFileURL(join(f.root, path)).href);
  assert.deepEqual(portable, native);
  const unbound = gzipSync(JSON.stringify([{ result: [{ url: 'unbound.mjs', functions: [] }] }]));
  await assert.rejects(validatePortableV8Artifact(unbound, { root: f.root, sources: f.sources }), /Unbound coverage source/);
  await assert.rejects(validatePortableV8Artifact(gzipSync('[]'), { root: f.root, sources: f.sources }), /Invalid V8 coverage/);
});

test('directory policies cache pure decisions without crossing explicit projections or changed rules', async t => {
  const root = await temporary(t);
  const context = createSnapshotContext();
  t.after(() => context.close());
  const config = { root, directoryIgnore: { directories: ['**/node_modules'], files: ['**/*.md'] } };
  const ordinary = context.directoryExcluded(config, root);
  const explicit = context.directoryExcluded(config, join(root, 'node_modules/example'));
  assert.equal(ordinary(join(root, 'node_modules')), true);
  assert.equal(explicit(join(root, 'node_modules/example/node_modules')), false);
  assert.equal(explicit(join(root, 'node_modules/example/README.md')), true);
  assert.equal(context.directoryExcluded(config, root), ordinary);
  config.directoryIgnore.files.push('**/*.txt');
  const changed = context.directoryExcluded(config, root);
  assert.notEqual(changed, ordinary);
  assert.equal(changed(join(root, 'new.txt')), true);
  assert.equal(ordinary(join(root, 'new.txt')), false);
});
