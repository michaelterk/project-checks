import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createFileSnapshot, createSnapshotContext, loadChecks, runTests } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

const ordinaryPreparation = `
export async function prepareInputs(config, { signal, inputGeneration }) {
  if (!(signal instanceof AbortSignal) || !inputGeneration) throw Error('missing preparation context');
  state.calls++;
  config.inputs.push('private-base-mutation');
  return state.data;
}`;

async function fixture(t, preparation = ordinaryPreparation, processInputs = true) {
  const root = await temporary(t, 'project-checks-preparation-');
  await put(root, 'test/one.test.mjs', '');
  await put(root, 'seed.txt', 'seed dependency');
  await put(root, 'fresh.txt', 'fresh dependency');
  await put(root, 'config.json', JSON.stringify({ root: '.', inputs: [], coverage: false, cache: false }));
  const source = await put(root, 'fixture.mjs', `
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
export const processInputs = ${processInputs};
export const state = { calls: 0, data: { paths: ['seed.txt'] } };
export const entered = Promise.withResolvers(), release = Promise.withResolvers();
${preparation}
export default function(config, { inputData } = {}) {
  return { testInputs: () => {
    appendFileSync(resolve(config.root, 'units.log'), 'unit\\n');
    return inputData?.paths ?? ['fresh.txt'];
  } };
}
`);
  await put(root, 'project.json', JSON.stringify({ checks: {
    fixture: { config: 'config.json', fixture: 'fixture.mjs' },
  }, targets: { default: ['fixture'] } }));
  const [definition] = await loadChecks(join(root, 'project.json'));
  const provider = await import(pathToFileURL(source));
  const controller = new AbortController();
  return { root, definition, provider, controller };
}

test('initial preparation privately binds worker data; later snapshots refresh without calling the hook', async t => {
  const { definition, provider, controller } = await fixture(t);
  const config = { ...await definition.config({ signal: controller.signal }), signal: controller.signal };
  assert.equal(provider.state.calls, 0, 'loading a fixture must not prepare or scan inputs');
  const context = createSnapshotContext({ inputConcurrency: 1, signal: controller.signal });
  const inputs = await createFileSnapshot({ ...config, snapshotContext: context });
  const seedReference = await createFileSnapshot({ ...config, inputConcurrency: 1, testInputs: () => ['seed.txt'] });
  const freshReference = await createFileSnapshot({ ...config, inputConcurrency: 1, testInputs: () => ['fresh.txt'] });
  try {
    context.beginScanGeneration();
    const first = await inputs.prepare();
    assert.equal(provider.state.calls, 1);
    provider.state.data.paths[0] = 'fresh.txt';
    await first.unit('test/one.test.mjs');
    assert.deepEqual(first.value, await seedReference.snapshot(), 'provider mutation cannot change an already prepared worker definition');
    const changed = await inputs.snapshot();
    assert.deepEqual(changed, await freshReference.snapshot(), 'a changed seed in the same initial generation must hydrate again');
    assert.notDeepEqual(changed, first.value);
    assert.deepEqual(config.inputs, [], 'preparation receives a private base configuration');
    await context.finishScanGeneration();
    provider.state.data.paths[0] = 'does-not-exist.txt';
    assert.deepEqual(await inputs.snapshot(), await freshReference.snapshot());
    assert.equal(provider.state.calls, 2, 'only initial prepares invoke the provider');
  } finally {
    await Promise.allSettled([inputs.close(), seedReference.close(), freshReference.close()]);
    await context.close();
  }
});

for (const [name, value] of [
  ['function', '() => {}'],
  ['nonplain map', 'new Map([["key", "value"]])'],
  ['undefined', 'undefined'],
  ['oversized UTF-8 payload', "'é'.repeat(8 * 1024 * 1024)"],
]) {
  test(`invalid prepared ${name} is rejected before worker unit execution`, async t => {
    const { root, definition, controller } = await fixture(t, `export function prepareInputs() { return ${value}; }`);
    const config = { ...await definition.config({ signal: controller.signal }), signal: controller.signal };
    const context = createSnapshotContext({ inputConcurrency: 1, signal: controller.signal });
    const inputs = await createFileSnapshot({ ...config, snapshotContext: context });
    try {
      context.beginScanGeneration();
      await assert.rejects(inputs.snapshot(), /prepareInputs.*(?:plain JSON|16 MiB)/);
      await assert.rejects(readFile(join(root, 'units.log')), { code: 'ENOENT' });
    } finally { await inputs.close(); await context.close(); }
  });
}

test('a non-function preparation export is rejected while loading the fixture configuration', async t => {
  const { definition, controller } = await fixture(t, 'export const prepareInputs = 42;');
  await assert.rejects(definition.config({ signal: controller.signal }), /prepareInputs must be a function/);
});

test('a non-process fixture ignores unrelated preparation exports and runs normally', async t => {
  const { definition, controller } = await fixture(t, 'export const prepareInputs = 42;', false);
  const config = await definition.config({ signal: controller.signal });
  const result = await runTests({ ...config, signal: controller.signal, logger: false,
    workers: 1, inputConcurrency: 1 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.passed, 1);
});

test('cancellation waits for preparation to settle and publishes no worker inputs', async t => {
  const { root, definition, provider, controller } = await fixture(t, `
export async function prepareInputs() {
  entered.resolve();
  await release.promise;
  return state.data;
}`);
  const config = { ...await definition.config({ signal: controller.signal }), signal: controller.signal };
  const context = createSnapshotContext({ inputConcurrency: 1, signal: controller.signal });
  const inputs = await createFileSnapshot({ ...config, snapshotContext: context });
  context.beginScanGeneration();
  const running = inputs.snapshot();
  const result = running.then(value => ({ value }), error => ({ error }));
  const reason = new Error('cancel preparation');
  try {
    await Promise.race([provider.entered.promise, result.then(() => { throw Error('preparation hook did not start'); })]);
    controller.abort(reason);
    let closed = false;
    const closing = inputs.close().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false, 'cleanup must wait for the active provider callback');
    provider.release.resolve();
    assert.equal((await result).error, reason);
    await closing;
    await assert.rejects(readFile(join(root, 'units.log')), { code: 'ENOENT' });
  } finally {
    controller.abort(reason);
    provider.release.resolve();
    await result;
    await inputs.close();
    await context.close();
  }
});
