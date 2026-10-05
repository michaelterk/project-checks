import { withProcessSignal } from './cancellation.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { command, digest, integer, keys, object, text } from './util.mjs';
import { Admission } from './admission.mjs';
import { createSnapshotContext } from './inputs.mjs';
import { withProgress } from './progress.mjs';

const ignoredEnvironment = /^(?:INVOCATION_ID|PWD|OLDPWD|SHLVL|_|NODE_TEST_CONTEXT|TMPDIR|TMP|TEMP|TERM|COLORTERM|FORCE_COLOR|NO_COLOR|NODE_DISABLE_COLORS|npm_lifecycle_event|npm_lifecycle_script|npm_command|npm_package_(?:name|version|json)|npm_config_(?:cache|logs_dir|loglevel|progress|timing|color|fund|audit|update_notifier))$/;

export function environmentIdentity(env = process.env, ignoreEnv = []) {
  const ignored = new Set(ignoreEnv);
  return digest(JSON.stringify(Object.entries(env).filter(([name, value]) => value !== undefined && !ignored.has(name) && !ignoredEnvironment.test(name)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}

export async function runCachedUnits(options) {
  return withProgress(options, progress => withProcessSignal(options.signal, signal => runUnits({ ...options, progress, signal })));
}

async function runUnits({ cacheDirectory, suite = 'tests', units, snapshot, workers, resources, execute, environment = process.env, ignoreEnv = [], cache = true, signal, logger = console, admission: sharedAdmission, retryTimeouts = false, restoreEvidence, saveEvidence, diagnostics, normalPhase, progress }) {
  if (workers !== undefined) integer(workers, 'workers');
  if (typeof retryTimeouts !== 'boolean') throw new TypeError('retryTimeouts must be a boolean');
  text(suite, 'suite');
  if (cache) text(cacheDirectory, 'cacheDirectory');
  if (!Array.isArray(units) || !units.length || new Set(units.map(unit => unit.id)).size !== units.length) throw new TypeError('Unique nonempty test units required');
  for (const unit of units) {
    text(unit.id, 'unit id');
    if (unit.identity === undefined) command(unit.command);
    else text(unit.identity, 'unit identity');
  }
  if (typeof snapshot !== 'function' || typeof execute !== 'function') throw new TypeError('snapshot and execute must be functions');
  if (restoreEvidence !== undefined || saveEvidence !== undefined) {
    if (typeof restoreEvidence !== 'function' || typeof saveEvidence !== 'function') throw new TypeError('restoreEvidence and saveEvidence must be supplied together as functions');
  }
  const ids = units.map(unit => unit.id).sort();
  const takeSnapshot = async () => {
    const value = structuredClone(await snapshot());
    object(value, 'snapshot');
    text(value.common, 'snapshot.common');
    object(value.units, 'snapshot.units');
    for (const hash of Object.values(value.units)) text(hash, 'unit fingerprint');
    return value;
  };
  signal?.throwIfAborted();
  progress && progress.files(suite, units.length);
  const before = await takeSnapshot();
  if (!isDeepStrictEqual(Object.keys(before.units).sort(), ids)) throw new Error('Current test-unit discovery changed before execution');
  const base = digest(JSON.stringify(['project-checks-evidence-v1', process.execPath, process.version, process.platform, process.arch, environmentIdentity(environment, ignoreEnv), before.common, ...(retryTimeouts ? [true] : [])]));
  const key = unit => digest(JSON.stringify([base, suite, unit.id, before.units[unit.id], unit.identity ?? unit.command]));
  if (cache) await mkdir(cacheDirectory, { recursive: true });
  const results = new Array(units.length);
  const admission = sharedAdmission ?? (resources !== undefined ? new Admission(resources, units.length, { signal, workers }) : null);
  const artifacts = saveEvidence ? createSnapshotContext({ signal }) : null;
  async function bindEvidence(value) {
    keys(value, ['files', 'metadata'], 'evidence');
    if (!Array.isArray(value.files) || !value.files.length) throw new TypeError('evidence.files must be a nonempty array of absolute regular-file paths');
    const files = [...new Set(value.files.map(file => {
      if (!isAbsolute(text(file, 'artifact path'))) throw new TypeError('artifact path must be absolute');
      return resolve(file);
    }))].sort();
    const json = JSON.stringify(value);
    const plain = JSON.parse(json);
    if (!isDeepStrictEqual(value, plain)) throw new TypeError('evidence must contain plain JSON metadata');
    const identities = await artifacts.identify(files, {
      root: process.cwd(), cacheDirectory: cacheDirectory ?? process.cwd(), ignore: [], regularFilesOnly: true,
    });
    return { ...plain, files, identities };
  }
  workers = admission?.capacity ?? workers ?? 1;
  let cursor = 0;
  let fatal;
  let stopped = false;
  let inputsChanged = false;
  let checking;
  const retries = [];
  const check = () => checking ??= takeSnapshot().finally(() => { checking = undefined; });
  async function runUnit(index, retry = false, originalFailure = 0) {
    const unit = units[index];
    const filename = cache ? join(cacheDirectory, `${digest(`${suite}\0${unit.id}`)}.json`) : undefined;
    const expected = key(unit);
    let cached;
    if (cache && !retry) {
      try { cached = JSON.parse(await readFile(filename, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    }
    const hit = cached?.key === expected && cached?.passed === true;
    if (hit && !restoreEvidence) {
      logger?.log(`==> Reusing successful ${suite}/${unit.id}`);
      diagnostics?.file(suite, unit.id, "cache-hit");
      progress && progress.file(suite, unit.id, 'cache-hit');
      results[index] = { id: unit.id, exitCode: 0, cached: true };
      return;
    }
    if (cache && !hit) await rm(filename, { force: true });
    await admission?.acquire({ exclusive: retry, signal });
    if (retry) normalPhase?.(true);
    let status;
    let timedOut = false;
    let ordinaryFailure = false;
    let executing = false, finished = false;
    try {
      signal?.throwIfAborted();
      if (stopped) return;
      if (hit) {
        let restored;
        try {
          let verified;
          try {
            const { identities, ...declaration } = cached.evidence ?? {};
            const bound = await bindEvidence(declaration);
            if (isDeepStrictEqual(bound.identities, identities)) verified = declaration;
          } catch { signal?.throwIfAborted(); }
          restored = verified ? await restoreEvidence(unit, verified) : false;
          if (typeof restored !== 'boolean') throw new TypeError('restoreEvidence must return a boolean');
          signal?.throwIfAborted();
          if (restored && !isDeepStrictEqual((await bindEvidence(verified)).identities, cached.evidence.identities)) {
            throw new Error(`Artifacts changed during restoration of ${suite}/${unit.id}; suite has not passed.`);
          }
        } catch (error) {
          await rm(filename, { force: true });
          throw error;
        }
        if (restored) {
          logger?.log(`==> Reusing successful ${suite}/${unit.id}`);
          diagnostics?.file(suite, unit.id, "cache-hit");
          progress && progress.file(suite, unit.id, 'cache-hit');
      results[index] = { id: unit.id, exitCode: 0, cached: true };
          return;
        }
        await rm(filename, { force: true });
      }
      logger?.log(`==> ${retry ? 'Retrying timeout file alone (once)' : 'Running'} ${suite}/${unit.id}`);
      progress && progress.file(suite, unit.id, 'file-start');
      executing = true;
      status = await execute(unit, { retry, reportTimeout: outcome => {
        if (typeof outcome?.ordinaryFailure !== 'boolean') throw new TypeError('reportTimeout requires ordinaryFailure boolean');
        timedOut = true;
        ordinaryFailure ||= outcome.ordinaryFailure;
      } });
      integer(status, 'execute exit code', 0);
      signal?.throwIfAborted();
      // A timeout is never a pass, even if a custom adapter returns zero.
      status = originalFailure || status || (timedOut ? 1 : 0);
      progress && progress.file(suite, unit.id, 'file-end', { status, timedOut });
      finished = true;
      results[index] = { id: unit.id, exitCode: status, cached: false };
      if (!retry && retryTimeouts && timedOut) retries.push({ index, originalFailure: ordinaryFailure ? status : 0 });
      if (status !== 0) return;
      if (!isDeepStrictEqual(before, await check()) || inputsChanged) {
        logger?.error(`Inputs changed during ${suite}/${unit.id}; no passing evidence saved.`);
        inputsChanged = true;
        return;
      }
      let evidence;
      if (saveEvidence) {
        const declaration = await saveEvidence(unit);
        signal?.throwIfAborted();
        evidence = await bindEvidence(declaration);
        if (!isDeepStrictEqual(before, await takeSnapshot()) || inputsChanged) {
          logger?.error(`Inputs changed while saving ${suite}/${unit.id}; no passing evidence saved.`);
          inputsChanged = true;
          return;
        }
        signal?.throwIfAborted();
      }
      if (cache) {
        const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify({ key: expected, passed: true, ...(saveEvidence ? { evidence } : {}) }), { mode: 0o600, flag: 'wx' });
          if (saveEvidence) signal?.throwIfAborted();
          await rename(temporary, filename);
        } finally { await rm(temporary, { force: true }); }
      }
    } finally {
      if (executing && !finished) progress && progress.file(suite, unit.id, 'file-end', { status: 'interrupted' });
      admission?.release();
    }
  }
  async function worker() {
    try {
      while (!stopped && cursor < units.length) {
        signal?.throwIfAborted();
        const index = cursor++;
        await runUnit(index);
      }
    } catch (error) { if (!stopped) fatal = error; stopped = true; if (!sharedAdmission) admission?.close(); }
  }
  const concurrency = Math.min(workers, units.length);
  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (stopped) throw fatal;
    for (const { index, originalFailure } of retries) {
      normalPhase?.(false);
      signal?.throwIfAborted();
      if (!isDeepStrictEqual(before, await check())) inputsChanged = true;
      await runUnit(index, true, originalFailure);
    }
  }
  finally { await artifacts?.close(); if (!sharedAdmission) admission?.close(); }
  if (stopped) throw fatal;
  signal?.throwIfAborted();
  if (!isDeepStrictEqual(before, await takeSnapshot())) {
    logger?.error(`Inputs changed during ${suite}; suite has not passed.`);
    inputsChanged = true;
  }
  signal?.throwIfAborted();
  if (!sharedAdmission) admission?.report(logger, suite);
  return {
    exitCode: inputsChanged ? 1 : results.find(result => result.exitCode !== 0)?.exitCode ?? 0,
    total: results.length,
    passed: results.filter(result => result.exitCode === 0 && !result.cached).length,
    failed: results.filter(result => result.exitCode !== 0).length,
    cached: results.filter(result => result.cached).length,
    workers: admission ? admission.peak || admission.limit : concurrency, inputsChanged, results,
  };
}
