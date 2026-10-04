import { withProcessSignal } from './cancellation.mjs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { defineConfig, defaultIgnore } from './config.mjs';
import { runCachedUnits } from './cache.mjs';
import { commandEnvironment, runCommand } from './command.mjs';
import { createSnapshot, createSnapshotContext, discoverTests, selectTests } from './inputs.mjs';
import { digest, inside } from './util.mjs';

async function implementationIdentity() {
  const files = (await readdir(import.meta.dirname)).filter(name => name.endsWith('.mjs')).sort();
  return digest(JSON.stringify(await Promise.all(files.map(async name => [name, digest(await readFile(join(import.meta.dirname, name)))]))));
}

async function normalizeConfig(options) {
  defineConfig(options);
  const root = await realpath(resolve(options.root ?? process.cwd()));
  const config = {
    ...options, root,
    testDirectory: options.testDirectory ?? 'test',
    pattern: options.pattern ?? '**/*.test.{js,mjs,cjs}',
    inputs: options.inputs ?? ['.'],
    ignore: options.ignore ?? defaultIgnore,
    cacheDirectory: resolve(root, options.cacheDirectory ?? '.test-cache/project-checks'),
  };
  if (inside(config.cacheDirectory, root) || inside(config.cacheDirectory, resolve(root, config.testDirectory))) throw new Error('cacheDirectory must not contain the project root or testDirectory');
  return config;
}

function fileSnapshot(config) {
  const identity = async () => digest(JSON.stringify([
    await implementationIdentity(), config.retryTimeouts ?? false, config.retryTimeoutMs ?? 60000,
    config.timeoutMs, config.excludeTestsFromInputs ?? false,
  ]));
  const context = createSnapshotContext({ signal: config.signal });
  return { snapshot: createSnapshot(config, identity, context), close: context.close };
}

export async function createFileSnapshot(options = {}) {
  return fileSnapshot(await normalizeConfig(options));
}

export async function runTests(options = {}) {
  return withProcessSignal(options.signal, signal => runTestsWithSignal({ ...options, signal }));
}

async function runTestsWithSignal(options) {
  const config = await normalizeConfig(options);
  const { root } = config;
  const files = selectTests(config, await discoverTests(config));
  if (!files.length) throw new Error(`No test files found in ${config.testDirectory}`);
  const env = commandEnvironment(options.env);
  const logger = options.logger === false ? null : options.logger ?? console;
  const template = options.command ?? [process.execPath, '--test', '--test-concurrency=1', '{file}'];
  const units = files.map(id => ({ id, command: template.map(argument => argument.replaceAll('{file}', id)) }));
  const nodeTest = template.includes('--test') && /^node(?:\.exe)?$/.test(basename(template[0]));
  const retryTimeouts = options.retryTimeouts ?? false;
  const retryTimeoutMs = options.retryTimeoutMs ?? 60000;
  const inputs = fileSnapshot(config);
  try { return await runCachedUnits({
    cacheDirectory: config.cacheDirectory, suite: options.suite ?? 'tests', units, workers: options.workers, resources: options.resources ?? {},
    cache: options.cache ?? true, signal: options.signal, logger, retryTimeouts,
    environment: env, ignoreEnv: options.ignoreEnv,
    snapshot: inputs.snapshot,
    execute: (unit, { retry, reportTimeout }) => runCommand(unit.command, {
      cwd: root, env, signal: options.signal, stdio: options.stdio ?? 'inherit', logger,
      timeoutMs: options.timeoutMs, nodeTest: nodeTest && retryTimeouts,
      testTimeoutMs: retry ? retryTimeoutMs : undefined, onTimeout: reportTimeout,
    }),
  }); } finally { await inputs.close(); }
}
