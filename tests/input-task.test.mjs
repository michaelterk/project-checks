import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createFileSnapshot, loadChecks } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';
import { groupRunning } from '../src/command.mjs';

async function fixture(t) {
  const root = await temporary(t);
  await put(root, 'test/a.test.mjs', 'a');
  await put(root, 'test/b.test.mjs', 'b');
  await put(root, 'dependency.txt', 'dependency');
  await put(root, 'common.txt', 'common');
  await put(root, 'fixture.txt', 'fixture');
  await put(root, 'config.json', JSON.stringify({ root: '.', suite: 'fixture', inputs: ['common.txt'],
    coverage: false, cache: false, inputConcurrency: 2, testInputs: { 'test/a.test.mjs': ['dependency.txt'] } }));
  await put(root, 'fixture.mjs', `
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { relative, resolve } from 'node:path';
export const processInputs = true;
export default function(config, context) {
  if (!(context.signal instanceof AbortSignal)) throw Error('missing factory signal');
  const record = kind => appendFileSync(resolve(config.root, 'pids.log'), JSON.stringify([kind, process.pid])+'\\n');
  return {
    testInputs: async id => {
      if (config.env?.BLOCK_INPUTS) {
        process.on('SIGTERM', () => {});
        const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"]);
        await new Promise(resolve => child.stdout.once('data', resolve));
        writeFileSync(resolve(config.root, 'ready.json'), JSON.stringify({ worker: process.pid, child: child.pid }));
        await new Promise(() => {});
      }
      record('discover'); return config.testInputs[id] ?? [];
    },
    testFixtureInputs: () => ['fixture.txt'],
    inputProjection: async (entries, { kind, signal }) => {
      if (!(signal instanceof AbortSignal)) throw Error('missing projection signal');
      signal.throwIfAborted(); record(kind);
      return entries.map(entry => [relative(config.root, entry.path), entry.identity]);
    },
  };
}
`);
  await put(root, 'project.json', JSON.stringify({ checks: { fixture: { config: 'config.json', fixture: 'fixture.mjs' } }, targets: { default: ['fixture'] } }));
  const [definition] = await loadChecks(join(root, 'project.json'));
  const signal = new AbortController().signal;
  const config = { ...await definition.config({ signal }), signal };
  return { root, config };
}

test('process snapshots preserve fingerprints, selection, fresh mutations and runtime fixture paths', { timeout: 10000 }, async t => {
  const { root, config } = await fixture(t);
  // A changed callback disables offload, giving an independent local baseline.
  const local = await createFileSnapshot({ ...config, testInputs: id => config.testInputs(id) });
  const remote = await createFileSnapshot(config);
  t.after(async () => { await Promise.all([local.close(), remote.close()]); });
  const before = await local.snapshot();
  await writeFile(join(root, 'pids.log'), '');
  assert.deepEqual(await remote.snapshot(), before);
  const events = (await readFile(join(root, 'pids.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.every(([, pid]) => pid !== process.pid));
  assert.ok(new Set(events.map(([, pid]) => pid)).size >= 2);
  assert.deepEqual(new Set(events.map(([kind]) => kind)), new Set(['discover', 'common', 'unit']));
  await writeFile(join(root, 'dependency.txt'), 'changed dependency');
  const changed = await remote.snapshot();
  assert.notEqual(changed.units['test/a.test.mjs'], before.units['test/a.test.mjs']);
  assert.equal(changed.units['test/b.test.mjs'], before.units['test/b.test.mjs']);
  assert.deepEqual(changed, await local.snapshot());
  const restricted = await createFileSnapshot({ ...config, files: ['test/b.test.mjs'],
    ignore: [...config.ignore ?? [], 'unrelated/**'], testFixtureInputs: () => ['dependency.txt'] });
  t.after(() => restricted.close());
  const value = await restricted.snapshot();
  assert.deepEqual(Object.keys(value.units), ['test/b.test.mjs']);
  const restrictedLocal = await createFileSnapshot({ ...config, files: ['test/b.test.mjs'],
    ignore: [...config.ignore ?? [], 'unrelated/**'], testFixtureInputs: () => ['dependency.txt'], testInputs: id => config.testInputs(id) });
  t.after(() => restrictedLocal.close());
  assert.deepEqual(value, await restrictedLocal.snapshot());
});

test('cancellation stops an active worker and Python-style descendants even when TERM is ignored',
  { timeout: 10000, skip: process.platform === 'win32' }, async t => {
    const { root } = await fixture(t);
    const path = join(root, 'config.json');
    const base = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...base, env: { BLOCK_INPUTS: '1' } }));
    const [definition] = await loadChecks(join(root, 'project.json'), { files: ['test/a.test.mjs'] });
    const controller = new AbortController(), reason = new Error('cancel process snapshot');
    const config = await definition.config({ signal: controller.signal });
    const snapshot = await createFileSnapshot({ ...config, signal: controller.signal });
    t.after(async () => { controller.abort(reason); await snapshot.close(); });
    const rejected = assert.rejects(snapshot.snapshot(), error => error === reason);
    let pids;
    for (;;) {
      try { pids = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; await delay(5); }
    }
    controller.abort(reason);
    await rejected;
    await snapshot.close();
    assert.equal(await groupRunning(pids.worker), false);
  });

test('overridden discovery callbacks retain their in-memory behavior', { timeout: 10000 }, async t => {
  const { root, config } = await fixture(t);
  let calls = 0;
  const snapshot = await createFileSnapshot({ ...config, testInputs: () => { calls++; return ['fixture.txt']; } });
  t.after(() => snapshot.close());
  const before = await snapshot.snapshot();
  assert.ok(calls > 0);
  await writeFile(join(root, 'fixture.txt'), 'new fixture');
  assert.notDeepEqual(await snapshot.snapshot(), before);
});
