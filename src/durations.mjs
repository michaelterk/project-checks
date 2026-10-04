import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function readHints(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return {};
  }
}

export async function createDurationHints(config, files, context) {
  const measured = {};
  const path = resolve(config.cacheDirectory, `durations-${encodeURIComponent(config.suite)}.json`);
  const hashes = new Map();
  if (config.durationHints) {
    const hints = await readHints(path);
    const identities = await context.identify(
      files.map((file) => resolve(config.root, file)),
      config,
    );
    files.forEach((file, index) => hashes.set(file, identities[index][2]));
    const priority = (file) => {
      const seconds = hints[file]?.hash === hashes.get(file) ? hints[file].seconds : config.initialDurations?.[file];
      return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    };
    files.sort((left, right) => priority(right) - priority(left));
  }
  return {
    record(file, seconds) {
      if (config.durationHints) measured[file] = { hash: hashes.get(file), seconds };
    },
    async save() {
      if (!config.durationHints || !Object.keys(measured).length) return;
      config.signal?.throwIfAborted();
      const latest = await readHints(path);
      Object.assign(latest, measured);
      await mkdir(config.cacheDirectory, { recursive: true });
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        config.signal?.throwIfAborted();
        await writeFile(temporary, JSON.stringify(latest), { mode: 0o600, flag: 'wx' });
        config.signal?.throwIfAborted();
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
