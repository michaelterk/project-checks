import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
