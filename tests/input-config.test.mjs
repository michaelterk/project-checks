import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createFileSnapshot, createSnapshotContext, defineConfig, loadChecks, loadConfig, runCachedUnits, runChecks, runTests } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

test('input concurrency inherits the packaged default and parent JSON settings', async t => {
  const root = await temporary(t);
  await put(root, 'base.json', JSON.stringify({ inputConcurrency: 3 }));
  await put(root, 'inherited.json', JSON.stringify({ extends: 'base.json' }));
  await put(root, 'override.json', JSON.stringify({ extends: 'base.json', inputConcurrency: 5 }));
  await put(root, 'default.json', '{}');
  assert.equal((await loadConfig(join(root, 'default.json'))).inputConcurrency, 8);
  assert.equal((await loadConfig(join(root, 'inherited.json'))).inputConcurrency, 3);
  assert.equal((await loadConfig(join(root, 'override.json'))).inputConcurrency, 5);
  const invalid = await put(root, 'invalid.json', JSON.stringify({ inputConcurrency: 'many' }));
  await assert.rejects(loadConfig(invalid), error => {
    assert.match(error.message, /inputConcurrency must be a positive safe integer; received string "many"/);
    assert.ok(error.message.includes(invalid), error.message);
    return true;
  });
});

test('invalid input limits fail before filesystem work', async () => {
  for (const inputConcurrency of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '4', true]) {
    assert.throws(() => defineConfig({ inputConcurrency }), /inputConcurrency/);
    assert.throws(() => createSnapshotContext({ inputConcurrency }), /inputConcurrency/);
    await assert.rejects(createFileSnapshot({ inputConcurrency }), /inputConcurrency/);
    await assert.rejects(runChecks([], { inputConcurrency, logger: false }), /inputConcurrency/);
    await assert.rejects(runCachedUnits({
      inputConcurrency, cache: false, logger: null, units: [{ id: 'file', identity: 'fixture' }],
      snapshot: () => ({ common: 'same', units: { file: 'same' } }),
      execute: () => { throw Error('invalid settings cannot execute'); },
    }), /inputConcurrency/);
  }
  assert.throws(() => defineConfig({ inputConcurrency: 0 }), /inputConcurrency must be a positive safe integer; received number 0/);
  assert.throws(() => createSnapshotContext({ inputConcurrency: null }), /inputConcurrency must be a positive safe integer; received null/);
});

test('shared checks honor the smallest JSON input limit and an explicit override', async t => {
  const root = await temporary(t);
  for (let index = 0; index < 8; index++) await put(root, `test/${index}.test.mjs`, '');
  await put(root, 'base.json', JSON.stringify({ inputs: [], coverage: false, cache: false }));
  await put(root, 'one.json', JSON.stringify({ extends: 'base.json', suite: 'one', inputConcurrency: 2 }));
  await put(root, 'two.json', JSON.stringify({ extends: 'base.json', suite: 'two', inputConcurrency: 4 }));
  await put(root, 'checks.json', JSON.stringify({ checks: {
    one: { config: 'one.json' }, two: { config: 'two.json' },
  }, targets: { default: ['one', 'two'] } }));
  const definitions = await loadChecks(join(root, 'checks.json'));
  let probe;
  for (const definition of definitions) {
    const factory = definition.config;
    definition.config = async context => ({
      ...await factory(context),
      setup: () => ({ execute: () => 0 }),
      testInputs(id) { return this.snapshotContext.run(() => probe(id)); },
    });
  }
  async function measure(limit, launch) {
    let active = 0, peak = 0, started;
    const reached = new Promise(resolve => { started = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    probe = async () => {
      peak = Math.max(peak, ++active);
      if (active === limit) started();
      await gate;
      active--;
      return [];
    };
    const running = launch();
    try {
      await reached;
      assert.equal(peak, limit);
    } finally { release(); }
    assert.equal((await running).exitCode, 0);
    assert.equal(peak, limit);
  }
  await measure(2, () => runChecks(definitions, { workers: 1, logger: false }));
  await measure(4, () => runChecks(definitions, { workers: 1, logger: false, inputConcurrency: 4 }));
  await measure(3, async () => runTests({
    ...await loadConfig(join(root, 'one.json')),
    inputConcurrency: 3, workers: 1, logger: false,
    setup: () => ({ execute: () => 0 }),
    testInputs(id) { return this.snapshotContext.run(() => probe(id)); },
  }));
});

test('checks CLI uses suite JSON input limit unless root JSON explicitly overrides it', async t => {
  const root = await temporary(t);
  const marker = join(root, 'input-peak');
  for (let index = 0; index < 4; index++) await put(root, `test/${index}.test.mjs`, '');
  await put(root, 'suite.json', JSON.stringify({ inputs: [], coverage: false, cache: true, inputConcurrency: 2 }));
  await put(root, 'suite.mjs', `
    import { writeFileSync } from 'node:fs';
    let active = 0, peak = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    process.on('exit', () => writeFileSync(${JSON.stringify(marker)}, String(peak)));
    export default {
      extends: 'suite.json',
      testInputs(id) {
        return this.snapshotContext.run(async () => {
          peak = Math.max(peak, ++active);
          if (active === 2) setImmediate(release);
          await gate;
          active--;
          return [];
        });
      },
    };
  `);
  await put(root, 'checks.json', JSON.stringify({ checks: { tests: { config: 'suite.mjs' } }, targets: { default: ['tests'] } }));
  const quotaPreload = await put(root, 'quota-preload.mjs', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = (file, ...args) => String(file).endsWith('/cpu.max') ? '100000 100000' : read(file, ...args);
    syncBuiltinESMExports();
  `);
  const bin = fileURLToPath(new URL('../bin/project-checks.mjs', import.meta.url));
  const command = [process.execPath, bin, 'checks', '--config', 'checks.json', '--workers', '1'];
  const execute = () => spawnSync(command[0], command.slice(1), {
    cwd: root, encoding: 'utf8', timeout: 30000,
    // The isolated child uses a synthetic inherited quota so CLI tests need no user systemd bus.
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${quotaPreload}`.trim() },
  });
  const details = result => JSON.stringify({ command, cwd: root, status: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr, error: result.error?.message }, null, 2);
  async function assertPeak(result, expected) {
    const observed = await readFile(marker, 'utf8').catch(error => {
      throw new Error(`Missing input peak. ${details(result)}`, { cause: error });
    });
    assert.equal(observed, String(expected), details(result));
  }
  const suite = execute();
  assert.equal(suite.status, 0, details(suite));
  await assertPeak(suite, 2);
  await put(root, 'project-checks.config.json', JSON.stringify({ inputConcurrency: 4 }));
  const overridden = execute();
  assert.equal(overridden.status, 0, details(overridden));
  await assertPeak(overridden, 4);
});
