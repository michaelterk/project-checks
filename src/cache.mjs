import { withProcessSignal } from './cancellation.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { command, digest, integer, keys, object, text } from './util.mjs';
import { Admission } from './admission.mjs';
import { createSnapshotContext } from './inputs.mjs';
import { withProgress } from './progress.mjs';
import { createFileQueue } from './file-queue.mjs';
import { verificationConcurrency as defaultVerificationConcurrency } from './verification-pool.mjs';

import { createScanQueue, scanConcurrency as defaultScanConcurrency } from './scan-queue.mjs';
export { scanConcurrency } from './scan-queue.mjs';

const scanQueue = createScanQueue();
export async function scanCacheJobs(operations, resources, scanConcurrency = defaultScanConcurrency, { logger = null, suite = 'checks' } = {}) {
  let latest;
  const complete = Promise.allSettled(scanQueue.enqueue(operations, resources, scanConcurrency, logger ? state => { latest = state; } : undefined));
  const report = () => {
    if (latest) logger.log(`CACHE_SCAN_PROGRESS: ${suite} | ${latest.scanned} out of ${latest.total} scanned | Workers: ${latest.active}`);
  };
  const timer = logger && operations.length ? setInterval(report, 1000) : undefined;
  try {
    report();
    const settled = await complete;
    report();
    const failure = settled.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  } finally { clearInterval(timer); await complete; }
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

export async function runCachedUnits(options, { queueScan, cacheScan, prepareExecution, executeFiles } = {}) {
  return withProgress(options, progress => withProcessSignal(options.signal, signal => runUnits({ ...options, progress, signal }, { queueScan, cacheScan, prepareExecution, executeFiles })));
}

async function runUnits({ cacheDirectory, suite = 'tests', units, snapshot, workers, scanConcurrency = defaultScanConcurrency, verificationConcurrency = defaultVerificationConcurrency, resources, execute, cache = true, signal, logger = console, admission: sharedAdmission, retryTimeouts = false, restoreEvidence, saveEvidence, diagnostics, normalPhase, progress }, { queueScan, cacheScan, prepareExecution, executeFiles }) {
  if (workers !== undefined) integer(workers, 'workers');
  integer(scanConcurrency, 'scanConcurrency');
  integer(verificationConcurrency, 'verificationConcurrency');
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
  let fatal;
  let stopped = false;
  let inputsChanged = false;
  let checking;
  const retries = [];
  const startedFiles = new Set();
  const check = () => checking ??= takeSnapshot().finally(() => { checking = undefined; });
  const plan = units.map(unit => ({
    filename: cache ? join(cacheDirectory, cacheRecordName(suite, unit.id)) : undefined,
    expected: cacheKey(before, unit.id), cached: false,
  }));
  async function scanUnit(index, read = filename => readFile(filename, 'utf8')) {
    signal?.throwIfAborted();
    const entry = plan[index];
    let cached;
    try { cached = JSON.parse(await read(entry.filename, signal)); }
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
  async function runUnit(index, retry = false, originalFailure = 0, admitted = false, scheduling) {
    const unit = units[index];
    const { filename, expected } = plan[index];
    if (!admitted) await admission?.acquire({ exclusive: retry, signal });
    if (retry) normalPhase?.(true);
    let status;
    let timedOut = false;
    let ordinaryFailure = false;
    let executing = false, finished = false;
    try {
      signal?.throwIfAborted();
      if (stopped) return;
      logger?.log(`==> ${retry ? 'Retrying timeout file alone (once)' : 'Running'} ${suite}/${unit.id}`);
      startedFiles.add(index);
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
      progress && progress.file(suite, unit.id, 'file-validating');
      results[index] = { id: unit.id, exitCode: status, cached: false };
      if (!retry && retryTimeouts && timedOut) retries.push({ index, originalFailure: ordinaryFailure ? status : 0 });
      if (status !== 0) { finished = true; return; }
      const finalize = async () => {
        signal?.throwIfAborted();
        if (!isDeepStrictEqual(before, await check()) || inputsChanged) {
          logger?.error(`Inputs changed during ${suite}/${unit.id}; no passing evidence saved.`);
          inputsChanged = true;
          finished = true;
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
            finished = true;
            return;
          }
          signal?.throwIfAborted();
        }
        if (cache) {
          const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, JSON.stringify({ key: expected, passed: true, ...(saveEvidence ? { evidence } : {}) }), { mode: 0o600, flag: 'wx' });
            signal?.throwIfAborted();
            if (inputsChanged) { finished = true; return; }
            await rename(temporary, filename);
          } finally { await rm(temporary, { force: true }); }
        }
        finished = true;
      };
      // Evidence collection can launch processes and retains command admission.
      if (scheduling && !saveEvidence) {
        scheduling.releaseExecution();
        await scheduling.verify(finalize);
      } else await finalize();
    } finally {
      if (executing) progress && progress.file(suite, unit.id, 'file-end', finished ? { status, timedOut } : { status: 'interrupted' });
      if (!admitted) admission?.release();
    }
  }
  const runnable = [];
  try {
    const started = performance.now();
    if (queueScan) {
      const prepare = () => queueScan(units.map((_, index) => async () => {
        signal?.throwIfAborted();
        if (!cache) return;
        await scanUnit(index, filename => readFile(filename, 'utf8'));
        if (restoreEvidence) await restoreUnit(index);
      }), scanConcurrency);
      await (diagnostics ? diagnostics.span(suite, 'cache-scan', prepare) : prepare());
    } else if (cache) {
      if (!cacheScan) logger?.log(`CACHE_SCAN: ${suite} | Scanning ${units.length} test files | Concurrency: ${scanConcurrency}`);
      const prepare = async () => {
        await scanCacheJobs(units.map((_, index) => async () => {
          if (stopped) throw fatal;
          try { await scanUnit(index); }
          catch (error) { if (!stopped) fatal = error; stopped = true; throw error; }
        }), resources, scanConcurrency, { logger: progress === false ? null : logger, suite });
        if (stopped) throw fatal;
        if (restoreEvidence) await scan(restoreUnit, Math.min(scanConcurrency, workers));
      };
      await (diagnostics ? diagnostics.span(suite, 'cache-scan', prepare) : prepare());
    }
    signal?.throwIfAborted();
    for (let index = 0; index < units.length; index++) {
      const { id } = units[index];
      if (!plan[index].cached) {
        runnable.push(index);
        progress && progress.file(suite, id, 'file-queued');
        continue;
      }
      results[index] = { id, exitCode: 0, cached: true };
      diagnostics?.file(suite, id, 'cache-hit');
      progress && progress.file(suite, id, 'cache-hit');
    }
    if (cacheScan) {
      await cacheScan({
        total: units.length, cached: units.length - runnable.length,
        verificationConcurrency,
        jobs: runnable.map(index => scheduling => runUnit(index, false, 0, true, scheduling)),
      });
      signal?.throwIfAborted();
      await prepareExecution?.();
      signal?.throwIfAborted();
    }
    if (!cacheScan) logger?.log(`CACHE_SCAN: ${suite} | Will run: ${runnable.length} | Will skip: ${units.length - runnable.length} | Duration: ${((performance.now() - started) / 1000).toFixed(2)}s${cache ? '' : ' | Cache disabled'}`);
    if (executeFiles) await executeFiles();
    else {
      const releaseNormal = admission?.beginNormal();
      const queue = createFileQueue([{ id: suite, jobs: runnable.map(index =>
        scheduling => runUnit(index, false, 0, true, scheduling)) }], admission, signal, { workers, verificationConcurrency });
      try { queue.enable(suite); await queue.run(suite); }
      finally { try { await queue.close(); } finally { releaseNormal?.(); } }
    }
    if (stopped) throw fatal;
    for (const { index, originalFailure } of retries) {
      normalPhase?.(false);
      signal?.throwIfAborted();
      if (!isDeepStrictEqual(before, await check())) inputsChanged = true;
      await runUnit(index, true, originalFailure);
    }
  }
  finally {
    for (const index of runnable) if (!startedFiles.has(index)) progress && progress.file(suite, units[index].id, 'file-cancelled');
    await artifacts?.close();
    if (!sharedAdmission) admission?.close();
  }
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
