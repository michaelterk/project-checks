import { createPermits } from './permits.mjs';
import { workerLimit } from './util.mjs';
import { cpuCapacity } from './cpu-limits.mjs';
import defaultConfig from '../project-checks.config.json' with { type: 'json' };

export const verificationConcurrency = defaultConfig.verificationConcurrency;

// Bound completed work as well as active verification, before launching commands.
export function createVerificationPool(signal, concurrency = verificationConcurrency) {
  concurrency = workerLimit(concurrency, 'verificationConcurrency');
  const outstanding = createPermits(cpuCapacity() * 16, signal);
  const active = createPermits(concurrency, signal);
  return {
    reserve: () => outstanding.acquire(),
    async run(operation) {
      const release = await active.acquire();
      try { signal.throwIfAborted(); return await operation(); }
      finally { release(); }
    },
    close() { outstanding.close(); active.close(); },
  };
}
