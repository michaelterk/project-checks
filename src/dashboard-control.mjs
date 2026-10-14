import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, readJsonBounded } from './test-exclusions.mjs';

export const controlPath = (directory, id) => join(directory, 'controls', `${id}.json`);

// The dashboard and runner serialize acceptance against the final-result fence.
// A request arriving after close is rejected, never silently acknowledged.
export async function updateControl(directory, id, update) {
  const path = controlPath(directory, id), lock = `${path}.lock`;
  const deadline = Date.now() + 5000;
  while (true) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Run controls are busy; retry after the current update finishes');
      await delay(20);
    }
  }
  try {
    const value = await readJsonBounded(path);
    const result = await update(value);
    await atomicJson(path, value);
    return result;
  } finally { await rm(lock, { recursive: true, force: true }); }
}

export async function createRunControl(directory, id) {
  await mkdir(join(directory, 'controls'), { recursive: true, mode: 0o700 });
  await atomicJson(controlPath(directory, id), { open: true, files: [] });
  let frozen, closing;
  return {
    async files(suite) {
      const files = frozen ?? (await readJsonBounded(controlPath(directory, id))).files;
      return files.filter(file => file.suite === suite).map(file => file.file);
    },
    close() {
      closing ??= updateControl(directory, id, value => { value.open = false; frozen = value.files; });
      return closing;
    },
  };
}
