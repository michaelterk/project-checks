import { hashInputSync, inspectInputSync } from './input-hash-sync.mjs';
import { filterInputDirectory } from './input-exclusions.mjs';
import { runInputTask } from './input-task.mjs';

const buffer = Buffer.allocUnsafe(65536);
const caches = { exclusions: new Map(), directories: new Map() };
const filterPolicies = new Map();
const serialize = error => ({ name: error.name, message: error.message, stack: error.stack,
  code: error.code, path: error.path, syscall: error.syscall,
  ...(error.cause instanceof Error ? { cause: serialize(error.cause) } : {}) });
process.on('message', async ({ jobs, policies = [] }) => {
  for (const [id, definition] of policies) filterPolicies.set(id,
    definition.snapshot ? definition : { ...definition, excludedFiles: new Set(definition.excludedFiles) });
  const results = await Promise.all(jobs.map(async ({ id, file, identity, inspect, cached, filter, task }) => {
    const metrics = {};
    try {
      if (task) {
        const definition = filterPolicies.get(task.policy)?.snapshot;
        if (!definition) throw new Error('Unknown input snapshot policy');
        return { id, value: await runInputTask(definition, task), metrics };
      }
      if (filter) {
        const policy = filterPolicies.get(filter.policy);
        if (!policy) throw new Error('Unknown input directory policy');
        return { id, value: filterInputDirectory({ ...filter, ...policy }, caches), metrics };
      }
      const cancelled = () => !process.connected;
      const hash = inspect ? inspectInputSync(file, cached, buffer, cancelled, metrics)
        : hashInputSync(file, identity, buffer, cancelled, metrics);
      return { id, hash, metrics };
    } catch (error) { return { id, error: serialize(error), metrics }; }
  }));
  process.send({ results, done: true });
});
process.on('disconnect', () => process.exit(0));
