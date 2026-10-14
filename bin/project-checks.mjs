#!/usr/bin/env node
import { createDiagnostics, loadConfig, loadChecks, runChecks, reportCoverage, runTests, runWithCpuQuota, selectConcurrency } from '../src/index.mjs';

import { hasCpuQuota, quotaCpus } from '../src/cpu-quota.mjs';
import { profileSummary } from '../src/scan-profile.mjs';
import { dirname, resolve } from 'node:path';
import { launchDashboard } from '../src/dashboard-launch.mjs';
import { startDashboardServer } from '../src/dashboard-server.mjs';
import { createDashboardRecorder } from '../src/dashboard-store.mjs';
import { commandEnvironment } from '../src/command.mjs';

const help = `Usage: project-checks [run|checks|dashboard|coverage|resources|exec] [options]

  --config <file>  Load a .mjs, .js or .json configuration
  --workers <n>    Cap resource-based concurrency
  --file <id>      Select a root-relative test file (repeatable); retain full inventory
  --no-cache       Run every test without reading or writing cached evidence
  --diagnostics    Emit per-second resource and admission diagnostics (run/checks)
  --dashboard      Start a localhost progress page and retain this run's manifest
  --dashboard-port <n>  Loopback port (default: a free port)
  --help          Show this help

  exec [--config <file>] -- <command> [args...]  Run a whole command under the CPU quota

Defaults: project-checks.config.{mjs,js,json}, test/**/*.test.{js,mjs,cjs}
`;

let controller;
let diagnostics;
let recorder;
const abort = () => controller.abort();
try {
  const args = process.argv.slice(2);
  let action = 'run';
  if (args[0] && !args[0].startsWith('-')) action = args.shift();
  if (!['run', 'checks', 'dashboard', 'coverage', 'resources', 'exec'].includes(action)) throw new Error(`Unknown command: ${action}`);
  let quotaCommand;
  let filename;
  let target;
  const overrides = {};
  let showHelp = false;
  let showDiagnostics = false;
  let showDashboard = false;
  let dashboardPort;
  while (args.length) {
    const option = args.shift();
    if (action === 'checks' && option === '--') { overrides.frameworkArgs = args.splice(0); break; }
    if (action === 'exec' && option === '--') { quotaCommand = args.splice(0); break; }
    if (option === '--help' || option === '-h') showHelp = true;
    else if (option === '--no-cache') overrides.cache = false;
    else if (option === '--diagnostics') showDiagnostics = true;
    else if (option === '--dashboard') showDashboard = true;
    else if (option === '--dashboard-port') {
      const value = args.shift();
      if (!/^(0|[1-9][0-9]*)$/.test(value ?? '') || Number(value) > 65535) throw new Error('--dashboard-port must be between 0 and 65535');
      dashboardPort = Number(value);
    }
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
    if (showDiagnostics && !['run', 'checks'].includes(action)) throw new Error('--diagnostics requires run or checks');
    if (showDashboard && !['run', 'checks'].includes(action)) throw new Error('--dashboard requires run or checks');
    if (dashboardPort !== undefined && !showDashboard && action !== 'dashboard') throw new Error('--dashboard-port requires --dashboard or dashboard');
    const explicit = new Set();
    const config = { ...await loadConfig(['checks', 'coverage'].includes(action) ? undefined : filename, { explicit }), ...overrides };
    const dashboardRoot = action === 'checks' ? dirname(resolve(filename ?? 'project-checks.project.json')) : config.root;
    // Start outside the test CPU scope so completed results remain available.
    const inheritedDashboard = process.env.PROJECT_CHECKS_DASHBOARD_ROOT === dashboardRoot ? process.env.PROJECT_CHECKS_DASHBOARD_URL : undefined;
    const dashboardUrl = showDashboard ? inheritedDashboard ?? await launchDashboard(dashboardRoot, dashboardPort) : undefined;
    if (dashboardUrl && !inheritedDashboard) console.log(`DASHBOARD: ${dashboardUrl}`);
    if (action === 'dashboard') {
      const dashboard = await startDashboardServer({ root: dashboardRoot, port: dashboardPort });
      console.log(`DASHBOARD: ${dashboard.url}`);
      const stop = () => { void dashboard.close(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      process.exitCode = 0;
    } else if (action === 'coverage') {
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
      process.exitCode = await runWithCpuQuota(quotaCommand ?? [process.execPath, ...process.argv.slice(1)], {
        resources: config.resources, ...(dashboardUrl ? { env: commandEnvironment({
          PROJECT_CHECKS_DASHBOARD_URL: dashboardUrl, PROJECT_CHECKS_DASHBOARD_ROOT: dashboardRoot,
        }) } : {}),
      });
    } else {
      controller = new AbortController();
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      const definitions = action === 'checks' ? await loadChecks(filename ?? 'project-checks.project.json', { target, files: overrides.files, cache: overrides.cache, filters: overrides.filters, frameworkArgs: overrides.frameworkArgs }) : undefined;
      const suites = definitions?.filter(definition => definition.config !== undefined).map(definition => definition.id) ?? [config.suite ?? 'tests'];
      if (showDashboard) recorder = await createDashboardRecorder({ root: dashboardRoot, target: target ?? action, suites });
      if (showDiagnostics || showDashboard) diagnostics = createDiagnostics({ suites, onEvent: recorder?.event });
      const failureExclusions = recorder?.failureExclusions;
      const result = action === 'checks' ? await runChecks(definitions, { resources: config.resources, workers: overrides.workers, scanConcurrency: config.scanConcurrency, inputConcurrency: explicit.has('inputConcurrency') ? config.inputConcurrency : undefined, verificationConcurrency: config.verificationConcurrency, signal: controller.signal, diagnostics, failureExclusions }) : await runTests({ ...config, signal: controller.signal, failureExclusions, ...(diagnostics ? { diagnostics } : {}) });
      process.exitCode = result.exitCode;
    }
  }
} catch (error) {
  recorder?.event({ event: 'run-error', message: error.message });
  console.error(`project-checks: ${error.message}`);
  process.exitCode = controller?.signal.aborted || error.name === 'AbortError' ? 130 : 2;
} finally {
  diagnostics?.close(process.exitCode ?? 2);
  try { await recorder?.close(process.exitCode ?? 2); }
  catch (error) { console.error(`project-checks dashboard: ${error.message}`); }
  if (controller && process.env.PROJECT_CHECKS_SCAN_PROFILE) console.log('SCAN_PROFILE ' + JSON.stringify(profileSummary()));
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
}
