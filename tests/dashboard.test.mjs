import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createDashboardState } from '../src/dashboard-state.mjs';
import { createDashboardRecorder, dashboardDirectory, discardRun, listRuns, readRun } from '../src/dashboard-store.mjs';
import { startDashboardServer } from '../src/dashboard-server.mjs';
import { excludedTests, excludeTest } from '../src/test-exclusions.mjs';
import { excludeFailures } from '../src/failure-exclusions.mjs';
import { createDiagnostics, runChecks, runTests } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

test('dashboard totals, scheduler order, retry replacement and ETA follow verified events', () => {
  let now = 100000;
  const state = createDashboardState({ root: '/project', target: 'checks', suites: ['a', 'b'], now: () => now });
  const progress = (suite, file, kind, fields = {}) => state.event({ event: 'progress-file', suite, file, kind, ...fields });
  state.event({ event: 'progress-files', suite: 'a', total: 2 });
  assert.equal(state.snapshot().counts.total, null);
  state.event({ event: 'inventory', suite: 'a', root: '/project', files: ['one', 'two'] });
  state.event({ event: 'progress-files', suite: 'b', total: 1 });
  progress('b', 'one', 'cache-hit');
  progress('a', 'one', 'file-queued');
  progress('a', 'two', 'file-queued');
  assert.equal(state.snapshot().etaSeconds, null);
  state.event({ event: 'file-estimates', suite: 'a', files: [{ file: 'one', seconds: 10 }, { file: 'two', seconds: 20 }] });
  state.event({ event: 'file-order', suite: 'a', files: ['two', 'one'] });
  state.event({ event: 'sample', admission: { active: 1, limit: 1, capacity: 4 }, cpuPercent: 65 });
  assert.equal(state.snapshot().etaSeconds, 30);
  progress('a', 'two', 'file-start');
  now += 10000;
  assert.equal(state.snapshot().etaSeconds, 20);
  state.event({ event: 'file-end', suite: 'a', file: 'two', seconds: 10 });
  progress('a', 'two', 'file-validating');
  assert.equal(state.snapshot().counts.finished, 1);
  progress('a', 'two', 'file-end', { status: 1, timedOut: true });
  progress('a', 'two', 'file-start');
  assert.equal(state.snapshot().counts['timed-out'], 0);
  progress('a', 'two', 'file-end', { status: 0 });
  progress('a', 'one', 'file-end', { status: 7 });
  state.finish(7);
  state.event({ event: 'progress-files', suite: 'a', total: 999 });
  const result = state.snapshot();
  assert.equal(result.counts.total, 3);
  assert.equal(result.counts.finished, 3);
  assert.equal(result.counts.cached, 1);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.elapsedSeconds, 10);
  assert.equal(result.etaSeconds, 0);
  assert.equal(result.files.find(file => file.file === 'two').order, 0);
});

async function recorded(t, execute) {
  const root = await temporary(t);
  await put(root, 'test/a.test.mjs', '');
  await put(root, 'test/b.test.mjs', '');
  const options = { root, inputs: [], coverage: false, logger: false, workers: 1,
    setup: () => ({ execute }) };
  const recorder = await createDashboardRecorder({ root, target: 'unit', suites: ['unit'] });
  const diagnostics = createDiagnostics({ logger: false, suites: ['unit'], onEvent: recorder.event });
  let result;
  try {
    result = await runChecks([{ id: 'unit', config: options }], { diagnostics, logger: false, workers: 1 });
  } finally {
    diagnostics.close(result?.exitCode ?? 2);
    await recorder.close(result?.exitCode ?? 2);
  }
  return { root, options, recorder, result, directory: dashboardDirectory(root) };
}

test('discard removes only a failed run manifest by default and does not resurrect on close', async t => {
  const f = await recorded(t, () => 1);
  const manifest = await readRun(f.directory, f.recorder.id);
  assert.equal(manifest.counts.failed, 2);
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.files.length, 2);
  await discardRun(f.directory, f.root, f.recorder.id);
  await f.recorder.close(0);
  await f.recorder.flush();
  assert.deepEqual(await listRuns(f.directory), []);
  assert.deepEqual([...await excludedTests(f.root)], []);
  assert.equal(await readFile(join(f.root, 'test/a.test.mjs'), 'utf8'), '');
  let calls = 0;
  assert.equal((await runTests({ ...f.options, setup: () => ({ execute: () => { calls++; return 0; } }) })).passed, 2);
  assert.equal(calls, 2);
});

test('optional exclusion persists only failed files, applies without dashboard or cache, and is concurrency-safe', async t => {
  const f = await recorded(t, command => command.at(-1).endsWith('a.test.mjs') ? 1 : 0);
  await Promise.all([
    discardRun(f.directory, f.root, f.recorder.id, true),
    discardRun(f.directory, f.root, f.recorder.id, true),
  ]);
  assert.deepEqual([...await excludedTests(f.root)], ['test/a.test.mjs']);
  const calls = [];
  const result = await runTests({ ...f.options, cache: false,
    setup: () => ({ execute: command => { calls.push(command.at(-1)); return 0; } }) });
  assert.equal(result.passed, 1);
  assert.deepEqual(calls, ['test/b.test.mjs']);
  assert.equal(await readFile(join(f.root, 'test/a.test.mjs'), 'utf8'), '');
  assert.deepEqual(await readdir(join(f.directory, 'runs')), []);
});

test('all explicitly excluded files settle the shared scan and are visibly excluded', async t => {
  const f = await recorded(t, () => 1);
  await discardRun(f.directory, f.root, f.recorder.id, true);
  const result = await runChecks([{ id: 'unit', config: { ...f.options,
    setup: () => { throw new Error('excluded suite must not launch'); } } }], { logger: false });
  assert.equal(result.exitCode, 0);
  assert.equal(result.results[0].excluded, 2);
  assert.equal(result.results[0].total, 0);
});

test('running and passing invocations cannot be discarded or excluded', async t => {
  const root = await temporary(t);
  const recorder = await createDashboardRecorder({ root, target: 'unit' });
  const directory = dashboardDirectory(root);
  await assert.rejects(discardRun(directory, root, recorder.id, true), /completed failed/);
  await recorder.close(0);
  await assert.rejects(discardRun(directory, root, recorder.id, true), /completed failed/);
  await assert.rejects(readRun(directory, '../outside'), /Invalid run ID/);
});

test('live files become terminal only after validation; cancellation preserves the real exit result', async t => {
  const root = await temporary(t);
  await put(root, 'test/a.test.mjs', '');
  const state = createDashboardState({ root, suites: ['tests'] });
  const controller = new AbortController();
  const diagnostics = createDiagnostics({ logger: false, onEvent: value => state.event(value) });
  try {
    await assert.rejects(runTests({ root, inputs: [], coverage: false, logger: false, diagnostics,
      signal: controller.signal, setup: () => ({ execute: () => {
        assert.equal(state.snapshot().counts.running, 1);
        controller.abort(); controller.signal.throwIfAborted();
      } }) }), { name: 'AbortError' });
  } finally { diagnostics.close(130); state.finish(130); }
  assert.equal(state.snapshot().status, 'interrupted');
  assert.equal(state.snapshot().counts.passed, 0);
  assert.equal(state.snapshot().counts.running, 0);
});

test('loopback HTTP serves the packaged assets and requires origin and token for discard', async t => {
  const f = await recorded(t, () => 1);
  const server = await startDashboardServer({ root: f.root });
  t.after(() => server.close());
  const get = path => fetch(server.url + path);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Also exclude failed test files/);
  for (const path of ['/dashboard.css', '/dashboard.js']) assert.equal((await get(path)).status, 200);
  const data = await (await get('/api/runs')).json();
  assert.equal(data.runs[0].id, f.recorder.id);
  const path = `/api/runs/${f.recorder.id}/discard`;
  assert.equal((await fetch(server.url + path, { method: 'POST' })).status, 403);
  const headers = { 'Content-Type': 'application/json', Origin: server.url, 'X-Dashboard-Token': data.token };
  assert.equal((await fetch(server.url + path, { method: 'POST', headers: { ...headers, Origin: 'https://example.org' }, body: '{}' })).status, 403);
  assert.equal((await fetch(server.url + path, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(server.url + path, { method: 'POST', headers, body: JSON.stringify({ excludeTests: false }) })).status, 200);
  assert.equal((await get(`/api/runs/${f.recorder.id}`)).status, 404);
  assert.deepEqual((await (await get('/api/runs')).json()).runs, []);
});

test('current-run exclusion removes failed files from results and the manifest without future exclusion', async t => {
  const root = await temporary(t);
  for (const file of ['a', 'b']) await put(root, `test/${file}.test.mjs`, '');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const recorder = await createDashboardRecorder({ root, target: 'checks', suites: ['unit'] });
  const diagnostics = createDiagnostics({ logger: false, suites: ['unit'], onEvent: recorder.event });
  const running = runChecks([{ id: 'unit', config: { root, inputs: [], coverage: false,
    setup: () => ({ execute: async command => {
      if (command.at(-1).endsWith('a.test.mjs')) return 1;
      entered.resolve(); await release.promise; return 0;
    } }) } }], { logger: false, workers: 1, diagnostics, failureExclusions: recorder.failureExclusions });
  let result;
  try {
    await entered.promise;
    await recorder.flush();
    const directory = dashboardDirectory(root);
    assert.equal((await readRun(directory, recorder.id)).counts.failed, 1);
    await discardRun(directory, root, recorder.id, false, true);
    release.resolve();
    result = await running;
    assert.equal(result.exitCode, 0);
    assert.equal(result.results[0].excluded, 1);
    assert.equal(result.results[0].failed, 0);
    await assert.rejects(discardRun(directory, root, recorder.id, false, true), /finishing/);
  } finally {
    release.resolve(); await running;
    diagnostics.close(result?.exitCode ?? 2); await recorder.close(result?.exitCode ?? 2);
  }
  const manifest = await readRun(dashboardDirectory(root), recorder.id);
  assert.equal(manifest.status, 'passed');
  assert.equal(manifest.counts.excluded, 1);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].file, 'test/b.test.mjs');
  assert.deepEqual([...await excludedTests(root)], []);
});

test('late exclusions reconcile a finished suite while other suites run; validation failure stays failed', async t => {
  const root = await temporary(t);
  await put(root, 'test/a.test.mjs', '');
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const ended = Promise.withResolvers();
  const excluded = [];
  const diagnostics = createDiagnostics({ logger: false, onEvent: value => {
    if (value.event === 'suite-transition' && value.suite === 'bad') ended.resolve();
  } });
  const config = { root, inputs: [], coverage: false, setup: () => ({ execute: () => 1 }) };
  const running = runChecks([
    { id: 'bad', config },
    { id: 'waiting', config: { ...config, setup: () => ({ execute: async () => { await barrier; return 0; } }) } },
  ], { logger: false, diagnostics, workers: 2,
    failureExclusions: { files: async suite => suite === 'bad' ? excluded : [], close: async () => {} } });
  try {
    await ended.promise;
    excluded.push('test/a.test.mjs');
    release();
    const result = await running;
    assert.equal(result.exitCode, 0);
    assert.equal(result.results[0].excluded, 1);
  } finally { release(); await running; diagnostics.close(0); }
  const result = { failed: 1, results: [{ id: 'a', exitCode: 1 }], inputsChanged: true, exitCode: 1 };
  await excludeFailures(result, { files: async () => ['a'] }, 'unit', false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failed, 0);
});

test('excluding a current failure still enforces coverage on the remaining test contributions', async t => {
  const root = await temporary(t);
  await put(root, 'source.mjs', 'export function used() { return 1; }\nexport function missing() { return 2; }\n');
  await put(root, 'test/pass.test.mjs', "import { used } from '../source.mjs'; used();\n");
  await put(root, 'test/fail.test.mjs', 'process.exitCode = 1;\n');
  const result = await runTests({ root, inputs: ['source.mjs'], coverage: { include: ['source.mjs'] }, logger: false, stdio: 'ignore', workers: 1,
    failureExclusions: { files: async () => ['test/fail.test.mjs'], close: async () => {} } });
  assert.equal(result.excluded, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.exitCode, 1, 'uncovered function still fails the coverage gate');
});

test('future exclusions also constrain uncached framework actions and their dashboard inventory', async t => {
  const root = await temporary(t);
  for (const file of ['a', 'b']) await put(root, `test/${file}.test.mjs`, '');
  await excludeTest(root, 'test/a.test.mjs');
  const state = createDashboardState({ root, suites: ['tests'] });
  const diagnostics = createDiagnostics({ logger: false, onEvent: value => state.event(value) });
  const commands = [];
  try {
    const result = await runTests({ root, inputs: [], coverage: false, logger: false, diagnostics,
      engine: 'playwright', command: ['playwright', 'test', '{file}'], frameworkArgs: ['--update-snapshots'],
      setup: () => ({ execute: command => { commands.push(command); return 0; } }) });
    assert.equal(result.exitCode, 0);
    assert.equal(commands[0].length, 4);
    assert.match(commands[0][2], /b\\\.test\\\.mjs\$$/);
    assert.equal(state.snapshot().counts.total, 1);
    assert.equal(state.snapshot().files.length, 1);
    assert.equal(state.snapshot().files[0].file, 'framework-action');
  } finally { diagnostics.close(0); }
});
