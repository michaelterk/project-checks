import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createDiagnostics, createProgress, runCachedUnits, runChecks, runTests } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

function capture() {
  const lines = [];
  return { lines, logger: { log: line => lines.push(line), error: line => lines.push(line) } };
}
const summary = lines => lines.filter(line => line.startsWith('\nTEST_SUMMARY:'));

test('combined totals wait for all inventories and retain completed suites', () => {
  const { lines, logger } = capture();
  const progress = createProgress({ logger, suites: ['one', 'two'] });
  try {
    progress.files('one', 2);
    progress.file('one', 'a', 'file-end', { status: 0 });
    progress.file('one', 'b', 'cache-hit');
    assert.equal(lines.length, 0, 'never print a partial denominator');
    progress.files('two', 2);
    assert.match(lines.at(-1), /2 out of 4 test files finished.*Skipped because cache: 1/);
    progress.file('two', 'a', 'file-end', { status: 1 });
    progress.file('two', 'b', 'file-end', { status: 1, timedOut: true });
  } finally { progress.close(1); }
  assert.match(lines.at(-2), /4 out of 4 test files finished/);
  assert.match(summary(lines)[0], /Tests run: 3 \| Success: 1 \| Skipped because cache: 1 \| Failed: 1 \| Timed out: 1.*FAIL/);
});

test('five-second heartbeats append plain lines; closing stops updates and reports elapsed time', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { lines, logger } = capture();
  const progress = createProgress({ logger, suites: ['one'] });
  progress.files('one', 1);
  progress.file('one', 'a', 'file-start');
  const before = lines.length;
  now = 5000;
  t.mock.timers.tick(5000);
  assert.equal(lines.length, before + 1);
  assert.match(lines.at(-1), /0 out of 1.*Running: 1/);
  progress.close(130);
  assert.match(lines.at(-1), /Duration: 5.00s \| INTERRUPTED/);
  assert.equal(lines.some(line => /[\r\x1b]/.test(line)), false);
  const closed = lines.length;
  progress.close(0);
  t.mock.timers.tick(10000);
  assert.equal(lines.length, closed);
});

test('cache engine summarizes unique files after successful and exhausted retries', async t => {
  const root = await temporary(t);
  const ids = ['cached', 'success', 'retry-success', 'failed', 'retry-timeout'];
  let revision = 'seed';
  const options = {
    suite: 'mixed', cacheDirectory: join(root, 'cache'), workers: 2,
    units: ids.map(id => ({ id, identity: 'fixture' })), retryTimeouts: true,
    snapshot: () => ({ common: 'stable', units: Object.fromEntries(ids.map(id => [id, id === 'cached' ? 'stable' : revision])) }),
    logger: null,
  };
  assert.equal((await runCachedUnits({ ...options, execute: () => 0 })).passed, 5);
  revision = 'changed';
  const { lines, logger } = capture();
  const attempts = [];
  const result = await runCachedUnits({ ...options, logger, execute: (unit, context) => {
    attempts.push([unit.id, context.retry]);
    if (unit.id.startsWith('retry-') && (!context.retry || unit.id === 'retry-timeout')) {
      context.reportTimeout({ ordinaryFailure: false });
      return 1;
    }
    return unit.id === 'failed' ? 7 : 0;
  } });
  assert.equal(result.exitCode, 7);
  assert.equal(attempts.length, 6, 'four fresh files plus two retry attempts');
  assert.equal(attempts.some(([id]) => id === 'cached'), false);
  const plan = lines.findIndex(line => /CACHE_SCAN: mixed \| Will run: 4 \| Will skip: 1/.test(line));
  assert.ok(plan >= 0 && plan < lines.findIndex(line => line.startsWith('==> Running')));
  assert.equal(summary(lines).length, 1);
  assert.match(summary(lines)[0], /Tests run: 4 \| Success: 2 \| Skipped because cache: 1 \| Failed: 1 \| Timed out: 1 \| Duration: [\d.]+s \| FAIL/);
  assert.match(lines.at(-2), /5 out of 5 test files finished/);
});

test('aborted in-flight files do not become successes, failures or timeouts', async () => {
  const controller = new AbortController();
  const { lines, logger } = capture();
  await assert.rejects(runCachedUnits({
    suite: 'cancel', cache: false, units: [{ id: 'a', identity: 'fixture' }],
    snapshot: () => ({ common: 'stable', units: { a: 'stable' } }),
    logger, signal: controller.signal,
    execute: () => { controller.abort(); controller.signal.throwIfAborted(); },
  }), { name: 'AbortError' });
  assert.match(lines.at(-2), /0 out of 1 test files finished.*Running: 0/);
  assert.match(summary(lines)[0], /Tests run: 1 \| Success: 0.*Failed: 0 \| Timed out: 0.*INTERRUPTED/);
});

test('runTests reports fresh, all-cached and focused runs by default', async t => {
  const root = await temporary(t);
  for (const name of ['a', 'b']) await put(root, `test/${name}.test.mjs`, '');
  const { lines, logger } = capture();
  const options = { root, coverage: false, inputs: [], logger, stdio: 'ignore' };
  await runTests(options);
  assert.ok(lines.some(line => /CACHE_SCAN: tests \| Will run: 2 \| Will skip: 0/.test(line)));
  assert.match(summary(lines).at(-1), /Tests run: 2 \| Success: 2 \| Skipped because cache: 0/);
  lines.length = 0;
  await runTests(options);
  assert.ok(lines.some(line => /CACHE_SCAN: tests \| Will run: 0 \| Will skip: 2/.test(line)));
  assert.match(summary(lines)[0], /Tests run: 0 \| Success: 0 \| Skipped because cache: 2/);
  lines.length = 0;
  await runTests({ ...options, files: ['test/a.test.mjs'] });
  assert.ok(lines.some(line => /CACHE_SCAN: tests \| Will run: 0 \| Will skip: 1/.test(line)));
  assert.match(lines.at(-2), /1 out of 1 test files finished/);
  assert.match(summary(lines)[0], /Skipped because cache: 1/);
  lines.length = 0;
  await runTests({ ...options, progress: false });
  assert.equal(lines.some(line => /TEST_PROGRESS|TEST_SUMMARY/.test(line)), false);
  lines.length = 0;
  await runTests({ ...options, cache: false });
  assert.ok(lines.some(line => /Will run: 2 \| Will skip: 0.*Cache disabled/.test(line)));
});

test('runChecks shares one total across suites with identical default suite IDs', async t => {
  const root = await temporary(t);
  for (const name of ['a', 'b']) await put(root, `test/${name}.test.mjs`, '');
  const { lines, logger } = capture();
  const config = { root, coverage: false, inputs: [], cache: false, setup: () => ({ execute: async () => {
    await new Promise(resolve => setImmediate(resolve));
    return 0;
  } }) };
  await runChecks([{ id: 'one', config }, { id: 'two', config }], { logger, workers: 2 });
  const progress = lines.filter(line => line.startsWith('\nTEST_PROGRESS:'));
  assert.ok(progress.length);
  assert.ok(progress.every(line => /out of 4 test files/.test(line)));
  assert.equal(summary(lines).length, 1);
  assert.match(summary(lines)[0], /Tests run: 4 \| Success: 4.*PASS/);
});

test('final graph validation failures cannot produce a passing summary', async t => {
  const root = await temporary(t);
  await put(root, 'test/a.test.mjs', '');
  await put(root, 'source', 'old');
  const { lines, logger } = capture();
  await assert.rejects(runChecks([
    { id: 'tests', config: { root, coverage: false, inputs: ['source'], stdio: 'ignore' } },
    { id: 'mutate', dependsOn: ['tests'], cwd: root, command: [process.execPath, '-e', "require('node:fs').writeFileSync('source','new')"] },
  ], { logger }), /inputs changed/);
  assert.match(summary(lines)[0], /Tests run: 1 \| Success: 1.*FAIL/);
});

test('shared diagnostics retain all suite outcomes until the whole invocation closes', async t => {
  const root = await temporary(t);
  await put(root, 'test/a.test.mjs', '');
  const { lines, logger } = capture();
  const diagnostics = createDiagnostics({ logger, suites: ['one', 'two'] });
  try {
    for (const suite of ['one', 'two']) {
      diagnostics.suiteStart(suite);
      await runTests({ root, suite, diagnostics, logger, inputs: [], coverage: false, stdio: 'ignore' });
      diagnostics.suiteEnd(suite);
    }
    assert.equal(summary(lines).length, 0);
  } finally { diagnostics.close(0); }
  assert.equal(summary(lines).length, 1);
  assert.match(lines.at(-2), /2 out of 2 test files finished/);
  assert.match(summary(lines)[0], /Tests run: 2 \| Success: 2.*PASS/);
});

test('stdout redirected to a file contains visible progress and final summary', async t => {
  const root = await temporary(t);
  await put(root, 'test/a.test.mjs', '');
  const log = join(root, 'output.log');
  const handle = await open(log, 'a');
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { runTests } from ${JSON.stringify(new URL('../src/index.mjs', import.meta.url).href)};
       await runTests({ root: ${JSON.stringify(root)}, inputs: [], coverage: false, stdio: 'ignore' });`],
    { stdio: ['ignore', handle.fd, handle.fd] });
    assert.equal(result.status, 0);
  } finally { await handle.close(); }
  const output = await readFile(log, 'utf8');
  assert.match(output, /\nTEST_PROGRESS: 1 out of 1 test files finished/);
  assert.match(output, /\nTEST_SUMMARY: Tests run: 1.*Duration: [\d.]+s \| PASS\n/);
  assert.doesNotMatch(output, /[\r\x1b]/);
});

test('queued and validating files are distinct from executing commands until evidence drains', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const root = await temporary(t);
  await put(root, 'artifact', 'coverage');
  const saving = Promise.withResolvers(), release = Promise.withResolvers();
  const { lines, logger } = capture();
  const starts = [];
  const running = runCachedUnits({
    cache: false, workers: 1, logger,
    units: ['a', 'b'].map(id => ({ id, identity: 'fixture' })),
    snapshot: () => ({ common: 'stable', units: { a: 'stable', b: 'stable' } }),
    execute: unit => { starts.push(unit.id); return 0; },
    restoreEvidence: () => true,
    saveEvidence: async unit => {
      if (unit.id === 'a') { saving.resolve(); await release.promise; }
      return { files: [join(root, 'artifact')] };
    },
  });
  await saving.promise;
  t.mock.timers.tick(5000);
  assert.deepEqual(starts, ['a']);
  assert.match(lines.at(-1), /0 out of 2.*Queued: 1 \| Running: 0 \| Validating: 1/);
  release.resolve();
  assert.equal((await running).exitCode, 0);
  assert.match(lines.at(-2), /2 out of 2.*Queued: 0 \| Running: 0 \| Validating: 0/);
});


test('cancellation clears queued counts without counting unstarted files as run', async () => {
  const controller = new AbortController();
  const { lines, logger } = capture();
  await assert.rejects(runCachedUnits({
    cache: false, workers: 1, signal: controller.signal, logger,
    units: ['a', 'b'].map(id => ({ id, identity: 'fixture' })),
    snapshot: () => ({ common: 'stable', units: { a: 'stable', b: 'stable' } }),
    execute: () => { controller.abort(); controller.signal.throwIfAborted(); },
  }), { name: 'AbortError' });
  assert.match(lines.at(-2), /Queued: 0 \| Running: 0 \| Validating: 0/);
  assert.match(lines.at(-1), /Tests run: 1.*INTERRUPTED/);
});
