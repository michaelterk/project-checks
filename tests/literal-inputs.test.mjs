import assert from 'node:assert/strict';
import fs from 'node:fs';
import { glob } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { contentFingerprint, createSnapshot, createSnapshotContext } from '../src/inputs.mjs';
import { put, temporary } from './helpers.mjs';

const magic = /[*?{}()[\]\\!+@]/;

test('literal fast path preserves legacy selection for Unicode, missing, explicit tests and escaped globs', async t => {
  const root = await temporary(t);
  for (const file of ['test/a.test.mjs', 'test/b.test.mjs', 'canción con espacio.txt', 'sub/file.txt', 'literal[1].txt']) await put(root, file, file);
  const context = createSnapshotContext();
  t.after(() => context.close());
  const config = { root, suite: 'literal', testDirectory: 'test', pattern: '*.test.mjs', inputs: [], ignore: [],
    excludeTestsFromInputs: true, cacheDirectory: join(root, '.cache') };
  const excludedFiles = new Set(['a', 'b'].map(name => join(root, `test/${name}.test.mjs`)));
  for (const inputs of [
    ['canción con espacio.txt', 'absent.txt'], ['test/b.test.mjs'], ['./test/b.test.mjs'],
    ['test/../test/b.test.mjs'], ['sub/', 'absent-dir/'], ['sub/*.txt', 'literal\\[1\\].txt'],
    ['canción con espacio.txt', 'canción con espacio.txt'],
  ]) {
    config.inputs = inputs;
    const selected = new Set();
    for await (const name of glob(inputs, { cwd: root, exclude: config.ignore })) {
      const file = resolve(root, name);
      if (!excludedFiles.has(file) || inputs.includes(relative(root, file))) selected.add(file);
    }
    for (const pattern of inputs) {
      const file = resolve(root, pattern);
      if (!magic.test(pattern) && !excludedFiles.has(file)) selected.add(file);
    }
    const expected = contentFingerprint(await context.identify([...selected], { ...config, allowMissing: true }, excludedFiles));
    assert.equal((await createSnapshot(config, context)()).common, expected, JSON.stringify(inputs));
  }
});

test('literal-only dependencies do not enter Node glob traversal', async t => {
  const root = await temporary(t);
  await put(root, 'test/a.test.mjs', '');
  await put(root, 'source', '');
  const context = createSnapshotContext();
  t.after(() => context.close());
  const original = fs.promises.glob;
  const calls = [];
  fs.promises.glob = (patterns, options) => { calls.push({ patterns, cwd: options.cwd }); return original(patterns, options); };
  syncBuiltinESMExports();
  try {
    await createSnapshot({ root, testDirectory: 'test', pattern: '*.test.mjs', inputs: ['source', 'missing'], testInputs: () => ['source'],
      ignore: [], cacheDirectory: join(root, '.cache') }, context)();
    assert.equal(calls.filter(call => call.cwd === root).length, 0);
    assert.ok(calls.some(call => call.cwd === join(root, 'test')));
  } finally { fs.promises.glob = original; syncBuiltinESMExports(); }
});
