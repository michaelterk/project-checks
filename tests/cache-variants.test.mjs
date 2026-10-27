import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { cacheKey, cacheRecordName, runCachedUnits } from '../src/index.mjs';
import { temporary } from './helpers.mjs';

async function fixture(t) {
  const directory = await temporary(t);
  const inputs = { common: 'runtime-a', units: { first: 'source-a' } };
  let calls = 0;
  return { directory, inputs, calls: () => calls, options: {
    cacheDirectory: directory, suite: 'variants', workers: 1, logger: null,
    units: [{ id: 'first', command: ['test', 'first'] }],
    snapshot: () => inputs, execute: () => { calls++; return 0; },
  } };
}

for (const kind of ['source', 'runtime']) test(`retains both passed ${kind} variants after a stale snapshot restore`, async t => {
  const f = await fixture(t);
  await runCachedUnits(f.options);
  const oldRecords = await Promise.all((await readdir(f.directory)).map(async name =>
    [name, await readFile(join(f.directory, name))]));
  if (kind === 'source') f.inputs.units.first = 'source-b';
  else f.inputs.common = 'runtime-b';
  assert.equal((await runCachedUnits(f.options)).passed, 1);
  for (const [name, bytes] of oldRecords) await writeFile(join(f.directory, name), bytes);
  assert.equal((await runCachedUnits(f.options)).cached, 1);
  if (kind === 'source') f.inputs.units.first = 'source-a';
  else f.inputs.common = 'runtime-a';
  assert.equal((await runCachedUnits(f.options)).cached, 1);
  assert.equal(f.calls(), 2);
});

test('migrates only an exact passing legacy key and retains its variant independently', async t => {
  const f = await fixture(t);
  const key = cacheKey(f.inputs, 'first');
  const legacy = join(f.directory, cacheRecordName('variants', 'first'));
  await writeFile(legacy, JSON.stringify({ key, passed: true }));
  assert.equal((await runCachedUnits(f.options)).cached, 1);
  const variant = join(f.directory, cacheRecordName('variants', 'first', key));
  assert.notEqual(variant, legacy);
  assert.equal(JSON.parse(await readFile(variant, 'utf8')).key, key);
  await writeFile(legacy, JSON.stringify({ key: 'older-inputs', passed: true }));
  assert.equal((await runCachedUnits(f.options)).cached, 1);
  assert.equal(f.calls(), 0);
});

test('never promotes mismatched or failed legacy evidence', async t => {
  for (const record of [{ key: 'other', passed: true }, { key: 'current', passed: false }]) {
    const f = await fixture(t);
    if (record.key === 'current') record.key = cacheKey(f.inputs, 'first');
    const legacy = join(f.directory, cacheRecordName('variants', 'first'));
    await writeFile(legacy, JSON.stringify(record));
    const result = await runCachedUnits(f.options);
    assert.equal(result.cached, 0);
    assert.equal(result.passed, 1);
    assert.deepEqual(JSON.parse(await readFile(legacy, 'utf8')), record);
  }
});

test('resolves the fingerprint before selecting a lazily prepared record', async t => {
  const f = await fixture(t);
  await runCachedUnits(f.options);
  const value = { common: f.inputs.common, units: {} };
  const result = await runCachedUnits(f.options, { initialSnapshot: {
    value, files: new Set(['first']), unit: async id => { value.units[id] = f.inputs.units[id]; },
  } });
  assert.equal(result.cached, 1);
  assert.equal(f.calls(), 1);
});
