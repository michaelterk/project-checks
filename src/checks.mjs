import { resolve } from 'node:path';
import { Admission } from './admission.mjs';
import { withProcessSignal } from './cancellation.mjs';
import { loadConfig } from './config.mjs';
import { runCommand } from './command.mjs';
import { createSnapshotContext } from './inputs.mjs';
import { runTests } from './runner.mjs';
import { command, keys, text } from './util.mjs';
import { createProgress } from './progress.mjs';

// Definitions describe ownership and ordering. Every command, fixture attempt,
// retry and coverage gate uses the same invocation-owned admission pool.
export async function runChecks(definitions, options = {}) {
  keys(options, ['resources', 'workers', 'signal', 'logger', 'progress'], 'check options');
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
  return withProcessSignal(options.signal, async signal => {
    const logger = options.logger === false ? null : options.logger ?? console;
    const progress = options.progress ?? createProgress({ logger, suites: definitions.filter(definition => definition.config !== undefined).map(definition => definition.id) });
    let exitCode = 2;
    const admission = new Admission(options.resources ?? {}, Number.MAX_SAFE_INTEGER, { signal, workers: options.workers });
    const snapshotContext = createSnapshotContext({ signal });
    const pending = new Map(), completed = new Map();
    const retained = [];
    const launchReady = () => {
      for (const [id, definition] of byId) {
        if (pending.has(id) || (definition.dependsOn ?? []).some(dependency => !completed.has(dependency))) continue;
        let releaseNormal = admission.beginNormal();
        const normalPhase = active => {
          if (active) releaseNormal ??= admission.beginNormal();
          else { releaseNormal?.(); releaseNormal = undefined; }
        };
        const operation = (async () => {
          if ((definition.dependsOn ?? []).some(dependency => completed.get(dependency).exitCode)) {
            if (definition.config !== undefined) progress && progress.files(id, 0);
            return { id, exitCode: 1, skipped: true };
          }
          signal.throwIfAborted();
          await definition.verify?.();
          if (definition.command) {
            await admission.acquire({ signal });
            try { return { id, exitCode: await runCommand(definition.command, { cwd: definition.cwd, env: definition.env, signal, logger }) }; }
            finally { admission.release(); }
          }
          const config = typeof definition.config === 'function' ? await definition.config({ signal })
            : typeof definition.config === 'string' ? await loadConfig(resolve(definition.cwd ?? process.cwd(), definition.config)) : definition.config;
          const suiteProgress = progress ? {
            files: (_, total) => progress.files(id, total),
            file: (_, ...args) => progress.file(id, ...args),
          } : false;
          return { id, ...await runTests({ ...config, signal, admission, snapshotContext, logger: logger ?? false, progress: suiteProgress }, { retained, normalPhase }) };
        })();
        pending.set(id, operation.then(value => {
          completed.set(id, value);
          launchReady();
          return { status: 'fulfilled', value };
        }, reason => {
          completed.set(id, { id, exitCode: 1 });
          launchReady();
          return { status: 'rejected', reason };
        }).finally(() => normalPhase(false)));
      }
    };
    try {
      launchReady();
      let settled;
      do { settled = await Promise.all([...pending.values()]); } while (settled.length !== byId.size);
      const failure = settled.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      const results = settled.map(result => result.value);
      // Recheck all suites after dependents and aggregates have drained.
      for (const handle of retained) await handle.verify();
      for (const definition of definitions) await definition.verify?.();
      exitCode = results.find(result => result.exitCode)?.exitCode ?? 0;
      return { exitCode, results };
    } catch (error) {
      if (signal.aborted || error.name === 'AbortError') exitCode = 130;
      throw error;
    } finally {
      try {
        const closed = await Promise.allSettled(retained.map(handle => handle.close()));
        await snapshotContext.close();
        admission.report(logger, 'checks');
        admission.close();
        const failure = closed.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      } catch (error) { exitCode = 2; throw error; }
      finally { if (options.progress === undefined) progress.close(exitCode); }
    }
  });
}
