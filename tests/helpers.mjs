import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { cacheRecordName } from '../src/cache.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export async function temporary(t, prefix = 'project-checks-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function put(root, name, value) {
  const file = join(root, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, value);
  return file;
}

export async function cachedRecord(directory, suite, id) {
  for (const filename of await readdir(directory)) {
    if (!/^[0-9a-f]{64}\.json$/.test(filename)) continue;
    const record = JSON.parse(await readFile(join(directory, filename), 'utf8'));
    if (typeof record.key === 'string' && filename === cacheRecordName(suite, id, record.key)) return record;
  }
  throw new Error(`Missing passing record for ${suite}/${id}`);
}
