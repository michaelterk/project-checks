import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { defineConfig, loadConfig, runTests } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

test('subprocess timeout uses the packaged default and inherits JSON overrides', async t => {
  const root = await temporary(t);
  assert.equal((await loadConfig(undefined, { cwd: root })).subprocessTimeoutMs, 60000);
  await put(root, 'default.json', '{}');
  await put(root, 'base.json', JSON.stringify({ subprocessTimeoutMs: 90000 }));
  await put(root, 'child.json', JSON.stringify({ extends: 'base.json' }));
  const defaults = await loadConfig(join(root, 'default.json'));
  assert.equal(defaults.subprocessTimeoutMs, 60000);
  assert.equal(defaults.timeoutMs, undefined);
  assert.equal(defaults.retryTimeoutMs, undefined);
  assert.equal((await loadConfig(join(root, 'child.json'))).subprocessTimeoutMs, 90000);
  await put(root, 'child.json', JSON.stringify({ extends: 'base.json', subprocessTimeoutMs: 120000 }));
  assert.equal((await loadConfig(join(root, 'child.json'))).subprocessTimeoutMs, 120000);
});

test('subprocess timeout rejects invalid values before running tests', async t => {
  for (const subprocessTimeoutMs of [0, -1, 1.5, NaN, Infinity, 2147483648, null, '60000', true]) {
    assert.throws(() => defineConfig({ subprocessTimeoutMs }), /subprocessTimeoutMs/);
    await assert.rejects(runTests({ subprocessTimeoutMs, logger: false }), /subprocessTimeoutMs/);
  }
  for (const subprocessTimeoutMs of [1, 2147483647, undefined]) {
    assert.doesNotThrow(() => defineConfig({ subprocessTimeoutMs }));
  }
  const root = await temporary(t);
  const file = await put(root, 'invalid.json', JSON.stringify({ subprocessTimeoutMs: false }));
  await assert.rejects(loadConfig(file), /subprocessTimeoutMs/);
});

test('test children receive their subprocess budget without changing command deadlines or content evidence', async t => {
  const root = await temporary(t);
  await put(root, 'test/child.mjs', `
    import { mkdirSync, writeFileSync } from 'node:fs';
    setTimeout(() => {
      mkdirSync('.test-cache', { recursive: true });
      writeFileSync('.test-cache/child.json', JSON.stringify({
        timeout: process.env.PROJECT_CHECKS_SUBPROCESS_TIMEOUT_MS,
        other: process.env.PROJECT_CHECKS_TEST_VALUE,
      }));
    }, 25);
  `);
  const env = { PROJECT_CHECKS_SUBPROCESS_TIMEOUT_MS: 'stale', PROJECT_CHECKS_TEST_VALUE: 'kept' };
  const original = process.env.PROJECT_CHECKS_SUBPROCESS_TIMEOUT_MS;
  const options = {
    root, workers: 1, pattern: '**/*.mjs', inputs: [], coverage: false,
    command: [process.execPath, '{file}'], env, logger: false, stdio: 'ignore',
  };
  const observed = async () => JSON.parse(await readFile(join(root, '.test-cache/child.json'), 'utf8'));
  assert.equal((await runTests(options)).passed, 1);
  assert.deepEqual(await observed(), { timeout: '60000', other: 'kept' });
  assert.equal((await runTests({ ...options, subprocessTimeoutMs: 7 })).cached, 1);
  assert.equal((await runTests({ ...options, subprocessTimeoutMs: 7, cache: false })).passed, 1);
  assert.deepEqual(await observed(), { timeout: '7', other: 'kept' });
  assert.equal(options.timeoutMs, undefined);
  assert.deepEqual(env, { PROJECT_CHECKS_SUBPROCESS_TIMEOUT_MS: 'stale', PROJECT_CHECKS_TEST_VALUE: 'kept' });
  assert.equal(process.env.PROJECT_CHECKS_SUBPROCESS_TIMEOUT_MS, original);
});
