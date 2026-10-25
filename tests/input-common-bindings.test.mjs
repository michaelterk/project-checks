import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { createFileSnapshot, createSnapshotContext, loadChecks } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

test('shared initial generation hydrates each distinct coordinator common-input binding', { timeout: 10000 }, async t => {
  const root = await temporary(t, 'project-checks-common-bindings-');
  await put(root, 'test/one.test.mjs', '');
  await put(root, 'dependency.txt', 'required dependency');
  await put(root, 'config.json', JSON.stringify({ root: '.', inputs: ['dependency.txt'],
    coverage: false, cache: false, inputConcurrency: 1 }));
  await put(root, 'fixture.mjs', `
export const processInputs = true;
export default function(config, { commonInputs = [] } = {}) {
  return { testInputs: () => commonInputs.includes('dependency.txt') ? [] : ['dependency.txt'] };
}
`);
  await put(root, 'project.json', JSON.stringify({ checks: {
    fixture: { config: 'config.json', fixture: 'fixture.mjs' },
  }, targets: { default: ['fixture'] } }));
  const [definition] = await loadChecks(join(root, 'project.json'));
  const signal = new AbortController().signal;
  const config = { ...await definition.config({ signal }), signal };
  const context = createSnapshotContext({ inputConcurrency: 1, signal });
  const first = await createFileSnapshot({ ...config, snapshotContext: context });
  const second = await createFileSnapshot({ ...config, inputs: [], snapshotContext: context });
  const independent = await createFileSnapshot({ ...config, inputs: [], inputConcurrency: 1 });
  try {
    context.beginScanGeneration();
    await first.snapshot();
    const shared = await second.snapshot();
    const fresh = await independent.snapshot();
    assert.deepEqual(shared, fresh,
      'the second coordinator must bind the dependency per unit when it is absent from its common inputs');
  } finally {
    await Promise.allSettled([first.close(), second.close(), independent.close()]);
    await context.close();
  }
});
