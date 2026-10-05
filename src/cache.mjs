import { withProcessSignal } from './cancellation.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { command, digest, integer, keys, object, text } from './util.mjs';
import { Admission } from './admission.mjs';
import { createSnapshotContext } from './inputs.mjs';
import { withProgress } from './progress.mjs';

// Share the read limit across concurrent suites without occupying test workers.
export const scanConcurrency = 16;
const cacheReads = [];
let activeCacheReads = 0;
function readCacheRecord(filename, signal) {
  return new Promise((resolve, reject) => {
    cacheReads.push({ filename, signal, resolve, reject });
    drainCacheReads();
  });
}
function drainCacheReads() {
  while (activeCacheReads < scanConcurrency && cacheReads.length) {
    const { filename, signal, resolve, reject } = cacheReads.shift();
    activeCacheReads++;
    Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return readFile(filename, 'utf8');
    }).then(resolve, reject).finally(() => {
      activeCacheReads--;
      drainCacheReads();
    });
  }
}

// Record routing is independent of validity; neither identifier enters the key.
export function cacheRecordName(suite, unitId) {
  return `${digest(`${suite}\0${unitId}`)}.json`;
}

// Snapshots contain only digests of file existence and content.
export function cacheKey(snapshot, unitId) {
  text(snapshot.common, 'snapshot.common');
  text(snapshot.units[unitId], 'unit fingerprint');
  return digest(JSON.stringify([snapshot.common, snapshot.units[unitId]]));
}

export async function runCachedUnits(options, { cacheScan, prepareExecution } = {}) {
  return withProgress(options, progress => withProcessSignal(options.signal, signal => runUnits({ ...options, progress, signal }, { cacheScan, prepareExecution })));
}

async function runUnits({ cacheDirectory, suite = 'tests', units, snapshot, workers, resources, execute, cache = true, signal, logger = console, admission: sharedAdmission, retryTimeouts = false, restoreEvidence, saveEvidence, diagnostics, normalPhase, progress }, { cacheScan, prepareExecution }) {
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
  const plan = units.map(unit => ({
    filename: cache ? join(cacheDirectory, cacheRecordName(suite, unit.id)) : undefined,
    expected: cacheKey(before, unit.id), cached: false,
  }));
  async function scanUnit(index) {
    const entry = plan[index];
    let cached;
    try { cached = JSON.parse(await readCacheRecord(entry.filename, signal)); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    signal?.throwIfAborted();
    entry.cached = cached?.key === entry.expected && cached?.passed === true;
    if (entry.cached && restoreEvidence) entry.evidence = cached.evidence;
    if (!entry.cached) await rm(entry.filename, { force: true });
  }
  async function restoreUnit(index) {
    const entry = plan[index];
    if (!entry.cached) return;
    const unit = units[index];
    entry.cached = false;
    await admission?.acquire({ signal });
    try {
      signal?.throwIfAborted();
      if (stopped) return;
      try {
        let verified;
        try {
          const { identities, ...declaration } = entry.evidence ?? {};
          const bound = await bindEvidence(declaration);
          if (isDeepStrictEqual(bound.identities, identities)) verified = declaration;
        } catch { signal?.throwIfAborted(); }
        const restored = verified ? await restoreEvidence(unit, verified) : false;
        if (typeof restored !== 'boolean') throw new TypeError('restoreEvidence must return a boolean');
        signal?.throwIfAborted();
        if (restored && !isDeepStrictEqual((await bindEvidence(verified)).identities, entry.evidence.identities)) {
          throw new Error(`Artifacts changed during restoration of ${suite}/${unit.id}; suite has not passed.`);
        }
        entry.cached = restored;
      } catch (error) {
        await rm(entry.filename, { force: true });
        throw error;
      }
      if (!entry.cached) await rm(entry.filename, { force: true });
    } finally {
      delete entry.evidence;
      admission?.release();
    }
  }
  async function scan(operation, limit = scanConcurrency) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, units.length) }, async () => {
      try {
        while (!stopped && next < units.length) {
          signal?.throwIfAborted();
          await operation(next++);
        }
      } catch (error) { if (!stopped) fatal = error; stopped = true; if (!sharedAdmission) admission?.close(); }
    }));
    if (stopped) throw fatal;
  }
  async function runUnit(index, retry = false, originalFailure = 0) {
    const unit = units[index];
    const { filename, expected } = plan[index];
    await admission?.acquire({ exclusive: retry, signal });
    if (retry) normalPhase?.(true);
    let status;
    let timedOut = false;
    let ordinaryFailure = false;
    let executing = false, finished = false;
    try {
      signal?.throwIfAborted();
      if (stopped) return;
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
      while (!stopped && cursor < runnable.length) {
        signal?.throwIfAborted();
        const index = runnable[cursor++];
        await runUnit(index);
      }
    } catch (error) { if (!stopped) fatal = error; stopped = true; if (!sharedAdmission) admission?.close(); }
  }
  const runnable = [];
  let concurrency;
  try {
    const started = performance.now();
    if (cache) {
      if (!cacheScan) logger?.log(`CACHE_SCAN: ${suite} | Scanning ${units.length} test files | Concurrency: ${scanConcurrency}`);
      const prepare = async () => {
        await scan(scanUnit);
        if (restoreEvidence) await scan(restoreUnit, Math.min(scanConcurrency, workers));
      };
      await (diagnostics ? diagnostics.span(suite, 'cache-scan', prepare) : prepare());
    }
    signal?.throwIfAborted();
    if (cacheScan) {
      await cacheScan({
        total: units.length, cached: plan.filter(entry => entry.cached).length,
      });
      signal?.throwIfAborted();
      await prepareExecution?.();
      signal?.throwIfAborted();
    }
    for (let index = 0; index < units.length; index++) {
      if (!plan[index].cached) { runnable.push(index); continue; }
      const { id } = units[index];
      results[index] = { id, exitCode: 0, cached: true };
      diagnostics?.file(suite, id, 'cache-hit');
      progress && progress.file(suite, id, 'cache-hit');
    }
    if (!cacheScan) logger?.log(`CACHE_SCAN: ${suite} | Will run: ${runnable.length} | Will skip: ${units.length - runnable.length} | Duration: ${((performance.now() - started) / 1000).toFixed(2)}s${cache ? '' : ' | Cache disabled'}`);
    concurrency = Math.min(workers, runnable.length);
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
    workers: admission ? admission.peak || admission.limit : Math.min(workers, units.length), inputsChanged, results,
  };
}
