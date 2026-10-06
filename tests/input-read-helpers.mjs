import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

// Intercept the read operation while retaining real handle ownership and close.
export function interceptReads(t, intercept) {
  const original = fs.open;
  fs.open = async (file, ...args) => {
    const handle = await original(file, ...args);
    let first = true;
    return { read: (...readArgs) => {
      if (!first) return handle.read(...readArgs);
      first = false;
      return intercept(file, () => handle.read(...readArgs));
    }, close: () => handle.close() };
  };
  syncBuiltinESMExports();
  t.after(() => { fs.open = original; syncBuiltinESMExports(); });
}
