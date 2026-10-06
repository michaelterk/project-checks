#!/usr/bin/env node
import { loadConfig, loadChecks, runChecks, reportCoverage, runTests, runWithCpuQuota, selectConcurrency } from '../src/index.mjs';

import { hasCpuQuota, quotaCpus } from '../src/cpu-quota.mjs';

const help = `Usage: project-checks [run|checks|coverage|resources|exec] [options]

  --config <file>  Load a .mjs, .js or .json configuration
  --workers <n>    Cap resource-based concurrency
  --file <id>      Select a root-relative test file (repeatable); retain full inventory
  --no-cache       Run every test without reading or writing cached evidence
  --help          Show this help

  exec [--config <file>] -- <command> [args...]  Run a whole command under the CPU quota

Defaults: project-checks.config.{mjs,js,json}, test/**/*.test.{js,mjs,cjs}
`;

let controller;
const abort = () => controller.abort();
try {
  const args = process.argv.slice(2);
  let action = 'run';
  if (args[0] && !args[0].startsWith('-')) action = args.shift();
  if (!['run', 'checks', 'coverage', 'resources', 'exec'].includes(action)) throw new Error(`Unknown command: ${action}`);
  let quotaCommand;
  let filename;
  let target;
  const overrides = {};
  let showHelp = false;
  while (args.length) {
    const option = args.shift();
    if (action === 'checks' && option === '--') { overrides.frameworkArgs = args.splice(0); break; }
    if (action === 'exec' && option === '--') { quotaCommand = args.splice(0); break; }
    if (option === '--help' || option === '-h') showHelp = true;
    else if (option === '--no-cache') overrides.cache = false;
    else if (option === '--test-only' || /^--test-(?:name|skip)-pattern=/.test(option)) (overrides.filters ??= []).push(option);
    else if (/^--test-(?:name|skip)-pattern$/.test(option)) { const value = args.shift(); if (!value) throw new Error(`Missing value for ${option}`); (overrides.filters ??= []).push(`${option}=${value}`); }
    else if (option === '--config' || option === '--workers' || option === '--file' || option === '--target') {
      const value = args.shift();
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${option}`);
      if (option === '--config') filename = value;
      else if (option === '--target') target = value;
      else if (option === '--file') (overrides.files ??= []).push(value);
      else {
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--workers must be a positive integer');
        overrides.workers = Number(value);
      }
    } else throw new Error(`Unknown option: ${option}`);
  }
  if (showHelp) console.log(help);
  else {
    const explicit = new Set();
    const config = { ...await loadConfig(['checks', 'coverage'].includes(action) ? undefined : filename, { explicit }), ...overrides };
    if (action === 'coverage') {
      for (const definition of await loadChecks(filename ?? 'project-checks.project.json', { target })) {
        if (!definition.config) continue;
        const report = await reportCoverage(await definition.config({}));
        if (report) console.log(JSON.stringify(report));
      }
    } else if (action === 'resources') {
      const selected = selectConcurrency(config.resources);
      console.log(JSON.stringify({ ...selected, workers: config.workers ?? selected.workers }, null, 2));
    } else if (action === 'exec' || (process.platform === 'linux' && !await hasCpuQuota(quotaCpus(config.resources)))) {
      if (action === 'exec' && !quotaCommand?.length) throw new Error('exec requires -- followed by a command');
      process.exitCode = await runWithCpuQuota(quotaCommand ?? [process.execPath, ...process.argv.slice(1)], { resources: config.resources });
    } else {
      controller = new AbortController();
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      const result = action === 'checks' ? await runChecks(await loadChecks(filename ?? 'project-checks.project.json', { target, files: overrides.files, cache: overrides.cache, filters: overrides.filters, frameworkArgs: overrides.frameworkArgs }), { resources: config.resources, workers: overrides.workers, scanConcurrency: config.scanConcurrency, inputConcurrency: explicit.has('inputConcurrency') ? config.inputConcurrency : undefined, verificationConcurrency: config.verificationConcurrency, signal: controller.signal }) : await runTests({ ...config, signal: controller.signal });
      process.exitCode = result.exitCode;
    }
  }
} catch (error) {
  console.error(`project-checks: ${error.message}`);
  process.exitCode = controller?.signal.aborted || error.name === 'AbortError' ? 130 : 2;
} finally {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
}
