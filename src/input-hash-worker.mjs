import { parentPort, workerData } from 'node:worker_threads';
import { hashInputSync, inspectInputSync } from './input-hash-sync.mjs';

const cancellation = new Int32Array(workerData.cancellation);
const buffer = Buffer.allocUnsafe(65536);
const serialize = error => ({ name: error.name, message: error.message, stack: error.stack,
  code: error.code, path: error.path, syscall: error.syscall,
  ...(error.cause instanceof Error ? { cause: serialize(error.cause) } : {}) });
parentPort.on('message', ({ jobs }) => {
  const results = jobs.map(({ id, file, identity, inspect, cached }) => {
    const metrics = {};
    try {
      const cancelled = () => Atomics.load(cancellation, 0) !== 0;
      const hash = inspect ? inspectInputSync(file, cached, buffer, cancelled, metrics)
        : hashInputSync(file, identity, buffer, cancelled, metrics);
      return { id, hash, metrics };
    } catch (error) { return { id, error: serialize(error), metrics }; }
  });
  parentPort.postMessage({ results, done: true });
});
