import { scanHashWorkers } from './input-hash-pool.mjs';
import { resolve } from 'node:path';
import { profileStage } from './scan-profile.mjs';
import { createFileQueue } from './file-queue.mjs';
import { Admission } from './admission.mjs';
import { withProcessSignal } from './cancellation.mjs';
import { defineConfig, loadConfig } from './config.mjs';
import { runCommand } from './command.mjs';
import { createSnapshotContext } from './inputs.mjs';
import { runTests } from './runner.mjs';
import { command, inputLimit, integer, keys, text } from './util.mjs';
import { createProgress } from './progress.mjs';
import { scanCacheJobs, scanConcurrency as defaultScanConcurrency } from './cache.mjs';
import defaultConfig from '../project-checks.config.json' with { type: 'json' };

// Definitions describe ownership and ordering. Every command, fixture attempt,
// retry and coverage gate uses the same invocation-owned admission pool.
export async function runChecks(definitions, options = {}) {
  keys(options, ['resources', 'workers', 'scanConcurrency', 'inputConcurrency', 'verificationConcurrency', 'signal', 'logger', 'progress'], 'check options');
  if (options.scanConcurrency !== undefined) integer(options.scanConcurrency, 'scanConcurrency');
  if (options.inputConcurrency !== undefined) inputLimit(options.inputConcurrency);
  if (options.verificationConcurrency !== undefined) integer(options.verificationConcurrency, 'verificationConcurrency');
  const byId = new Map();
  for (const definition of definitions) {
    keys(definition, ['id', 'dependsOn', 'config', 'command', 'cwd', 'env', 'verify'], 'check');
    text(definition.id, 'check id');
    if (byId.has(definition.id)) throw new Error(`Duplicate check: ${definition.id}`);
    if ((definition.config === undefined) === (definition.command === undefined)) throw new Error('A check needs exactly one config or command');
    if (definition.command !== undefined) command(definition.command);
    if (definition.verify !== undefined && typeof definition.verify !== 'function') throw new Error('verify must be a function');
    if (definition.dependsOn !== undefined && (!Array.isArray(definition.dependsOn) || definition.dependsOn.some(id => typeof id !== 'string'))) throw new Error('dependsOn must be an array of check IDs');
    byId.set(definition.id, definition);
  }
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`Check dependency cycle: ${id}`);
    if (visited.has(id)) return;
    const definition = byId.get(id);
    if (!definition) throw new Error(`Unknown check dependency: ${id}`);
    visiting.add(id);
    for (const dependency of definition.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  const prerequisites = new Set(), inspected = new Set();
  function collectPrerequisite(id, commandOwner) {
    const definition = byId.get(id);
    if (commandOwner && definition.config !== undefined) throw new Error(`Global scan cannot run command prerequisite ${commandOwner} before test suite ${id}`);
    if (inspected.has(id)) return;
    inspected.add(id);
    for (const dependency of definition.dependsOn ?? []) collectPrerequisite(dependency, definition.command !== undefined ? id : undefined);
    if (definition.command !== undefined) prerequisites.add(id);
  }
  for (const definition of definitions) if (definition.config !== undefined) {
    for (const dependency of definition.dependsOn ?? []) collectPrerequisite(dependency);
  }
  return withProcessSignal(options.signal, async processSignal => {
    const controller = new AbortController();
    const signal = AbortSignal.any([processSignal, controller.signal]);
    const logger = options.logger === false ? null : options.logger ?? console;
    const progress = options.progress ?? createProgress({ logger, suites: definitions.filter(definition => definition.config !== undefined).map(definition => definition.id) });
    let exitCode = 2;
    const admission = new Admission(options.resources ?? {}, Number.MAX_SAFE_INTEGER, { signal, workers: options.workers });
    let snapshotContext;
    const pending = new Map(), completed = new Map(), launched = new Set(), suites = new Map();
    const retained = [];
    const blocked = new Error('Check prerequisite failed');
    let executing = false, scanning = false, fileQueue;
    const scanned = Promise.withResolvers();
    scanned.promise.catch(() => {});
    const phases = new Map(definitions.map(({ id }) => {
      let releaseNormal;
      return [id, active => {
        if (active) releaseNormal ??= admission.beginNormal();
        else { releaseNormal?.(); releaseNormal = undefined; }
      }];
    }));
    function track(id, operation) {
      const settled = operation.then(value => {
        completed.set(id, value);
        if (executing) launchReady();
        return { status: 'fulfilled', value };
      }, reason => {
        completed.set(id, { id, exitCode: 1 });
        if (executing) launchReady();
        return { status: 'rejected', reason };
      }).finally(() => phases.get(id)(false));
      pending.set(id, settled);
      return settled;
    }
    async function runCommandCheck(definition) {
      signal.throwIfAborted();
      await definition.verify?.();
      await admission.acquire({ signal });
      try { return { id: definition.id, exitCode: await runCommand(definition.command, { cwd: definition.cwd, env: definition.env, signal, logger }) }; }
      finally { admission.release(); }
    }
    function runPrerequisite(id) {
      if (pending.has(id)) return pending.get(id);
      launched.add(id);
      const definition = byId.get(id);
      return track(id, (async () => {
        await Promise.all((definition.dependsOn ?? []).map(runPrerequisite));
        if ((definition.dependsOn ?? []).some(dependency => completed.get(dependency).exitCode)) return { id, exitCode: 1, skipped: true };
        return runCommandCheck(definition);
      })());
    }
    function failedPrerequisite(id) {
      return (byId.get(id).dependsOn ?? []).some(dependency => completed.get(dependency)?.exitCode || failedPrerequisite(dependency));
    }
    function stopPreparation() {
      if (!scanning) scanned.reject(signal.reason);
      for (const { ready, permission, queued } of suites.values()) {
        queued.reject(signal.reason);
        ready.reject(signal.reason);
        permission.reject(signal.reason);
      }
    }
    signal.addEventListener('abort', stopPreparation, { once: true });
    function launchReady() {
      for (const [id, definition] of byId) {
        if (launched.has(id) || (definition.dependsOn ?? []).some(dependency => !completed.has(dependency))) continue;
        launched.add(id);
        const failed = (definition.dependsOn ?? []).some(dependency => completed.get(dependency).exitCode);
        if (definition.config !== undefined) {
          if (failed) { progress && progress.files(id, 0); fileQueue.skip(id); suites.get(id).permission.reject(blocked); }
          else {
            phases.get(id)(true);
            fileQueue.enable(id);
            suites.get(id).permission.resolve();
          }
        } else {
          phases.get(id)(true);
          track(id, failed ? Promise.resolve({ id, exitCode: 1, skipped: true }) : runCommandCheck(definition));
        }
      }
    }
    try {
      const builds = await Promise.all([...prerequisites].map(runPrerequisite));
      const buildError = builds.find(result => result.status === 'rejected');
      if (buildError) throw buildError.reason;
      const testDefinitions = definitions.filter(definition => definition.config !== undefined);
      const started = performance.now();
      if (testDefinitions.length) logger?.log('CACHE_SCAN: checks | Collecting all selected test files');
      let configError;
      const preparedConfigs = await Promise.allSettled(testDefinitions.filter(({ id }) => !failedPrerequisite(id)).map(async definition => {
        try {
          signal.throwIfAborted();
          await definition.verify?.();
          signal.throwIfAborted();
          const config = typeof definition.config === 'function' ? await definition.config({ signal })
            : typeof definition.config === 'string' ? await loadConfig(resolve(definition.cwd ?? process.cwd(), definition.config)) : definition.config;
          signal.throwIfAborted();
          defineConfig(config);
          return [definition.id, config];
        } catch (error) {
          if (!configError) { configError = error; controller.abort(error); }
          throw error;
        }
      }));
      if (configError) throw configError;
      const configs = new Map(preparedConfigs.map(result => result.value));
      const inputConcurrency = options.inputConcurrency ?? (configs.size
        ? Math.min(...[...configs.values()].map(config => config.inputConcurrency ?? defaultConfig.inputConcurrency)) : defaultConfig.inputConcurrency);
      snapshotContext = createSnapshotContext({ signal, inputConcurrency });
      snapshotContext.beginScanGeneration({ hashWorkers: scanHashWorkers(admission) });
      for (const definition of testDefinitions) {
        const { id } = definition;
        if (failedPrerequisite(id)) {
          launched.add(id);
          progress && progress.files(id, 0);
          track(id, Promise.resolve({ id, exitCode: 1, skipped: true }));
          continue;
        }
        const ready = Promise.withResolvers(), permission = Promise.withResolvers(), queued = Promise.withResolvers();
        // Gates can be cancelled before a slow configuration reaches them.
        permission.promise.catch(() => {});
        const prepared = ready.promise.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
        const inventory = queued.promise.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
        suites.set(id, { ready, permission, prepared, queued, inventory });
        track(id, (async () => {
          try {
            signal.throwIfAborted();
            const config = configs.get(id);
            const suiteProgress = progress ? {
              files: (_, total) => progress.files(id, total),
              file: (_, ...args) => progress.file(id, ...args),
            } : false;
            return { id, ...await runTests({ ...config, inputConcurrency: options.inputConcurrency ?? config.inputConcurrency, signal, admission, snapshotContext, logger: logger ?? false, progress: suiteProgress }, {
              retained, normalPhase: phases.get(id),
              executeFiles: () => fileQueue.run(id),
              queueScan: (jobs, scanConcurrency) => { queued.resolve({ jobs, scanConcurrency }); return scanned.promise; },
              cacheScan: plan => { ready.resolve(plan); return permission.promise; },
            }) };
          } catch (error) {
            fileQueue?.skip(id, error);
            if (error === blocked) return { id, exitCode: 1, skipped: true };
            ready.reject(error);
            if (!executing) controller.abort(error);
            throw error;
          }
        })());
      }
      const inventories = await profileStage('collect-inputs', () => Promise.all([...suites.values()].map(suite => suite.inventory)));
      const inventoryError = inventories.find(result => result.status === 'rejected');
      if (inventoryError) throw inventoryError.reason;
      signal.throwIfAborted();
      const jobs = inventories.flatMap(({ value }) => value.jobs);
      const scanConcurrency = options.scanConcurrency ?? (inventories.length
        ? Math.min(...inventories.map(({ value }) => value.scanConcurrency)) : defaultScanConcurrency);
      if (testDefinitions.length) logger?.log(`CACHE_SCAN: checks | Queued: ${jobs.length} test files | Concurrency: ${scanConcurrency}`);
      scanning = true;
      try {
        await profileStage('scan-queue', () => scanCacheJobs(jobs.map(run => Object.assign(async () => {
          try { signal.throwIfAborted(); await run(); }
          catch (error) { controller.abort(error); throw error; }
        }, { scanIdentity: run.scanIdentity })), options.resources, scanConcurrency, { logger: options.progress === false ? null : logger }));
      } finally {
        scanning = false;
        if (signal.aborted) scanned.reject(signal.reason);
      }
      await profileStage('scan-acceptance', () => snapshotContext.finishScanGeneration());
      scanned.resolve();
      const prepared = await Promise.all([...suites.values()].map(suite => suite.prepared));
      const preparationError = prepared.find(result => result.status === 'rejected');
      if (preparationError) throw preparationError.reason;
      signal.throwIfAborted();
      const total = prepared.reduce((sum, { value }) => sum + value.total, 0);
      const cached = prepared.reduce((sum, { value }) => sum + value.cached, 0);
      if (testDefinitions.length) logger?.log(`CACHE_SCAN: checks | Will run: ${total - cached} | Will skip: ${cached} | Total: ${total} | Duration: ${((performance.now() - started) / 1000).toFixed(2)}s`);
      if (process.env.PROJECT_CHECKS_SCAN_ONLY === '1') {
        exitCode = 0;
        logger?.log(`SCAN_ONLY: Complete | Cached: ${cached} | Cache misses: ${total - cached} | Test execution suppressed`);
        return { exitCode, scanOnly: true, total, cached };
      }
      const verificationConcurrency = options.verificationConcurrency ?? (prepared.length
        ? Math.min(...prepared.map(({ value }) => value.verificationConcurrency)) : undefined);
      fileQueue = createFileQueue([...suites.keys()].map((id, index) => ({ id, jobs: prepared[index].value.jobs })), admission, signal, { verificationConcurrency });
      executing = true;
      launchReady();
      let settled;
      do { settled = await Promise.all([...pending.values()]); } while (settled.length !== byId.size);
      const failure = settled.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      const results = definitions.map(({ id }) => completed.get(id));
      // Recheck all suites after dependents and aggregates have drained.
      for (const handle of retained) await handle.verify();
      for (const definition of definitions) await definition.verify?.();
      exitCode = results.find(result => result.exitCode)?.exitCode ?? 0;
      return { exitCode, results };
    } catch (error) {
      if (processSignal.aborted || error.name === 'AbortError') exitCode = 130;
      throw error;
    } finally {
      if (!executing) {
        if (!signal.aborted) controller.abort(new Error('Global cache scan stopped'));
        stopPreparation();
        await Promise.all(pending.values());
      }
      await fileQueue?.close();
      signal.removeEventListener('abort', stopPreparation);
      try {
        const closed = await Promise.allSettled(retained.map(handle => handle.close()));
        await snapshotContext?.close();
        admission.report(logger, 'checks');
        admission.close();
        const failure = closed.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      } catch (error) { exitCode = 2; throw error; }
      finally { if (options.progress === undefined) progress.close(exitCode); }
    }
  });
}
