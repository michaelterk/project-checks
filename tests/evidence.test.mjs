import assert from 'node:assert/strict';
import { chmod, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Admission, createFileSnapshot, loadConfig, runCachedUnits } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

const deferred = () => Promise.withResolvers();

async function fixture(t) {
  const root = await temporary(t);
  const inputs = { common: 'source', units: { a: 'v1' } };
  const declaration = { files: [await put(root, 'artifacts/raw', 'coverage')] };
  const options = {
    cacheDirectory: join(root, 'cache'), logger: null, resources: {},
    units: [{ id: 'a', identity: 'fixture-v1' }], snapshot: () => inputs,
    execute: async () => 0,
    restoreEvidence: async () => false, saveEvidence: async () => declaration,
  };
  return { root, inputs, options, declaration, records: async () => (await readdir(options.cacheDirectory)).filter(name => name.endsWith('.json')) };
}

test('artifact metadata shares the atomic pass record; missing, corrupt and legacy artifacts rerun', async t => {
  const f = await fixture(t);
  const artifact = join(f.options.cacheDirectory, 'artifact.data');
  const aggregate = join(f.root, 'contribution.json');
  let executions = 0;
  let restores = 0;
  f.options.execute = async () => { executions++; await writeFile(artifact, '{"coverage":[1]}'); return 0; };
  f.options.saveEvidence = async () => {
    const bytes = await readFile(artifact);
    assert.deepEqual(JSON.parse(bytes), { coverage: [1] });
    return { files: [artifact], metadata: { format: 'coverage-v1' } };
  };
  f.options.restoreEvidence = async (_unit, { files, metadata }) => {
    restores++;
    assert.deepEqual(metadata, { format: 'coverage-v1' });
    const bytes = await readFile(files[0]);
    assert.deepEqual(JSON.parse(bytes), { coverage: [1] });
    await writeFile(`${aggregate}.tmp`, bytes);
    await rename(`${aggregate}.tmp`, aggregate);
    return true;
  };
  assert.equal((await runCachedUnits(f.options)).passed, 1);
  const [record] = await f.records();
  const cached = JSON.parse(await readFile(join(f.options.cacheDirectory, record)));
  assert.deepEqual(cached.evidence.files, [artifact]);
  assert.equal(cached.evidence.identities[0][0], 'file');
  assert.match(cached.evidence.identities[0][1], /^[a-f0-9]{64}$/);
  assert.equal((await runCachedUnits(f.options)).cached, 1);
  assert.deepEqual(JSON.parse(await readFile(aggregate)), { coverage: [1] });
  await rm(aggregate); // Each invocation owns an initially empty aggregate area.
  await writeFile(artifact, 'corrupt');
  assert.equal((await runCachedUnits(f.options)).passed, 1);
  await assert.rejects(readFile(aggregate), { code: 'ENOENT' });
  await rm(artifact);
  assert.equal((await runCachedUnits(f.options)).passed, 1);
  delete cached.evidence;
  await writeFile(join(f.options.cacheDirectory, record), JSON.stringify(cached));
  assert.equal((await runCachedUnits(f.options)).passed, 1);
  assert.equal(executions, 4);
  assert.equal(restores, 1);
  const current = JSON.parse(await readFile(join(f.options.cacheDirectory, record)));
  current.evidence.identities = ['corrupt binding'];
  await writeFile(join(f.options.cacheDirectory, record), JSON.stringify(current));
  assert.equal((await runCachedUnits(f.options)).passed, 1);
  assert.equal(restores, 1);
});

test('artifact permission changes preserve passing evidence before and during restoration', async t => {
  const f = await fixture(t);
  const artifact = f.declaration.files[0];
  await chmod(artifact, 0o600);
  assert.equal((await runCachedUnits(f.options)).passed, 1);
  await chmod(artifact, 0o640);
  f.options.execute = () => { throw new Error('unchanged artifact must remain cached'); };
  f.options.restoreEvidence = async () => {
    assert.equal(await readFile(artifact, 'utf8'), 'coverage');
    await chmod(artifact, 0o600);
    return true;
  };
  assert.equal((await runCachedUnits(f.options)).cached, 1);
});

test('cache plan counts validated restorations and artifact fallbacks before executing', async t => {
  const f = await fixture(t);
  const ids = ['valid', 'missing', 'incompatible'];
  const artifacts = Object.fromEntries(await Promise.all(ids.map(async id =>
    [id, await put(f.root, `artifacts/${id}`, id)])));
  f.inputs.units = Object.fromEntries(ids.map(id => [id, 'v1']));
  f.options.units = ids.map(id => ({ id, identity: 'fixture' }));
  f.options.saveEvidence = unit => ({ files: [artifacts[unit.id]] });
  await runCachedUnits(f.options);
  await rm(artifacts.missing);
  const lines = [];
  const restored = [];
  const executed = [];
  f.options.logger = { log: line => lines.push(line) };
  f.options.restoreEvidence = unit => {
    restored.push(unit.id);
    return unit.id !== 'incompatible';
  };
  f.options.execute = async unit => {
    assert.deepEqual([...restored].sort(), ['incompatible', 'valid']);
    assert.ok(lines.some(line => /Will run: 2 \| Will skip: 1/.test(line)));
    executed.push(unit.id);
    await writeFile(artifacts[unit.id], unit.id);
    return 0;
  };
  const result = await runCachedUnits(f.options);
  assert.equal(result.exitCode, 0);
  assert.deepEqual([result.passed, result.cached], [2, 1]);
  assert.deepEqual([...executed].sort(), ['incompatible', 'missing']);
});

test('upfront artifact restoration preserves a low-level worker limit without a resource pool', async t => {
  const f = await fixture(t);
  const ids = ['a', 'b', 'c'];
  f.inputs.units = Object.fromEntries(ids.map(id => [id, 'v1']));
  f.options.units = ids.map(id => ({ id, identity: 'fixture' }));
  f.options.workers = 1;
  delete f.options.resources;
  await runCachedUnits(f.options);
  let active = 0;
  let peak = 0;
  f.options.restoreEvidence = async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return true;
  };
  f.options.execute = () => { throw new Error('valid artifacts must remain cached'); };
  const result = await runCachedUnits(f.options);
  assert.equal(result.cached, 3);
  assert.equal(result.workers, 1);
  assert.equal(peak, 1);
  assert.equal(active, 0);
});

test('shared artifact replacement during restoration fails before aggregation and removes passing evidence', async t => {
  const f = await fixture(t);
  const artifact = f.declaration.files[0];
  await writeFile(artifact, '{"coverage":[1]}');
  await runCachedUnits(f.options);
  const entered = deferred();
  const resume = deferred();
  const aggregate = join(f.root, 'aggregate.json');
  let executed = false;
  let aggregated = false;
  const running = runCachedUnits({
    ...f.options,
    execute: () => { executed = true; return 0; },
    restoreEvidence: async (_unit, { files }) => {
      entered.resolve();
      await resume.promise;
      const bytes = await readFile(files[0]);
      assert.ok(Array.isArray(JSON.parse(bytes).coverage));
      await writeFile(aggregate, bytes);
      return true;
    },
  }).then(result => { if (result.exitCode === 0) aggregated = true; return result; });
  await entered.promise;
  // Another checkout publishes a valid but different artifact at the shared path.
  await writeFile(`${artifact}.replacement`, '{"coverage":[2]}');
  await rename(`${artifact}.replacement`, artifact);
  resume.resolve();
  await assert.rejects(running, /Artifacts changed during restoration/);
  assert.deepEqual(JSON.parse(await readFile(aggregate)), { coverage: [2] });
  assert.equal(aggregated, false);
  assert.equal(executed, false);
  assert.deepEqual(await f.records(), []);
});

test('cache:false validates fresh artifacts without reading or publishing passing records', async t => {
  const f = await fixture(t);
  let saved = 0;
  f.options.cache = false;
  f.options.restoreEvidence = () => { throw new Error('unexpected restore'); };
  f.options.saveEvidence = () => { saved++; return f.declaration; };
  assert.equal((await runCachedUnits(f.options)).passed, 1);
  assert.equal(saved, 1);
  await assert.rejects(f.records(), { code: 'ENOENT' });
  await rm(f.declaration.files[0]);
  await assert.rejects(runCachedUnits(f.options), { code: 'ENOENT' });
  f.options.saveEvidence = () => { throw new Error('invalid coverage'); };
  await assert.rejects(runCachedUnits(f.options), /invalid coverage/);
});

test('invalid callback contracts and artifact failures cannot leave reusable passes', async t => {
  const f = await fixture(t);
  await assert.rejects(runCachedUnits({ ...f.options, saveEvidence: undefined }), /supplied together/);
  for (const metadata of [NaN, { missing: undefined }, new Date()]) {
    await assert.rejects(runCachedUnits({ ...f.options, saveEvidence: () => ({ ...f.declaration, metadata }) }), /JSON metadata/);
    assert.deepEqual(await f.records(), []);
  }
  await runCachedUnits(f.options);
  await assert.rejects(runCachedUnits({ ...f.options, restoreEvidence: () => 'yes' }), /return a boolean/);
  assert.deepEqual(await f.records(), []);
  await runCachedUnits(f.options);
  await assert.rejects(runCachedUnits({ ...f.options, restoreEvidence: () => { throw new Error('restore failed'); } }), /restore failed/);
  assert.deepEqual(await f.records(), []);
});

test('artifact declarations reject directories and symlinks before content reads', async t => {
  const f = await fixture(t);
  const dangling = join(f.root, 'dangling');
  await symlink(join(f.root, 'missing-target'), dangling);
  for (const file of [join(f.root, 'artifacts'), dangling]) {
    await assert.rejects(runCachedUnits({ ...f.options, saveEvidence: () => ({ files: [file] }) }), /Artifact must be a regular file/);
    assert.deepEqual(await f.records(), []);
  }
  await assert.rejects(runCachedUnits({ ...f.options, saveEvidence: () => ({ files: ['relative'] }) }), /must be absolute/);
  await runCachedUnits(f.options);
  await rm(f.declaration.files[0]);
  await symlink(join(f.root, 'missing-target'), f.declaration.files[0]);
  let executed = false;
  const result = await runCachedUnits({
    ...f.options,
    restoreEvidence: () => { throw new Error('unsafe binding reached restore'); },
    execute: async () => { executed = true; await rm(f.declaration.files[0]); await writeFile(f.declaration.files[0], 'new coverage'); return 0; },
  });
  assert.equal(executed, true);
  assert.equal(result.passed, 1);
});

test('ordinary failures, mixed timeout failures and second timeouts never save artifacts', async t => {
  const f = await fixture(t);
  let saves = 0;
  f.options.saveEvidence = () => { saves++; return f.declaration; };
  f.options.retryTimeouts = true;
  for (const mode of ['ordinary', 'mixed', 'twice', 'recovered']) {
    let attempts = 0;
    f.options.execute = (_unit, { retry, reportTimeout }) => {
      attempts++;
      if (mode === 'ordinary') return 7;
      if (!retry || mode === 'twice') { reportTimeout({ ordinaryFailure: mode === 'mixed' }); return 1; }
      return 0;
    };
    const result = await runCachedUnits(f.options);
    assert.equal(attempts, mode === 'ordinary' ? 1 : 2);
    assert.equal(result.exitCode === 0, mode === 'recovered');
    assert.equal(saves, mode === 'recovered' ? 1 : 0);
  }
});

test('source changes and cancellation during persistence prevent record publication', async t => {
  for (const mode of ['source', 'cancel']) {
    const f = await fixture(t);
    const started = deferred();
    const release = deferred();
    const controller = new AbortController();
    f.options.signal = controller.signal;
    f.options.saveEvidence = async () => { started.resolve(); await release.promise; return f.declaration; };
    const running = runCachedUnits(f.options);
    await started.promise;
    if (mode === 'source') f.inputs.units.a = 'changed';
    else controller.abort(new Error('cancelled during save'));
    release.resolve();
    if (mode === 'source') assert.equal((await running).inputsChanged, true);
    else await assert.rejects(running, /cancelled during save/);
    assert.deepEqual(await f.records(), []);
  }
  const f = await fixture(t);
  f.options.execute = () => { f.inputs.common = 'changed'; return 0; };
  f.options.saveEvidence = () => { throw new Error('must not save unstable artifacts'); };
  assert.equal((await runCachedUnits(f.options)).inputsChanged, true);
  assert.deepEqual(await f.records(), []);
});

test('post-command snapshots, save and cache-hit restoration retain admission through publication before exclusive retry', async t => {
  for (const phase of ['snapshot', 'save', 'restore']) {
    const f = await fixture(t);
    if (phase === 'restore') await runCachedUnits(f.options);
    const pool = new Admission({}, 2, {
      workers: 2, host: { cpus: 8, memoryMiB: 8192 },
      sample: () => ({ busyCpus: 0, pressure: 0, memoryPressure: 0, availableMemoryMiB: 8192 }),
    });
    t.after(() => pool.close());
    const entered = deferred();
    const release = deferred();
    let finished = false;
    let retried = false;
    const callback = async () => { entered.resolve(); await release.promise; finished = true; return phase === 'restore' ? true : f.declaration; };
    if (phase === 'snapshot') {
      f.options.restoreEvidence = f.options.saveEvidence = undefined;
      let snapshots = 0;
      f.options.snapshot = async () => {
        if (++snapshots === 2) await callback();
        return f.inputs;
      };
    } else f.options[phase === 'restore' ? 'restoreEvidence' : 'saveEvidence'] = callback;
    const owner = runCachedUnits({ ...f.options, admission: pool });
    await entered.promise;
    const retry = runCachedUnits({
      ...f.options, admission: pool, suite: 'retry', cache: false, retryTimeouts: true,
      snapshot: () => f.inputs,
      restoreEvidence: undefined, saveEvidence: undefined,
      execute: async (_unit, { retry, reportTimeout }) => {
        if (!retry) { reportTimeout({ ordinaryFailure: false }); return 1; }
        assert.equal(finished, true);
        assert.equal(pool.active, 1);
        assert.equal((await f.records()).length, 1);
        retried = true;
        return 0;
      },
    });
    const deadline = Date.now() + 3000;
    while (!pool.pendingExclusive && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    const pending = pool.pendingExclusive;
    const overlapped = retried;
    release.resolve();
    const results = await Promise.all([owner, retry]);
    assert.equal(pending, 1);
    assert.equal(overlapped, false);
    assert.equal(retried, true);
    assert.ok(results.every(result => result.exitCode === 0));
    assert.equal(pool.active, 0);
    pool.close();
  }
});

test('empty resource policy uses package adaptive admission and releases it after artifact errors', async t => {
  const f = await fixture(t);
  const original = Admission.prototype.acquire;
  const pools = [];
  t.mock.method(Admission.prototype, 'acquire', async function (options) {
    pools.push(this);
    return original.call(this, options);
  });
  f.options.saveEvidence = () => { throw new Error('fixture invalid'); };
  await assert.rejects(runCachedUnits(f.options), /fixture invalid/);
  assert.equal(pools.length, 1);
  assert.equal(pools[0].fixedWorkers, undefined);
  assert.deepEqual(pools[0].policy, {});
  assert.equal(pools[0].active, 0);
  assert.equal(pools[0].closed, true);
});

test('public JSON snapshots preserve minimal dependencies and full/focused passing identity', async t => {
  const root = await temporary(t);
  await put(root, 'test/a.test.mjs', 'test A');
  await put(root, 'test/b.test.mjs', 'test B');
  await put(root, 'test/helper.mjs', 'shared helper');
  await put(root, 'src/a/value', 'A');
  await put(root, 'src/b/value', 'B');
  const configFile = await put(root, 'config/checks.json', JSON.stringify({
    root: '..', inputs: [], excludeTestsFromInputs: true,
    testInputs: { 'test/': ['test'], 'test/a.test.mjs': ['src/a'], 'test/b.test.mjs': ['src/b'] },
  }));
  const config = await loadConfig(configFile);
  const full = await createFileSnapshot(config);
  const focused = await createFileSnapshot({ ...config, files: ['test/a.test.mjs'] });
  t.after(() => Promise.all([full.close(), focused.close()]));
  const before = await full.snapshot();
  const selected = await focused.snapshot();
  assert.deepEqual(selected, { common: before.common, units: { 'test/a.test.mjs': before.units['test/a.test.mjs'] } });
  const run = async inputs => runCachedUnits({
    cacheDirectory: join(root, '.test-cache'), logger: null, snapshot: inputs.snapshot,
    units: Object.keys((await inputs.snapshot()).units).map(id => ({ id, identity: 'fixture' })), execute: () => 0,
  });
  assert.equal((await run(full)).passed, 2);
  assert.equal((await run(focused)).cached, 1);
  await put(root, 'src/b/value', 'changed B');
  await put(root, 'test/b.test.mjs', 'changed B test');
  assert.deepEqual(await focused.snapshot(), selected);
  assert.equal((await run(full)).cached, 1);
  await put(root, 'test/a.test.mjs', 'changed A test');
  assert.equal((await run(focused)).passed, 1);
  await put(root, 'test/helper.mjs', 'changed shared helper');
  assert.equal((await run(full)).passed, 2);
  await focused.close();
  await assert.rejects(focused.snapshot());
  await full.close();
});

test('snapshot factory rejects invalid selection and drains on cancellation', async t => {
  const root = await temporary(t);
  await put(root, 'test/a.test.mjs', 'test');
  await assert.rejects(createFileSnapshot({ root, inputs: ['../outside'] }), /relative paths/);
  const missing = await createFileSnapshot({ root, files: ['test/missing.test.mjs'] });
  await assert.rejects(missing.snapshot(), /not in the configured test inventory/);
  await missing.close();
  const controller = new AbortController();
  const inputs = await createFileSnapshot({ root, signal: controller.signal });
  controller.abort(new Error('snapshot cancelled'));
  await assert.rejects(inputs.snapshot(), /snapshot cancelled/);
  await inputs.close();
});

test('artifact proof runs before restoration admission and rejects replacement during the wait', async t => {
  const f = await fixture(t);
  await runCachedUnits(f.options);
  const pool = new Admission({}, 1, { workers: 1, host: { cpus: 8, memoryMiB: 8192 },
    sample: () => ({ busyCpus: 0, pressure: 0, memoryPressure: 0, availableMemoryMiB: 8192 }) });
  t.after(() => pool.close());
  await pool.acquire();
  const waiting = deferred(), acquire = pool.acquire.bind(pool);
  pool.acquire = options => { waiting.resolve(); return acquire(options); };
  let restored = false, executed = false;
  const running = runCachedUnits({ ...f.options, admission: pool,
    execute: () => { executed = true; return 0; },
    restoreEvidence: async () => { restored = true; assert.equal(pool.active, 1); return true; },
  });
  const rejected = assert.rejects(running, /Artifacts changed during restoration/);
  await waiting.promise; // The successful first proof now precedes this wait.
  assert.equal(restored, false);
  await writeFile(f.declaration.files[0], 'replacement while waiting');
  pool.release();
  await rejected;
  assert.equal(restored, true);
  assert.equal(executed, false);
  assert.equal(pool.active, 0);
  assert.deepEqual(await f.records(), []);
});

test('abort while waiting after artifact proof preserves another admission owner and removes evidence', async t => {
  const f = await fixture(t);
  await runCachedUnits(f.options);
  const controller = new AbortController(), reason = new Error('cancel before restoration admission');
  const pool = new Admission({}, 1, { workers: 1, host: { cpus: 8, memoryMiB: 8192 },
    sample: () => ({ busyCpus: 0, pressure: 0, memoryPressure: 0, availableMemoryMiB: 8192 }) });
  t.after(() => pool.close());
  await pool.acquire();
  const waiting = deferred(), acquire = pool.acquire.bind(pool);
  pool.acquire = options => { waiting.resolve(); return acquire(options); };
  const running = runCachedUnits({ ...f.options, admission: pool, signal: controller.signal,
    restoreEvidence: () => { throw new Error('must not restore without admission'); },
    execute: () => { throw new Error('must not execute after abort'); },
  });
  const rejected = assert.rejects(running, error => error === reason);
  await waiting.promise;
  controller.abort(reason);
  await rejected;
  assert.equal(pool.active, 1, 'unacquired cleanup cannot release the unrelated owner');
  pool.release();
  assert.equal(pool.active, 0);
  assert.deepEqual(await f.records(), []);
});
