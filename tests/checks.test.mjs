import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { runChecks, runTests, loadChecks, defineConfig, reportCoverage } from '../src/index.mjs';
import { normalizeCoverageArtifact, restoreCoverageArtifact } from '../src/coverage-paths.mjs';

async function project(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'project-checks-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), source);
  }
  return root;
}
const config = root => ({ root, testDirectory: 'test', inputs: [], coverage: false, logger: false });
const options = { workers: 1, logger: false };

test('JSON dependencies build before tests; failed prerequisites block only their consumers', async t => {
  const root = await project(t, {
    'test/a.test.mjs': "import {readFileSync} from 'node:fs'; if (readFileSync('built','utf8') !== 'ready') throw Error('build missing');",
    'checks.json': JSON.stringify({ checks: {
      build: { command: [process.execPath, '-e', "require('node:fs').writeFileSync('built','ready')"] },
      broken: { command: [process.execPath, '-e', 'process.exit(7)'] },
      tests: { config: 'suite.json', dependsOn: ['build'] },
      blocked: { command: [process.execPath, '-e', "require('node:fs').writeFileSync('unsafe','ran')"], dependsOn: ['broken'] },
    }, targets: { default: ['tests', 'blocked'] } }),
    'suite.json': JSON.stringify({ testDirectory: 'test', inputs: ['built'], coverage: false }),
  });
  const result = await runChecks(await loadChecks(join(root, 'checks.json')), options);
  assert.equal(result.results.find(result => result.id === 'tests').exitCode, 0);
  assert.equal(result.results.find(result => result.id === 'broken').exitCode, 7);
  assert.equal(result.results.find(result => result.id === 'blocked').skipped, true);
  await assert.rejects(readFile(join(root, 'unsafe')), { code: 'ENOENT' });
});

test('cycles and unknown dependencies fail before any command starts', async t => {
  const root = await project(t, {});
  const command = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'ran'))}, 'bad')`];
  await assert.rejects(runChecks([{ id: 'a', command, dependsOn: ['b'] }, { id: 'b', command, dependsOn: ['a'] }], options), /cycle/);
  await assert.rejects(runChecks([{ id: 'a', command, dependsOn: ['missing'] }], options), /Unknown/);
  await assert.rejects(readFile(join(root, 'ran')), { code: 'ENOENT' });
});

test('all suites share admission, including uncached fixture commands; cleanup runs once', async t => {
  const root = await project(t, { 'test/a.test.mjs': '' });
  let active = 0, peak = 0, closed = 0;
  const suite = name => ({ id: name, config: { ...config(root), cache: false,
    setup: () => ({ execute: async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; return 0; }, close: () => { closed++; } }),
  } });
  assert.equal((await runChecks([suite('one'), suite('two')], options)).exitCode, 0);
  assert.equal(peak, 1);
  assert.equal(closed, 2);
});

test('dependency mutation of already passed source invalidates whole invocation', async t => {
  const root = await project(t, { 'test/a.test.mjs': '', 'source': 'old' });
  await assert.rejects(runChecks([
    { id: 'test', config: { ...config(root), inputs: ['source'] } },
    { id: 'mutate', dependsOn: ['test'], cwd: root, command: [process.execPath, '-e', "require('node:fs').writeFileSync('source','new')"] },
  ], options), /inputs changed/);
});

test('suite coverage defaults each metric to 80; partial overrides retain other floors', async t => {
  const root = await project(t, {
    'source.mjs': 'export function called() { return 1; }\nexport function unused() { return 2; }\n',
    'test/a.test.mjs': "import { called } from '../source.mjs'; called();",
  });
  const base = { ...config(root), inputs: ['source.mjs'], coverage: { include: ['source.mjs'], minimum: { lines: 0, branches: 0 } } };
  assert.notEqual((await runTests(base)).exitCode, 0, 'functions retains its 80% default');
  assert.equal((await runTests({ ...base, coverage: { ...base.coverage, minimum: { lines: 0, branches: 0, functions: 50 } } })).exitCode, 0);
});

test('coverage artifacts survive threshold changes but filtered runs cannot certify a file', async t => {
  const root = await project(t, {
    'source.mjs': 'export function called() { return 1; }\n',
    'test/a.test.mjs': "import test from 'node:test'; import { called } from '../source.mjs'; test('works', () => called()); test('other', () => called());",
  });
  const base = { ...config(root), inputs: ['source.mjs'], coverage: { include: ['source.mjs'] } };
  assert.equal((await runTests(base)).exitCode, 0);
  const second = await runTests({ ...base, coverage: { ...base.coverage, minimum: { lines: 90 } } });
  assert.equal(second.exitCode, 0);
  assert.equal(second.cached, 1);
  const filtered = await runTests({ ...base, filters: ['--test-name-pattern=works'] });
  assert.equal(filtered.exitCode, 0);
  assert.equal(filtered.cached, 0);
  assert.equal((await runTests(base)).cached, 1);
});

test('focused file collects its contribution without claiming aggregate coverage', async t => {
  const root = await project(t, {
    'source.mjs': 'export function first() { return 1; }\nexport function second() { return 2; }\n',
    'test/a.test.mjs': "import { first } from '../source.mjs'; first();",
    'test/b.test.mjs': "import { second } from '../source.mjs'; second();",
  });
  const base = { ...config(root), inputs: ['source.mjs'], coverage: { include: ['source.mjs'], minimum: { lines: 100, branches: 100, functions: 100 } } };
  assert.equal((await runTests({ ...base, files: ['test/a.test.mjs'] })).exitCode, 0);
  const complete = await runTests(base);
  assert.equal(complete.exitCode, 0);
  assert.equal(complete.cached, 1);
});

test('invalid coverage floors fail explicitly', () => {
  for (const minimum of [{ lines: -1 }, { functions: 101 }, { branches: '80' }, { functionality: 80 }]) {
    assert.throws(() => defineConfig({ coverage: { minimum } }));
  }
});

test('JSON inheritance and selections preserve a full independent inventory', async t => {
  const root = await project(t, {
    'test/a.test.mjs': '', 'test/b.test.mjs': '',
    'base.json': JSON.stringify({ testDirectory: 'test', inputs: [], coverage: false }),
    'suite.json': JSON.stringify({ extends: 'base.json', select: { include: ['test/a*'] } }),
    'checks.json': JSON.stringify({ checks: { tests: { config: 'suite.json' } }, targets: { default: ['tests'] } }),
  });
  const result = await runChecks(await loadChecks(join(root, 'checks.json')), options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.results[0].total, 1);
});

test('fractional coverage floors are not truncated by Node CLI thresholds', async t => {
  const root = await project(t, {
    'source.mjs': 'export function called() { return 1; }\nexport function unused() { return 2; }\n',
    'test/a.test.mjs': "import { called } from '../source.mjs'; called();",
  });
  assert.notEqual((await runTests({ ...config(root), inputs: ['source.mjs'], coverage: { include: ['source.mjs'], minimum: { functions: 50.5 } } })).exitCode, 0);
});

test('coverage criteria edited during a graph invocation fail final certification', async t => {
  const root = await project(t, {
    'test/a.test.mjs': '',
    'suite.json': JSON.stringify({ testDirectory: 'test', inputs: [], coverage: false }),
    'checks.json': JSON.stringify({ checks: {
      tests: { config: 'suite.json' },
      mutate: { command: [process.execPath, '-e', "require('node:fs').appendFileSync('suite.json','\\n')"], dependsOn: ['tests'] },
    }, targets: { default: ['mutate'] } }),
  });
  await assert.rejects(runChecks(await loadChecks(join(root, 'checks.json')), options), /configuration changed/);
});

test('Python contributions enforce separate metrics and retain reusable evidence', { skip: !process.env.PROJECT_CHECKS_PYTHON }, async t => {
  const python = process.env.PROJECT_CHECKS_PYTHON;
  const root = await project(t, {
    'test/__init__.py': '',
    '.coveragerc': '[run]\nbranch = True\nsource = sample\n',
    'sample.py': 'def first():\n    return 1\ndef second():\n    return 2\n',
    'test/test_a.py': 'import unittest\nimport sample\nclass Example(unittest.TestCase):\n    def test_first(self): self.assertEqual(sample.first(), 1)\n',
    'test/test_b.py': 'import unittest\nimport sample\nclass Example(unittest.TestCase):\n    def test_second(self): self.assertEqual(sample.second(), 2)\n',
  });
  const base = { root, testDirectory: 'test', pattern: 'test_*.py', inputs: ['sample.py', '.coveragerc'],
    command: [python, '-m', 'unittest', '{file}'], env: { PYTHONDONTWRITEBYTECODE: '1' }, logger: false,
    coverage: { provider: 'python', python, configFile: '.coveragerc', minimum: { lines: 100, branches: 100, functions: 100 } },
  };
  assert.equal((await runTests({ ...base, files: ['test/test_a.py'] })).exitCode, 0);
  const complete = await runTests(base);
  assert.equal(complete.exitCode, 0);
  assert.equal(complete.cached, 1);
});

test('Playwright user actions preserve arguments, bypass evidence and allow snapshot outputs', async t => {
  const root = await project(t, { 'test/page.spec.mjs': '', 'snapshot.png': 'before' });
  let executions = 0;
  const action = { ...config(root), pattern: '*.spec.mjs', engine: 'playwright',
    command: ['playwright', 'test', '{file}'], frameworkArgs: ['--update-snapshots'], inputs: ['snapshot.png'],
    setup: () => ({ execute: async command => {
      assert.deepEqual(command, ['playwright', 'test', '--update-snapshots']);
      await writeFile(join(root, 'snapshot.png'), `after-${++executions}`);
      return 0;
    } }),
  };
  assert.equal((await runChecks([{ id: 'browser', config: action }], options)).exitCode, 0);
  assert.equal((await runChecks([{ id: 'browser', config: action }], options)).exitCode, 0);
  assert.equal(executions, 2);
});


test('graph drains fresh work and newly ready async dependents before an exclusive retry', async t => {
  const root = await project(t, { 'test/a.test.mjs': '' });
  const events = [];
  let started;
  const firstAttempt = new Promise(resolve => { started = resolve; });
  const suite = execute => ({ ...config(root), cache: false, setup: () => ({ execute }) });
  const result = await runChecks([
    { id: 'retry', config: { ...suite(async (_, { retry, reportTimeout }) => {
      events.push(retry ? 'retry' : 'first');
      if (!retry) { reportTimeout({ ordinaryFailure: false }); started(); return 1; }
      assert.deepEqual(events, ['first', 'independent', 'dependent', 'retry']);
      return 0;
    }), retryTimeouts: true } },
    { id: 'independent', config: async () => { await firstAttempt; return suite(async () => { events.push('independent'); return 0; }); } },
    { id: 'dependent', dependsOn: ['independent'], config: async () => {
      await readFile(join(root, 'test/a.test.mjs'));
      return suite(async () => { events.push('dependent'); return 0; });
    } },
  ], options);
  assert.equal(result.exitCode, 0);
});

test('full lane notices a newly eligible file while focused evidence stays file scoped', async t => {
  for (const focused of [false, true]) {
    const root = await project(t, { 'test/a.test.mjs': '' });
    const result = await runTests({ ...config(root), cache: false, select: { include: ['test/*.test.mjs'] },
      ...(focused ? { files: ['test/a.test.mjs'] } : {}),
      setup: () => ({ execute: async () => { await writeFile(join(root, 'test/b.test.mjs'), ''); return 0; } }),
    });
    assert.equal(result.exitCode, focused ? 0 : 1);
  }
});

test('coverage reports remain fresh across Node runtimes', async t => {
  const root = await project(t, { 'source.mjs': 'export const answer = 42;', 'test/a.test.mjs': "import '../source.mjs';" });
  const suite = { ...config(root), coverage: { include: ['source.mjs'], report: 'coverage.json' } };
  assert.equal((await runTests(suite)).exitCode, 0);
  assert.equal((await reportCoverage(suite)).stale, false);
  const file = join(root, 'coverage.json');
  const summary = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...summary, runtime: 'v0.0.0' }));
  assert.equal((await reportCoverage(suite)).stale, false);
});

for (const provider of ['v8', 'python']) test(`${provider} coverage survives a checkout move and recollects renamed reporting paths`, { skip: provider === 'python' && !process.env.PROJECT_CHECKS_PYTHON }, async t => {
  const python = process.env.PROJECT_CHECKS_PYTHON;
  const root = await project(t, provider === 'v8' ? {
    'src/source.mjs': 'export const answer = 42;',
    'test/a.test.mjs': "import { readdirSync } from 'node:fs'; await import('../src/' + readdirSync('src')[0]);",
  } : {
    '.coveragerc': '[run]\nbranch = True\nsource = src\n',
    'src/source.py': 'answer = 42\n',
    'test/test_a.py': "import glob, runpy\nrunpy.run_path(glob.glob('src/*.py')[0])\n",
  });
  const cacheDirectory = await project(t, {});
  const suite = { ...config(root), cacheDirectory, inputs: ['src'],
    ...(provider === 'python' ? { pattern: 'test_*.py', command: [python, '{file}'], env: { PYTHONDONTWRITEBYTECODE: '1' } } : {}),
    coverage: { provider, ...(provider === 'python' ? { python, configFile: '.coveragerc' } : { include: ['src/**'] }) },
  };
  assert.equal((await runTests(suite)).exitCode, 0);
  const recordFile = join(cacheDirectory, (await readdir(cacheDirectory)).find(name => name.endsWith('.json')));
  const record = JSON.parse(await readFile(recordFile, 'utf8'));
  const artifact = await readFile(record.evidence.files[0]);
  assert.ok(Object.keys(record.evidence.metadata.sources).every(name => !name.startsWith('/')));
  if (provider === 'v8') assert.ok(JSON.parse(gunzipSync(artifact)).every(report => report.result.every(item => !item.url.startsWith('file:'))));
  // The same normalizer migrates retained native artifacts without executing tests.
  const native = await restoreCoverageArtifact(artifact, { provider, root, sources: record.evidence.metadata.sources });
  const migrated = await normalizeCoverageArtifact(native, { provider, sourceRoot: root });
  assert.deepEqual(migrated.sources, record.evidence.metadata.sources);
  const moved = `${root}-moved`;
  t.after(() => rm(moved, { recursive: true, force: true }));
  await rename(root, moved);
  suite.root = moved;
  const reused = await runTests(suite);
  assert.equal(reused.exitCode, 0);
  assert.equal(reused.cached, 1);
  const extension = provider === 'python' ? 'py' : 'mjs';
  await rename(join(moved, `src/source.${extension}`), join(moved, `src/renamed.${extension}`));
  const renamed = await runTests(suite);
  assert.equal(renamed.exitCode, 0);
  assert.equal(renamed.cached, 0, 'coverage with obsolete reporting paths must be recollected');
  assert.equal(JSON.parse(await readFile(recordFile, 'utf8')).key, record.key, 'reporting paths do not enter validity');
});

test('checks CLI supports Darwin and honors its explicit worker limit', async t => {
  const root = await project(t, {});
  const command = [process.execPath, '-e', "const fs=require('node:fs');fs.writeFileSync('active','',{flag:'wx'});setTimeout(()=>fs.unlinkSync('active'),100)"];
  await writeFile(join(root, 'checks.json'), JSON.stringify({ checks: { first: { command }, second: { command } }, targets: { default: ['first', 'second'] } }));
  const result = spawnSync(process.execPath, ['--import', "data:text/javascript,Object.defineProperty(process,'platform',{value:'darwin'})", new URL('../bin/project-checks.mjs', import.meta.url).pathname,
    'checks', '--config', join(root, 'checks.json'), '--workers', '1'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});


test('Playwright focused uncached checks and snapshot updates preserve every selected file', async t => {
  const root = await project(t, { 'test/member.spec.mjs': '', 'test/signed-out.spec.mjs': '', 'test/admin.spec.mjs': '' });
  const commands = [];
  const suite = { ...config(root), pattern: '*.spec.mjs', engine: 'playwright', cache: false,
    command: ['playwright', 'test', '{file}'], files: ['test/member.spec.mjs', 'test/signed-out.spec.mjs'],
    setup: () => ({ execute: async command => { commands.push(command); return 0; } }),
  };
  assert.equal((await runChecks([{ id: 'browser', config: suite }], options)).exitCode, 0);
  assert.equal(commands.length, 2, 'ordinary uncached checks execute selected files independently');
  const selectors = commands.map(command => command[2]);
  for (let index = 0; index < selectors.length; index++) {
    assert.match(join(root, suite.files[index]), new RegExp(selectors[index]));
    assert.doesNotMatch(join(root, 'test/admin.spec.mjs'), new RegExp(selectors[index]));
  }
  commands.length = 0;
  assert.equal((await runChecks([{ id: 'browser', config: { ...suite, frameworkArgs: ['--update-snapshots'] } }], options)).exitCode, 0);
  assert.deepEqual(commands, [['playwright', 'test', ...selectors, '--update-snapshots']]);
});
