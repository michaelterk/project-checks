import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { runCachedUnits, runCommand, runTests } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

const packageURL = new URL('../src/index.mjs', import.meta.url).href;
const posix = { skip: !['linux', 'darwin'].includes(process.platform) };
const counts = () => ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));

async function waitForFile(root, filename) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try { return await readFile(join(root, filename), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

async function running(pid) {
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function nodeFixture(t, api = 'runTests') {
  const root = await temporary(t);
  await put(root, 'preload.mjs', "process.on('SIGTERM', () => {});\n");
  await put(root, 'test/one.test.mjs', `
    import test from 'node:test'; import { writeFileSync } from 'node:fs';
    test('stubborn worker', async () => { writeFileSync('worker-pid', String(process.pid)); setInterval(() => {}, 1000); await new Promise(() => {}); });
  `);
  const command = [process.execPath, '--import', join(root, 'preload.mjs'), '--test', 'test/one.test.mjs'];
  const call = api === 'runTests'
    ? `runTests({ root: ${JSON.stringify(root)}, inputs: [], retryTimeouts: true, workers: 1, logger: false, stdio: 'ignore', command: ${JSON.stringify([...command.slice(0, -1), '{file}'])} })`
    : api === 'runCommand'
      ? `runCommand(${JSON.stringify(command)}, { cwd: ${JSON.stringify(root)}, nodeTest: true, stdio: 'ignore', logger: null })`
      : `runCachedUnits({ cacheDirectory: 'cache', units: [{ id: 'one', identity: 'one' }], workers: 1, retryTimeouts: true, logger: null, snapshot: () => ({ common: 'constant', units: { one: 'constant' } }), execute: () => runCommand(${JSON.stringify(command)}, { cwd: ${JSON.stringify(root)}, nodeTest: true, stdio: 'ignore', logger: null }) })`;
  await put(root, 'entry.mjs', `
    import assert from 'node:assert/strict'; import { writeFileSync } from 'node:fs';
    import { runTests, runCachedUnits, runCommand } from ${JSON.stringify(packageURL)};
    const counts = () => ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
    const before = counts();
    await assert.rejects(${call}, { name: 'AbortError' });
    assert.deepEqual(counts(), before);
    writeFileSync('drained', 'yes');
  `);
  await put(root, 'package.json', JSON.stringify({ private: true, scripts: { check: `${JSON.stringify(process.execPath)} entry.mjs` } }));
  // Register safety cleanup before assertions; keep a captured PID after temp removal.
  let workerPid;
  t.after(async () => { if (workerPid && await running(workerPid)) process.kill(workerPid, 'SIGKILL'); });
  return { root, ready: async () => workerPid = Number(await waitForFile(root, 'worker-pid')) };
}

function launch(t, command, root) {
  const child = spawn(command[0], command.slice(1), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  let output = '';
  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => output += data);
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output }));
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return { child, result };
}

for (const api of ['runTests', 'runCachedUnits', 'runCommand']) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`${api} default API ownership drains stubborn Node children on direct ${signal}`, posix, async t => {
      const f = await nodeFixture(t, api);
      const { child, result } = launch(t, [process.execPath, 'entry.mjs'], f.root);
      const worker = await f.ready();
      child.kill(signal);
      const closed = await result;
      assert.equal(closed.code, 0, closed.output);
      assert.equal(await running(worker), false);
      assert.equal(await readFile(join(f.root, 'drained'), 'utf8'), 'yes');
      if (api === 'runTests') assert.deepEqual(await readdir(join(f.root, '.test-cache/project-checks')), []);
      if (api === 'runCachedUnits') assert.deepEqual(await readdir(join(f.root, 'cache')), []);
    });
  }
}

test('an explicitly cancelled bash/npm launcher waits for nested runTests to drain detached Node workers', posix, async t => {
  const f = await nodeFixture(t);
  const controller = new AbortController();
  let timeouts = 0;
  const result = runCommand(['bash', '-c', 'npm run check'], { cwd: f.root, signal: controller.signal, stdio: 'ignore', onTimeout: () => timeouts++ });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  const worker = await f.ready();
  controller.abort();
  await rejected;
  assert.equal(await running(worker), false, 'outer launcher returned before detached worker drained');
  assert.equal(await readFile(join(f.root, 'drained'), 'utf8'), 'yes');
  assert.equal(timeouts, 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`default runCommand ${signal} drains bash/npm and its nested package owner`, posix, async t => {
    const f = await nodeFixture(t);
    await put(f.root, 'outer.mjs', `
      import assert from 'node:assert/strict';
      import { runCommand } from ${JSON.stringify(packageURL)};
      await assert.rejects(runCommand(['bash', '-c', 'npm run check'], { stdio: 'ignore' }), { name: 'AbortError' });
    `);
    const { child, result } = launch(t, [process.execPath, 'outer.mjs'], f.root);
    const worker = await f.ready();
    child.kill(signal);
    const closed = await result;
    assert.equal(closed.code, 0, closed.output);
    assert.equal(await running(worker), false);
    assert.equal(await readFile(join(f.root, 'drained'), 'utf8'), 'yes');
  });
}

test('default concurrent and nested API calls share listeners and release them after final drain', posix, async t => {
  const root = await temporary(t);
  const before = counts();
  const hold = Promise.withResolvers();
  let started;
  const ready = new Promise(resolve => started = resolve);
  const nested = runCachedUnits({ cache: false, logger: null, units: [{ id: 'one', identity: 'one' }], snapshot: () => ({ common: 'fixed', units: { one: 'one' } }), execute: async () => {
    const child = runCommand([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'ready'))}, 'yes'); setTimeout(() => {}, 500);`], { stdio: 'ignore' });
    await waitForFile(root, 'ready');
    started();
    await child;
    await hold.promise;
    return 0;
  } });
  await ready;
  assert.deepEqual(counts(), before.map(count => count + 1));
  await runCommand([process.execPath, '-e', ''], { stdio: 'ignore' });
  assert.deepEqual(counts(), before.map(count => count + 1));
  hold.resolve();
  assert.equal((await nested).exitCode, 0);
  assert.deepEqual(counts(), before);
  await assert.rejects(runTests({ root, pattern: '**/*.missing' }), { code: 'ENOENT' });
  await assert.rejects(runCommand([]), /command/);
  assert.deepEqual(counts(), before);
});

test('explicit signals retain caller ownership and never install process signal listeners', async t => {
  const root = await temporary(t);
  const before = counts();
  const controller = new AbortController();
  const reason = new Error('caller cancellation');
  const result = runCommand([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'ready'))}, 'yes'); setInterval(() => {}, 1000);`], { signal: controller.signal, stdio: 'ignore' });
  const rejected = assert.rejects(result, error => error === reason);
  await waitForFile(root, 'ready');
  assert.deepEqual(counts(), before);
  controller.abort(reason);
  await rejected;
  assert.deepEqual(counts(), before);
});

test('generic forced cleanup fails closed without reporting a retryable deadline', posix, async t => {
  const root = await temporary(t);
  const program = await put(root, 'stubborn.mjs', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  let timeouts = 0;
  await assert.rejects(runCommand([process.execPath, program], { timeoutMs: 1000, stdio: 'ignore', logger: null, onTimeout: () => timeouts++ }), /cooperative command cleanup/);
  assert.equal(timeouts, 0);
});

test('cancellation during final input verification cannot return suite success', async () => {
  const controller = new AbortController();
  let snapshots = 0;
  await assert.rejects(runCachedUnits({
    cache: false, signal: controller.signal, logger: null,
    units: [{ id: 'one', identity: 'one' }], execute: async () => 0,
    snapshot: async () => {
      if (++snapshots === 3) controller.abort();
      return { common: 'fixed', units: { one: 'one' } };
    },
  }), { name: 'AbortError' });
  assert.equal(snapshots, 3);
});
