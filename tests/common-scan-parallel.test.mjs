import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { createFileSnapshot, createSnapshotContext } from '../src/index.mjs';
import { inputProcess } from '../src/input-task.mjs';
import { interceptReads } from './input-read-helpers.mjs';
import { put, temporary } from './helpers.mjs';

test('process-backed common trees use the shared parallel scanner and drain every owned read', { timeout: 10000 }, async t => {
  const root = await temporary(t);
  const context = createSnapshotContext({ inputConcurrency: 4 });
  const full = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(async () => { release.resolve(); await context.close(); });
  for (let i = 0; i < 4; i++) await put(root, `common/${i}`, `source-${i}`);
  await put(root, 'test/one.test.mjs', '');
  let active = 0, peak = 0, reads = 0;
  interceptReads(t, async (file, read) => {
    if (!file.startsWith(join(root, 'common/'))) return read();
    reads++;
    peak = Math.max(peak, ++active);
    if (active === 4) full.resolve();
    try { await release.promise; return await read(); }
    finally { active--; }
  });
  const config = { root, inputs: ['common'], snapshotContext: context };
  config[inputProcess] = { fixture: 'unused-common-only-fixture', base: {},
    testInputs: undefined, inputProjection: undefined };
  const inputs = await createFileSnapshot(config);
  t.after(() => inputs.close());
  const prepared = await inputs.prepare(['test/one.test.mjs']);
  assert.equal(typeof prepared.common, "function", "shared common work must have its own parallel plan");
  const common = prepared.common();
  await full.promise;
  assert.equal(active, 4);
  assert.equal(context.scanState().active, 4);
  release.resolve();
  assert.match(await common, /^[a-f0-9]{64}$/);
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.equal(reads, 4);
});
