import assert from 'node:assert/strict';
import fsPromises, { readdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { cacheRecordName, runCachedUnits, runChecks } from '../src/index.mjs';
import { createFileQueue } from '../src/file-queue.mjs';
import { createVerificationPool } from '../src/verification-pool.mjs';
import { put, temporary } from './helpers.mjs';

const deferred = () => Promise.withResolvers();

function units() {
  return ['first', 'second'].map(id => ({ id, identity: id }));
}

function snapshot() {
  return { common: 'unchanged', units: { first: 'first', second: 'second' } };
}

test('standalone commands continue while an earlier file is verifying', { timeout: 5000 }, async t => {
  const directory = await temporary(t);
  const validating = deferred(), release = deferred(), secondStarted = deferred();
  t.after(() => release.resolve());
  let snapshots = 0;
  const started = [];
  const running = runCachedUnits({
    cache: false, cacheDirectory: directory, workers: 1, logger: null,
    units: units(),
    snapshot: async () => {
      if (++snapshots === 2) {
        validating.resolve();
        await release.promise;
      }
      return snapshot();
    },
    execute: unit => {
      started.push(unit.id);
      if (unit.id === 'second') secondStarted.resolve();
      return 0;
    },
  });
  await validating.promise;
  await secondStarted.promise;
  assert.deepEqual(started, ['first', 'second']);
  release.resolve();
  assert.equal((await running).passed, 2);
});

test('cancellation during verification drains work without publishing a pass', { timeout: 5000 }, async t => {
  const directory = await temporary(t);
  const validating = deferred(), release = deferred(), secondStarted = deferred();
  t.after(() => release.resolve());
  const controller = new AbortController();
  let snapshots = 0;
  const running = runCachedUnits({
    cacheDirectory: directory, workers: 1, logger: null, signal: controller.signal,
    units: units(),
    snapshot: async () => {
      if (++snapshots === 2) {
        validating.resolve();
        await release.promise;
      }
      return snapshot();
    },
    execute: unit => {
      if (unit.id === 'second') secondStarted.resolve();
      return 0;
    },
  });
  const rejected = assert.rejects(running, { name: 'AbortError' });
  await validating.promise;
  await secondStarted.promise;
  controller.abort();
  release.resolve();
  await rejected;
  assert.deepEqual(await readdir(directory), []);
});

test('a dependent check and fixture teardown wait for verification', { timeout: 5000 }, async t => {
  const root = await temporary(t);
  await put(root, 'test/one.test.mjs', '');
  const validating = deferred(), release = deferred();
  t.after(() => release.resolve());
  let parentCommandFinished = false, parentClosed = false, childStarted = false;
  const base = { root, inputs: [], coverage: false, cache: false };
  const running = runChecks([
    { id: 'parent', config: { ...base, suite: 'parent',
      testInputs: async () => {
        if (parentCommandFinished) { validating.resolve(); await release.promise; }
        return [];
      },
      setup: () => ({
        execute: () => { parentCommandFinished = true; return 0; },
        close: () => { parentClosed = true; },
      }),
    } },
    { id: 'child', dependsOn: ['parent'], config: { ...base, suite: 'child',
      setup: () => ({ execute: () => { childStarted = true; return 0; } }),
    } },
  ], { logger: false, workers: 1 });
  await validating.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(childStarted, false);
  assert.equal(parentClosed, false);
  release.resolve();
  assert.equal((await running).exitCode, 0);
  assert.equal(childStarted, true);
  assert.equal(parentClosed, true);
});

test('an independent check can execute while another suite verifies', { timeout: 5000 }, async t => {
  const root = await temporary(t);
  await put(root, 'test/one.test.mjs', '');
  const validating = deferred(), release = deferred(), secondStarted = deferred();
  t.after(() => release.resolve());
  let firstCommandFinished = false;
  const order = [];
  const base = { root, inputs: [], coverage: false, cache: false };
  const running = runChecks([
    { id: 'first', config: { ...base, suite: 'first',
      testInputs: async () => {
        if (firstCommandFinished) { validating.resolve(); await release.promise; }
        return [];
      },
      setup: () => ({ execute: () => {
        order.push('first');
        firstCommandFinished = true;
        return 0;
      } }),
    } },
    { id: 'second', config: { ...base, suite: 'second',
      setup: () => ({ execute: () => { order.push('second'); secondStarted.resolve(); return 0; } }),
    } },
  ], { logger: false, workers: 1 });
  await validating.promise;
  await secondStarted.promise;
  assert.deepEqual(order, ['first', 'second']);
  release.resolve();
  assert.equal((await running).exitCode, 0);
});

test('a signal aborted before queue construction rejects without starting files', { timeout: 5000 }, async t => {
  const directory = await temporary(t);
  const controller = new AbortController();
  let executed = 0;
  await assert.rejects(runCachedUnits({
    cache: false, cacheDirectory: directory, workers: 1, signal: controller.signal,
    units: units(), snapshot,
    logger: { log(message) {
      if (message.startsWith('CACHE_SCAN: tests | Will run:')) controller.abort();
    } },
    execute: () => { executed++; return 0; },
  }), { name: 'AbortError' });
  assert.equal(executed, 0);
});

test('a failed job drains a dispatcher blocked on admission', { timeout: 5000 }, async () => {
  const secondAcquire = deferred();
  const failure = new Error('first file failed');
  let acquisitions = 0, releases = 0, otherStarted = false;
  const admission = {
    capacity: 1,
    async acquire({ signal }) {
      if (++acquisitions === 1) return;
      secondAcquire.resolve();
      await new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    release() { releases++; },
  };
  const queue = createFileQueue([{ id: 'suite', jobs: [
    async () => { await secondAcquire.promise; throw failure; },
    () => { otherStarted = true; },
  ] }], admission, new AbortController().signal);
  queue.enable('suite');
  await assert.rejects(queue.run('suite'), error => error === failure);
  await queue.close();
  assert.equal(acquisitions, 2);
  assert.equal(releases, 1);
  assert.equal(otherStarted, false);
});

test('a full verification backlog blocks the thirty-fourth command', { timeout: 5000 }, async t => {
  const release = deferred(), thirtyThirdStarted = deferred();
  t.after(() => release.resolve());
  let started = 0, active = 0, peak = 0;
  const jobs = Array.from({ length: 34 }, () => async ({ releaseExecution, verify }) => {
    if (++started === 33) thirtyThirdStarted.resolve();
    releaseExecution();
    await verify(async () => {
      peak = Math.max(peak, ++active);
      await release.promise;
      active--;
    });
  });
  const queue = createFileQueue([{ id: 'suite', jobs }], null, new AbortController().signal);
  queue.enable('suite');
  const finished = queue.run('suite');
  await thirtyThirdStarted.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 33);
  assert.equal(active, 32);
  release.resolve();
  await finished;
  await queue.close();
  assert.equal(started, 34);
  assert.equal(active, 0);
  assert.equal(peak, 32);
});

test('a queued verifier checks fresh inputs before publishing its pass', { timeout: 5000 }, async t => {
  const root = await temporary(t);
  const cacheDirectory = join(root, 'cache');
  const ids = Array.from({ length: 33 }, (_, index) => `file-${index}`);
  const state = { common: 'unchanged', units: Object.fromEntries(ids.map(id => [id, 'original'])) };
  const thirtyTwoWriting = deferred(), releaseWrites = deferred(), thirtyThirdStarted = deferred();
  let blocked = 0;
  const writeFile = fsPromises.writeFile;
  t.mock.method(fsPromises, 'writeFile', async (path, ...args) => {
    if (String(path).startsWith(`${cacheDirectory}/`) && String(path).endsWith('.tmp') && blocked < 32) {
      if (++blocked === 32) thirtyTwoWriting.resolve();
      await releaseWrites.promise;
    }
    return writeFile(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    releaseWrites.resolve();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const running = runCachedUnits({
    suite: 'fresh', cacheDirectory, workers: 1, logger: null,
    units: ids.map(id => ({ id, identity: id })), snapshot: () => state,
    execute: unit => {
      if (unit.id === ids[32]) thirtyThirdStarted.resolve();
      return 0;
    },
  });
  await Promise.all([thirtyTwoWriting.promise, thirtyThirdStarted.promise]);
  state.units[ids[32]] = 'changed while queued';
  releaseWrites.resolve();
  const result = await running;
  assert.equal(result.inputsChanged, true);
  assert.equal(result.exitCode, 1);
  assert.equal((await readdir(cacheDirectory)).includes(cacheRecordName('fresh', ids[32])), false);
});

test('verification credits bound finished commands awaiting validation', { timeout: 5000 }, async t => {
  const pool = createVerificationPool(1, new AbortController().signal);
  t.after(() => pool.close());
  const release = await Promise.all(Array.from({ length: 33 }, () => pool.reserve()));
  let nextReserved = false;
  const next = pool.reserve().then(releaseCredit => {
    nextReserved = true;
    return releaseCredit;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nextReserved, false);
  release[0]();
  const releaseNext = await next;
  assert.equal(nextReserved, true);
  for (const releaseCredit of release.slice(1)) releaseCredit();
  releaseNext();
});

test('at most thirty-two verification operations run at once', { timeout: 5000 }, async t => {
  const pool = createVerificationPool(1, new AbortController().signal);
  t.after(() => pool.close());
  const full = deferred(), release = deferred();
  let active = 0, peak = 0, started = 0;
  const operations = Array.from({ length: 33 }, () => pool.run(async () => {
    peak = Math.max(peak, ++active);
    if (++started === 32) full.resolve();
    await release.promise;
    active--;
  }));
  await full.promise;
  assert.equal(started, 32);
  release.resolve();
  await Promise.all(operations);
  assert.equal(started, 33);
  assert.equal(active, 0);
  assert.equal(peak, 32);
});

test('abort releases queued credits and validation slots after active work drains', { timeout: 5000 }, async t => {
  const controller = new AbortController();
  const pool = createVerificationPool(1, controller.signal);
  t.after(() => pool.close());
  const releaseCredits = await Promise.all(Array.from({ length: 33 }, () => pool.reserve()));
  const pendingCredit = assert.rejects(pool.reserve(), { name: 'AbortError' });
  const full = deferred(), release = deferred();
  t.after(() => release.resolve());
  let started = 0;
  const active = Array.from({ length: 32 }, () => pool.run(async () => {
    if (++started === 32) full.resolve();
    await release.promise;
  }));
  await full.promise;
  const pendingValidation = assert.rejects(pool.run(() => { throw new Error('cancelled validation ran'); }), { name: 'AbortError' });
  controller.abort();
  release.resolve();
  await Promise.all([pendingCredit, pendingValidation, ...active]);
  releaseCredits.forEach(releaseCredit => releaseCredit());
  assert.equal(started, 32);
});

test('a failed validation releases its slot for the next file', { timeout: 5000 }, async t => {
  const pool = createVerificationPool(1, new AbortController().signal);
  t.after(() => pool.close());
  const failure = new Error('validation failed');
  await assert.rejects(pool.run(() => { throw failure; }), error => error === failure);
  assert.equal(await pool.run(() => 42), 42);
});

test('configured verification limits bound both active jobs and outstanding credits', { timeout: 5000 }, async t => {
  for (const concurrency of [1, 4]) {
    const pool = createVerificationPool(1, new AbortController().signal, concurrency);
    t.after(() => pool.close());
    const credits = await Promise.all(Array.from({ length: concurrency + 1 }, () => pool.reserve()));
    let reserved = false;
    const next = pool.reserve().then(release => { reserved = true; return release; });
    const release = deferred(), full = deferred();
    t.after(() => release.resolve());
    let active = 0, peak = 0;
    const jobs = Array.from({ length: concurrency + 1 }, () => pool.run(async () => {
      peak = Math.max(peak, ++active);
      if (active === concurrency) full.resolve();
      try { await release.promise; } finally { active--; }
    }));
    await full.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(active, concurrency);
    assert.equal(reserved, false, 'backlog admission uses the configured validation cap');
    credits[0]();
    (await next)();
    credits.slice(1).forEach(releaseCredit => releaseCredit());
    release.resolve();
    await Promise.all(jobs);
    assert.equal(peak, concurrency);
  }
});
