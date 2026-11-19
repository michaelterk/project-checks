import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCoverage } from '../src/coverage.mjs';
import { digest } from '../src/util.mjs';
import { put, temporary } from './helpers.mjs';

test('Python aggregate reuse binds the validated database, source domain, configuration and measurement', {
  skip: !process.env.PROJECT_CHECKS_PYTHON,
}, async t => {
  const root = await temporary(t), cacheDirectory = await temporary(t);
  const python = process.env.PROJECT_CHECKS_PYTHON;
  const environment = { ...process.env };
  const config = { root, suite: 'python', cacheDirectory, logger: false, coverage: {
    provider: 'python', python, configFile: '.coveragerc', minimum: { lines: 50, branches: 0, functions: 0 },
  } };
  const rc = await put(root, '.coveragerc', '[run]\nbranch = True\nsource = src\n');
  await put(root, 'src/a.py', 'value = 1\n');
  await put(root, 'src/b.py', 'unused = 2\n');
  const file = join(cacheDirectory, 'evidence.db');
  execFileSync(python, ['-c', [
    'import sys', 'from coverage import CoverageData', 'd=CoverageData(basename=sys.argv[1])',
    'd.add_arcs({"src/a.py":[(-1,1),(1,-1)]})', 'd.touch_file("src/b.py")', 'd.write()',
  ].join('\n'), file]);
  const unit = { id: 'test.py' }, snapshot = { common: 'common', units: { 'test.py': 'key' } };
  const evidence = { files: [file], metadata: { format: 'project-checks-python-v2', unit: unit.id, sources: {
    'src/a.py': digest('value = 1\n'), 'src/b.py': digest('unused = 2\n'),
  } } };
  const directory = join(cacheDirectory, 'coverage', 'python');
  const summary = join(directory, 'latest.json');
  async function run({ merged, status = 0, after } = {}) {
    const coverage = await createCoverage(config, environment);
    try {
      assert.ok(await coverage.restoreEvidence(unit, evidence));
      assert.equal(await coverage.aggregate([unit], snapshot), status);
      const runDir = (await readdir(directory)).find(name => name.startsWith('.run-'));
      assert.equal((await readdir(join(directory, runDir))).includes('combined'), merged);
      if (after) return await after(coverage, join(directory, runDir));
      if (!status) {
        await coverage.verifySources();
        await coverage.saveSummary(snapshot);
        return JSON.parse(await readFile(summary));
      }
    } finally { await coverage.close(); }
  }
  const fresh = await run({ merged: true });
  assert.ok(fresh.reuse, 'native report includes the unexecuted file');
  assert.equal(fresh.actual.lines, 50);
  assert.deepEqual((await run({ merged: false })).actual, fresh.actual);
  await writeFile(summary, JSON.stringify({ ...fresh, actual: { ...fresh.actual, lines: 100 } }));
  assert.equal((await run({ merged: true })).actual.lines, 50, 'invalid saved measurement is recomputed');

  await writeFile(summary, JSON.stringify({ ...fresh, actual: Object.keys(fresh.actual) }));
  assert.equal((await run({ merged: true })).actual.lines, 50, 'a malformed metric container is recomputed');
  const enormous = JSON.stringify(fresh).replace('"lines":50', '"lines":' + '9'.repeat(310));
  await writeFile(summary, enormous);
  assert.equal((await run({ merged: true })).actual.lines, 50, 'overflow in an old summary is a cache miss');

  await run({ merged: false, after: async (coverage, staging) => {
    const [staged] = JSON.parse(await readFile(join(staging, 'manifest.json')));
    await writeFile(staged, 'truncated');
    await assert.rejects(coverage.verifySources(), /Staged Python coverage contribution changed/);
    await assert.rejects(coverage.aggregate([unit], snapshot), /Staged Python coverage contribution changed/);
  } });

  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE extra (value INTEGER)'); db.close();
  await run({ merged: true });
  await writeFile(rc, '[run]\nbranch = True\nsource = src\n[report]\nshow_missing = True\n');
  await run({ merged: true });

  const added = join(root, 'src/new.py');
  await run({ merged: false, after: async coverage => {
    await writeFile(added, 'previously_unmeasured = 3\n');
    await assert.rejects(coverage.verifySources(), /verify/);
  } });
  const changed = await run({ merged: true });
  assert.equal(changed.reuse, undefined, 'native report omitted a configured source');
  await rm(added);
  environment.COVERAGE_FORCE_CONFIG = await put(root, 'override.rc', '[report]\nshow_missing = False\n');
  assert.equal((await run({ merged: true })).reuse, undefined);
  await writeFile(environment.COVERAGE_FORCE_CONFIG, '[report]\nomit = src/b.py\n');
  assert.equal((await run({ merged: true })).actual.lines, 100);
  delete environment.COVERAGE_FORCE_CONFIG;

  const hooks = await temporary(t);
  await put(hooks, 'sitecustomize.py', [
    'import sys', 'from importlib.machinery import PathFinder, SourceFileLoader',
    'class Alternate(SourceFileLoader): pass',
    'class Finder:', '    def find_spec(self, name, path, target=None):',
    '        if name == "coverage.report":', '            spec = PathFinder.find_spec(name, path)',
    '            spec.loader = Alternate(name, spec.origin)', '            return spec',
    'sys.meta_path.insert(0, Finder())',
  ].join('\n'));
  const inheritedPythonPath = environment.PYTHONPATH;
  environment.PYTHONPATH = hooks;
  assert.equal((await run({ merged: true })).reuse, undefined, 'custom reporting module loaders use native coverage');
  await put(hooks, 'sitecustomize.py', [
    'import sys', 'from importlib.machinery import PathFinder',
    'package = PathFinder.find_spec("coverage").submodule_search_locations[0]',
    'original = PathFinder._path_importer_cache(package)',
    'class Finder:', '    def find_spec(self, name, target=None): return original.find_spec(name, target)',
    'sys.path_importer_cache[package] = Finder()',
  ].join('\n'));
  assert.equal((await run({ merged: true })).reuse, undefined, 'nonstandard package directory importers use native coverage');
  if (inheritedPythonPath === undefined) delete environment.PYTHONPATH;
  else environment.PYTHONPATH = inheritedPythonPath;

  config.coverage.report = 'my-report.json';
  const custom = await run({ merged: true, after: async coverage => {
    await coverage.verifySources();
    await coverage.saveSummary(snapshot);
    return JSON.parse(await readFile(join(root, config.coverage.report)));
  } });
  assert.equal(custom.reuse, undefined, 'project-owned report paths are output only');
  delete config.coverage.report;
  config.coverage.minimum.lines = 51;
  await run({ merged: true, status: 1 });
});
