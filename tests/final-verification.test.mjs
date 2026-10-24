import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { runChecks } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

async function fixture(t, { count = 8, verificationConcurrency, verify = async () => {} } = {}) {
  const root = await temporary(t);
  const source = await put(root, 'source.txt', 'original');
  await put(root, 'test/one.test.mjs', '');
  let completed = 0, final = false, callbacks = 0;
  const closed = [];
  const diagnostics = {
    event() {}, files() {}, file() {},
    span: (suite, stage, operation) => operation(),
    suiteEnd() { if (++completed === count) final = true; },
  };
  const definitions = Array.from({ length: count }, (_, id) => ({
    id: `suite-${id}`,
    verify() { if (final) callbacks++; },
    config: {
      root, suite: `suite-${id}`, inputs: [], coverage: false, cache: false,
      testInputs: async () => { if (final) await verify(id); return ['source.txt']; },
      setup: () => ({ execute: () => 0, close: () => { closed.push(id); } }),
    },
  }));
  return {
    source, closed, callbacks: () => callbacks,
    run: signal => runChecks(definitions, {
      logger: false, progress: false, workers: 1, inputConcurrency: 1,
      diagnostics, signal, ...(verificationConcurrency === undefined ? {} : { verificationConcurrency }),
    }),
  };
}

for (const limit of [undefined, 1, 3]) {
  test(`final verification honors ${limit ?? 'default'} concurrency and drains before callbacks`, { timeout: 10000 }, async t => {
    const full = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    let started = 0, active = 0, peak = 0;
    const expected = limit ?? 8;
    const state = await fixture(t, { verificationConcurrency: limit, verify: async () => {
      peak = Math.max(peak, ++active);
      if (++started === expected) full.resolve();
      try { await release.promise; } finally { active--; }
    } });
    const running = state.run();
    await full.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, expected);
    assert.equal(peak, expected);
    assert.equal(state.callbacks(), 0);
    assert.deepEqual(state.closed, []);
    release.resolve();
    assert.equal((await running).exitCode, 0);
    assert.equal(started, 8);
    assert.equal(active, 0);
    assert.equal(state.callbacks(), 8);
    assert.equal(state.closed.length, 8);
  });
}

test('overlapping final verifiers reject a source mutation after suite completion', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  let started = 0;
  const state = await fixture(t, { count: 2, verify: async () => {
    if (++started === 2) entered.resolve();
    await release.promise;
  } });
  const running = assert.rejects(state.run(), /Check inputs changed during invocation/);
  await entered.promise;
  await writeFile(state.source, 'changed after all suites completed');
  release.resolve();
  await running;
  assert.equal(state.callbacks(), 0);
  assert.equal(state.closed.length, 2);
});

for (const outcome of ['failure', 'cancellation']) {
  test(`final verification ${outcome} skips queued checks and drains peers before cleanup`, { timeout: 10000 }, async t => {
    const bothStarted = Promise.withResolvers(), fail = Promise.withResolvers(), releasePeer = Promise.withResolvers();
    t.after(() => { fail.resolve(); releasePeer.resolve(); });
    const controller = new AbortController(), reason = new Error('final verifier failed');
    let started = 0, settled = false;
    const state = await fixture(t, { count: 4, verificationConcurrency: 2, verify: async () => {
      const position = ++started;
      if (position === 2) bothStarted.resolve();
      if (position === 1) {
        await fail.promise;
        if (outcome === 'failure') throw reason;
      } else await releasePeer.promise;
    } });
    const running = state.run(controller.signal);
    running.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(running, outcome === 'failure'
      ? error => error.cause === reason : { name: 'AbortError' });
    await bothStarted.promise;
    if (outcome === 'cancellation') controller.abort();
    fail.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, 2);
    assert.equal(settled, false);
    assert.deepEqual(state.closed, []);
    releasePeer.resolve();
    await rejected;
    assert.equal(started, 2);
    assert.equal(state.callbacks(), 0);
    assert.equal(state.closed.length, 4);
  });
}
