import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runCommand } from './command.mjs';
import { withProcessSignal } from './cancellation.mjs';
import { cpuLimit } from './cpu-limits.mjs';
import { defaultResources, detectResources, selectConcurrency } from './resources.mjs';
import { command as validateCommand } from './util.mjs';

const execute = promisify(execFile);

export function quotaCpus(resources = {}, host = detectResources()) {
  selectConcurrency(resources, host);
  return host.cpus * (resources.cpuQuotaPercent ?? defaultResources.cpuQuotaPercent) / 100;
}

export async function hasCpuQuota(cpus, options) {
  if (process.platform !== 'linux') return false;
  const { cpus: limit, ownedScope } = cpuLimit(options);
  if (limit <= cpus + 1e-6) return true;
  if (ownedScope) throw new Error('Cannot tighten a nested project-checks quota; configure cpuQuotaPercent on the outer runner');
  return false;
}

export async function runWithCpuQuota(command, { resources = {}, ...options } = {}) {
  return withProcessSignal(options.signal, async signal => {
    const status = await runQuotaCommand(command, resources, { ...options, signal });
    signal.throwIfAborted();
    return status;
  });
}

async function runQuotaCommand(command, resources, options) {
  validateCommand(command);
  const cpus = quotaCpus(resources);
  if (process.platform !== 'linux') throw new Error('OS CPU quota requires Linux cgroup v2 and user systemd');
  if (await hasCpuQuota(cpus)) return runCommand(command, options);
  options.signal?.throwIfAborted();
  const unit = `project-checks-${randomUUID()}.scope`;
  try {
    return await runCommand([
      'systemd-run', '--user', '--scope', '--quiet', '--collect', `--unit=${unit}`,
      `--property=CPUQuota=${cpus * 100}%`, '--property=CPUQuotaPeriodSec=10ms',
      process.execPath, fileURLToPath(new URL('./quota-exec.mjs', import.meta.url)), String(cpus), ...command,
    ], options);
  } finally {
    // A command can detach children from its process group; drain its entire scope.
    try { await execute('systemctl', ['--user', 'stop', unit]); }
    catch (error) { if (error.code !== 5) throw new Error(`Could not stop CPU quota scope: ${error.stderr || error.message}`, { cause: error }); }
  }
}
