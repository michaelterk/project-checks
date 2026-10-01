import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadConfig, runTests } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const cli = join(root, 'bin/project-checks.mjs');
const npm = process.env.npm_execpath;

test('packed package installs into an independent project and exposes imports, require, types and CLI', async t => {
  const directory = await temporary(t);
  const npmArgs = ['--cache', join(directory, 'npm-cache'), '--offline'];
  const invokeNpm = args => execFileSync(process.execPath, [npm, ...args, ...npmArgs], { cwd: root, encoding: 'utf8' });
  const [archive] = JSON.parse(invokeNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', directory]));
  const names = archive.files.map(file => file.path);
  assert.ok(names.includes('LICENSE'));
  assert.ok(names.includes('src/index.d.ts'));
  assert.ok(names.includes('bin/project-checks.mjs'));
  assert.ok(names.includes('examples/python/test/test_calculator.py'));
  assert.ok(names.includes('examples/node/test/add.test.mjs'));
  assert.ok(names.every(name => ['package.json', 'README.md', 'CONTRIBUTING.md', 'LICENSE'].includes(name) || name.startsWith('src/') || name.startsWith('bin/') || name.startsWith('examples/')));
  assert.ok(names.every(name => !name.includes('__pycache__') && !name.includes('.test-cache')));
  const consumer = join(directory, 'consumer');
  await put(consumer, 'package.json', JSON.stringify({ name: 'independent-consumer', private: true, type: 'module' }));
  await put(consumer, 'test/smoke.test.mjs', "import test from 'node:test'; test('ok', () => {});");
  const install = spawnSync(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', ...npmArgs, join(directory, archive.filename)], { cwd: consumer, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { runTests, defineConfig } from 'project-checks';
    const first = await runTests(defineConfig({ logger: false, stdio: 'ignore' }));
    const second = await runTests({ logger: false, stdio: 'ignore' });
    if (first.passed !== 1 || second.cached !== 1) process.exit(1);
  `], { cwd: consumer, encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  const required = spawnSync(process.execPath, ['-e', `const { selectConcurrency } = require('project-checks'); if (selectConcurrency({}, {cpus: 2, memoryMiB: 2048}).workers !== 2) process.exit(1);`], { cwd: consumer, encoding: 'utf8' });
  assert.equal(required.status, 0, required.stderr);
  const executable = join(consumer, 'node_modules/.bin/project-checks');
  const command = spawnSync(executable, ['--workers', '1'], { cwd: consumer, encoding: 'utf8' });
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout, /1 cached/);
});

test('CLI resolves configuration outside cwd, rejects invalid options, and preserves test failures', async t => {
  const directory = await temporary(t);
  const project = join(directory, 'project');
  await put(project, 'test/fail.test.mjs', "import test from 'node:test'; test('fails', () => { throw new Error('expected failure'); });");
  const config = await put(project, 'project-checks.config.json', JSON.stringify({ logger: false, stdio: 'ignore', workers: 1 }));
  const execute = args => spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8' });
  const failed = execute(['run', '--config', config]);
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stdout, /1 failed/);
  for (const args of [['--unknown'], ['--workers', '0'], ['--config'], ['invalid-command']]) {
    const result = execute(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /project-checks:/);
  }
  const resources = execute(['resources', '--config', config, '--workers', '3']);
  assert.equal(JSON.parse(resources.stdout).workers, 3);
  const help = execute(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
});

test('Node example runs through its project config', async t => {
  const config = await loadConfig(join(root, 'examples/node/project-checks.config.mjs'));
  // Use a temporary cache so repository examples remain untouched by tests.
  const cacheDirectory = await temporary(t);
  const result = await runTests({ ...config, cacheDirectory, logger: false, stdio: 'ignore' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.passed, 1);
  assert.equal((await runTests({ ...config, cacheDirectory, logger: false, stdio: 'ignore' })).cached, 1);
});

test('Python example uses the installed interpreter without a version pin', async t => {
  const available = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (available.status !== 0) return t.skip('python3 is not installed');
  const config = await loadConfig(join(root, 'examples/python/project-checks.config.mjs'));
  const cacheDirectory = await temporary(t);
  const result = await runTests({ ...config, cacheDirectory, logger: false, stdio: 'ignore', env: { PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.passed, 1);
  assert.equal((await runTests({ ...config, cacheDirectory, logger: false, stdio: 'ignore', env: { PYTHONDONTWRITEBYTECODE: '1' } })).cached, 1);
  assert.ok((await readdir(join(root, 'examples/python/test'))).includes('test_calculator.py'));
});
