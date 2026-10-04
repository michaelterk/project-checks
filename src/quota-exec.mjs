import { hasCpuQuota } from './cpu-quota.mjs';
import { runCommand } from './command.mjs';

try {
  const cpus = Number(process.argv[2]);
  if (!(cpus > 0 && Number.isFinite(cpus)) || !await hasCpuQuota(cpus)) throw new Error('Kernel CPU quota was not applied; command was not started');
  process.exitCode = await runCommand(process.argv.slice(3));
} catch (error) {
  console.error(`project-checks: ${error.message}`);
  process.exitCode = 2;
}
