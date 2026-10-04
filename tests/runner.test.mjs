import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
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

test('declared external fixture paths invalidate only consumers and share full/focused evidence', async t => {
  const f = await fixture(t);
  const configFile = await put(f.root, 'checks.json', JSON.stringify({
    inputs: [], testInputs: { 'test/': ['src', 'node_modules/playwright-core'] },
    ignore: ['node_modules/playwright-core/.local-browsers', 'node_modules/playwright-core/.local-browsers/**'],
  }));
  const external = await temporary(t);
  const chromium = await put(f.root, 'node_modules/playwright-core/.local-browsers/chromium/binary', 'chromium-v1');
  const webkit = await put(external, 'webkit/binary', 'webkit-v1');
  const runtimes = { 'test/a.test.mjs': ['node_modules/playwright-core/.local-browsers/chromium'], 'test/nested/b.test.mjs': [webkit] };
  const calls = [];
  const options = { ...f.options, ...await loadConfig(configFile), testFixtureInputs: async id => { calls.push(id); return runtimes[id]; } };
  assert.equal((await runTests(options)).passed, 2);
  const focused = { ...options, files: ['test/a.test.mjs'] };
  calls.length = 0;
  assert.equal((await runTests(focused)).cached, 1);
  assert.ok(calls.length > 0 && calls.every(id => id === 'test/a.test.mjs'));
  await put(external, 'webkit/binary', 'webkit-v2');
  assert.equal((await runTests(focused)).cached, 1);
  assert.deepEqual((await runTests(options)).results.map(result => result.cached), [true, false]);
  await put(f.root, 'node_modules/playwright-core/.local-browsers/chromium/binary', 'chromium-v2');
  assert.equal((await runTests(focused)).passed, 1);
  assert.equal((await runTests(options)).cached, 2);
  assert.throws(() => defineConfig({ testFixtureInputs: 'invalid' }), /testFixtureInputs must be a function/);
  await assert.rejects(runTests({ ...focused, testFixtureInputs: () => undefined }), /testFixtureInputs must return an array/);
  await assert.rejects(runTests({ ...focused, testFixtureInputs: () => [null] }), /fixture input path/);
  await rm(chromium);
  await assert.rejects(runTests({ ...focused, testFixtureInputs: () => [chromium] }), { code: 'ENOENT' });
});

test('fixture directories inside the cache or resolving there are rejected instead of caching empty trees', async t => {
  const f = await fixture(t);
  const cacheDirectory = join(f.root, '.test-cache/project-checks');
  await put(cacheDirectory, 'runtime/binary', 'first');
  const runtime = join(cacheDirectory, 'runtime');
  const alias = join(f.root, 'runtime-alias');
  await symlink(runtime, alias);
  for (const path of [runtime, alias]) {
    const options = { ...f.options, inputs: [], testFixtureInputs: () => [path] };
    await assert.rejects(runTests(options), /Fixture directory must stay outside cacheDirectory/);
    await put(cacheDirectory, 'runtime/binary', 'changed');
    await assert.rejects(runTests(options), /Fixture directory must stay outside cacheDirectory/);
  }
  const cacheAlias = join(f.root, 'cache-alias');
  await symlink(cacheDirectory, cacheAlias);
  await assert.rejects(runTests({ ...f.options, inputs: [], cacheDirectory: cacheAlias, testFixtureInputs: () => [runtime] }), /Fixture directory must stay outside cacheDirectory/);
  assert.equal(await readFile(join(f.root, '.test-cache/events'), 'utf8'), '');
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

test('explicit cacheIdentity shares equivalent checkouts while retaining input and environment invalidation', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const cacheDirectory = await temporary(t);
  const config = { cacheDirectory, cacheIdentity: 'same-project', inputs: ['src', 'test'], workers: 1, logger: false, stdio: 'ignore' };
  assert.equal((await runTests({ ...config, root: first.root })).passed, 2);
  assert.equal((await runTests({ ...config, root: second.root })).cached, 2);
  await put(second.root, 'src/value.mjs', 'export const value = 2;');
  assert.equal((await runTests({ ...config, root: second.root })).passed, 2);
  assert.equal((await runTests({ ...config, root: second.root, env: { PROJECT_CHECKS_TEST_MODE: 'changed' } })).cached, 0);
  assert.equal((await runTests({ ...config, root: first.root, cacheIdentity: 'other-project' })).cached, 0);
});

test('JSON per-test dependencies invalidate only their consumers, including focused selections', async t => {
  const root = await temporary(t);
  await put(root, 'src/a.mjs', 'a-v1');
  await put(root, 'src/b.mjs', 'b-v1');
  await put(root, 'shared/helper.mjs', 'shared-v1');
  for (const name of ['a', 'b']) await put(root, `test/${name}.test.mjs`, "import test from 'node:test'; test('ok', () => {});");
  const config = {
    inputs: ['shared'], testInputs: { 'test/a.test.mjs': ['src/a.mjs'], 'test/b.test.mjs': ['src/b.mjs'] },
    workers: 1, logger: false, stdio: 'ignore',
  };
  const file = await put(root, 'checks.json', JSON.stringify(config));
  const run = async (overrides = {}) => runTests({ ...await loadConfig(file), ...overrides });
  assert.equal((await run()).passed, 2);
  await put(root, 'src/a.mjs', 'a-v2');
  assert.deepEqual((await run()).results.map(result => result.cached), [false, true]);
  await put(root, 'test/b.test.mjs', "import test from 'node:test'; test('changed', () => {});");
  assert.deepEqual((await run()).results.map(result => result.cached), [true, false]);
  config.testInputs['test/b.test.mjs'].push('src/new-b.mjs');
  await put(root, 'src/new-b.mjs', 'new');
  await put(root, 'checks.json', JSON.stringify(config));
  assert.equal((await run({ files: ['test/a.test.mjs'] })).cached, 1);
  assert.deepEqual((await run()).results.map(result => result.cached), [true, false]);
  await put(root, 'shared/helper.mjs', 'shared-v2');
  assert.equal((await run()).passed, 2);
  config.testInputs['test/a.test.mjs'].push('checks.json');
  await put(root, 'checks.json', JSON.stringify(config));
  assert.deepEqual((await run()).results.map(result => result.cached), [false, true]);
  await put(root, 'checks.json', JSON.stringify(config, null, 2));
  assert.deepEqual((await run()).results.map(result => result.cached), [false, true]);
});

test('per-test dependency mapping rejects escaping or noncanonical keys and unsafe paths', () => {
  for (const testInputs of [
    { '../a.test.mjs': [] }, { '/a.test.mjs': [] }, { './a.test.mjs': [] }, { 'test//a.test.mjs': [] },
    { 'test/*.mjs': [] }, { 'a.test.mjs': ['../private'] }, { 'a.test.mjs': ['/private'] }, { 'a.test.mjs': ['!src'] },
  ]) assert.throws(() => defineConfig({ testInputs }));
});

test('folder dependencies exclude full runnable inventory, retain helpers and share focused evidence', async t => {
  const root = await temporary(t);
  const source = "import test from 'node:test'; test('ok', () => {});";
  for (const id of ['a', 'b']) await put(root, `test/${id}.test.mjs`, source);
  await put(root, 'test/helper.mjs', 'helper-v1');
  await put(root, 'src/common/value', 'common-v1');
  await put(root, 'src/a/value', 'a-v1');
  await mkdir(join(root, 'test/new-folder'));
  const options = {
    root, inputs: [], excludeTestsFromInputs: true,
    testInputs: { 'test/': ['test', 'src/common'], 'test/a.test.mjs': ['src/a'] },
    workers: 1, logger: false, stdio: 'ignore',
  };
  assert.equal((await runTests(options)).passed, 2);
  await put(root, 'test/a.test.mjs', source + '\n// changed own file');
  assert.equal((await runTests({ ...options, files: ['test/a.test.mjs'] })).passed, 1);
  assert.equal((await runTests(options)).cached, 2);
  await put(root, 'src/a/value', 'a-v2');
  assert.deepEqual((await runTests(options)).results.map(result => result.cached), [false, true]);
  await put(root, 'test/helper.mjs', 'helper-v2');
  assert.equal((await runTests(options)).passed, 2);
  await put(root, 'test/new-folder/c.test.mjs', source);
  assert.equal((await runTests({ ...options, files: ['test/a.test.mjs'] })).cached, 1);
  assert.deepEqual((await runTests(options)).results.map(result => result.cached), [true, true, false]);
  await rm(join(root, 'test/new-folder/c.test.mjs'));
  assert.equal((await runTests(options)).cached, 2);
  await rm(join(root, 'test/new-folder'), { recursive: true });
  assert.equal((await runTests(options)).passed, 2);
  await put(root, 'src/common/value', 'common-v2');
  assert.equal((await runTests(options)).passed, 2);
  await assert.rejects(runTests({ ...options, files: ['test/helper.mjs'] }), /configured test inventory/);
});

test('empty fixture directory presence remains an input with independent-test exclusion', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'fixtures/empty'), { recursive: true });
  await put(root, 'test/a.test.mjs', `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    test('fixture exists', () => assert.ok(existsSync('fixtures/empty')));
  `);
  const options = { root, inputs: [], testInputs: { 'test/a.test.mjs': ['fixtures'] }, excludeTestsFromInputs: true, workers: 1, logger: false, stdio: 'ignore' };
  assert.equal((await runTests(options)).passed, 1);
  assert.equal((await runTests(options)).cached, 1);
  await rm(join(root, 'fixtures/empty'), { recursive: true });
  const removedChild = await runTests(options);
  assert.equal(removedChild.cached, 0);
  assert.equal(removedChild.failed, 1);
  await mkdir(join(root, 'fixtures/empty'));
  assert.equal((await runTests(options)).passed, 1);
  await rm(join(root, 'fixtures'), { recursive: true });
  const removedRoot = await runTests(options);
  assert.equal(removedRoot.cached, 0);
  assert.equal(removedRoot.failed, 1);
});

test('shared folders exclude sibling tests while explicit runnable dependencies remain meaningful', async t => {
  const root = await temporary(t);
  const source = "import test from 'node:test'; test('ok', () => {});";
  for (const id of ['a', 'b']) await put(root, `test/${id}.test.mjs`, source);
  await put(root, 'test/helper.mjs', 'helper');
  const options = { root, inputs: ['test'], excludeTestsFromInputs: true, workers: 1, logger: false, stdio: 'ignore' };
  await runTests(options);
  await put(root, 'test/a.test.mjs', source + '\n// changed');
  assert.deepEqual((await runTests(options)).results.map(result => result.cached), [false, true]);
  options.testInputs = { 'test/b.test.mjs': ['test', 'test/a.test.mjs'] };
  assert.deepEqual((await runTests(options)).results.map(result => result.cached), [true, false]);
  await put(root, 'test/a.test.mjs', source + '\n// changed imported fixture');
  assert.equal((await runTests(options)).passed, 2);
});
