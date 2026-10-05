import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Admission, defineConfig, runCachedUnits, runCommand, runTests } from '../src/index.mjs';
import timeoutReporter, { classifyReport } from '../src/timeout-reporter.mjs';
import { put, temporary } from './helpers.mjs';

const deferred = () => Promise.withResolvers();
const turn = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, ids = ['a', 'b']) {
  const root = await temporary(t);
  const inputs = { common: 'shared', units: Object.fromEntries(ids.map(id => [id, id])) };
  return { root, inputs, options: {
    suite: 'retry', cacheDirectory: root, workers: 2, retryTimeouts: true, logger: null,
    units: ids.map(id => ({ id, identity: id })), snapshot: () => inputs,
  } };
}

test('drains all normal units before one complete serial retry and saves only its pass', async t => {
  const { root, options } = await fixture(t, ['a', 'b', 'c']);
  const events = [];
  let active = 0;
  const execute = async (unit, { retry, reportTimeout }) => {
    active++;
    events.push(`${unit.id}:${retry}`);
    if (retry) assert.equal(active, 1);
    await turn();
    active--;
    if (unit.id !== 'c' && !retry) { reportTimeout({ ordinaryFailure: false }); return 1; }
    return 0;
  };
  const result = await runCachedUnits({ ...options, execute });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(events.slice(0, 3).sort(), ['a:false', 'b:false', 'c:false']);
  assert.deepEqual(events.slice(3).sort(), ['a:true', 'b:true']);
  assert.equal((await readdir(root)).length, 3);
  assert.equal((await runCachedUnits({ ...options, execute })).cached, 3);
});

test('a mixed first attempt still retries but preserves ordinary failure without evidence', async t => {
  const { root, options } = await fixture(t, ['a']);
  const attempts = [];
  const result = await runCachedUnits({ ...options, execute: async (_, { retry, reportTimeout }) => {
    attempts.push(retry);
    if (!retry) { reportTimeout({ ordinaryFailure: true }); return 17; }
    return 0;
  } });
  assert.deepEqual(attempts, [false, true]);
  assert.equal(result.exitCode, 17);
  assert.equal(result.failed, 1);
  assert.deepEqual(await readdir(root), []);
});

test('second timeout fails, ordinary failures never retry, and legacy integer adapters still work', async t => {
  const { root, options } = await fixture(t);
  const attempts = [];
  const result = await runCachedUnits({ ...options, execute: async (unit, { retry, reportTimeout }) => {
    attempts.push(`${unit.id}:${retry}`);
    if (unit.id === 'a') reportTimeout({ ordinaryFailure: false });
    return unit.id === 'a' ? 1 : 9;
  } });
  assert.deepEqual(attempts.slice(0, 2).sort(), ['a:false', 'b:false']);
  assert.deepEqual(attempts.slice(2), ['a:true']);
  assert.equal(result.failed, 2);
  assert.deepEqual(await readdir(root), []);
  assert.equal((await runCachedUnits({ ...options, execute: async () => 0 })).passed, 2);
});

test('input changes before retry cannot be adopted or undone to certify evidence', async t => {
  const { root, inputs, options } = await fixture(t, ['a']);
  const result = await runCachedUnits({ ...options, execute: async (_, { retry, reportTimeout }) => {
    if (!retry) {
      inputs.common = 'changed';
      reportTimeout({ ordinaryFailure: false });
      return 1;
    }
    inputs.common = 'shared';
    return 0;
  } });
  assert.equal(result.inputsChanged, true);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(await readdir(root), []);
});

test('cancellation after normal execution cannot start retries', async t => {
  const { root, options } = await fixture(t, ['a']);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(runCachedUnits({ ...options, signal: controller.signal, execute: async (_, { reportTimeout }) => {
    calls++;
    reportTimeout({ ordinaryFailure: false });
    controller.abort();
    return 1;
  } }), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(root), []);
});

test('shared admission drains active work and excludes new normal arrivals throughout retry', async t => {
  const { options } = await fixture(t, ['a']);
  const pool = new Admission({}, 4, {
    workers: 4, host: { cpus: 8, memoryMiB: 8192 }, sample: () => ({ availableMemoryMiB: 8192 }),
  });
  t.after(() => pool.close());
  await pool.acquire(); // Another sharing suite is still running.
  const initialDone = deferred();
  const retryStarted = deferred();
  const finishRetry = deferred();
  const running = runCachedUnits({ ...options, admission: pool, execute: async (_, { retry, reportTimeout }) => {
    if (!retry) { reportTimeout({ ordinaryFailure: false }); initialDone.resolve(); return 1; }
    assert.equal(pool.active, 1);
    retryStarted.resolve();
    await finishRetry.promise;
    return 0;
  } });
  await initialDone.promise;
  while (!pool.pendingExclusive) await turn();
  let normalStarted = false;
  const normal = pool.acquire().then(() => { normalStarted = true; });
  await turn();
  assert.equal(normalStarted, false);
  pool.release();
  await retryStarted.promise;
  assert.equal(normalStarted, false);
  assert.equal(pool.active, 1);
  finishRetry.resolve();
  await normal;
  assert.equal(normalStarted, true);
  pool.release();
  assert.equal((await running).exitCode, 0);
  assert.equal(pool.active, 0);
});

test('cancelled exclusive waiters release the reservation without closing a shared pool', async t => {
  const { options } = await fixture(t, ['a']);
  const pool = new Admission({}, 2, {
    workers: 2, host: { cpus: 2, memoryMiB: 8192 }, sample: () => ({ availableMemoryMiB: 8192 }),
  });
  t.after(() => pool.close());
  await pool.acquire();
  const controller = new AbortController();
  const running = runCachedUnits({ ...options, admission: pool, signal: controller.signal, execute: async (_, { reportTimeout }) => {
    reportTimeout({ ordinaryFailure: false }); return 1;
  } });
  while (!pool.pendingExclusive) await turn();
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(pool.pendingExclusive, 0);
  await pool.acquire();
  assert.equal(pool.active, 2);
  pool.release(); pool.release();
});

async function nodeFixture(t, body) {
  const root = await temporary(t);
  await put(root, '.test-cache/count', '0');
  await put(root, 'test/one.test.mjs', `
    import test, { after, before } from 'node:test';
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    const attempt = Number(readFileSync('.test-cache/count', 'utf8')) + 1;
    writeFileSync('.test-cache/count', String(attempt));
    const delay = () => new Promise(resolve => setTimeout(resolve, 100));
    ${body}
  `);
  return { root, options: { root, workers: 1, retryTimeouts: true, coverage: false, logger: false, stdio: 'ignore' },
    count: async () => Number(await readFile(join(root, '.test-cache/count'), 'utf8')) };
}

test('actual Node body timeout retries a complete file, then reuses only the passing result', async t => {
  const f = await nodeFixture(t, "test('body', { timeout: 20 }, () => attempt === 1 ? delay() : undefined);");
  assert.equal((await runTests(f.options)).exitCode, 0);
  assert.equal(await f.count(), 2);
  assert.equal((await runTests(f.options)).cached, 1);
  assert.equal(await f.count(), 2);
});

test('Node cancelled descendants inherit a verified timed-out parent', async t => {
  const f = await nodeFixture(t, "test('parent', { timeout: 20 }, async t => { if (attempt === 1) await t.test('child', delay); });");
  assert.equal((await runTests(f.options)).exitCode, 0);
  assert.equal(await f.count(), 2);
});

test('Node timeout plus assertion retries but remains failed and never saves evidence', async t => {
  const f = await nodeFixture(t, `
    test('assertion', () => { if (attempt === 1) assert.fail('ordinary failure'); });
    test('timeout', { timeout: 20 }, () => attempt === 1 ? delay() : undefined);
  `);
  assert.equal((await runTests(f.options)).exitCode, 1);
  assert.equal(await f.count(), 2);
  assert.deepEqual(await readdir(join(f.root, '.test-cache/project-checks')), []);
});

test('late uncaught exceptions and rejections survive a successful timeout retry without evidence', async t => {
  for (const activity of ["throw new Error('late ordinary failure');", "Promise.reject(new Error('late ordinary failure'));"]) {
    const f = await nodeFixture(t, `
      test('already finished', () => { if (attempt === 1) setTimeout(() => { ${activity} }, 40); });
      test('timeout', { timeout: 20 }, () => attempt === 1 ? delay() : undefined);
    `);
    assert.equal((await runTests(f.options)).exitCode, 1);
    assert.equal(await f.count(), 2);
    assert.deepEqual(await readdir(join(f.root, '.test-cache/project-checks')), []);
  }
});

test('the async observer cannot turn a rejection-only failure into a pass or retry', async t => {
  const f = await nodeFixture(t, "test('finished', () => { setTimeout(() => Promise.reject(new Error('ordinary rejection')), 20); });");
  assert.equal((await runTests(f.options)).exitCode, 1);
  assert.equal(await f.count(), 1);
  assert.deepEqual(await readdir(join(f.root, '.test-cache/project-checks')), []);
});

test('default rejection in a later preload still exits promptly before the test harness', async t => {
  const f = await nodeFixture(t, "test('body', () => {});");
  const preload = await put(f.root, 'preload.mjs', "import { writeFileSync } from 'node:fs'; writeFileSync('.test-cache/preload-started', 'yes'); Promise.reject(new Error('setup failed')); await new Promise(resolve => setTimeout(resolve, 600000));");
  const controller = new AbortController();
  // This watchdog only cleans up a regression; the package has no wall deadline.
  const watchdog = setTimeout(() => controller.abort(new Error('preload rejection was swallowed')), 3000);
  try {
    const result = await runTests({ ...f.options, signal: controller.signal, command: [process.execPath, '--test', '--import', preload, '{file}'] });
    assert.equal(result.exitCode, 1);
    assert.equal(await f.count(), 0);
    assert.equal(await readFile(join(f.root, '.test-cache/preload-started'), 'utf8'), 'yes');
    assert.deepEqual(await readdir(join(f.root, '.test-cache/project-checks')), []);
  } finally { clearTimeout(watchdog); }
});

test('preload rejection warn/none modes and custom handlers retain their original passing behavior', async t => {
  const cases = [
    { args: ['--unhandled-rejections=warn'], setup: '' },
    { args: ['--unhandled-rejections=none'], setup: '' },
    { args: [], setup: "process.on('unhandledRejection', () => {});" },
    { args: [], setup: "process.on('uncaughtException', () => {});" },
    { args: [], setup: "process.setUncaughtExceptionCaptureCallback(() => {});" },
  ];
  for (const { args, setup } of cases) {
    const f = await nodeFixture(t, "test('body', () => {});");
    const preload = await put(f.root, 'preload.mjs', `${setup} Promise.reject(new Error('handled setup rejection')); await new Promise(resolve => setTimeout(resolve, 30));`);
    const result = await runTests({ ...f.options, command: [process.execPath, ...args, '--test', '--import', preload, '{file}'] });
    assert.equal(result.exitCode, 0, `${args.join(' ')} ${setup}`);
    assert.equal(await f.count(), 1);
  }
});

test('observer waits for atomic ownership publication and fails closed if it never arrives', async t => {
  for (const publish of [true, false]) {
    const root = await temporary(t);
    const report = await put(root, 'async-failures', '');
    const observer = new URL('../src/async-failure-monitor.mjs', import.meta.url);
    observer.searchParams.set('report', report);
    let timedOut = false;
    const code = await runCommand([process.execPath, '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const owner = ${JSON.stringify(`${report}.owner`)};
      const read = fs.readFileSync;
      let raced = false;
      if (${publish}) {
        fs.readFileSync = function(path, ...args) {
          try { return read(path, ...args); }
          catch (error) {
            if (path === owner && error.code === 'ENOENT' && !raced) {
              raced = true;
              // Simulate publication immediately after an unsuccessful read.
              fs.writeFileSync(owner + '.tmp', String(process.pid));
              fs.renameSync(owner + '.tmp', owner);
            }
            throw error;
          }
        };
        syncBuiltinESMExports();
        await import(${JSON.stringify(observer.href)});
        assert.equal(raced, true);
      } else {
        await assert.rejects(import(${JSON.stringify(observer.href)}), /Timed out waiting for timeout observer ownership publication/);
      }
    `], { stdio: 'ignore', logger: null, timeoutMs: 3000, onTimeout: () => { timedOut = true; } });
    assert.equal(code, 0);
    assert.equal(timedOut, false);
  }
});

test('fork fixtures may intentionally fail without contaminating their passing owner', async t => {
  const f = await nodeFixture(t, `
    import { fork } from 'node:child_process';
    test('expected failing fixture', async () => {
      const child = fork('fixture.mjs', { stdio: 'ignore' });
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      assert.equal(code, 1);
    });
  `);
  await put(f.root, 'fixture.mjs', "throw new Error('expected fixture failure');");
  assert.equal((await runTests(f.options)).exitCode, 0);
  assert.equal(await f.count(), 1);
  assert.equal((await runTests(f.options)).cached, 1);
});

test('ordinary diagnostic messages do not prevent verified timeout recovery', async t => {
  const f = await nodeFixture(t, `
    test('diagnostic', t => { t.diagnostic('This is harmless context, not a failure'); });
    test('timeout', { timeout: 20 }, () => attempt === 1 ? delay() : undefined);
  `);
  assert.equal((await runTests(f.options)).exitCode, 0);
  assert.equal(await f.count(), 2);
});

test('second real Node timeout fails without evidence', async t => {
  const f = await nodeFixture(t, "test('body', { timeout: 20 }, delay);");
  assert.equal((await runTests(f.options)).exitCode, 1);
  assert.equal(await f.count(), 2);
  assert.deepEqual(await readdir(join(f.root, '.test-cache/project-checks')), []);
});

test('retry overrides Node CLI default test timeout', async t => {
  const f = await nodeFixture(t, "test('body', delay);");
  const options = { ...f.options, command: [process.execPath, '--test', '--test-timeout=20', '{file}'], retryTimeoutMs: 1000 };
  assert.equal((await runTests(options)).exitCode, 0);
  assert.equal(await f.count(), 2);
});

test('structured timeout detection preserves a configured console reporter', async t => {
  const f = await nodeFixture(t, "test('body', { timeout: 20 }, () => attempt === 1 ? delay() : undefined);");
  const options = { ...f.options, command: [process.execPath, '--test', '--test-reporter=tap', '{file}'] };
  assert.equal((await runTests(options)).exitCode, 0);
  assert.equal(await f.count(), 2);
});

test('native before-hook deadlines retry the whole file and retain only a complete pass', async t => {
  const f = await nodeFixture(t, "before(() => attempt === 1 ? delay() : undefined, { timeout: 20 }); test('body', () => {});");
  assert.equal((await runTests(f.options)).exitCode, 0);
  assert.equal(await f.count(), 2);
  assert.equal((await runTests(f.options)).cached, 1);
  assert.equal(await f.count(), 2);
});

test('native after-hook deadlines retry the whole file and retain only a complete pass', async t => {
  const f = await nodeFixture(t, "after(() => attempt === 1 ? delay() : undefined, { timeout: 20 }); test('body', () => {});");
  assert.equal((await runTests(f.options)).exitCode, 0);
  assert.equal(await f.count(), 2);
  assert.equal((await runTests(f.options)).cached, 1);
  assert.equal(await f.count(), 2);
});

test('a second native hook deadline fails without passing evidence', async t => {
  const f = await nodeFixture(t, "before(delay, { timeout: 20 }); test('body', () => {});");
  assert.equal((await runTests(f.options)).exitCode, 1);
  assert.equal(await f.count(), 2);
  assert.deepEqual(await readdir(join(f.root, '.test-cache/project-checks')), []);
});

test('a native hook deadline beside an ordinary failure keeps the file failed without evidence', async t => {
  const f = await nodeFixture(t, `
    test('assertion', () => { if (attempt === 1) assert.fail('ordinary failure'); });
    test('group', async t => {
      t.before(() => attempt === 1 ? delay() : undefined, { timeout: 20 });
      await t.test('child', () => {});
    });
  `);
  assert.equal((await runTests(f.options)).exitCode, 1);
  assert.equal(await f.count(), 2);
  assert.deepEqual(await readdir(join(f.root, '.test-cache/project-checks')), []);
});

test('printed timeout text, TimeoutError names and ordinary hook causes do not trigger retry', async t => {
  for (const body of [
    "test('TimeoutError timed out', () => { console.log('testTimeoutFailure'); assert.fail('timed out'); });",
    "test('body', () => { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; });",
    "before(() => { throw new Error('test timed out after 20ms'); }); test('body', () => {});",
    "before(() => { throw 'timed out'; }); test('body', () => {});",
    "before(() => { throw 'test timed out after 20ms: ordinary failure'; }); test('body', () => {});",
  ]) {
    const f = await nodeFixture(t, body);
    assert.equal((await runTests(f.options)).exitCode, 1);
    assert.equal(await f.count(), 1);
  }
});

test('wall deadlines kill and drain non-Node commands before their one retry', async t => {
  const f = await nodeFixture(t, '');
  const source = `const fs = require('node:fs'); const n = Number(fs.readFileSync('.test-cache/count')) + 1; fs.writeFileSync('.test-cache/count', String(n)); if (n === 1) setInterval(() => {}, 1000);`;
  assert.equal((await runTests({ ...f.options, timeoutMs: 300, command: [process.execPath, '-e', source, '{file}'] })).exitCode, 0);
  assert.equal(await f.count(), 2);
});

test('wall deadline drains a SIGTERM-resistant Node worker before retry starts', { skip: process.platform !== 'linux' }, async t => {
  const f = await nodeFixture(t, `
    test('stubborn worker', () => {
      if (attempt === 1) {
        writeFileSync('.test-cache/first-pid', String(process.pid));
        process.on('SIGTERM', () => {});
        setInterval(() => {}, 50);
      } else {
        const pid = Number(readFileSync('.test-cache/first-pid', 'utf8'));
        let state;
        try { const stat = readFileSync('/proc/' + pid + '/stat', 'utf8'); state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        assert.ok(state === undefined || state === 'Z' || state === 'X', 'first worker still running during retry');
      }
    });
  `);
  let firstPid;
  t.after(() => {
    if (firstPid) { try { process.kill(firstPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  });
  let result;
  try { result = await runTests({ ...f.options, timeoutMs: 1000 }); }
  finally { firstPid = Number(await readFile(join(f.root, '.test-cache/first-pid'), 'utf8').catch(() => '0')); }
  assert.equal(result.exitCode, 0);
  assert.equal(await f.count(), 2);
});

test('a wall deadline never masks an ordinary Node failure already reported', async t => {
  const f = await nodeFixture(t, `
    test('assertion', () => { if (attempt === 1) assert.fail('ordinary'); });
    test('hang', () => { if (attempt === 1) setInterval(() => {}, 1000); });
  `);
  assert.equal((await runTests({ ...f.options, timeoutMs: 500 })).exitCode, 1);
  assert.equal(await f.count(), 2);
  assert.deepEqual(await readdir(join(f.root, '.test-cache/project-checks')), []);
});

test('command cancellation never reports a retryable timeout', async () => {
  const controller = new AbortController();
  let timeouts = 0;
  const running = runCommand([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', signal: controller.signal, timeoutMs: 1000, onTimeout: () => timeouts++,
  });
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(timeouts, 0);
});

test('reporter accepts nested verified hook timeout causes and keeps unrelated cancellations ordinary', async () => {
  const timeout = { code: 'ERR_TEST_FAILURE', failureType: 'testTimeoutFailure' };
  const errors = [
    { code: 'ERR_TEST_FAILURE', failureType: 'hookFailed', cause: timeout },
    { code: 'ERR_TEST_FAILURE', failureType: 'cancelledByParent' },
  ];
  let output = '';
  for await (const text of timeoutReporter(errors.map(error => ({ type: 'test:fail', data: { nesting: 0, details: { error } } })))) output += text;
  assert.deepEqual(classifyReport(output), { timedOut: true, ordinaryFailure: true, complete: true });
});

test('invalid timeout and cache identity configuration fails explicitly', () => {
  for (const config of [{ retryTimeouts: 1 }, { timeoutMs: 0 }, { timeoutMs: 2147483648 }, { retryTimeoutMs: -1 }]) assert.throws(() => defineConfig(config));
});
