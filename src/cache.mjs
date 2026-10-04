import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { command, digest, integer, object, text } from './util.mjs';
import { Admission } from './admission.mjs';

const ignoredEnvironment = /^(?:PWD|OLDPWD|SHLVL|_|NODE_TEST_CONTEXT|TMPDIR|TMP|TEMP|TERM|COLORTERM|FORCE_COLOR|NO_COLOR|NODE_DISABLE_COLORS|npm_lifecycle_event|npm_lifecycle_script|npm_command|npm_package_(?:name|version|json)|npm_config_(?:cache|logs_dir|loglevel|progress|timing|color|fund|audit|update_notifier))$/;

export function environmentIdentity(env = process.env, ignoreEnv = []) {
  const ignored = new Set(ignoreEnv);
  return digest(JSON.stringify(Object.entries(env).filter(([name, value]) => value !== undefined && !ignored.has(name) && !ignoredEnvironment.test(name)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}

export async function runCachedUnits({ cacheDirectory, suite = 'tests', units, snapshot, workers, resources, execute, environment = process.env, ignoreEnv = [], cache = true, signal, logger = console, admission: sharedAdmission }) {
  if (workers !== undefined) integer(workers, 'workers');
  text(suite, 'suite');
  if (cache) text(cacheDirectory, 'cacheDirectory');
  if (!Array.isArray(units) || !units.length || new Set(units.map(unit => unit.id)).size !== units.length) throw new TypeError('Unique nonempty test units required');
  for (const unit of units) {
    text(unit.id, 'unit id');
    if (unit.identity === undefined) command(unit.command);
    else text(unit.identity, 'unit identity');
  }
  if (typeof snapshot !== 'function' || typeof execute !== 'function') throw new TypeError('snapshot and execute must be functions');
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
  const before = await takeSnapshot();
  if (!isDeepStrictEqual(Object.keys(before.units).sort(), ids)) throw new Error('Current test-unit discovery changed before execution');
  const base = digest(JSON.stringify(['project-checks-evidence-v1', process.execPath, process.version, process.platform, process.arch, environmentIdentity(environment, ignoreEnv), before.common]));
  const key = unit => digest(JSON.stringify([base, suite, unit.id, before.units[unit.id], unit.identity ?? unit.command]));
  if (cache) await mkdir(cacheDirectory, { recursive: true });
  const results = new Array(units.length);
  const admission = sharedAdmission ?? (workers === undefined && resources !== undefined ? new Admission(resources, units.length, { signal }) : null);
  workers = sharedAdmission ? sharedAdmission.capacity : workers ?? admission?.capacity ?? 1;
  let cursor = 0;
  let fatal;
  let stopped = false;
  let inputsChanged = false;
  let checking;
  const check = () => checking ??= takeSnapshot().finally(() => { checking = undefined; });
  async function worker() {
    try {
      while (!stopped && cursor < units.length) {
        signal?.throwIfAborted();
        const index = cursor++;
        const unit = units[index];
        const filename = cache ? join(cacheDirectory, `${digest(`${suite}\0${unit.id}`)}.json`) : undefined;
        const expected = key(unit);
        let cached;
        if (cache) {
          try { cached = JSON.parse(await readFile(filename, 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        }
        if (cached?.key === expected && cached?.passed === true) {
          logger?.log(`==> Reusing successful ${suite}/${unit.id}`);
          results[index] = { id: unit.id, exitCode: 0, cached: true };
          continue;
        }
        if (cache) await rm(filename, { force: true });
        await admission?.acquire();
        let status;
        try {
          signal?.throwIfAborted();
          if (stopped) return;
          logger?.log(`==> Running ${suite}/${unit.id}`);
          status = await execute(unit);
        } finally { admission?.release(); }
        integer(status, 'execute exit code', 0);
        signal?.throwIfAborted();
        results[index] = { id: unit.id, exitCode: status, cached: false };
        if (status !== 0) continue;
        if (!isDeepStrictEqual(before, await check())) {
          logger?.error(`Inputs changed during ${suite}/${unit.id}; no passing evidence saved.`);
          inputsChanged = true;
          continue;
        }
        if (cache) {
          const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, JSON.stringify({ key: expected, passed: true }), { mode: 0o600, flag: 'wx' });
            await rename(temporary, filename);
          } finally { await rm(temporary, { force: true }); }
        }
      }
    } catch (error) { if (!stopped) fatal = error; stopped = true; if (!sharedAdmission) admission?.close(); }
  }
  const concurrency = Math.min(workers, units.length);
  try { await Promise.all(Array.from({ length: concurrency }, worker)); }
  finally { if (!sharedAdmission) admission?.close(); }
  if (stopped) throw fatal;
  signal?.throwIfAborted();
  if (!isDeepStrictEqual(before, await takeSnapshot())) {
    logger?.error(`Inputs changed during ${suite}; suite has not passed.`);
    inputsChanged = true;
  }
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
