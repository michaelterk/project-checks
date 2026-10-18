import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { defineConfig, loadConfig } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

test('compilation host defaults and overrides survive configuration inheritance', async t => {
  const root = await temporary(t);
  assert.deepEqual((await loadConfig(undefined, { cwd: root })).compilation,
    { machineType: 't2d-standard-32', executor: 'local' });
  await put(root, 'base.json', JSON.stringify({ compilation: { machineType: 'n2d-highcpu-64' } }));
  await put(root, 'child.json', JSON.stringify({ extends: 'base.json', compilation: {} }));
  assert.equal((await loadConfig(join(root, 'child.json'))).compilation.machineType, 'n2d-highcpu-64');
  await put(root, 'child.json', JSON.stringify({ extends: 'base.json', compilation: { machineType: 't2d-standard-48' } }));
  assert.equal((await loadConfig(join(root, 'child.json'))).compilation.machineType, 't2d-standard-48');
  await put(root, 'empty.json', JSON.stringify({ compilation: {} }));
  assert.equal((await loadConfig(join(root, 'empty.json'))).compilation.machineType, 't2d-standard-32');
});

test('compilation metadata rejects malformed objects, unknown fields and unsafe names', () => {
  for (const compilation of [null, [], 'machine', { cores: 32 },
    ...['', 'two cores', '../machine', 'x;id', 32, null, 'x'.repeat(64),
      ...['\n', '\r', '\u2028', '\u2029'].map(ending => 't2d-standard-32' + ending)].map(machineType => ({ machineType }))]) {
    assert.throws(() => defineConfig({ compilation }), /compilation/);
  }
  assert.doesNotThrow(() => defineConfig({ compilation: { machineType: undefined } }));
});

test('executor metadata inherits and validates without coupling the runner to cloud orchestration', async t => {
  const root = await temporary(t);
  await put(root, 'base.json', JSON.stringify({ compilation: { executor: 'batch' } }));
  await put(root, 'child.json', JSON.stringify({ extends: 'base.json', compilation: { machineType: 't2d-standard-48' } }));
  assert.deepEqual((await loadConfig(join(root, 'child.json'))).compilation,
    { executor: 'batch', machineType: 't2d-standard-48' });
  for (const executor of [null, false, 'cloud', 'local\n', 0]) {
    assert.throws(() => defineConfig({ compilation: { executor } }), /executor/);
  }
});
