import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { glob, lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, join, matchesGlob, relative, resolve } from 'node:path';
import { digest, inside, slash } from './util.mjs';

export async function discoverTests({ root, testDirectory, pattern, ignore }) {
  const directory = resolve(root, testDirectory);
  if (!inside(root, directory) || !inside(root, await realpath(directory))) throw new Error('testDirectory must stay inside the project root');
  const files = [];
  for await (const name of glob(pattern, { cwd: directory })) {
    const file = resolve(directory, name);
    const id = slash(relative(root, file));
    if (ignore.some(pattern => matchesGlob(id, pattern))) continue;
    const info = await lstat(file);
    if (info.isSymbolicLink() || !inside(root, await realpath(file))) throw new Error(`Test must be a regular file inside the project root: ${id}`);
    if (info.isFile()) files.push(id);
  }
  return [...new Set(files)].sort();
}

// Memoize contents within one run only; every snapshot rechecks metadata.
export function createSnapshot(config, extraIdentity) {
  const digests = new Map();
  const excluded = file => inside(config.cacheDirectory, file) || config.ignore.some(pattern => matchesGlob(slash(relative(config.root, file)), pattern));
  const metadata = info => [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(':');
  async function fileIdentity(file, info) {
    const identity = metadata(info);
    if (digests.get(file)?.identity === identity) return digests.get(file).hash;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (metadata(await lstat(file, { bigint: true })) !== identity) throw new Error(`Input changed while hashing: ${file}`);
    const value = hash.digest('hex');
    digests.set(file, { identity, hash: value });
    return value;
  }
  async function identity(file, ancestors = new Set()) {
    const info = await lstat(file, { bigint: true });
    if (info.isSymbolicLink()) {
      const target = await realpath(file);
      // Dependency managers can create cyclic link graphs. The ancestor's
      // contents are already in this snapshot; retain the link and its target.
      if (ancestors.has(target)) return ['symlink', await readlink(file), ['cycle', target]];
      return ['symlink', await readlink(file), await identity(target, ancestors)];
    }
    if (info.isFile()) return ['file', Number(info.mode & 0o777n), await fileIdentity(file, info)];
    if (!info.isDirectory()) throw new Error(`Unsupported input type: ${file}`);
    const canonical = await realpath(file);
    if (ancestors.has(canonical)) return ['cycle', canonical];
    const nested = new Set(ancestors).add(canonical);
    const entries = [];
    for (const name of (await readdir(file)).sort()) {
      const child = join(file, name);
      if (!excluded(child)) entries.push([name, await identity(child, nested)]);
    }
    return ['directory', entries];
  }
  return async () => {
    const files = await discoverTests(config);
    const common = [];
    const selected = new Set();
    // Node's glob does not emit the cwd itself for '.'. Select that tree
    // explicitly so default input tracking includes every project file.
    const patterns = config.inputs.filter(pattern => {
      if (resolve(config.root, pattern) !== config.root) return true;
      if (!excluded(config.root)) selected.add(config.root);
      return false;
    });
    for await (const name of glob(patterns, { cwd: config.root, exclude: config.ignore })) {
      const file = resolve(config.root, name);
      if (!inside(config.root, file)) throw new Error(`Input must stay inside the project root: ${name}`);
      if (!excluded(file)) selected.add(file);
    }
    // A selected directory already covers its descendants; hash each tree once.
    for (const file of [...selected].sort()) {
      let parent = dirname(file);
      while (inside(config.root, parent) && parent !== config.root && !selected.has(parent)) parent = dirname(parent);
      if (file !== config.root && selected.has(parent)) continue;
      common.push([slash(relative(config.root, file)), await identity(file)]);
    }
    const units = {};
    for (const id of files) units[id] = digest(JSON.stringify(await identity(resolve(config.root, id))));
    const custom = config.fingerprint ? await config.fingerprint() : null;
    if (config.fingerprint && typeof custom !== 'string') throw new TypeError('fingerprint must return a string');
    const implementation = await extraIdentity();
    return { common: digest(JSON.stringify([config.root, implementation, common, custom])), units };
  };
}
