import { createPermits } from './permits.mjs';
import { integer } from './util.mjs';
import defaultConfig from '../project-checks.config.json' with { type: 'json' };

export const verificationConcurrency = defaultConfig.verificationConcurrency;

// Bound completed work as well as active verification, before launching commands.
export function createVerificationPool(capacity, signal, concurrency = verificationConcurrency) {
  integer(concurrency, 'verificationConcurrency');
  const outstanding = createPermits(capacity + concurrency, signal);
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
