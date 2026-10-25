import { createPermits } from './permits.mjs';
import { hashInputSync, inspectInputSync } from './input-hash-sync.mjs';
import { filterInputDirectory } from './input-exclusions.mjs';

// A snapshot task already owns one scanner slot in its parent process.
export function createLocalInputPool() {
  const controller = new AbortController(), permits = createPermits(1, controller.signal);
  const pending = new Set(), buffer = Buffer.allocUnsafe(65536);
  const caches = { exclusions: new Map(), directories: new Map() };
  let active = 0, waiting = 0, closed;
  const run = operation => {
    if (closed) return Promise.reject(closed);
    const task = (async () => {
      waiting++;
      let release;
      try { release = await permits.acquire(); }
      finally { waiting--; }
      active++;
      try { controller.signal.throwIfAborted(); return await operation(); }
      finally { active--; release(); }
    })();
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  };
  const hash = async (file, identity) => hashInputSync(file, identity, buffer, () => controller.signal.aborted);
  return {
    run, runWithWorker: operation => run(() => operation(hash)),
    hash: (file, identity) => run(() => hash(file, identity)),
    inspect: (file, cached) => run(() => inspectInputSync(file, cached, buffer, () => controller.signal.aborted)),
    filterDirectory: filter => run(() => filterInputDirectory(filter, caches).map(index => filter.names[index])),
    state: () => ({ active, waiting, limit: 1 }),
    close: async reason => {
      closed ??= reason ?? new Error('Input context closed');
      controller.abort(closed);
      await Promise.allSettled([...pending]);
      permits.close();
    },
  };
}
