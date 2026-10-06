import { resourceSampler } from './admission.mjs';
import { defaultResources, detectResources, selectConcurrency } from './resources.mjs';
import { integer } from './util.mjs';
import defaultConfig from '../project-checks.config.json' with { type: 'json' };

export const scanConcurrency = defaultConfig.scanConcurrency;
const increment = 8;

// Lightweight cache I/O shares a pool across callers. Evidence restoration still
// acquires the caller's heavier command admission slot inside its scan job.
export function createScanQueue({ sample = resourceSampler(), host = detectResources() } = {}) {
  const queue = [];
  const batches = new Set();
  let cursor = 0, active = 0, limit = scanConcurrency, timer;
  const initial = () => Math.min(...[...batches].map(batch => batch.scanConcurrency));
  const report = batch => batch.onProgress?.({ total: batch.total, scanned: batch.scanned, active: batch.active });
  function drain() {
    if (batches.size) limit = Math.max(initial(), limit);
    while (active < limit && cursor < queue.length) {
      const { run, batch, resolve, reject } = queue[cursor];
      queue[cursor++] = undefined;
      active++;
      batch.active++;
      Promise.resolve().then(run).then(value => { batch.scanned++; return value; }).finally(() => {
        active--;
        batch.active--;
        if (--batch.remaining === 0) batches.delete(batch);
        drain();
        if (!batch.remaining) report(batch);
      }).then(resolve, reject);
    }
    if (cursor === queue.length) { queue.length = 0; cursor = 0; }
    if (!active && !queue.length) {
      clearInterval(timer);
      timer = undefined;
      limit = scanConcurrency;
    }
    for (const batch of batches) report(batch);
  }
  function tick() {
    const reading = sample();
    const cpuBudget = Math.min(...[...batches].map(batch => batch.cpuBudget));
    const reserve = Math.max(...[...batches].map(batch => batch.reserve));
    const memory = Math.max(...[...batches].map(batch => batch.memory));
    const cpu = reading.busyCpus;
    const memoryFits = Number.isFinite(reading.availableMemoryMiB) && reading.availableMemoryMiB >= reserve + memory;
    const pressureFits = !(reading.pressure > 0.05) && !(reading.memoryPressure > 0.05) && !(reading.ioPressure > 0.05);
    if (queue.length > cursor && active >= limit && Number.isFinite(cpu) && memoryFits && pressureFits
      && cpu * (active + increment) / active < cpuBudget) {
      limit += increment;
    } else if ((Number.isFinite(cpu) && cpu >= cpuBudget) || !memoryFits || !pressureFits) {
      limit = Math.max(initial(), limit - increment);
    }
    drain();
  }
  return {
    enqueue(operations, resources = {}, startingConcurrency = scanConcurrency, onProgress) {
      integer(startingConcurrency, 'scanConcurrency');
      if (!operations.length) return [];
      const previousInitial = batches.size ? initial() : startingConcurrency;
      const selected = selectConcurrency(resources, host);
      const batch = {
        remaining: operations.length,
        total: operations.length, scanned: 0, active: 0, onProgress,
        cpuBudget: Math.min(selected.cpuBudget, host.cpus * (resources.cpuQuotaPercent ?? defaultResources.cpuQuotaPercent) / 100),
        reserve: resources.reserveMemoryMiB ?? defaultResources.reserveMemoryMiB,
        memory: resources.memoryMiBPerWorker ?? defaultResources.memoryMiBPerWorker,
        scanConcurrency: startingConcurrency,
      };
      batches.add(batch);
      const promises = operations.map(run => new Promise((resolve, reject) => queue.push({ run, batch, resolve, reject })));
      // Record every job before starting workers or sampling for growth.
      if (!timer) { limit = startingConcurrency; sample(); timer = setInterval(tick, 1000); }
      else if (startingConcurrency < previousInitial) limit = Math.min(limit, startingConcurrency);
      drain();
      return promises;
    },
  };
}
