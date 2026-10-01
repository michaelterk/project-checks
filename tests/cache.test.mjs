import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { environmentIdentity, runCachedUnits } from '../src/index.mjs';
import { temporary } from './helpers.mjs';

async function fixture(t) {
  const directory = await temporary(t);
  const inputs = { common: 'source-v1', units: { first: 'v1', second: 'v1' } };
  const calls = [];
  const options = {
    cacheDirectory: directory, suite: 'fixture', workers: 1, logger: null,
    units: ['first', 'second'].map(id => ({ id, command: ['test', id] })),
    snapshot: () => inputs,
    execute: async unit => { calls.push(unit.id); return unit.id === 'second' ? 17 : 0; },
  };
  return { directory, calls, options, inputs };
}

test('retains passes after failure and runs only failed, changed or newly discovered units', async t => {
  const f = await fixture(t);
  const first = await runCachedUnits(f.options);
  assert.equal(first.exitCode, 17);
  assert.deepEqual([first.passed, first.failed, first.cached], [1, 1, 0]);
  f.calls.length = 0;
  f.options.execute = async unit => { f.calls.push(unit.id); return 0; };
  assert.equal((await runCachedUnits(f.options)).exitCode, 0);
  assert.deepEqual(f.calls, ['second']);
  f.calls.length = 0;
  f.inputs.units.second = 'v2';
  await runCachedUnits(f.options);
  assert.deepEqual(f.calls, ['second']);
  f.calls.length = 0;
  f.inputs.units.third = 'v1';
  f.options.units.push({ id: 'third', command: ['test', 'third'] });
  await runCachedUnits(f.options);
  assert.deepEqual(f.calls, ['third']);
  f.calls.length = 0;
  f.inputs.common = 'source-v2';
  await runCachedUnits(f.options);
  assert.deepEqual(f.calls, ['first', 'second', 'third']);
});

test('keeps completed evidence when a later unit throws', async t => {
  const f = await fixture(t);
  f.options.execute = async unit => {
    if (unit.id === 'second') throw new Error('interrupted');
    return 0;
  };
  await assert.rejects(runCachedUnits(f.options), /interrupted/);
  f.options.execute = async unit => { f.calls.push(unit.id); return 0; };
  await runCachedUnits(f.options);
  assert.deepEqual(f.calls, ['second']);
});

test('input mutation is detected even when the snapshot callback returns the same object', async t => {
  const f = await fixture(t);
  f.options.execute = async () => { f.inputs.common = 'changed-mid-run'; return 0; };
  const result = await runCachedUnits(f.options);
  assert.equal(result.exitCode, 1);
  assert.equal(result.inputsChanged, true);
  assert.deepEqual(await readdir(f.directory), []);
  f.options.execute = async unit => { f.calls.push(unit.id); return 0; };
  await runCachedUnits(f.options);
  assert.deepEqual(f.calls, ['first', 'second']);
});

test('corrupt evidence reruns and cache stores only hashes, without environment secrets', async t => {
  const f = await fixture(t);
  f.options.execute = async () => 0;
  f.options.environment = { TOKEN: 'do-not-store-this-secret' };
  await runCachedUnits(f.options);
  for (const file of await readdir(f.directory)) {
    const value = await readFile(join(f.directory, file), 'utf8');
    assert.doesNotMatch(value, /do-not-store-this-secret/);
    await writeFile(join(f.directory, file), 'corrupt');
  }
  const result = await runCachedUnits(f.options);
  assert.equal(result.cached, 0);
  assert.equal(result.passed, 2);
});

test('effective environment and command identity invalidate evidence', async t => {
  const f = await fixture(t);
  f.options.execute = async () => 0;
  f.options.environment = { RUN_AXE: '0' };
  await runCachedUnits(f.options);
  assert.equal((await runCachedUnits(f.options)).cached, 2);
  f.options.environment = { RUN_AXE: '1' };
  assert.equal((await runCachedUnits(f.options)).cached, 0);
  f.options.units[0].command = ['test', '--new-option', 'first'];
  assert.equal((await runCachedUnits(f.options)).cached, 1);
});

test('unknown environment values matter; display and explicit scheduling values do not', () => {
  assert.equal(environmentIdentity({ FORCE_COLOR: '0' }), environmentIdentity({ FORCE_COLOR: '1' }));
  assert.equal(environmentIdentity({ MY_WORKERS: '1' }, ['MY_WORKERS']), environmentIdentity({ MY_WORKERS: '8' }, ['MY_WORKERS']));
  assert.notEqual(environmentIdentity({ RUN_AXE: '0' }), environmentIdentity({ RUN_AXE: '1' }));
  assert.notEqual(environmentIdentity({ NODE_V8_COVERAGE: '/first' }), environmentIdentity({ NODE_V8_COVERAGE: '/second' }));
});

test('discovery mismatches and malformed worker limits fail before execution', async t => {
  const f = await fixture(t);
  f.inputs.units.third = 'new';
  await assert.rejects(runCachedUnits(f.options), /discovery changed/);
  assert.deepEqual(f.calls, []);
  for (const workers of [0, -1, 1.5, NaN, Infinity]) await assert.rejects(runCachedUnits({ ...f.options, workers }), /workers/);
});

test('bounded scheduling drains failures, preserves input order, and waits for active jobs on errors', async t => {
  const f = await fixture(t);
  f.options.workers = 2;
  f.inputs.units.third = 'v1';
  f.options.units.push({ id: 'third', command: ['test', 'third'] });
  let active = 0;
  let peak = 0;
  let ended = 0;
  f.options.execute = async unit => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, unit.id === 'first' ? 80 : 5));
    active--;
    ended++;
    return unit.id === 'second' ? 17 : 0;
  };
  const result = await runCachedUnits(f.options);
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(ended, 3);
  assert.equal(result.exitCode, 17);
  assert.deepEqual(result.results.map(result => result.id), ['first', 'second', 'third']);
  f.inputs.common = 'new';
  let siblingEnded = false;
  f.options.execute = async unit => {
    if (unit.id === 'first') { await new Promise(resolve => setTimeout(resolve, 10)); throw new Error('fatal'); }
    await new Promise(resolve => setTimeout(resolve, 80));
    siblingEnded = true;
    return 0;
  };
  await assert.rejects(runCachedUnits(f.options), /fatal/);
  assert.equal(siblingEnded, true);
});
