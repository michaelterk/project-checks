import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { realpath, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { defineConfig, loadChecks, loadConfig, runCachedUnits, runChecks, runTests } from '../src/index.mjs';
import { createVerificationPool } from '../src/verification-pool.mjs';
import { put, temporary } from './helpers.mjs';

test('invalid verification limits fail before execution', async () => {
  for (const verificationConcurrency of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '4', true]) {
    assert.throws(() => defineConfig({ verificationConcurrency }), /verificationConcurrency/);
    assert.throws(() => createVerificationPool(1, new AbortController().signal, verificationConcurrency), /verificationConcurrency/);
    await assert.rejects(runChecks([], { verificationConcurrency, logger: false }), /verificationConcurrency/);
    await assert.rejects(runCachedUnits({
      verificationConcurrency, cache: false, logger: null,
      units: [{ id: 'file', identity: 'fixture' }],
      snapshot: () => ({ common: 'same', units: { file: 'same' } }),
      execute: () => { throw Error('invalid settings cannot execute'); },
    }), /verificationConcurrency/);
  }
});

test('JSON verification settings govern actual passing-record writes in all runner APIs', { timeout: 10000 }, async t => {
  const root = await realpath(await temporary(t));
  const cacheDirectory = join(root, '.test-cache/project-checks');
  const ids = Array.from({ length: 12 }, (_, index) => `test/${index}.test.mjs`);
  for (const id of ids) await put(root, id, '');
  await put(root, 'base.json', JSON.stringify({ inputs: [], coverage: false, scanConcurrency: 2, verificationConcurrency: 6 }));
  await put(root, 'one.json', JSON.stringify({ extends: 'base.json', suite: 'one', files: ids.slice(0, 1), verificationConcurrency: 2 }));
  await put(root, 'two.json', JSON.stringify({ extends: 'base.json', suite: 'two', files: ids.slice(1) }));
  await put(root, 'checks.json', JSON.stringify({ checks: {
    one: { config: 'one.json' }, two: { config: 'two.json' },
  }, targets: { default: ['one', 'two'] } }));
  const definitions = await loadChecks(join(root, 'checks.json'));
  for (const definition of definitions) {
    const factory = definition.config;
    definition.config = async context => ({ ...await factory(context), setup: () => ({ execute: () => 0 }) });
  }
  let observation;
  const original = fs.writeFile, releases = [], running = [];
  t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (typeof file === 'string' && file.startsWith(`${cacheDirectory}/`) && file.endsWith('.tmp')) {
      const state = observation;
      state.peak = Math.max(state.peak, ++state.active);
      if (state.active === state.expected) state.full.resolve();
      try { await state.release.promise; }
      finally { state.active--; }
    }
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(async () => {
    releases.forEach(release => release.resolve());
    await Promise.allSettled(running);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  async function measure(expected, operation) {
    await rm(cacheDirectory, { recursive: true, force: true });
    const state = observation = { expected, active: 0, peak: 0, full: Promise.withResolvers(), release: Promise.withResolvers() };
    releases.push(state.release);
    const result = operation();
    running.push(result);
    await state.full.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.active, expected);
    state.release.resolve();
    assert.equal((await result).exitCode, 0);
    assert.equal(state.peak, expected);
  }
  await measure(2, () => runChecks(definitions, { workers: 1, logger: false }));
  await measure(5, () => runChecks(definitions, { workers: 1, verificationConcurrency: 5, logger: false }));
  const standalone = { ...await loadConfig(join(root, 'two.json')), workers: 1, logger: false, setup: () => ({ execute: () => 0 }) };
  await measure(6, () => runTests(standalone));
  await measure(3, () => runTests({ ...standalone, verificationConcurrency: 3 }));
  await measure(4, () => runCachedUnits({
    suite: 'adapter', cacheDirectory, workers: 1, verificationConcurrency: 4, logger: null,
    units: ids.map(id => ({ id, identity: 'fixture' })),
    snapshot: () => ({ common: 'same', units: Object.fromEntries(ids.map(id => [id, 'same'])) }),
    execute: () => 0,
  }));
});
