import { createPermits } from './permits.mjs';

// Bound completed work as well as active verification, before launching commands.
export function createVerificationPool(capacity, signal) {
  const outstanding = createPermits(capacity + 16, signal);
  const active = createPermits(16, signal);
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
