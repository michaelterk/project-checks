import fs from 'node:fs/promises';
import workers from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { inputMetadata } from '../src/input-hash-sync.mjs';

// Worker-protocol double for deterministic interleavings. Real worker byte
// ownership, reads and cancellation are exercised in input-hash-workers tests.
export function interceptReads(t, intercept) {
  const Original = workers.Worker;
  class ControlledWorker extends EventEmitter {
    constructor(filename, options) { super(); this.flag = new Int32Array(options.workerData.cancellation); }
    postMessage({ jobs }) {
      this.pending = Promise.all(jobs.map(async ({ id, file, cached, inspect, identity }) => {
        const metrics = {};
        try {
          const info = await fs.lstat(file, { bigint: true });
          const actual = inputMetadata(info);
          if (inspect && !info.isFile()) return { id, hash: { kind: info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'other' }, metrics };
          let hash = cached?.identity === actual ? cached.hash : undefined;
          if (hash === undefined) {
            const handle = await fs.open(file, 'r'), buffer = Buffer.alloc(65536), value = createHash('sha256');
            let first = true;
            try {
              while (true) {
                const read = () => handle.read(buffer, 0, buffer.length, null);
                const { bytesRead } = await (first ? intercept(file, read) : read());
                first = false;
                if (!bytesRead) break;
                value.update(buffer.subarray(0, bytesRead));
              }
            } finally { await handle.close(); }
            if (inputMetadata(await fs.lstat(file, { bigint: true })) !== (identity ?? actual)) throw Error(`Input changed while hashing: ${file}`);
            hash = value.digest('hex');
          }
          return { id, hash: inspect ? { kind: 'file', identity: actual, hash } : hash, metrics };
        } catch (error) { return { id, error: { name: error.name, message: error.message, code: error.code, path: error.path }, metrics }; }
      })).then(results => this.emit('message', { results, done: true }));
    }
    async terminate() { await this.pending; this.emit('exit', 1); }
  }
  workers.Worker = ControlledWorker;
  syncBuiltinESMExports();
  t.after(() => { workers.Worker = Original; syncBuiltinESMExports(); });
}
