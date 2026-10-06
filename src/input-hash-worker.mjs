import { parentPort, workerData } from 'node:worker_threads';
import { hashInputSync, inspectInputSync } from './input-hash-sync.mjs';

const cancellation = new Int32Array(workerData.cancellation);
const buffer = Buffer.allocUnsafe(65536);
const serialize = error => ({ name: error.name, message: error.message, stack: error.stack,
  code: error.code, path: error.path, syscall: error.syscall,
  ...(error.cause instanceof Error ? { cause: serialize(error.cause) } : {}) });
parentPort.on('message', ({ jobs }) => {
  let results = [], lastFlush = performance.now();
  const flush = (done = false) => {
    if (!results.length && !done) return;
    parentPort.postMessage({ results, done });
    results = []; lastFlush = performance.now();
  };
  const beforeHash = info => { if (info.size === 0n || info.size > 65536n) flush(); };
  // A misleading size or growth cannot hold preceding completed results for the
  // whole read. Byte ownership and cancellation remain within the same job.
  const duringRead = bytes => { if (results.length && (bytes >= 65536 || performance.now() - lastFlush >= 4)) flush(); };
  for (const { id, file, identity, inspect, cached } of jobs) {
    const metrics = {};
    try {
      const cancelled = () => Atomics.load(cancellation, 0) !== 0;
      if (!inspect) flush(); // No worker-fresh size is available for this request.
      const value = inspect ? inspectInputSync(file, cached, buffer, cancelled, metrics, beforeHash, duringRead)
        : hashInputSync(file, identity, buffer, cancelled, metrics, duringRead);
      results.push({ id, hash: value, metrics });
    } catch (error) { results.push({ id, error: serialize(error), metrics }); }
    if (performance.now() - lastFlush >= 4) flush();
  }
  flush(true);
});
