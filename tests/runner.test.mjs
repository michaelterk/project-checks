import assert from 'node:assert/strict';
import { readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { defineConfig, loadConfig, runCommand, runTests } from '../src/index.mjs';
import { put, temporary } from './helpers.mjs';

async function fixture(t) {
  const root = await temporary(t, 'project with spaces-');
  await put(root, 'src/value.mjs', 'export const value = 1;');
  await put(root, '.test-cache/events', '');
  const source = depth => `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { appendFileSync } from 'node:fs';
    import { value } from '${depth}src/value.mjs';
    test('positive', () => {
      appendFileSync('.test-cache/events', import.meta.url + '\\n');
      assert.ok(value > 0);
    });
  `;
  await put(root, 'test/a.test.mjs', source('../'));
  await put(root, 'test/nested/b.test.mjs', source('../../'));
  const options = { root, workers: 2, logger: false, stdio: 'ignore' };
  return { root, options, source };
}

test('runs actual Node tests outside this repository and safely reuses unchanged passes', async t => {
  const f = await fixture(t);
  const first = await runTests(f.options);
  assert.equal(first.exitCode, 0);
  assert.deepEqual([first.passed, first.cached, first.workers], [2, 0, 2]);
  assert.deepEqual(first.results.map(result => result.id), ['test/a.test.mjs', 'test/nested/b.test.mjs']);
  assert.equal((await runTests({ ...f.options, workers: 1 })).cached, 2);
  const events = (await readFile(join(f.root, '.test-cache/events'), 'utf8')).trim().split('\n');
  assert.equal(events.length, 2);
  await put(f.root, 'src/value.mjs', 'export const value = 2;');
  assert.equal((await runTests(f.options)).passed, 2);
});

test('explicit shared inputs allow individual test edits and additions to rerun alone', async t => {
  const f = await fixture(t);
  f.options.inputs = ['src', 'test/helpers'];
  await runTests(f.options);
  await put(f.root, 'test/a.test.mjs', f.source('../') + '\n// edited');
  assert.deepEqual((await runTests(f.options)).results.map(result => result.cached), [false, true]);
  await put(f.root, 'test/new file.test.mjs', f.source('../'));
  assert.equal((await runTests(f.options)).cached, 2);
  await put(f.root, 'test/helpers/data.json', '{"shared":true}');
  assert.equal((await runTests(f.options)).passed, 3);
  await rm(join(f.root, 'test/nested/b.test.mjs'));
  assert.equal((await runTests(f.options)).total, 2);
});

test('default inputs include hidden files, sibling tests, installed dependencies and symlink targets', async t => {
  const f = await fixture(t);
  const external = await temporary(t);
  const linked = await put(external, 'value', 'first');
  await put(f.root, 'node_modules/example/index.js', 'first');
  await symlink(linked, join(f.root, 'linked-input'));
  await put(f.root, '.env', 'FLAG=first');
  await runTests(f.options);
  await put(f.root, 'test/a.test.mjs', f.source('../') + '\n// sibling dependency');
  assert.equal((await runTests(f.options)).passed, 2);
  await put(f.root, 'node_modules/example/index.js', 'second');
  assert.equal((await runTests(f.options)).passed, 2);
  await put(external, 'value', 'second');
  assert.equal((await runTests(f.options)).passed, 2);
  await put(f.root, '.env', 'FLAG=second');
  assert.equal((await runTests(f.options)).passed, 2);
});

test('environment overrides and custom external fingerprints bind cache evidence', async t => {
  const f = await fixture(t);
  f.options.env = { PROJECT_CHECKS_TEST_MODE: 'first' };
  let external = 'runtime-v1';
  f.options.fingerprint = () => external;
  await runTests(f.options);
  assert.equal((await runTests(f.options)).cached, 2);
  f.options.env.PROJECT_CHECKS_TEST_MODE = 'second';
  assert.equal((await runTests(f.options)).cached, 0);
  external = 'runtime-v2';
  assert.equal((await runTests(f.options)).cached, 0);
});

test('custom commands receive literal paths with spaces without shell expansion', async t => {
  const root = await temporary(t);
  await put(root, 'checks/a $(echo unsafe).spec', 'input');
  const result = await runTests({
    root, testDirectory: 'checks', pattern: '*.spec', logger: false, stdio: 'ignore',
    command: [process.execPath, '-e', `const fs = require('node:fs'); fs.readFileSync(process.argv[1]);`, '{file}'],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.total, 1);
  assert.deepEqual((await readdir(root)).sort(), ['.test-cache', 'checks']);
});

test('changes and new discoveries during execution prevent passing evidence', async t => {
  const root = await temporary(t);
  await put(root, 'test/one.test.mjs', 'first');
  const result = await runTests({
    root, workers: 1, logger: false, stdio: 'ignore',
    command: [process.execPath, '-e', `require('node:fs').writeFileSync('test/new.test.mjs', 'new');`, '{file}'],
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.inputsChanged, true);
  assert.deepEqual(await readdir(join(root, '.test-cache/project-checks')), []);
});

test('cache-disabled runs execute every time and create no cache directory', async t => {
  const root = await temporary(t);
  await put(root, 'test/one.test.mjs', "import test from 'node:test'; test('ok', () => {});");
  const options = { root, cache: false, logger: false, stdio: 'ignore' };
  assert.equal((await runTests(options)).passed, 1);
  assert.equal((await runTests(options)).passed, 1);
  assert.deepEqual(await readdir(root), ['test']);
});

test('config paths resolve beside the config file and absent auto config uses cwd', async t => {
  const root = await temporary(t);
  assert.deepEqual(await loadConfig(undefined, { cwd: root }), { root });
  const file = await put(root, 'config/project-checks.config.json', JSON.stringify({ root: '..', testDirectory: 'checks' }));
  assert.equal((await loadConfig(file)).root, root);
  const module = await put(root, 'project-checks.config.mjs', 'export default { workers: 2 };');
  assert.equal((await loadConfig(undefined, { cwd: root })).workers, 2);
  assert.equal((await loadConfig(module)).root, root);
  await assert.rejects(loadConfig('missing.json', { cwd: root }), /ENOENT/);
});

test('bad configuration, empty selection and escaping tests fail explicitly', async t => {
  for (const config of [{ workres: 1 }, { command: 'node --test' }, { command: ['node', '--test'] }, { testDirectory: '../test' }, { inputs: ['/etc'] }, { cache: 'yes' }, { env: { FLAG: 1 } }]) assert.throws(() => defineConfig(config));
  const root = await temporary(t);
  await put(root, 'test/no-tests.txt', 'none');
  await assert.rejects(runTests({ root }), /No test files/);
  const external = await temporary(t);
  const file = await put(external, 'external.test.mjs', 'none');
  await symlink(file, join(root, 'test/link.test.mjs'));
  await assert.rejects(runTests({ root }), /regular file/);
  await rm(join(root, 'test/link.test.mjs'));
  await put(root, 'test/one.test.mjs', 'none');
  await assert.rejects(runTests({ root, cacheDirectory: '.' }), /cacheDirectory/);
});

test('cyclic input link graphs terminate and still invalidate on content changes', async t => {
  const f = await fixture(t);
  await symlink(f.root, join(f.root, 'cycle'));
  assert.equal((await runTests(f.options)).passed, 2);
  assert.equal((await runTests(f.options)).cached, 2);
  await put(f.root, 'src/value.mjs', 'export const value = 2;');
  assert.equal((await runTests(f.options)).passed, 2);
});

test('command errors return failure and cancellation waits for child exit', async () => {
  assert.equal(await runCommand(['nonexistent-project-checks-command'], { stdio: 'ignore', logger: null }), 1);
  assert.equal(await runCommand([process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")'], { stdio: 'ignore' }), 1);
  const controller = new AbortController();
  const running = runCommand([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal, stdio: 'ignore' });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(running, { name: 'AbortError' });
  await assert.rejects(runCommand([process.execPath], { signal: controller.signal }), { name: 'AbortError' });
});
