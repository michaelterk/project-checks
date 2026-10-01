import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defineConfig, defaultIgnore } from './config.mjs';
import { runCachedUnits } from './cache.mjs';
import { commandEnvironment, runCommand } from './command.mjs';
import { createSnapshot, discoverTests } from './inputs.mjs';
import { selectConcurrency } from './resources.mjs';
import { digest, inside } from './util.mjs';

async function implementationIdentity() {
  const files = (await readdir(import.meta.dirname)).filter(name => name.endsWith('.mjs')).sort();
  return digest(JSON.stringify(await Promise.all(files.map(async name => [name, digest(await readFile(join(import.meta.dirname, name)))]))));
}

export async function runTests(options = {}) {
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
  const files = await discoverTests(config);
  if (!files.length) throw new Error(`No test files found in ${config.testDirectory}`);
  const env = commandEnvironment(options.env);
  const logger = options.logger === false ? null : options.logger ?? console;
  const selected = selectConcurrency(options.resources);
  const workers = options.workers ?? selected.workers;
  const template = options.command ?? [process.execPath, '--test', '--test-concurrency=1', '{file}'];
  const units = files.map(id => ({ id, command: template.map(argument => argument.replaceAll('{file}', id)) }));
  return runCachedUnits({
    cacheDirectory: config.cacheDirectory, suite: options.suite ?? 'tests', units, workers,
    cache: options.cache ?? true, signal: options.signal, logger,
    environment: env, ignoreEnv: options.ignoreEnv,
    snapshot: createSnapshot(config, implementationIdentity),
    execute: unit => runCommand(unit.command, { cwd: root, env, signal: options.signal, stdio: options.stdio ?? 'inherit', logger }),
  });
}
