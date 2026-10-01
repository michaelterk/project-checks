import { availableParallelism, totalmem } from 'node:os';
import { integer, keys } from './util.mjs';

export function detectResources() {
  const limit = process.constrainedMemory();
  return {
    cpus: availableParallelism(),
    memoryMiB: Math.max(1, Math.floor(Math.min(totalmem(), limit || Infinity) / 1024 ** 2)),
  };
}

export function selectConcurrency(policy = {}, resources = detectResources()) {
  keys(policy, ['cpuPercent', 'reserveCpus', 'reserveMemoryMiB', 'cpusPerWorker', 'memoryMiBPerWorker', 'maxWorkers', 'divisor'], 'resources');
  const cpus = integer(resources.cpus, 'Available CPUs');
  const memoryMiB = integer(resources.memoryMiB, 'Available memory MiB');
  const divisor = integer(policy.divisor === undefined ? 1 : policy.divisor, 'divisor');
  const cpuPercent = policy.cpuPercent === undefined ? 100 : policy.cpuPercent;
  const cpusPerWorker = policy.cpusPerWorker === undefined ? 1 : policy.cpusPerWorker;
  for (const [name, value] of Object.entries({ cpuPercent, cpusPerWorker })) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive number`);
  }
  const adjustedCpus = integer(Math.max(1, Math.floor(cpus * cpuPercent / 100)), 'Adjusted CPUs');
  const cpuBudget = Math.max(1, Math.floor((adjustedCpus - integer(policy.reserveCpus === undefined ? 0 : policy.reserveCpus, 'reserveCpus', 0)) / divisor));
  const memoryBudgetMiB = Math.max(1, Math.floor((memoryMiB - integer(policy.reserveMemoryMiB === undefined ? 0 : policy.reserveMemoryMiB, 'reserveMemoryMiB', 0)) / divisor));
  const workers = Math.max(1, Math.min(
    Math.floor(cpuBudget / cpusPerWorker),
    Math.floor(memoryBudgetMiB / integer(policy.memoryMiBPerWorker === undefined ? 256 : policy.memoryMiBPerWorker, 'memoryMiBPerWorker')),
    policy.maxWorkers === undefined ? Infinity : integer(policy.maxWorkers, 'maxWorkers'),
  ));
  return { cpus, memoryMiB, divisor, cpuBudget, memoryBudgetMiB, workers };
}
