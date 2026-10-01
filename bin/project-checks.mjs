#!/usr/bin/env node
import { loadConfig, runTests, selectConcurrency } from '../src/index.mjs';

const help = `Usage: project-checks [run|resources] [options]

  --config <file>  Load a .mjs, .js or .json configuration
  --workers <n>    Override resource-based concurrency
  --no-cache       Run every test without reading or writing cached evidence
  --help          Show this help

Defaults: project-checks.config.{mjs,js,json}, test/**/*.test.{js,mjs,cjs}
`;

let controller;
const abort = () => controller.abort();
try {
  const args = process.argv.slice(2);
  let action = 'run';
  if (args[0] && !args[0].startsWith('-')) action = args.shift();
  if (!['run', 'resources'].includes(action)) throw new Error(`Unknown command: ${action}`);
  let filename;
  const overrides = {};
  let showHelp = false;
  while (args.length) {
    const option = args.shift();
    if (option === '--help' || option === '-h') showHelp = true;
    else if (option === '--no-cache') overrides.cache = false;
    else if (option === '--config' || option === '--workers') {
      const value = args.shift();
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${option}`);
      if (option === '--config') filename = value;
      else {
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--workers must be a positive integer');
        overrides.workers = Number(value);
      }
    } else throw new Error(`Unknown option: ${option}`);
  }
  if (showHelp) console.log(help);
  else {
    const config = { ...await loadConfig(filename), ...overrides };
    if (action === 'resources') {
      const selected = selectConcurrency(config.resources);
      console.log(JSON.stringify({ ...selected, workers: config.workers ?? selected.workers }, null, 2));
    } else {
      controller = new AbortController();
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      const result = await runTests({ ...config, signal: controller.signal });
      console.log(`Tests: ${result.passed} passed, ${result.failed} failed, ${result.cached} cached (${result.total} total).`);
      process.exitCode = result.exitCode;
    }
  }
} catch (error) {
  console.error(`project-checks: ${error.message}`);
  process.exitCode = controller?.signal.aborted ? 130 : 2;
} finally {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
}
