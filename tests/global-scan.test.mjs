import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { cacheRecordName, runChecks, runTests, loadChecks } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

function observeRecords(t, directory, observe) {
  const original = fs.readFile;
  t.mock.method(fs, 'readFile', (file, ...args) =>
    typeof file === 'string' && file.startsWith(`${directory}/`) && file.endsWith('.json')
      ? observe(file, () => original(file, ...args)) : original(file, ...args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

const config = (root, suite) => ({ root, suite, inputs: [], coverage: false });
const project = async t => realpath(await temporary(t));

test('all independent and dependent suites are queued before the first of 16 scan workers reads', async t => {
  const root = await project(t);
  for (let index = 0; index < 40; index++) await put(root, `test/${index}.test.mjs`, 'old');
  const cacheDirectory = join(root, '.test-cache/project-checks');
  const definitions = ['one', 'two'].map(id => ({ id, config: {
    ...config(root, id), setup: () => ({ execute: () => 0 }),
  } }));
  assert.equal((await runChecks(definitions, { logger: false, workers: 1 })).exitCode, 0);
  for (let index = 1; index < 40; index += 2) await writeFile(join(root, `test/${index}.test.mjs`), 'new');
  const reads = new Map();
  let active = 0, peak = 0, commands = 0;
  let slowConfigReady = false;
  const lines = [];
  observeRecords(t, cacheDirectory, async (file, read) => {
    assert.equal(slowConfigReady, true, 'a fast suite cannot start scanning while another configuration is still loading');
    assert.ok(lines.some(line => /Queued: 80 test files \| Concurrency: 16/.test(line)));
    active++;
    peak = Math.max(peak, active);
    reads.set(file, (reads.get(file) ?? 0) + 1);
    try { await delay(3); return await read(); }
    finally { active--; }
  });
  const logger = { log: line => {
    if (/Queued: 80 test files/.test(line)) assert.equal(reads.size, 0, 'all 80 jobs must be queued before any read');
    lines.push(line);
  }, error: line => lines.push(line) };
  const assertScanned = () => {
    assert.equal(reads.size, 80);
    assert.equal(active, 0);
    assert.ok(lines.some(line => /CACHE_SCAN: checks \| Will run: 40 \| Will skip: 40 \| Total: 80/.test(line)));
  };
  for (const definition of definitions) definition.config.setup = async () => {
    assertScanned();
    assert.equal(await readFile(join(root, 'built'), 'utf8'), 'ready');
    if (definition.id === 'two') assert.equal(commands, 20, 'dependent setup waits for the first suite');
    return { execute: () => { assertScanned(); commands++; return 0; } };
  };
  definitions[0].dependsOn = ['build'];
  definitions[1].dependsOn = ['one'];
  const secondConfig = definitions[1].config;
  definitions[1].config = async () => { await delay(30); slowConfigReady = true; return secondConfig; };
  const result = await runChecks([
    { id: 'build', cwd: root, command: [process.execPath, '-e', "require('node:fs').writeFileSync('built','ready')"], verify: () => {
      if (!slowConfigReady) assert.equal(reads.size, 0);
    } },
    { id: 'unrelated', cwd: root, command: [process.execPath, '-e', ''], verify: assertScanned },
    ...definitions,
  ], { logger, workers: 1 });
  assert.equal(result.exitCode, 0);
  assert.equal(peak, 16);
  assert.ok([...reads.values()].every(count => count === 1));
  assert.equal(commands, 40);
  assert.equal(lines.filter(line => line.startsWith('CACHE_SCAN:')).length, 3);
});

test('global scan failure drains siblings and never starts builds or setup', async t => {
  const root = await project(t);
  for (let index = 0; index < 40; index++) await put(root, `test/${index}.test.mjs`, '');
  const cacheDirectory = join(root, '.test-cache/project-checks');
  let active = 0, entered = 0, setup = 0;
  const failure = new Error('global scan read failed');
  observeRecords(t, cacheDirectory, async () => {
    active++;
    const index = entered++;
    try { await delay(index ? 20 : 5); throw failure; }
    finally { active--; }
  });
  await assert.rejects(runChecks([
    { id: 'build', cwd: root, command: [process.execPath, '-e', "require('node:fs').writeFileSync('built','unsafe')"] },
    ...['one', 'two'].map(id => ({ id, config: {
      ...config(root, id), setup: () => { setup++; return { execute: () => 0 }; },
    } })),
  ], { logger: false, workers: 1 }), error => error === failure);
  assert.equal(entered, 16, 'the remaining queued files never start I/O after a fatal scan failure');
  assert.equal(active, 0);
  assert.equal(setup, 0);
  await assert.rejects(readFile(join(root, 'built')), { code: 'ENOENT' });
});

test('cancellation drains the global scan and releases suites waiting at its barrier', async t => {
  const root = await project(t);
  await put(root, 'test/a.test.mjs', '');
  const cacheDirectory = join(root, '.test-cache/project-checks');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let active = 0, setup = 0, scanEnded = 0;
  const diagnostics = {
    event() {}, files() {}, file() {},
    span: async (_, stage, operation) => {
      try { return await operation(); }
      finally { if (stage === 'cache-scan') scanEnded++; }
    },
  };
  observeRecords(t, cacheDirectory, async (_file, read) => {
    active++;
    entered.resolve();
    try { await release.promise; return await read(); }
    finally { active--; }
  });
  const controller = new AbortController(), reason = new Error('cancel global scan');
  const running = runChecks(['one', 'two'].map(id => ({ id, config: {
    ...config(root, id), diagnostics, setup: () => { setup++; return { execute: () => 0 }; },
  } })), { logger: false, signal: controller.signal });
  const rejected = assert.rejects(running, error => error === reason);
  await entered.promise;
  controller.abort(reason);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scanEnded, 0, 'suite scan handles remain open until active queue jobs have drained');
  release.resolve();
  await rejected;
  assert.equal(active, 0);
  assert.equal(setup, 0);
  assert.equal(scanEnded, 2);
  assert.equal((await runChecks([{ id: 'again', config: {
    ...config(root, 'again'), setup: () => ({ execute: () => 0 }),
  } }], { logger: false })).exitCode, 0);
});

test('nested dependent projects populate one complete queue with cached and uncached files', async t => {
  const root = await project(t);
  await put(root, 'test/a.test.mjs', '');
  await put(root, 'cached.json', JSON.stringify({ inputs: [], coverage: false, suite: 'cached' }));
  await put(root, 'fresh.json', JSON.stringify({ inputs: [], coverage: false, cache: false }));
  await put(root, 'child.json', JSON.stringify({ checks: { cached: { config: 'cached.json' } }, targets: { default: ['cached'] } }));
  await put(root, 'checks.json', JSON.stringify({ checks: {
    nested: { project: 'child.json' }, fresh: { config: 'fresh.json', dependsOn: ['nested'] },
  }, targets: { default: ['fresh'] } }));
  assert.equal((await runTests({ ...config(root, 'cached'), logger: false, stdio: 'ignore' })).exitCode, 0);
  const lines = [];
  const result = await runChecks(await loadChecks(join(root, 'checks.json')), {
    logger: { log: line => lines.push(line), error: line => lines.push(line) }, workers: 1,
  });
  assert.equal(result.exitCode, 0);
  const scans = lines.filter(line => line.startsWith('CACHE_SCAN:'));
  assert.equal(scans.length, 3);
  assert.match(scans[1], /Queued: 2 test files \| Concurrency: 16/);
  assert.match(scans[2], /Will run: 1 \| Will skip: 1 \| Total: 2/);
  assert.ok(lines.indexOf(scans[2]) < lines.findIndex(line => line.startsWith('==> Running')));
});

test('setup changes after a cached global plan fail final verification', async t => {
  const root = await project(t);
  await put(root, 'test/a.test.mjs', '');
  await put(root, 'source', 'old');
  const suite = { ...config(root, 'cached'), inputs: ['source'] };
  assert.equal((await runTests({ ...suite, logger: false, stdio: 'ignore' })).exitCode, 0);
  const lines = [];
  let commands = 0;
  await assert.rejects(runChecks([{ id: 'cached', config: { ...suite, setup: async () => {
    await writeFile(join(root, 'source'), 'new');
    return { execute: () => { commands++; return 0; } };
  } } }], { logger: { log: line => lines.push(line), error: line => lines.push(line) } }), /inputs changed/);
  assert.equal(commands, 0);
  assert.ok(lines.some(line => /Will run: 0 \| Will skip: 1/.test(line)));
  assert.match(lines.at(-1), /TEST_SUMMARY:.*FAIL/);
  assert.equal((await runTests({ ...suite, logger: false, stdio: 'ignore' })).cached, 0);
});

test('failed prerequisites block dependent cache scans and fixture setup', async t => {
  const root = await project(t);
  await put(root, 'test/a.test.mjs', '');
  let blockedSetup = 0, closed = 0;
  const result = await runChecks([
    { id: 'broken', command: [process.execPath, '-e', 'process.exit(7)'] },
    { id: 'blocked', dependsOn: ['broken'], config: { ...config(root, 'blocked'), setup: () => { blockedSetup++; } } },
    { id: 'independent', config: { ...config(root, 'independent'), setup: () => ({ execute: () => 0, close: () => { closed++; } }) } },
  ], { logger: false, workers: 1 });
  assert.equal(result.exitCode, 7);
  assert.equal(result.results.find(result => result.id === 'blocked').skipped, true);
  assert.equal(blockedSetup, 0);
  assert.equal(closed, 1);
});

test('global totals include artifact validation and missing-artifact fallbacks before setup', async t => {
  const root = await project(t);
  await put(root, 'source.mjs', 'export const answer = 42;');
  for (const id of ['a', 'b']) await put(root, `test/${id}.test.mjs`, "import '../source.mjs';");
  const definitions = ['one', 'two'].map((id, index) => ({ id, config: {
    root, suite: id, files: [`test/${index ? 'b' : 'a'}.test.mjs`], inputs: ['source.mjs'],
    coverage: { include: ['source.mjs'] }, stdio: 'ignore',
  } }));
  for (const definition of definitions) assert.equal((await runTests({ ...definition.config, logger: false })).exitCode, 0);
  const record = JSON.parse(await readFile(join(root, '.test-cache/project-checks', cacheRecordName('two', 'test/b.test.mjs')), 'utf8'));
  await rm(record.evidence.files[0]);
  const lines = [];
  for (const definition of definitions) definition.config.setup = () => {
    assert.ok(lines.some(line => /CACHE_SCAN: checks \| Will run: 1 \| Will skip: 1 \| Total: 2/.test(line)));
  };
  const result = await runChecks(definitions, { logger: { log: line => lines.push(line), error: line => lines.push(line) }, workers: 1 });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.results.map(({ passed, cached }) => [passed, cached]), [[0, 1], [1, 0]]);
});

test('command prerequisites that need test results fail before global scan or execution', async t => {
  const root = await project(t);
  await put(root, 'test/a.test.mjs', '');
  await assert.rejects(runChecks([
    { id: 'first', config: config(root, 'first') },
    { id: 'build', dependsOn: ['first'], cwd: root, command: [process.execPath, '-e', "require('node:fs').writeFileSync('built','unsafe')"] },
    { id: 'second', dependsOn: ['build'], config: config(root, 'second') },
  ], { logger: false }), /Global scan cannot run command prerequisite build before test suite first/);
  await assert.rejects(readFile(join(root, 'built')), { code: 'ENOENT' });
});
