import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runChecksWithReceipt } from '../src/index.mjs';

for (const schedule of ['preflight', 'ready']) {
  test(`verified release checks revalidate outputs and retain readiness in ${schedule} mode`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'verified-checks-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'test'));
    await writeFile(join(root, 'test/a.test.mjs'), '');
    await writeFile(join(root, 'generated'), 'first');
    const executed = { behavior: 0, readiness: 0 };
    let closed = 0, mutate = false;
    const environment = { ...process.env, NODE_TEST_CONTEXT: undefined, GUAJIRON_TEST_CACHE_DIR: join(root, 'cache') };
    const suite = (id, cache) => ({ id, config: {
      root, suite: id, coverage: false, cache, inputs: [], env: environment,
      testFixtureInputs: () => [join(root, 'generated')],
      setup: async () => {
        if (id === 'behavior' && mutate) await writeFile(join(root, 'generated'), 'changed during the run');
        return { execute: () => { executed[id]++; return 0; }, close: () => { closed++; } };
      },
    } });
    const definitions = [suite('behavior', true), suite('readiness', false)];
    const run = previous => runChecksWithReceipt(definitions, {
      schedule, workers: 1, scanConcurrency: 2, logger: false,
    }, previous);
    const initial = await run();
    assert.equal(initial.exitCode, 0);
    assert.deepEqual(Object.keys(initial.receipt), ['behavior']);
    assert.deepEqual(executed, { behavior: 1, readiness: 1 });
    // Remove ordinary records to distinguish reuse of this release from a cache hit.
    await rm(join(root, '.test-cache'), { recursive: true });
    const reused = await run(initial.receipt);
    assert.equal(reused.exitCode, 0);
    assert.deepEqual(executed, { behavior: 1, readiness: 2 });
    assert.equal(closed, 4);
    await writeFile(join(root, 'generated'), 'second');
    const changed = await run(initial.receipt);
    assert.equal(changed.exitCode, 0);
    assert.deepEqual(executed, { behavior: 2, readiness: 3 });
    mutate = true;
    await assert.rejects(run(changed.receipt), /inputs changed/i);
    assert.equal(await readFile(join(root, 'generated'), 'utf8'), 'changed during the run');
    assert.equal(closed, 8);
  });
}
