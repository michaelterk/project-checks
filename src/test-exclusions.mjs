import { mkdir, readdir, rename, rm, writeFile, open } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './util.mjs';

export async function readJsonBounded(path, limit = 16 * 1024 * 1024) {
  const handle = await open(path, 'r');
  try {
    const sizeHint = (await handle.stat()).size;
    if (sizeHint > limit) throw new Error('JSON file exceeds size limit');
    const buffer = Buffer.alloc(Math.min(limit + 1, sizeHint + 1));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error('JSON file exceeds size limit');
    return JSON.parse(buffer.toString('utf8', 0, size));
  } finally { await handle.close(); }
}

export async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

function validFile(file) {
  return typeof file === 'string' && file.length > 0 && file.length < 4096 && !isAbsolute(file)
    && !/[\\\0]/.test(file) && file.split('/').every(part => part && part !== '.' && part !== '..');
}

export async function excludeTest(root, file) {
  if (!validFile(file)) throw new Error('Invalid test file');
  const directory = join(root, '.project-checks/excluded-tests');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // One immutable identity per file avoids lost updates between concurrent dashboards.
  await atomicJson(join(directory, `${digest(file)}.json`), { file, reason: 'obsolete' });
}

export async function excludedTests(root) {
  const directory = join(root, '.project-checks/excluded-tests');
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
  const result = new Set();
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const value = await readJsonBounded(join(directory, name), 8192);
    if (!validFile(value.file) || name !== `${digest(value.file)}.json` || value.reason !== 'obsolete')
      throw new Error(`Invalid excluded test record: ${name}`);
    result.add(value.file);
  }
  return result;
}
