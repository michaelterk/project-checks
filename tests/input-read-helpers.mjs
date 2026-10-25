import fs from 'node:fs/promises';
import children from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { inputMetadata } from '../src/input-hash-sync.mjs';
import { filterInputDirectory } from '../src/input-exclusions.mjs';

// Worker-protocol double for deterministic interleavings. Real worker byte
// ownership, reads and cancellation are exercised in input-hash-workers tests.
export function interceptReads(t, intercept) {
  const original = children.fork;
  class ControlledProcess extends EventEmitter {
    constructor() { super(); this.exitCode = this.signalCode = null; this.caches = { exclusions: new Map(), directories: new Map() }; this.policies = new Map(); }
    ref() {}
    unref() {}
    send({ jobs, policies = [] }, callback) {
      callback?.();
      for (const [id, policy] of policies) this.policies.set(id, policy);
      this.pending = Promise.all(jobs.map(async ({ id, file, cached, inspect, identity, filter }) => {
        const metrics = {};
        try {
          if (filter) return { id, value: filterInputDirectory({ ...filter, ...this.policies.get(filter.policy) }, this.caches), metrics };
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
    kill(signal) {
      if (!this.stopping) {
        this.stopping = true;
        Promise.resolve(this.pending).then(() => {
          this.signalCode = signal;
          this.emit('exit', null, signal);
          this.emit('close', null, signal);
        });
      }
      return true;
    }
  }
  children.fork = () => new ControlledProcess();
  syncBuiltinESMExports();
  t.after(() => { children.fork = original; syncBuiltinESMExports(); });
}
