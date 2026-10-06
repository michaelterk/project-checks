import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';

export const inputMetadata = info => [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(':');

// A worker owns this fixed buffer and one file handle at a time. Read actual
// bytes through EOF, including virtual regular files with misleading st_size.
export function hashInputSync(file, expected, buffer, cancelled = () => false, metrics = {}, duringRead) {
  const check = () => {
    if (cancelled()) throw Object.assign(new Error(`Input hashing cancelled: ${file}`), { code: 'INPUT_HASH_CANCELLED', path: file });
  };
  check();
  const hash = createHash('sha256');
  const descriptor = openSync(file, 'r');
  metrics.opened = true;
  metrics.bytes = 0;
  let failed = false;
  try {
    while (true) {
      check();
      duringRead?.(metrics.bytes);
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytes) break;
      metrics.bytes += bytes;
      hash.update(buffer.subarray(0, bytes));
    }
  } catch (error) { failed = true; throw error; }
  finally { try { closeSync(descriptor); } catch (error) { if (!failed) throw error; } }
  check();
  metrics.postStat = true;
  if (inputMetadata(lstatSync(file, { bigint: true })) !== expected) throw new Error(`Input changed while hashing: ${file}`);
  return hash.digest('hex');
}

// Directory entries are hints only: inspect the actual current type in this
// worker before either trusting a prior digest or reading bytes.
export function inspectInputSync(file, cached, buffer, cancelled, metrics = {}, beforeHash, duringRead) {
  if (cancelled()) throw Object.assign(new Error(`Input hashing cancelled: ${file}`), { code: 'INPUT_HASH_CANCELLED', path: file });
  metrics.initialStat = true;
  const info = lstatSync(file, { bigint: true });
  if (!info.isFile()) return { kind: 'other' };
  const identity = inputMetadata(info);
  let hash;
  if (cached?.identity === identity) hash = cached.hash;
  else { beforeHash?.(info); hash = hashInputSync(file, identity, buffer, cancelled, metrics, duringRead); }
  return { kind: 'file', identity, hash };
}
