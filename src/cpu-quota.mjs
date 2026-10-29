import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { commandEnvironment, runCommand } from './command.mjs';
import { withProcessSignal } from './cancellation.mjs';
import { cpuLimit } from './cpu-limits.mjs';
import { defaultResources, detectResources, selectConcurrency } from './resources.mjs';
import { command as validateCommand } from './util.mjs';

const execute = promisify(execFile);

export function userBusEnvironment(env = commandEnvironment(), { uid = process.getuid(), stat = lstatSync } = {}) {
  if (env.XDG_RUNTIME_DIR || env.DBUS_SESSION_BUS_ADDRESS) return env;
  // Non-login launchers can omit session variables while the user's manager is running.
  const directory = `/run/user/${uid}`;
  const bus = `${directory}/bus`;
  try {
    const runtime = stat(directory), socket = stat(bus);
    if (!runtime.isDirectory() || runtime.uid !== uid || (runtime.mode & 0o777) !== 0o700 || !socket.isSocket() || socket.uid !== uid) {
      throw new Error('Runtime directory or bus socket is not owned and private');
    }
  } catch (cause) {
    throw new Error(`Cannot locate the current user's systemd bus at ${bus}; provide XDG_RUNTIME_DIR or DBUS_SESSION_BUS_ADDRESS for the user session`, { cause });
  }
  return { ...env, XDG_RUNTIME_DIR: directory, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` };
}

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
  const env = userBusEnvironment(options.env);
  const unit = `project-checks-${randomUUID()}.scope`;
  try {
    return await runCommand([
      'systemd-run', '--user', '--scope', '--quiet', '--collect', `--unit=${unit}`,
      `--property=CPUQuota=${cpus * 100}%`, '--property=CPUQuotaPeriodSec=10ms',
      process.execPath, fileURLToPath(new URL('./quota-exec.mjs', import.meta.url)), String(cpus), ...command,
    ], { ...options, env });
  } finally {
    // A command can detach children from its process group; drain its entire scope.
    try { await execute('systemctl', ['--user', 'stop', unit], { env }); }
    catch (error) { if (error.code !== 5) throw new Error(`Could not stop CPU quota scope: ${error.stderr || error.message}`, { cause: error }); }
  }
}
