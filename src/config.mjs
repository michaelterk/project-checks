import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { command, integer, keys, text } from './util.mjs';
import { selectConcurrency } from './resources.mjs';
import defaultConfig from '../project-checks.config.json' with { type: 'json' };

const options = ['root', 'testDirectory', 'pattern', 'files', 'command', 'inputs', 'testInputs', 'excludeTestsFromInputs', 'ignore', 'workers', 'resources', 'cache', 'cacheDirectory', 'cacheIdentity', 'suite', 'env', 'ignoreEnv', 'fingerprint', 'testFixtureInputs', 'signal', 'logger', 'stdio', 'retryTimeouts', 'retryTimeoutMs', 'timeoutMs'];
export const defaultIgnore = ['**/.git', '**/.git/**', '**/.test-cache', '**/.test-cache/**', '**/__pycache__', '**/__pycache__/**'];

function patterns(value, label, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new TypeError(`${label} must be ${allowEmpty ? 'an' : 'a nonempty'} array of relative paths or glob patterns`);
  for (const pattern of value) {
    text(pattern, label);
    if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..') || pattern.startsWith('!')) throw new TypeError(`${label} must contain relative paths without '..' or negation`);
  }
}

function testId(id) {
  patterns([id], 'test file ID');
  if (id.includes('\\') || /[*?{}[\]]/.test(id) || id.split('/').some(part => !part || part === '.')) throw new TypeError('Test IDs must be canonical root-relative file paths');
}

export function defineConfig(config) {
  keys(config, options, 'config');
  for (const key of ['root', 'testDirectory', 'cacheDirectory', 'cacheIdentity', 'suite']) if (config[key] !== undefined) text(config[key], key);
  if (config.testDirectory !== undefined) patterns([config.testDirectory], 'testDirectory');
  if (config.pattern !== undefined) patterns(typeof config.pattern === 'string' ? [config.pattern] : config.pattern, 'pattern');
  if (config.files !== undefined) {
    if (!Array.isArray(config.files) || !config.files.length || new Set(config.files).size !== config.files.length) throw new TypeError('files must be a nonempty array of unique test file IDs');
    config.files.forEach(testId);
  }
  if (config.excludeTestsFromInputs !== undefined && typeof config.excludeTestsFromInputs !== 'boolean') throw new TypeError('excludeTestsFromInputs must be a boolean');
  for (const key of ['inputs', 'ignore']) if (config[key] !== undefined) patterns(config[key], key, true);
  if (config.testInputs !== undefined) {
    keys(config.testInputs, Object.keys(config.testInputs), 'testInputs');
    for (const [id, inputs] of Object.entries(config.testInputs)) {
      testId(id.endsWith('/') ? id.slice(0, -1) : id);
      patterns(inputs, `testInputs[${id}]`, true);
    }
  }
  if (config.command !== undefined) {
    command(config.command);
    if (!config.command.slice(1).some(value => value.includes('{file}'))) throw new TypeError('command must include {file} in an argument');
  }
  if (config.workers !== undefined) integer(config.workers, 'workers');
  if (config.resources !== undefined) selectConcurrency(config.resources, { cpus: 1, memoryMiB: 1 });
  if (config.cache !== undefined && typeof config.cache !== 'boolean') throw new TypeError('cache must be a boolean');
  if (config.retryTimeouts !== undefined && typeof config.retryTimeouts !== 'boolean') throw new TypeError('retryTimeouts must be a boolean');
  for (const name of ['retryTimeoutMs', 'timeoutMs']) {
    if (config[name] !== undefined && integer(config[name], name) > 2147483647) throw new TypeError(`${name} must be <= 2147483647`);
  }
  if (config.env !== undefined) {
    keys(config.env, Object.keys(config.env), 'env');
    for (const [name, value] of Object.entries(config.env)) {
      text(name, 'env name');
      if (name.includes('=') || (value !== undefined && (typeof value !== 'string' || value.includes('\0')))) throw new TypeError('env values must be strings without NUL characters, or undefined');
    }
  }
  if (config.ignoreEnv !== undefined && (!Array.isArray(config.ignoreEnv) || config.ignoreEnv.some(name => typeof name !== 'string' || !name))) throw new TypeError('ignoreEnv must be an array of environment variable names');
  if (config.fingerprint !== undefined && typeof config.fingerprint !== 'function') throw new TypeError('fingerprint must be a function');
  if (config.testFixtureInputs !== undefined && typeof config.testFixtureInputs !== 'function') throw new TypeError('testFixtureInputs must be a function');
  if (config.signal !== undefined && !(config.signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
  if (config.logger !== undefined && config.logger !== false && (typeof config.logger?.log !== 'function' || typeof config.logger?.error !== 'function')) throw new TypeError('logger must provide log and error methods, or be false');
  if (config.stdio !== undefined && !['inherit', 'ignore'].includes(config.stdio)) throw new TypeError('stdio must be inherit or ignore');
  return config;
}

export async function loadConfig(filename, { cwd = process.cwd() } = {}) {
  let file;
  if (filename !== undefined) file = resolve(cwd, text(filename, 'config filename'));
  else {
    for (const name of ['project-checks.config.mjs', 'project-checks.config.js', 'project-checks.config.json']) {
      const candidate = resolve(cwd, name);
      try { if ((await stat(candidate)).isFile()) { file = candidate; break; } }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  if (!file) return { ...structuredClone(defaultConfig), root: resolve(cwd) };
  const value = file.endsWith('.json') ? JSON.parse(await readFile(file, 'utf8')) : (await import(pathToFileURL(file).href)).default;
  defineConfig(value);
  const overrides = Object.fromEntries(Object.entries(value).filter(([, setting]) => setting !== undefined));
  const resources = Object.fromEntries(Object.entries(value.resources ?? {}).filter(([, setting]) => setting !== undefined));
  return {
    ...structuredClone(defaultConfig), ...overrides,
    resources: { ...defaultConfig.resources, ...resources },
    root: resolve(dirname(file), value.root ?? '.'),
  };
}
