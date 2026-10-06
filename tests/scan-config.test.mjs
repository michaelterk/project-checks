import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFile, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { defineConfig, loadConfig, loadChecks, runCachedUnits, runChecks, runTests } from '../src/index.mjs';
import { createScanQueue } from '../src/scan-queue.mjs';
import { put, temporary } from './helpers.mjs';

test('JSON scan settings inherit packaged and parent defaults and allow project overrides', async t => {
  const root = await temporary(t);
  await put(root, 'base.json', JSON.stringify({ scanConcurrency: 6, verificationConcurrency: 8 }));
  await put(root, 'inherit.json', JSON.stringify({ extends: 'base.json' }));
  await put(root, 'override.json', JSON.stringify({ extends: 'base.json', scanConcurrency: 2, verificationConcurrency: 3 }));
  await put(root, 'default.json', '{}');
  assert.equal((await loadConfig(join(root, 'default.json'))).scanConcurrency, 32);
  assert.equal((await loadConfig(join(root, 'inherit.json'))).scanConcurrency, 6);
  assert.equal((await loadConfig(join(root, 'override.json'))).scanConcurrency, 2);
  assert.equal((await loadConfig(join(root, 'default.json'))).verificationConcurrency, 32);
  assert.equal((await loadConfig(join(root, 'inherit.json'))).verificationConcurrency, 8);
  assert.equal((await loadConfig(join(root, 'override.json'))).verificationConcurrency, 3);
});

test('invalid scan concurrency fails before execution in configuration and runner APIs', async () => {
  const queue = createScanQueue();
  for (const scanConcurrency of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '4', true]) {
    assert.throws(() => defineConfig({ scanConcurrency }), /scanConcurrency/);
    assert.throws(() => queue.enqueue([], {}, scanConcurrency), /scanConcurrency/);
    await assert.rejects(runChecks([], { scanConcurrency, logger: false }), /scanConcurrency/);
    await assert.rejects(runCachedUnits({
      scanConcurrency, cache: false, logger: null, units: [{ id: 'file', identity: 'fixture' }],
      snapshot: () => ({ common: 'same', units: { file: 'same' } }),
      execute: () => { throw Error('invalid settings cannot execute'); },
    }), /scanConcurrency/);
  }
});

test('JSON overrides control actual shared scan reads and invocation options take precedence', async t => {
  const root = await realpath(await temporary(t));
  const cacheDirectory = join(root, '.test-cache/project-checks');
  for (let index = 0; index < 40; index++) await put(root, `test/${index}.test.mjs`, '');
  await put(root, 'base.json', JSON.stringify({ inputs: [], coverage: false, scanConcurrency: 6 }));
  await put(root, 'one.json', JSON.stringify({ extends: 'base.json', suite: 'one', scanConcurrency: 2 }));
  await put(root, 'two.json', JSON.stringify({ extends: 'base.json', suite: 'two' }));
  await put(root, 'checks.json', JSON.stringify({ checks: {
    one: { config: 'one.json' }, two: { config: 'two.json', dependsOn: ['one'] },
  }, targets: { default: ['two'] } }));
  const definitions = await loadChecks(join(root, 'checks.json'));
  for (const definition of definitions) {
    const factory = definition.config;
    definition.config = async context => ({ ...await factory(context), setup: () => ({ execute: () => 0 }) });
  }
  assert.equal((await runChecks(definitions, { workers: 1, logger: false })).exitCode, 0);
  let active = 0, peak = 0, reads = 0;
  const original = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (!(typeof file === 'string' && file.startsWith(`${cacheDirectory}/`) && file.endsWith('.json'))) return original(file, ...args);
    active++;
    reads++;
    peak = Math.max(peak, active);
    try { await delay(2); return await original(file, ...args); }
    finally { active--; }
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const lines = [], logger = { log: line => lines.push(line), error: line => lines.push(line) };
  const first = await runChecks(definitions, { workers: 1, logger });
  assert.equal(first.exitCode, 0);
  assert.equal(peak, 2);
  assert.equal(reads, 80);
  assert.ok(first.results.every(result => result.cached === 40));
  assert.ok(lines.some(line => /Queued: 80 test files \| Concurrency: 2/.test(line)));
  assert.ok(lines.some(line => /CACHE_SCAN_PROGRESS: checks \| 0 out of 80 scanned \| Workers: 2/.test(line)));
  assert.ok(lines.some(line => /CACHE_SCAN_PROGRESS: checks \| 80 out of 80 scanned \| Workers: 0/.test(line)));
  peak = reads = 0;
  lines.length = 0;
  assert.equal((await runChecks(definitions, { workers: 1, scanConcurrency: 5, logger })).exitCode, 0);
  assert.equal(peak, 5);
  assert.equal(reads, 80);
  assert.ok(lines.some(line => /Queued: 80 test files \| Concurrency: 5/.test(line)));
  peak = reads = 0;
  lines.length = 0;
  assert.equal((await runTests({ ...await loadConfig(join(root, 'one.json')), logger })).cached, 40);
  assert.equal(peak, 2);
  assert.equal(reads, 40);
  assert.ok(lines.some(line => /Scanning 40 test files \| Concurrency: 2/.test(line)));
  assert.ok(lines.some(line => /CACHE_SCAN_PROGRESS: one \| 40 out of 40 scanned \| Workers: 0/.test(line)));
  lines.length = 0;
  await runTests({ ...await loadConfig(join(root, 'one.json')), logger, progress: false });
  assert.equal(lines.some(line => line.startsWith('CACHE_SCAN_PROGRESS:')), false);
  lines.length = 0;
  await runChecks(definitions, { workers: 1, logger, progress: false });
  assert.equal(lines.some(line => line.startsWith('CACHE_SCAN_PROGRESS:')), false);
  peak = reads = 0;
  const ids = Array.from({ length: 40 }, (_, index) => `adapter-${index}`);
  assert.equal((await runCachedUnits({
    suite: 'adapter', scanConcurrency: 3, cacheDirectory, workers: 1, logger: null,
    units: ids.map(id => ({ id, identity: 'fixture' })),
    snapshot: () => ({ common: 'same', units: Object.fromEntries(ids.map(id => [id, 'same'])) }),
    execute: () => 0,
  })).exitCode, 0);
  assert.equal(peak, 3);
  assert.equal(reads, 40);
});

test('CLI run and checks use project JSON scan settings', async t => {
  const root = await realpath(await temporary(t));
  await put(root, 'test/a.test.mjs', '');
  await put(root, 'project-checks.config.json', JSON.stringify({ inputs: [], coverage: false, scanConcurrency: 7 }));
  await put(root, 'suite.json', JSON.stringify({ inputs: [], coverage: false, scanConcurrency: 2 }));
  await put(root, 'checks.json', JSON.stringify({ checks: { tests: { config: 'suite.json' } }, targets: { default: ['tests'] } }));
  const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
  const execute = args => spawnSync(process.execPath, [join(packageRoot, 'bin/project-checks.mjs'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 30000,
  });
  const run = execute(['run', '--workers', '1']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Scanning 1 test files \| Concurrency: 7/);
  assert.match(run.stdout, /CACHE_SCAN_PROGRESS: tests \| 1 out of 1 scanned \| Workers: 0/);
  const checks = execute(['checks', '--config', 'checks.json', '--workers', '1']);
  assert.equal(checks.status, 0, checks.stderr);
  assert.match(checks.stdout, /Queued: 1 test files \| Concurrency: 7/);
  assert.match(checks.stdout, /CACHE_SCAN_PROGRESS: checks \| 1 out of 1 scanned \| Workers: 0/);
  assert.equal(JSON.parse(await readFile(join(root, 'project-checks.config.json'), 'utf8')).scanConcurrency, 7);
});
