import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { inputMetadata } from './input-hash-sync.mjs';
import { profileContentRead } from './scan-profile.mjs';
import { digest, inside, keys, slash, text } from './util.mjs';

// Locate the innermost installation, including a scoped name. A checkout may
// itself live under node_modules; only its own installed dependencies qualify.
export function packageRoot(project, file) {
  if (!file.includes(sep + 'node_modules' + sep)) return;
  const parts = relative(project, file).split(sep);
  const index = parts.lastIndexOf('node_modules');
  const first = parts[index + 1];
  if (index < 0 || !first || first.startsWith('.')) return;
  const end = index + (first.startsWith('@') ? 3 : 2);
  if (end <= parts.length) return join(project, ...parts.slice(0, end));
}

export async function installedVersion(config, root, file) {
  const actualRoot = await realpath(root);
  const target = file === root ? actualRoot : await realpath(file);
  const selected = await lstat(target);
  if (!selected.isDirectory() && !selected.isFile()) return;
  if (selected.isDirectory() && config.fixtureCacheDirectory &&
    (inside(config.cacheDirectory, file) || inside(config.fixtureCacheDirectory, target)))
    throw new Error(`Fixture directory must stay outside cacheDirectory: ${file}`);
  const manifest = join(root, 'package.json');
  let before;
  try { before = await lstat(manifest, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error; }
  if (!before.isFile()) return;
  const bytes = await readFile(manifest);
  profileContentRead(manifest, bytes.length, 'buffered');
  if (inputMetadata(await lstat(manifest, { bigint: true })) !== inputMetadata(before))
    throw new Error(`Input changed while reading installed version: ${manifest}`);
  let metadata;
  try { metadata = JSON.parse(bytes); } catch (error) { if (error instanceof SyntaxError) return; throw error; }
  if (typeof metadata?.name !== 'string' || !metadata.name || typeof metadata.version !== 'string' || !metadata.version) return;
  // Bind aliases and explicit leaf availability to installation slots. Only
  // links within the same installed package may substitute version for bytes.
  const marker = ['file', digest(JSON.stringify(['npm-version-v1', slash(relative(config.root, root)),
    slash(relative(root, file)), metadata.name, metadata.version, selected.isDirectory() ? 'directory' : 'file']))];
  const trusted = actualRoot === root && inside(root, target) && packageRoot(config.root, target) === root;
  return { marker, trusted };
}

export function fixtureInputs(root, declared) {
  if (!Array.isArray(declared)) throw new TypeError('testFixtureInputs must return an array of literal paths or versioned files');
  const byPath = new Map();
  for (const item of declared) {
    const versioned = item !== null && typeof item === 'object';
    if (versioned) keys(item, ['path', 'version'], 'versioned fixture');
    const path = resolve(root, text(versioned ? item.path : item, 'fixture input path'));
    const version = versioned ? text(item.version, 'fixture version') : undefined;
    if (byPath.has(path) && byPath.get(path) !== version) throw new TypeError(`Conflicting fixture declarations for ${path}`);
    byPath.set(path, version);
  }
  return [...byPath.keys()].sort().map(path => byPath.get(path) === undefined ? path : { path, version: byPath.get(path) });
}

export async function fixtureVersion({ path, version }) {
  try {
    if (!(await stat(path)).isFile()) throw new TypeError(`Versioned fixture must be a regular file: ${path}`);
  } catch (error) { if (error.code === 'ENOENT') return ['missing']; throw error; }
  return ['file', digest(JSON.stringify(['fixture-version-v1', version]))];
}
