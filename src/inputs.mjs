import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { glob, lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, join, matchesGlob, relative, resolve } from 'node:path';
import { digest, inside, slash } from './util.mjs';

// One queue bounds leaf work. Visitors enqueue children without awaiting them.
export function createSnapshotContext({ signal } = {}) {
  const waiting = [];
  const idle = [];
  const digests = new Map();
  const exclusions = new Map();
  let active = 0;
  let closed = false;
  let closeReason;
  function drain() {
    while (active < 8 && waiting.length) {
      const { operation, resolve, reject } = waiting.shift();
      active++;
      Promise.resolve().then(operation).then(
        value => closed ? reject(closeReason) : resolve(value),
        error => reject(closed ? closeReason : error),
      ).finally(() => {
        active--;
        drain();
        if (closed && !active) idle.splice(0).forEach(resolve => resolve());
      });
    }
  }
  const run = operation => new Promise((resolve, reject) => {
    if (closed) { reject(closeReason); return; }
    waiting.push({ operation, resolve, reject });
    drain();
  });
  function excluded(config) {
    // These decisions depend on paths and rules only, never filesystem state.
    const rules = JSON.stringify([config.root, config.cacheDirectory, config.ignore]);
    let values = exclusions.get(rules);
    if (!values) exclusions.set(rules, values = new Map());
    const patterns = config.ignore.map(pattern => ({
      pattern,
      literal: process.platform !== 'win32' && !/[*?{}()[\]\\!+@]/.test(pattern) && pattern === slash(relative(config.root, resolve(config.root, pattern))),
    }));
    return file => {
      if (values.has(file)) return values.get(file);
      const id = slash(relative(config.root, file));
      const value = inside(config.cacheDirectory, file) || patterns.some(({ pattern, literal }) => literal ? id === pattern : matchesGlob(id, pattern));
      values.set(file, value);
      return value;
    };
  }
  const metadata = info => [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(':');
  function fileIdentity(file, info) {
    const identity = metadata(info);
    const existing = digests.get(file);
    if (existing?.identity === identity) return existing.hash;
    const entry = { identity };
    entry.hash = (async () => {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      if (metadata(await lstat(file, { bigint: true })) !== identity) throw new Error(`Input changed while hashing: ${file}`);
      return hash.digest('hex');
    })().catch(error => {
      if (digests.get(file) === entry) digests.delete(file);
      throw error;
    });
    digests.set(file, entry);
    return entry.hash;
  }
  function identify(files, config) {
    const exclude = excluded(config);
    return new Promise((resolve, reject) => {
      const values = new Array(files.length);
      let remaining = 0;
      const failures = [];
      function enqueue(file, ancestors, assign) {
        remaining++;
        run(async () => {
          if (failures.length) return;
          const info = await lstat(file, { bigint: true });
          if (info.isSymbolicLink()) {
            const target = await realpath(file);
            const value = ['symlink', await readlink(file), null];
            assign(value);
            if (ancestors.has(target)) value[2] = ['cycle', target];
            else enqueue(target, ancestors, identity => { value[2] = identity; });
          } else if (info.isFile()) {
            assign(['file', Number(info.mode & 0o777n), await fileIdentity(file, info)]);
          } else if (info.isDirectory()) {
            const canonical = await realpath(file);
            if (ancestors.has(canonical)) { assign(['cycle', canonical]); return; }
            const nested = new Set(ancestors).add(canonical);
            const entries = (await readdir(file)).sort().filter(name => !exclude(join(file, name))).map(name => [name, null]);
            assign(['directory', entries]);
            for (const entry of entries) enqueue(join(file, entry[0]), nested, identity => { entry[1] = identity; });
          } else throw new Error(`Unsupported input type: ${file}`);
        }).catch(error => { if (!failures.length) failures.push(error); }).finally(() => {
          if (!--remaining) failures.length ? reject(failures[0]) : resolve(values);
        });
      }
      files.forEach((file, index) => enqueue(file, new Set(), identity => { values[index] = identity; }));
      if (!remaining) resolve(values);
    });
  }
  const close = (reason = new Error('Input context closed')) => {
    if (!closed) closeReason = reason;
    closed = true;
    waiting.splice(0).forEach(({ reject }) => reject(closeReason));
    signal?.removeEventListener('abort', abort);
    return active ? new Promise(resolve => idle.push(resolve)) : Promise.resolve();
  };
  const abort = () => { void close(signal.reason); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return { run, excluded, identify, digests, exclusions, close };
}

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

// Every snapshot still discovers paths and rechecks metadata, including cache hits.
export function createSnapshot(config, extraIdentity, context = createSnapshotContext()) {
  const snapshot = async () => {
    const excluded = context.excluded(config);
    const files = await context.run(() => discoverTests(config));
    const common = [];
    const selected = new Set();
    // Node's glob does not emit the cwd itself for '.'. Select that tree
    // explicitly so default input tracking includes every project file.
    const patterns = config.inputs.filter(pattern => {
      if (resolve(config.root, pattern) !== config.root) return true;
      if (!excluded(config.root)) selected.add(config.root);
      return false;
    });
    await context.run(async () => {
      for await (const name of glob(patterns, { cwd: config.root, exclude: config.ignore })) {
        const file = resolve(config.root, name);
        if (!inside(config.root, file)) throw new Error(`Input must stay inside the project root: ${name}`);
        if (!excluded(file)) selected.add(file);
      }
    });
    // A selected directory already covers its descendants; hash each tree once.
    const roots = [];
    for (const file of [...selected].sort()) {
      let parent = dirname(file);
      while (inside(config.root, parent) && parent !== config.root && !selected.has(parent)) parent = dirname(parent);
      if (file !== config.root && selected.has(parent)) continue;
      roots.push(file);
    }
    const values = await context.identify([...roots, ...files.map(id => resolve(config.root, id))], config);
    roots.forEach((file, index) => common.push([slash(relative(config.root, file)), values[index]]));
    const units = {};
    files.forEach((id, index) => { units[id] = digest(JSON.stringify(values[roots.length + index])); });
    const custom = config.fingerprint ? await config.fingerprint() : null;
    if (config.fingerprint && typeof custom !== 'string') throw new TypeError('fingerprint must return a string');
    const implementation = await extraIdentity();
    return { common: digest(JSON.stringify([config.root, implementation, common, custom])), units };
  };
  snapshot.close = () => context.close();
  return snapshot;
}
