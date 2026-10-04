import { totalmem } from 'node:os';
import { cpuCapacity, cpuLimit } from './cpu-limits.mjs';
import { integer, keys } from './util.mjs';
import defaultConfig from '../project-checks.config.json' with { type: 'json' };

export const defaultResources = Object.freeze(defaultConfig.resources);

export function detectResources() {
  const limit = process.constrainedMemory();
  return {
    cpus: cpuCapacity(),
    cpuQuotaCpus: cpuLimit().cpus,
    memoryMiB: Math.max(1, Math.floor(Math.min(totalmem(), limit || Infinity) / 1024 ** 2)),
  };
}

export function selectConcurrency(policy = {}, resources = detectResources()) {
  keys(policy, ['cpuPercent', 'cpuQuotaPercent', 'reserveCpus', 'reserveMemoryMiB', 'cpusPerWorker', 'memoryMiBPerWorker', 'maxWorkers', 'divisor'], 'resources');
  const cpuQuotaPercent = policy.cpuQuotaPercent === undefined ? defaultResources.cpuQuotaPercent : policy.cpuQuotaPercent;
  if (typeof cpuQuotaPercent !== 'number' || !Number.isFinite(cpuQuotaPercent) || cpuQuotaPercent <= 0 || cpuQuotaPercent > 100) throw new TypeError('cpuQuotaPercent must be greater than 0 and at most 100');
  const cpus = integer(resources.cpus, 'Available CPUs');
  const inheritedQuota = resources.cpuQuotaCpus ?? Infinity;
  if (typeof inheritedQuota !== 'number' || !(inheritedQuota > 0)) throw new TypeError('Inherited CPU quota must be positive');
  const memoryMiB = integer(resources.memoryMiB, 'Available memory MiB');
  const divisor = integer(policy.divisor === undefined ? defaultResources.divisor : policy.divisor, 'divisor');
  const cpuPercent = policy.cpuPercent === undefined ? defaultResources.cpuPercent : policy.cpuPercent;
  const cpusPerWorker = policy.cpusPerWorker === undefined ? defaultResources.cpusPerWorker : policy.cpusPerWorker;
  for (const [name, value] of Object.entries({ cpuPercent, cpusPerWorker })) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive number`);
  }
  const adjustedCpus = integer(Math.max(1, Math.floor(cpus * cpuPercent / 100)), 'Adjusted CPUs');
  const cpuBudget = Math.min(inheritedQuota / divisor, Math.max(1, Math.floor((adjustedCpus - integer(policy.reserveCpus === undefined ? defaultResources.reserveCpus : policy.reserveCpus, 'reserveCpus', 0)) / divisor)));
  const memoryBudgetMiB = Math.max(1, Math.floor((memoryMiB - integer(policy.reserveMemoryMiB === undefined ? defaultResources.reserveMemoryMiB : policy.reserveMemoryMiB, 'reserveMemoryMiB', 0)) / divisor));
  const workers = Math.max(1, Math.min(
    Math.floor(cpuBudget / cpusPerWorker),
    Math.floor(memoryBudgetMiB / integer(policy.memoryMiBPerWorker === undefined ? defaultResources.memoryMiBPerWorker : policy.memoryMiBPerWorker, 'memoryMiBPerWorker')),
    policy.maxWorkers === undefined ? Infinity : integer(policy.maxWorkers, 'maxWorkers'),
  ));
  return { cpus, memoryMiB, divisor, cpuBudget, memoryBudgetMiB, workers };
}
