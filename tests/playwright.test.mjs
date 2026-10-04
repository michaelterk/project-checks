import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { runCachedUnits, runCommand } from '../src/index.mjs';
import { classifyPlaywrightReport } from '../src/playwright-reporter.mjs';
import { put, temporary } from './helpers.mjs';

const playwrightRoot = process.env.PROJECT_CHECKS_PLAYWRIGHT_ROOT;
const native = { skip: !playwrightRoot && 'Set PROJECT_CHECKS_PLAYWRIGHT_ROOT to an installed playwright package' };
const encode = events => events.map(event => JSON.stringify(event)).join('\n');
const event = (status, errors = 0) => ({ type: 'test', status, expectedStatus: 'passed', errors });

test('native events distinguish timeouts, extra teardown failures and unrelated interruption', () => {
  assert.deepEqual(classifyPlaywrightReport(encode([event('timedOut', 1), { type: 'end', status: 'failed' }])), { timedOut: true, ordinaryFailure: false, complete: true });
  assert.equal(classifyPlaywrightReport(encode([event('timedOut', 2)])).ordinaryFailure, true);
  assert.equal(classifyPlaywrightReport(encode([event('interrupted', 1)])).ordinaryFailure, true);
  assert.equal(classifyPlaywrightReport(encode([event('interrupted', 0)]), { deadlineExpired: true }).ordinaryFailure, false);
  assert.equal(classifyPlaywrightReport(encode([event('interrupted', 1)]), { deadlineExpired: true }).ordinaryFailure, true);
  assert.equal(classifyPlaywrightReport(encode([event('interrupted', 2)]), { deadlineExpired: true }).ordinaryFailure, true);
  assert.equal(classifyPlaywrightReport('not json').ordinaryFailure, true);
});

async function fixture(t, body, config = '') {
  const root = await temporary(t);
  await put(root, 'playwright.config.mjs', `export default { testDir: '.', timeout: 200, ${config} };`);
  await put(root, 'one.spec.mjs', `
    import { test, expect } from ${JSON.stringify(pathToFileURL(join(resolve(playwrightRoot), 'test.mjs')).href)};
    import { readFileSync, writeFileSync } from 'node:fs';
    let attempt = 0;
    test.beforeAll(() => {
      try { attempt = Number(readFileSync('attempt', 'utf8')); } catch {}
      writeFileSync('attempt', String(++attempt));
    });
    ${body}
  `);
  const command = [process.execPath, join(resolve(playwrightRoot), 'cli.js'), 'test', 'one.spec.mjs'];
  const options = { cwd: root, playwrightTest: true, logger: null, stdio: 'ignore' };
  return { root, command, options };
}

async function cached(f, execute) {
  return runCachedUnits({
    units: [{ id: 'one', command: f.command }], workers: 1, retryTimeouts: true, logger: null,
    cacheDirectory: join(f.root, 'cache'), snapshot: () => ({ common: 'fixed', units: { one: 'fixed' } }),
    execute: execute ?? ((unit, { reportTimeout }) => runCommand(unit.command, { ...f.options, onTimeout: reportTimeout })),
  });
}

test('real Playwright timeout retries the whole file once and retains only a passing retry', native, async t => {
  const f = await fixture(t, `test('body', async () => { if (attempt === 1) await new Promise(() => {}); });`);
  assert.equal((await cached(f)).exitCode, 0);
  assert.equal(await readFile(join(f.root, 'attempt'), 'utf8'), '2');
  assert.equal((await cached(f)).cached, 1);
});

test('real Playwright timeout plus failed teardown remains failed after a passing retry', native, async t => {
  const f = await fixture(t, `test.afterEach(() => { if (attempt === 1) throw new Error('teardown'); }); test('body', async () => { if (attempt === 1) await new Promise(() => {}); });`);
  assert.equal((await cached(f)).exitCode, 1);
  assert.equal(await readFile(join(f.root, 'attempt'), 'utf8'), '2');
  assert.deepEqual(await readdir(join(f.root, 'cache')), []);
});

test('wall-deadline interruption preserves a single teardown assertion after a passing retry', native, async t => {
  const f = await fixture(t, `test.afterEach(() => { if (attempt === 1) throw new Error('teardown assertion'); }); test('body', async () => { if (attempt === 1) await new Promise(() => {}); });`);
  f.command.push('--timeout=0');
  const observations = [];
  const result = await cached(f, (unit, { reportTimeout }) => runCommand(unit.command, {
    ...f.options, timeoutMs: 6000,
    onTimeout: outcome => { observations.push(outcome); reportTimeout(outcome); },
  }));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(observations, [{ ordinaryFailure: true }]);
  assert.equal(await readFile(join(f.root, 'attempt'), 'utf8'), '2');
  assert.deepEqual(await readdir(join(f.root, 'cache')), []);
});

test('an explicit CLI artifact reporter survives native timeout observation and retry', native, async t => {
  const f = await fixture(t, `test('body', async () => { if (attempt === 1) await new Promise(() => {}); });`);
  await put(f.root, 'artifact-reporter.cjs', `
    const { appendFileSync } = require('node:fs');
    module.exports = class {
      printsToStdio() { return false; }
      onTestEnd(test, result) { appendFileSync('artifact.jsonl', JSON.stringify({ status: result.status }) + '\\n'); }
    };
  `);
  f.command.push('--reporter', './artifact-reporter.cjs');
  assert.equal((await cached(f)).exitCode, 0);
  const artifacts = (await readFile(join(f.root, 'artifact.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(artifacts, [{ status: 'timedOut' }, { status: 'passed' }]);
  assert.equal((await cached(f)).cached, 1);
});

test('native worker and retry flags cannot create nested parallelism across five projects', native, async t => {
  const f = await fixture(t, `test('body', ({}, info) => { expect(info.config.workers).toBe(1); expect(info.project.retries).toBe(0); });`, `workers: 5, retries: 3, projects: ${JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ name: String(i) })))}`);
  assert.equal(await runCommand([...f.command, '--workers', '7', '--retries=4'], f.options), 0);
  assert.equal(await readFile(join(f.root, 'attempt'), 'utf8'), '5');
});

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function running(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function serverFixture(t, body) {
  const port = await unusedPort();
  const f = await fixture(t, body, `webServer: { command: ${JSON.stringify(`${process.execPath} server.mjs`)}, url: 'http://127.0.0.1:${port}', gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 } }`);
  await put(f.root, 'server.mjs', `
    import { createServer } from 'node:http'; import { readFileSync, writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => { if (Number(readFileSync('attempt', 'utf8')) >= 2) process.exit(0); });
    createServer((req, res) => res.end('ok')).listen(${port}, '127.0.0.1', () => writeFileSync('server-pid', String(process.pid)));
  `);
  t.after(async () => {
    const pid = Number(await readFile(join(f.root, 'server-pid'), 'utf8').catch(() => '0'));
    if (pid && await running(pid)) process.kill(pid, 'SIGKILL');
  });
  return { ...f, port };
}

async function assertServerGone(f) {
  const pid = Number(await readFile(join(f.root, 'server-pid'), 'utf8'));
  const until = Date.now() + 2000;
  while (await running(pid) && Date.now() < until) await delay(10);
  assert.equal(await running(pid), false, 'native web server survived command completion');
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(f.port, '127.0.0.1', resolve));
  await new Promise(resolve => server.close(resolve));
}

async function waitForFile(root, name) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    try { return await readFile(join(root, name), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${name}`);
}

test('cancellation drains a native detached web server and never reports a timeout', { ...native, skip: native.skip || process.platform !== 'linux' }, async t => {
  const f = await serverFixture(t, `test('body', async () => { writeFileSync('ready', 'yes'); await new Promise(() => {}); });`);
  const controller = new AbortController();
  let timeouts = 0;
  const command = runCommand([...f.command, '--timeout=0'], { ...f.options, signal: controller.signal, onTimeout: () => timeouts++ });
  const rejected = assert.rejects(command, { name: 'AbortError' });
  await waitForFile(f.root, 'ready');
  controller.abort();
  await rejected;
  assert.equal(timeouts, 0);
  await assertServerGone(f);
});

for (const mode of ['native timeout', 'wall deadline']) {
  test(`${mode} drains a resistant native web server before its complete retry`, { ...native, skip: native.skip || process.platform !== 'linux' }, async t => {
    const f = await serverFixture(t, `test('body', async () => { if (attempt === 1) await new Promise(() => {}); });`);
    // The wall deadline also bounds a server configured to take ten seconds to stop.
    const result = await cached(f, async (unit, { retry, reportTimeout }) => {
      if (retry) await assertServerGone(f);
      return runCommand([...unit.command, ...(mode === 'wall deadline' && !retry ? ['--timeout=0'] : [])], { ...f.options, timeoutMs: retry ? 10000 : 6000, onTimeout: reportTimeout });
    });
    assert.equal(result.exitCode, 0);
    assert.equal(await readFile(join(f.root, 'attempt'), 'utf8'), '2');
    await assertServerGone(f);
  });
}

test('unresponsive native launcher fails closed without reporting a retryable deadline', async t => {
  const root = await temporary(t);
  const program = await put(root, 'launcher.mjs', `process.on('SIGINT', () => {}); setInterval(() => {}, 1000);`);
  let timeouts = 0;
  await assert.rejects(runCommand([process.execPath, program], { playwrightTest: true, timeoutMs: 300, stdio: 'ignore', logger: null, onTimeout: () => timeouts++ }), /native cleanup/);
  assert.equal(timeouts, 0);
});

for (const mode of ['SIGINT', 'SIGTERM', 'outer abort']) {
  test(`default native API cleanup survives ${mode} through bash/npm`, { ...native, skip: native.skip || process.platform !== 'linux' }, async t => {
    const f = await serverFixture(t, `test('body', async () => { writeFileSync('ready', 'yes'); await new Promise(() => {}); });`);
    const packageURL = new URL('../src/index.mjs', import.meta.url).href;
    await put(f.root, 'entry.mjs', `
      import assert from 'node:assert/strict'; import { writeFileSync } from 'node:fs';
      import { runCommand } from ${JSON.stringify(packageURL)};
      await assert.rejects(runCommand(${JSON.stringify([...f.command, '--timeout=0'])}, { playwrightTest: true, stdio: 'ignore' }), { name: 'AbortError' });
      writeFileSync('drained', 'yes');
    `);
    await put(f.root, 'package.json', JSON.stringify({ private: true, scripts: { check: `${JSON.stringify(process.execPath)} entry.mjs` } }));
    await put(f.root, 'outer.mjs', `
      import assert from 'node:assert/strict';
      import { runCommand } from ${JSON.stringify(packageURL)};
      await assert.rejects(runCommand(['bash', '-c', 'npm run check'], { stdio: 'ignore' }), { name: 'AbortError' });
    `);
    const controller = new AbortController();
    let complete;
    let child;
    if (mode === 'outer abort') {
      complete = assert.rejects(runCommand(['bash', '-c', 'npm run check'], { cwd: f.root, stdio: 'ignore', signal: controller.signal }), { name: 'AbortError' });
    } else {
      child = spawn(process.execPath, ['outer.mjs'], { cwd: f.root, stdio: 'ignore', env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
      complete = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`Outer API exited ${code}`))); });
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    }
    // Attach rejection handling while waiting for the readiness barrier.
    complete.catch(() => {});
    await waitForFile(f.root, 'ready');
    if (child) child.kill(mode); else controller.abort();
    await complete;
    assert.equal(await readFile(join(f.root, 'drained'), 'utf8'), 'yes');
    await assertServerGone(f);
  });
}
