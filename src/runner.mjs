import { withProcessSignal } from './cancellation.mjs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { defineConfig, defaultIgnore } from './config.mjs';
import { runCachedUnits } from './cache.mjs';
import { commandEnvironment, runCommand } from './command.mjs';
import { createSnapshot, createSnapshotContext, discoverTests, selectTests } from './inputs.mjs';
import { digest, inside } from './util.mjs';
import { createDurationHints } from './durations.mjs';

async function implementationIdentity() {
  const files = (await readdir(import.meta.dirname)).filter((name) => name.endsWith('.mjs')).sort();
  return digest(
    JSON.stringify(
      await Promise.all(files.map(async (name) => [name, digest(await readFile(join(import.meta.dirname, name)))])),
    ),
  );
}

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
    cacheDirectory: resolve(root, options.cacheDirectory ?? '.test-cache/project-checks'),
  };
  if (inside(config.cacheDirectory, root) || inside(config.cacheDirectory, resolve(root, config.testDirectory)))
    throw new Error('cacheDirectory must not contain the project root or testDirectory');
  return config;
}

function fileSnapshot(config) {
  const identity = async () =>
    digest(
      JSON.stringify([
        await implementationIdentity(),
        config.retryTimeouts ?? false,
        config.retryTimeoutMs ?? 60000,
        config.timeoutMs,
        config.excludeTestsFromInputs ?? false,
      ]),
    );
  const context = config.snapshotContext ?? createSnapshotContext({ signal: config.signal });
  const snapshot = createSnapshot(config, identity, context);
  let closed = false;
  const pending = new Set();
  return {
    snapshot: () => {
      if (closed) return Promise.reject(new Error('File snapshot closed'));
      const operation = snapshot();
      pending.add(operation);
      operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    },
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

export async function runTests(options = {}) {
  return withProcessSignal(options.signal, (signal) => runTestsWithSignal({ ...options, signal }));
}

async function runTestsWithSignal(options) {
  const config = await normalizeConfig(options);
  const { root } = config;
  const diagnostics = config.diagnostics;
  const span = (stage, operation, fields) =>
    diagnostics ? diagnostics.span(config.suite, stage, operation, fields) : operation();
  const files = selectTests(config, await span('test-discovery', () => discoverTests(config)));
  if (!files.length) throw new Error(`No test files found in ${config.testDirectory}`);
  diagnostics?.files(config.suite, files.length);
  const context = config.snapshotContext ?? createSnapshotContext({ signal: config.signal });
  config.snapshotContext = context;
  let inputs;
  try {
    const hints = await span('duration-hints', () => createDurationHints(config, files, context));
    const env = commandEnvironment(options.env);
    const logger = options.logger === false ? null : (options.logger ?? console);
    const template = options.command ?? [process.execPath, '--test', '--test-concurrency=1', '{file}'];
    const units = files.map((id) => ({ id, command: template.map((argument) => argument.replaceAll('{file}', id)) }));
    const nodeTest = template.includes('--test') && /^node(?:\.exe)?$/.test(basename(template[0]));
    const retryTimeouts = options.retryTimeouts ?? false;
    const retryTimeoutMs = options.retryTimeoutMs ?? 60000;
    inputs = fileSnapshot(config);
    let snapshotCalls = 0;
    let lastSnapshotSeconds = 0;
    const result = await runCachedUnits({
      cacheDirectory: config.cacheDirectory,
      suite: options.suite ?? 'tests',
      units,
      workers: options.workers,
      resources: options.resources ?? {},
      cache: options.cache ?? true,
      signal: options.signal,
      logger,
      retryTimeouts,
      environment: env,
      ignoreEnv: options.ignoreEnv,
      admission: options.admission,
      diagnostics,
      snapshot: () => {
        const call = ++snapshotCalls;
        const started = performance.now();
        return span(
          call === 1 ? 'snapshot-initial' : 'snapshot-recheck',
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
          status = await runCommand(unit.command, {
            cwd: root,
            env,
            signal: options.signal,
            stdio: options.stdio ?? 'inherit',
            logger,
            timeoutMs: options.timeoutMs,
            nodeTest: nodeTest && retryTimeouts,
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
    });
    diagnostics?.event('snapshot-final', { suite: config.suite, call: snapshotCalls, seconds: lastSnapshotSeconds });
    if (!result.inputsChanged) await hints.save();
    return result;
  } finally {
    await inputs?.close();
    if (!options.snapshotContext) await context.close();
    options.signal?.throwIfAborted();
  }
}
