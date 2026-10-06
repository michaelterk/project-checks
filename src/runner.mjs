import { scanHashWorkers } from './input-hash-pool.mjs';
import { isDeepStrictEqual } from 'node:util';
import { createCoverage } from './coverage.mjs';
import { Admission } from './admission.mjs';
import { withProcessSignal } from './cancellation.mjs';
import { readFile, realpath } from 'node:fs/promises';
import { basename, join, resolve, delimiter } from 'node:path';
import { defineConfig, defaultIgnore, defaultDirectoryIgnore } from './config.mjs';
import { runCachedUnits } from './cache.mjs';
import { commandEnvironment, runCommand } from './command.mjs';
import { createSnapshot, createSnapshotContext, discoverTests, selectTests } from './inputs.mjs';
import { inside } from './util.mjs';
import { createDurationHints } from './durations.mjs';
import { withProgress } from './progress.mjs';

async function normalizeConfig(options) {
  defineConfig(options);
  const root = await realpath(resolve(options.root ?? process.cwd()));
  const config = {
    ...options,
    root,
    suite: options.suite ?? 'tests',
    testDirectory: options.testDirectory ?? 'test',
    pattern: options.pattern ?? '**/*.test.{js,mjs,cjs}',
    inputs: options.inputs ?? ['.'],
    ignore: options.ignore ?? defaultIgnore,
    directoryIgnore: options.directoryIgnore ?? structuredClone(defaultDirectoryIgnore),
    cacheDirectory: resolve(root, options.cacheDirectory ?? '.test-cache/project-checks'),
  };
  if (inside(config.cacheDirectory, root) || inside(config.cacheDirectory, resolve(root, config.testDirectory)))
    throw new Error('cacheDirectory must not contain the project root or testDirectory');
  return config;
}

function fileSnapshot(config) {
  const context = config.snapshotContext ?? createSnapshotContext({ signal: config.signal, inputConcurrency: config.inputConcurrency });
  const snapshot = createSnapshot(config, context);
  let closed = false;
  const pending = new Set();
  const track = operation => {
    if (closed) return Promise.reject(new Error('File snapshot closed'));
    const result = Promise.resolve().then(operation);
    pending.add(result);
    result.then(() => pending.delete(result), () => pending.delete(result));
    return result;
  };
  return {
    prepare: inventory => track(async () => {
      const prepared = await snapshot.prepare(inventory);
      return { ...prepared, unit: id => track(() => prepared.unit(id)) };
    }),
    snapshot: () => track(snapshot),
    close: async () => {
      closed = true;
      await Promise.allSettled(pending);
      if (!config.snapshotContext) await context.close();
    },
  };
}

export async function createFileSnapshot(options = {}) {
  return fileSnapshot(await normalizeConfig(options));
}

export async function runTests(options = {}, lifecycle = {}) {
  return withProgress(options, progress => withProcessSignal(options.signal, signal => runTestsWithSignal({ ...options, progress, signal }, lifecycle)));
}

async function runTestsWithSignal(options, { retained, normalPhase, cacheScan, queueScan, executeFiles }) {
  const config = await normalizeConfig(options);
  const { root } = config;
  if (config.coverage?.report) config.ignore = [...config.ignore, config.coverage.report, `${config.coverage.report}.*.tmp`];
  const diagnostics = config.diagnostics;
  const span = (stage, operation, fields) =>
    diagnostics ? diagnostics.span(config.suite, stage, operation, fields) : operation();
  const inventory = await span('test-discovery', () => options.snapshotContext?.discoverInventory(config) ?? discoverTests(config));
  const selection = selectTests({ ...config, files: undefined }, inventory);
  const files = selectTests({ ...config, files: options.files ?? selection }, inventory);
  if (files.some(id => !selection.includes(id))) throw new Error('File is outside the selected suite');
  if (!files.length) throw new Error(`No test files found in ${config.testDirectory}`);
  diagnostics?.files(config.suite, files.length);
  config.progress && config.progress.files(config.suite, options.engine === 'playwright' && options.frameworkArgs?.length ? 1 : files.length);
  const context = config.snapshotContext ?? createSnapshotContext({ signal: config.signal, inputConcurrency: config.inputConcurrency });
  config.snapshotContext = context;
  let inputs, artifacts, fixture;
  let before;
  const admission = options.admission ?? new Admission(options.resources ?? {}, files.length + 1, { signal: config.signal, workers: options.workers });
  if (!options.admission) diagnostics?.observeAdmission?.(admission);
  let deferred = false;
  const close = async () => {
    try { await fixture?.close?.(); }
    finally { try { await artifacts?.close(); } finally { await inputs?.close(); } }
  };
  try {
    const hints = await span('duration-hints', () => createDurationHints(config));
    const env = commandEnvironment(options.env);
    if (config.normalizeNpmEnvironment) {
      for (const name of ['INIT_CWD', 'NODE', 'npm_execpath', 'npm_node_execpath', 'npm_config_local_prefix', 'npm_config_prefix', 'npm_config_user_agent']) delete env[name];
      env.PATH = [join(root, 'node_modules/.bin'), ...(env.PATH ?? '').split(delimiter).filter(directory => !directory.endsWith('/node_modules/.bin') && !directory.endsWith('/node-gyp-bin'))].join(delimiter);
    }
    const logger = options.logger === false ? null : (options.logger ?? console);
    const template = options.command ?? [process.execPath, '--test', '--test-concurrency=1', '{file}'];
    const fileArgument = id => options.engine === 'playwright' ? `${resolve(root, id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` : id;
    const units = files.map(id => ({ id, command: typeof template === 'function' ? template(id) : template.map(argument => argument.replaceAll('{file}', fileArgument(id))) }));
    const nodeTest = options.engine === 'node' || (!options.engine && units.every(unit => unit.command.includes('--test') && /^node(?:\.exe)?$/.test(basename(unit.command[0]))));
    const pythonTest = !options.engine && units.every(unit => /^python[0-9.]*(?:\.exe)?$/.test(basename(unit.command[0])));
    const filters = options.filters ?? [];
    if (filters.length && !nodeTest) throw new Error('Node filters require a Node test suite');
    if (filters.length) {
      config.cache = false;
      for (const unit of units) unit.command.splice(unit.command.indexOf('--test') + 1, 0, ...filters);
    }
    const definition = config.coverage ?? (nodeTest ? {} : pythonTest ? { provider: 'python', python: units[0].command[0] } : false);
    // Partial files can contribute coverage; filters never contribute complete evidence.
    if (definition !== false && !filters.length) {
      config.coverage = definition;
      artifacts = await createCoverage(config, env);
      for (const unit of units) {
        unit.command = artifacts.command(unit.command);
        unit.identity = JSON.stringify([unit.command, artifacts.identity]);
      }
    }
    if (!cacheScan) fixture = await options.setup?.({ signal: config.signal });
    const prepareExecution = cacheScan ? async () => {
      fixture = await options.setup?.({ signal: config.signal });
    } : undefined;
    if (options.engine === 'playwright' && options.frameworkArgs?.length) {
      if (typeof template === 'function') throw new Error('Playwright actions require a command template');
      const action = { id: 'framework-action', command: [...template.flatMap(argument => argument.includes('{file}')
        ? (options.files?.length ? files.map(id => argument.replaceAll('{file}', fileArgument(id))) : []) : [argument]), ...options.frameworkArgs] };
      return await runCachedUnits({
        suite: `${config.suite}/action`, cache: false, scanConcurrency: config.scanConcurrency, verificationConcurrency: config.verificationConcurrency, resources: {}, admission, signal: config.signal, logger,
        progress: config.progress ? {
          files: () => config.progress.files(config.suite, 1),
          file: (_, ...args) => config.progress.file(config.suite, ...args),
        } : false,
        units: [action], snapshot: async () => ({ common: 'uncached-action', units: { 'framework-action': 'uncached-action' } }),
        retryTimeouts: config.retryTimeouts, normalPhase,
        execute: (unit, { reportTimeout }) => (fixture?.execute ?? runCommand)(unit.command, {
          cwd: root, env, signal: config.signal, playwrightTest: true, onTimeout: reportTimeout, timeoutMs: config.timeoutMs,
        }),
      }, { queueScan, cacheScan, prepareExecution, executeFiles });
    }
    const retryTimeouts = options.retryTimeouts ?? false;
    const retryTimeoutMs = options.retryTimeoutMs ?? 60000;
    inputs = fileSnapshot(config);
    if (!options.snapshotContext) context.beginScanGeneration({ hashWorkers: options.admission ? 0 : scanHashWorkers(admission) });
    const initialSnapshot = await inputs.prepare(inventory);
    before = initialSnapshot.value;
    const prepareUnit = initialSnapshot.unit;
    initialSnapshot.unit = async id => hints.identify(id, await prepareUnit(id));
    let snapshotCalls = 1;
    let lastSnapshotSeconds = 0;
    const result = await runCachedUnits({
      cacheDirectory: config.cacheDirectory,
      suite: options.suite ?? 'tests',
      units,
      workers: options.workers,
      scanConcurrency: config.scanConcurrency,
      inputConcurrency: config.inputConcurrency,
      verificationConcurrency: config.verificationConcurrency,
      resources: options.resources ?? {},
      cache: config.cache ?? true,
      signal: options.signal,
      logger,
      retryTimeouts,
      normalPhase,
      admission,
      ...(artifacts ? { saveEvidence: artifacts.saveEvidence, restoreEvidence: artifacts.restoreEvidence } : {}),
      diagnostics,
      progress: config.progress,
      snapshot: () => {
        const call = ++snapshotCalls;
        const started = performance.now();
        return span(
          'snapshot-recheck',
          () => span('snapshot-inputs', inputs.snapshot, { call }),
          { call },
        ).finally(() => {
          lastSnapshotSeconds = (performance.now() - started) / 1000;
        });
      },
      execute: async (unit, { retry, reportTimeout }) => {
        const started = performance.now();
        diagnostics?.file(config.suite, unit.id, 'file-start', { retry });
        let status;
        try {
          const execute = fixture?.execute ?? runCommand;
          status = await execute(unit.command, {
            cwd: root,
            env: artifacts ? await artifacts.environment(unit) : env,
            retry, reportTimeout,
            signal: options.signal,
            stdio: options.stdio ?? 'inherit',
            logger,
            timeoutMs: options.timeoutMs,
            nodeTest,
            playwrightTest: options.engine === 'playwright',
            testTimeoutMs: retry ? retryTimeoutMs : undefined,
            onTimeout: reportTimeout,
          });
        } finally {
          diagnostics?.file(config.suite, unit.id, 'file-end', {
            status: status ?? 'interrupted',
            seconds: (performance.now() - started) / 1000,
          });
        }
        if (status === 0) hints.record(unit.id, (performance.now() - started) / 1000);
        return status;
      },
    }, { queueScan, cacheScan, prepareExecution, executeFiles, artifactContext: context, initialSnapshot, afterScan: !options.snapshotContext ? () => context.finishScanGeneration() : undefined, orderFiles: (a, b) => hints.priority(b) - hints.priority(a) });
    diagnostics?.event('snapshot-final', { suite: config.suite, call: snapshotCalls, seconds: lastSnapshotSeconds });
    if (!result.inputsChanged) await hints.save();
    if (!result.exitCode && artifacts && files.length === selection.length) {
      await admission.acquire({ signal: config.signal });
      try { result.exitCode = await artifacts.aggregate(units); }
      finally { admission.release(); }
    }
    const verify = async () => {
      if (!isDeepStrictEqual(before, await inputs.snapshot())) throw new Error('Check inputs changed during invocation');
      await artifacts?.verifySources();
    };
    if (!result.exitCode) {
      await verify();
      if (artifacts && files.length === selection.length) await artifacts.saveSummary(before);
    }
    if (retained) {
      retained.push({ verify, close });
      deferred = true;
    }
    return result;
  } finally {
    try { if (!deferred) await close(); }
    finally {
      if (!options.snapshotContext) await context.close();
      if (!options.admission) admission.close();
    }
    options.signal?.throwIfAborted();
  }
}

export async function reportCoverage(options) {
  const config = await normalizeConfig(options);
  if (config.coverage === false) return null;
  config.coverage ??= {};
  if (config.coverage.report) config.ignore = [...config.ignore, config.coverage.report, `${config.coverage.report}.*.tmp`];
  const inputs = fileSnapshot({ ...config, files: undefined });
  try {
    const file = config.coverage.report ? resolve(config.root, config.coverage.report) : join(config.cacheDirectory, 'coverage', encodeURIComponent(config.suite), 'latest.json');
    let summary;
    try { summary = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    return { suite: config.suite, minimum: { lines: 80, branches: 80, functions: 80, ...config.coverage.minimum },
      actual: summary?.actual, stale: !summary || !isDeepStrictEqual(summary.definition, config.coverage) || !isDeepStrictEqual(summary.snapshot, await inputs.snapshot()), measuredAt: summary?.measuredAt };
  } finally { await inputs.close(); }
}
