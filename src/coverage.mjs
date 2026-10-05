import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, sep, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzip, gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { runCommand } from './command.mjs';
import { keys } from './util.mjs';

const compress = promisify(gzip);
export const defaultMinimum = { lines: 80, branches: 80, functions: 80 };
export function validateCoverage(value) {
  keys(value, ['provider', 'minimum', 'include', 'exclude', 'python', 'configFile', 'report'], 'coverage');
  if (!['v8', 'python'].includes(value.provider ?? 'v8')) throw new TypeError('coverage.provider must be v8 or python');
  if (value.provider === 'python' && (value.include !== undefined || value.exclude !== undefined)) throw new TypeError('Python source domains belong in coverage.configFile');
  if (value.minimum !== undefined) {
    keys(value.minimum, Object.keys(defaultMinimum), 'coverage.minimum');
    for (const metric of Object.values(value.minimum)) if (!Number.isFinite(metric) || metric < 0 || metric > 100) throw new TypeError('Coverage minimums must be numbers from 0 to 100');
  }
  for (const field of ['include', 'exclude']) if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].some(item => typeof item !== 'string' || !item))) throw new TypeError(`coverage.${field} must be an array of patterns`);
  for (const field of ['python', 'configFile', 'report']) if (value[field] !== undefined && (typeof value[field] !== 'string' || !value[field])) throw new TypeError(`coverage.${field} must be a nonempty string`);
}
function reports(bytes) {
  const value = JSON.parse(gunzipSync(bytes));
  if (!Array.isArray(value) || !value.length || !value.every(report => Array.isArray(report.result))) throw new Error('Invalid V8 coverage contribution');
  return value;
}
export async function createCoverage(config, environment) {
  const definition = config.coverage;
  validateCoverage(definition);
  const provider = definition.provider ?? 'v8';
  const minimum = { ...defaultMinimum, ...definition.minimum };
  const directory = join(config.cacheDirectory, 'coverage', encodeURIComponent(config.suite));
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, '.run-'));
  const measured = join(staging, 'measurement.json');
  const outputs = new Map(), contributions = new Map();
  const prefix = pathToFileURL(`${config.root}${sep}`).href;
  const python = definition.python ?? 'python3';
  const configFile = definition.configFile ? resolve(config.root, definition.configFile) : undefined;
  const configArgs = configFile ? ['--config', configFile] : [];
  const helper = join(import.meta.dirname, 'python-coverage.py');
  const commandOptions = { cwd: config.root, env: environment, signal: config.signal, logger: config.logger === false ? null : config.logger };
  async function pythonArtifact(operation, source, destination) {
    const status = await runCommand([python, helper, operation, source, destination, ...configArgs], commandOptions);
    if (status) throw new Error(`Invalid Python coverage contribution (${operation})`);
  }
  async function materialize(source) {
    const destination = join(staging, randomUUID());
    if (provider === 'python') await pythonArtifact('materialize', source, destination);
    else {
      const bytes = await readFile(source);
      reports(bytes);
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    }
    return destination;
  }
  return {
    identity: JSON.stringify({ provider, python: provider === 'python' ? python : undefined, configFile: provider === 'python' ? configFile : undefined }),
    async environment(unit) {
      if (outputs.has(unit.id)) await rm(outputs.get(unit.id), { recursive: true, force: true });
      const output = await mkdtemp(join(staging, 'file-'));
      outputs.set(unit.id, output);
      return { ...environment, ...(provider === 'python' ? { COVERAGE_FILE: join(output, 'data') } : { NODE_V8_COVERAGE: output }) };
    },
    command(command) {
      if (provider !== 'python') return command;
      // Collection belongs to the package. The configured command remains the
      // application's ordinary interpreter/framework invocation.
      return [python, '-m', 'coverage', 'run', ...(configFile ? [`--rcfile=${configFile}`] : []), '--branch', '--parallel-mode', ...command.slice(1)];
    },
    async saveEvidence(unit) {
      const output = outputs.get(unit.id);
      const artifact = join(config.cache === false ? staging : directory, `${randomUUID()}.${provider === 'python' ? 'coverage' : 'json.gz'}`);
      if (provider === 'python') await pythonArtifact('collect', output, artifact);
      else {
        const names = (await readdir(output)).filter(name => /^coverage-\d+-\d+-\d+\.json$/.test(name)).sort();
        if (!names.length) throw new Error(`Missing V8 coverage for ${unit.id}`);
        const values = [];
        for (const name of names) {
          const report = JSON.parse(await readFile(join(output, name), 'utf8'));
          if (!Array.isArray(report.result)) throw new Error(`Invalid V8 coverage for ${unit.id}`);
          values.push({ ...report, result: report.result.filter(item => item.url.startsWith(prefix) && !item.url.slice(prefix.length).startsWith('node_modules/')) });
        }
        await writeFile(`${artifact}.tmp`, await compress(JSON.stringify(values)), { flag: 'wx', mode: 0o600 });
        await rename(`${artifact}.tmp`, artifact);
      }
      contributions.set(unit.id, await materialize(artifact));
      await rm(output, { recursive: true, force: true });
      outputs.delete(unit.id);
      return { files: [artifact], metadata: { format: `project-checks-${provider}-v1`, unit: unit.id } };
    },
    async restoreEvidence(unit, { files, metadata }) {
      if (files.length !== 1 || metadata?.format !== `project-checks-${provider}-v1` || metadata.unit !== unit.id) return false;
      try { contributions.set(unit.id, await materialize(files[0])); return true; }
      catch (error) { config.signal?.throwIfAborted(); return false; }
    },
    async aggregate(units) {
      if (units.some(unit => !contributions.has(unit.id))) throw new Error('Every current file must supply a valid coverage contribution');
      const manifest = join(staging, 'manifest.json');
      await writeFile(manifest, JSON.stringify(units.map(unit => contributions.get(unit.id))));
      const report = measured;
      if (report) await mkdir(resolve(report, '..'), { recursive: true });
      if (provider === 'python') return runCommand([python, helper, 'aggregate', manifest, join(staging, 'combined'), ...configArgs,
        '--root', config.root, '--minimum', JSON.stringify(minimum), ...(report ? ['--report', report] : [])], commandOptions);
      const summaryFile = join(staging, 'summary.json');
      const status = await runCommand([process.execPath, '--experimental-test-coverage',
        '--test-reporter=spec', `--test-reporter=${join(import.meta.dirname, 'coverage-reporter.mjs')}`,
        '--test-reporter-destination=stdout', '--test-reporter-destination=stdout',
        ...(definition.include ?? []).map(value => `--test-coverage-include=${value}`),
        ...(definition.exclude ?? []).map(value => `--test-coverage-exclude=${value}`),
        ...Object.entries(minimum).map(([name, value]) => `--test-coverage-${name}=${Math.floor(value)}`),
        '--test', join(import.meta.dirname, 'coverage-merge.mjs')], {
        ...commandOptions, env: { ...environment, PROJECT_CHECKS_COVERAGE_MANIFEST: manifest, PROJECT_CHECKS_COVERAGE_REPORT: summaryFile },
      });
      if (status) return status;
      const summary = JSON.parse(await readFile(summaryFile, 'utf8'));
      if (!summary.files?.length) throw new Error('No source files in coverage domain');
      const actual = Object.fromEntries(['Line', 'Branch', 'Function'].map((metric, index) => [Object.keys(defaultMinimum)[index], summary.totals[`covered${metric}Percent`]]));
      if (Object.values(actual).some(value => !Number.isFinite(value))) throw new Error('Invalid coverage summary');
      if (report) {
        await writeFile(`${report}.tmp`, JSON.stringify({ actual, minimum }));
        await rename(`${report}.tmp`, report);
      }
      const failures = Object.entries(minimum).filter(([metric, value]) => actual[metric] < value);
      if (failures.length) {
        (config.logger === false ? null : config.logger ?? console)?.error(`Coverage below minimum: ${failures.map(([metric, value]) => `${metric} ${actual[metric]}% < ${value}%`).join(', ')}`);
        return 1;
      }
      return 0;
    },
    async saveSummary(snapshot) {
      const measurement = JSON.parse(await readFile(measured, 'utf8'));
      const report = definition.report ? resolve(config.root, definition.report) : join(directory, 'latest.json');
      await mkdir(resolve(report, '..'), { recursive: true });
      const temporary = `${report}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ ...measurement, definition, snapshot, runtime: process.version, measuredAt: new Date().toISOString() }));
      await rename(temporary, report);
    },
    close: () => rm(staging, { recursive: true, force: true }),
  };
}
