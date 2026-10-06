import { createHashPool } from './input-hash-pool.mjs';
import { inputMetadata } from './input-hash-sync.mjs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { glob, open, lstat as fsLstat, readdir as fsReaddir, readlink as fsReadlink, realpath as fsRealpath } from 'node:fs/promises';
import { dirname, join, matchesGlob, relative, resolve } from 'node:path';
import { digest, inside, inputLimit, slash, text } from './util.mjs';
import { defineConfig, defaultDirectoryIgnore } from './config.mjs';
import { profileContentRead, profileFilesystemCall, profileQueue, profileStage, profileSync } from './scan-profile.mjs';
import defaultConfig from '../project-checks.config.json' with { type: 'json' };
const compareFingerprintEntries = new Intl.Collator('en').compare;
const lstat = (file, options, site = 'other') => profileFilesystemCall('lstat', file, () => fsLstat(file, options), site);
const readdir = (...args) => profileFilesystemCall('readdir', args[0], () => fsReaddir(...args));
const readlink = (...args) => profileFilesystemCall('readlink', args[0], () => fsReadlink(...args));
const realpath = (...args) => profileFilesystemCall('realpath', args[0], () => fsRealpath(...args));

// Generic folder rules do not prune an explicitly selected dependency/output
// subtree. Disposable file rules still apply within that explicit subtree.
function directoryExclusions(config, root, cache) {
  const { directories = [], files = [] } = config.directoryIgnore ?? defaultDirectoryIgnore;
  const ancestors = [];
  for (let file = root; inside(config.root, file); file = dirname(file)) {
    ancestors.push(slash(relative(config.root, file)));
    if (file === config.root) break;
  }
  const explicit = ancestors.some(id => directories.some(pattern => matchesGlob(id, pattern)));
  const patterns = explicit ? [...files] : [...directories, ...files];
  const key = JSON.stringify([config.root, patterns]);
  let values = cache?.get(key);
  if (!values) { values = new Map(); cache?.set(key, values); }
  return file => {
    if (values.has(file)) return values.get(file);
    const id = slash(relative(config.root, file));
    const excluded = patterns.some(pattern => matchesGlob(id, pattern));
    values.set(file, excluded);
    return excluded;
  };
}

// One queue bounds leaf work. Visitors enqueue children without awaiting them.
export function createSnapshotContext({ signal, inputConcurrency = defaultConfig.inputConcurrency } = {}) {
  inputLimit(inputConcurrency);
  const queueProfile = profileQueue('input-filesystem-queue', inputConcurrency);
  const waiting = [];
  const idle = [];
  const digests = new Map();
  const exclusions = new Map();
  const directoryRoots = new Map(), directoryDecisions = new Map();
  let active = 0;
  let closed = false;
  let closeReason;
  let sourceScan, scanProjections, scanRecords, scanInventories, scanLeaves;
  let hashPool, scanWorkerCount = 0, closing;
  const acceptedSources = new Map();
  function drain() {
    while (active < inputConcurrency && waiting.length) {
      const { operation, resolve, reject, queuedAt } = waiting.shift();
      active++;
      queueProfile?.admit(queuedAt, active, waiting.length);
      Promise.resolve().then(operation).then(
        value => closed ? reject(closeReason) : resolve(value),
        error => reject(closed ? closeReason : error),
      ).finally(() => {
        active--;
        queueProfile?.state(active, waiting.length);
        drain();
        if (closed && !active) {
          queueProfile?.close();
          idle.splice(0).forEach(resolve => resolve());
        }
      });
    }
  }
  const run = operation => new Promise((resolve, reject) => {
    if (closed) { reject(closeReason); return; }
    const queuedAt = queueProfile?.state(active, waiting.length + 1);
    waiting.push({ operation, resolve, reject, queuedAt });
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
  function directoryExcluded(config, root) {
    const key = JSON.stringify([config.root, config.directoryIgnore ?? defaultDirectoryIgnore]);
    let roots = directoryRoots.get(key);
    if (!roots) directoryRoots.set(key, roots = new Map());
    if (!roots.has(root)) roots.set(root, directoryExclusions(config, root, directoryDecisions));
    return roots.get(root);
  }
  const metadata = inputMetadata;
  function fileIdentity(file, info, source = false) {
    const leaf = scanLeaves?.get(file);
    if (leaf) return leaf.then(value => value.kind === 'file' && value.identity === metadata(info) ? value.hash : hashIdentity(file, info, source));
    return hashIdentity(file, info, source);
  }
  function hashIdentity(file, info, source = false) {
    const identity = metadata(info);
    const existing = digests.get(file);
    if (existing?.identity === identity) return existing.hash;
    const entry = { identity };
    const read = async () => {
      if (scanWorkerCount) {
        hashPool ??= createHashPool({ workers: scanWorkerCount });
        return profileStage('input-worker-hash', () => hashPool.hash(file, identity), { file });
      }
      const hash = createHash('sha256');
      let bytes = 0;
      if (info.size > 0n && info.size <= 65536n) {
        const buffer = Buffer.allocUnsafe(Number(info.size));
        const handle = await open(file, 'r');
        let failed = false;
        try {
          while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            bytes += bytesRead;
            hash.update(buffer.subarray(0, bytesRead));
          }
        } catch (error) { failed = true; throw error; }
        finally {
          profileContentRead(file, bytes, 'buffered');
          try { await handle.close(); } catch (error) { if (!failed) throw error; }
        }
      } else {
        try { for await (const chunk of createReadStream(file)) { bytes += chunk.length; hash.update(chunk); } }
        finally { profileContentRead(file, bytes); }
      }
      // Read through EOF even when reported size is smaller than readable data.
      // Virtual regular files can report zero; they retain the streaming reader.
      if (metadata(await lstat(file, { bigint: true }, 'hash-post-read')) !== identity) throw new Error(`Input changed while hashing: ${file}`);
      return hash.digest('hex');
    };
    entry.hash = (source ? profileStage('coverage-source-read', read, { file }) : read()).catch(error => {
      if (digests.get(file) === entry) digests.delete(file);
      throw error;
    });
    digests.set(file, entry);
    return entry.hash;
  }
  function inspectLeaf(file) {
    const memo = scanLeaves;
    if (!memo.has(file)) {
      // Capture the preceding owner before publishing this promise. Later
      // fileIdentity callers await us; this ordering cannot create a cycle.
      const preceding = digests.get(file);
      let operation;
      operation = (async () => {
        const cached = preceding ? { identity: preceding.identity, hash: await preceding.hash } : undefined;
        if (closed) throw closeReason;
        hashPool ??= createHashPool({ workers: scanWorkerCount });
        const value = await profileStage('input-worker-inspection', () => hashPool.inspect(file, cached), { file });
        if (value.kind === 'file' && digests.get(file) === preceding) digests.set(file, { identity: value.identity, hash: Promise.resolve(value.hash) });
        return value;
      })().catch(error => {
        if (memo.get(file) === operation) memo.delete(file);
        throw error;
      });
      memo.set(file, operation);
    }
    return memo.get(file);
  }
  // Recheck metadata on every use, sharing the same verified bytes/digest as inputs.
  const freshSourceHash = file => profileStage('coverage-source-check', () => run(async () => {
    try {
      const canonical = await realpath(file);
      const info = await lstat(canonical, { bigint: true }, 'coverage-source');
      if (!info.isFile()) throw new TypeError(`Covered source must be a regular file: ${file}`);
      return await fileIdentity(canonical, info, true);
    } catch (error) {
      if (error.code === 'ENOENT') return null; // V8 synthetic eval scripts.
      throw error;
    }
  }), { file });
  const sourceHash = file => {
    if (!sourceScan) return freshSourceHash(file);
    if (!sourceScan.has(file)) {
      const scan = sourceScan;
      const operation = freshSourceHash(file).catch(error => {
        if (scan.get(file) === operation) scan.delete(file);
        throw error;
      });
      scan.set(file, operation);
    }
    return sourceScan.get(file);
  };
  function beginScanGeneration({ hashWorkers = 0 } = {}) {
    if (sourceScan || hashPool) throw new Error('Input scan generation already active');
    scanWorkerCount = Math.min(inputConcurrency, hashWorkers);
    sourceScan = new Map();
    scanProjections = new Map();
    scanRecords = new WeakMap();
    scanInventories = new Map();
    scanLeaves = new Map();
    acceptedSources.clear();
  }
  function acceptSourceProof(root, sources) {
    if (!sourceScan) return;
    for (const [path, hash] of Object.entries(sources)) acceptedSources.set(resolve(root, path), hash);
  }
  function discoverInventory(config) {
    if (!scanInventories) return run(() => discoverTests(config));
    const memo = scanInventories;
    const key = JSON.stringify([config.root, config.testDirectory, config.pattern, config.ignore]);
    if (!memo.has(key)) {
      const operation = run(() => discoverTests(config)).catch(error => {
        if (memo.get(key) === operation) memo.delete(key);
        throw error;
      });
      memo.set(key, operation);
    }
    return memo.get(key);
  }
  function projectionMemo(config, excludedFiles) {
    if (!scanProjections) return new Map();
    // A complete selected-root traversal owns its symlink/cycle context. Only
    // identical projections may share that root; descendant trees are not reused.
    const key = JSON.stringify([config.root, config.cacheDirectory, config.ignore,
      config.directoryIgnore ?? defaultDirectoryIgnore, Boolean(config.allowMissing),
      Boolean(config.regularFilesOnly), config.fixtureCacheDirectory ?? null, [...excludedFiles].sort()]);
    if (!scanProjections.has(key)) scanProjections.set(key, new Map());
    return scanProjections.get(key);
  }
  function cancelScanGeneration(reason) {
    sourceScan = scanProjections = scanRecords = scanInventories = scanLeaves = undefined;
    scanWorkerCount = 0;
    acceptedSources.clear();
    return hashPool?.close(reason);
  }
  async function finishScanGeneration() {
    // Disable memoization before the independent freshness gate; every accepted
    // path is checked, including synthetic missing sources and symlink targets.
    sourceScan = scanProjections = scanRecords = scanInventories = scanLeaves = undefined;
    const proofs = [...acceptedSources];
    acceptedSources.clear();
    scanWorkerCount = 0;
    await hashPool?.close();
    hashPool = undefined;
    const settled = await profileStage('coverage-source-acceptance', () => Promise.allSettled(proofs.map(async ([file, expected]) => {
      if (await freshSourceHash(file) !== expected) throw new Error(`Covered source changed during cache scan: ${file}`);
    })));
    const failure = settled.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  function identify(files, config, excludedFiles = new Set()) {
    const exclude = excluded(config);
    return new Promise((resolveIdentities, reject) => {
      const values = new Array(files.length);
      let remaining = 0;
      const failures = [];
      function enqueue(file, ancestors, assign, directoryExcluded, regularHint = false) {
        remaining++;
        run(async () => {
          if (failures.length) return;
          let info;
          try {
            if (regularHint && scanWorkerCount && !config.regularFilesOnly) {
              const value = await inspectLeaf(file);
              if (value.kind === 'file') { assign(['file', value.hash]); return; }
            }
            info = await lstat(file, { bigint: true }, config.regularFilesOnly ? 'artifact-proof' : 'identify-entry');
          }
          catch (error) {
            if (error.code === 'ENOENT' && config.allowMissing && !config.regularFilesOnly) { assign(['missing']); return; }
            throw error;
          }
          if (config.regularFilesOnly && !info.isFile()) throw new TypeError(`Artifact must be a regular file: ${file}`);
          if (info.isSymbolicLink()) {
            const readlinkTarget = await readlink(file);
            const target = await realpath(file).catch(error => {
              if (error.code === 'ENOENT' && config.allowMissing) return resolve(dirname(file), readlinkTarget);
              throw error;
            });
            const value = ['symlink', readlinkTarget, null];
            assign(value);
            if (ancestors.has(target)) value[2] = ['cycle', target];
            else enqueue(target, ancestors, identity => { value[2] = identity; }, directoryExcluded);
          } else if (info.isFile()) {
            assign(['file', await fileIdentity(file, info)]);
          } else if (info.isDirectory()) {
            const canonical = await realpath(file);
            if (config.fixtureCacheDirectory && (inside(config.cacheDirectory, file) || inside(config.fixtureCacheDirectory, canonical))) {
              throw new Error(`Fixture directory must stay outside cacheDirectory: ${file}`);
            }
            if (ancestors.has(canonical)) { assign(['cycle', canonical]); return; }
            const nested = new Set(ancestors).add(canonical);
            const children = (await readdir(file, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
              .map(entry => ({ file: join(file, entry.name), regular: entry.isFile(), value: [entry.name, null] }))
              .filter(entry => !exclude(entry.file) && !directoryExcluded(entry.file) && !excludedFiles.has(entry.file));
            assign(['directory', children.map(entry => entry.value)]);
            for (const entry of children) enqueue(entry.file, nested, identity => { entry.value[1] = identity; }, directoryExcluded, entry.regular);
          } else throw new Error(`Unsupported input type: ${file}`);
        }).catch(error => { if (!failures.length) failures.push(error); }).finally(() => {
          if (!--remaining) failures.length ? reject(failures[0]) : resolveIdentities(values);
        });
      }
      files.forEach((file, index) => enqueue(file, new Set(), identity => { values[index] = identity; }, directoryExcluded(config, file)));
      if (!remaining) resolveIdentities(values);
    });
  }
  const close = (reason = new Error('Input context closed')) => {
    if (closing) return closing;
    if (!closed) closeReason = reason;
    closed = true;
    const hashing = cancelScanGeneration(closeReason);
    waiting.splice(0).forEach(({ reject }) => reject(closeReason));
    queueProfile?.state(active, 0);
    if (!active) queueProfile?.close();
    signal?.removeEventListener('abort', abort);
    const draining = active ? new Promise(resolve => idle.push(resolve)) : Promise.resolve();
    closing = Promise.all([draining, hashing]).then(() => {});
    return closing;
  };
  const abort = () => { void close(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return { run, excluded, directoryExcluded, identify, discoverInventory, projectionMemo, fingerprintRecords: () => scanRecords ?? new WeakMap(), sourceHash, beginScanGeneration, acceptSourceProof, cancelScanGeneration, finishScanGeneration, digests, exclusions, close };
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

export function selectTests(config, inventory) {
  if (config.select) inventory = inventory.filter(typeof config.select === 'function' ? config.select : id =>
    (config.select.include ?? ['**']).some(pattern => matchesGlob(id, pattern)) &&
    !(config.select.exclude ?? []).some(pattern => matchesGlob(id, pattern)));
  if (!config.files) return inventory;
  for (const id of config.files) if (!inventory.includes(id)) throw new Error(`Selected file is not in the configured test inventory: ${id}`);
  const selected = new Set(config.files);
  return inventory.filter(id => selected.has(id));
}

// Flatten trees before hashing: names, paths, type labels and traversal order
// never enter validity. Multiplicity preserves added/removed identical files.
function fingerprint(identities, memo) {
  const records = identity => {
    if (memo.has(identity)) return memo.get(identity);
    let value;
    if (identity[0] === 'file') {
      const hash = identity[1];
      value = { entries: [JSON.stringify([true, hash])], canonical: typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) };
    } else if (identity[0] === 'missing') value = { entries: ['[false,null]'], canonical: true };
    else if (identity[0] === 'directory') {
      value = { entries: ['[true,null]'], canonical: true };
      for (const [, child] of identity[1]) {
        const nested = records(child);
        value.canonical &&= nested.canonical;
        for (const entry of nested.entries) value.entries.push(entry);
      }
    } else if (identity[0] === 'symlink') value = records(identity[2]);
    else if (identity[0] === 'cycle') value = { entries: ['[true,null]'], canonical: true };
    else throw new TypeError('Unknown file identity');
    memo.set(identity, value);
    return value;
  };
  const entries = [];
  let canonical = true;
  for (const identity of identities) {
    const value = records(identity);
    canonical &&= value.canonical;
    for (const entry of value.entries) entries.push(entry);
  }
  // Lowercase hexadecimal digests and these two fixed markers have the same
  // English collation and code-unit order. General public inputs keep collation.
  profileSync('fingerprint-sort', () => entries.sort(canonical ? undefined : compareFingerprintEntries), { entries: entries.length });
  return digest(`[${entries.join(',')}]`);
}

export function contentFingerprint(identities) {
  return fingerprint(identities, new WeakMap());
}

// Every snapshot still discovers paths and rechecks metadata, including cache hits.
export function createSnapshot(config, context = createSnapshotContext()) {
  async function selectPaths(inputPatterns, excludedFiles) {
    const excluded = context.excluded(config);
    const selected = new Set();
    // Node's glob does not emit the cwd itself for '.'. Select that tree
    // explicitly so default input tracking includes every project file.
    const patterns = inputPatterns.filter(pattern => {
      if (resolve(config.root, pattern) !== config.root) return true;
      if (!excluded(config.root)) selected.add(config.root);
      return false;
    });
    const globPatterns = patterns.filter(pattern => /[*?{}()[\]\\!+@]/.test(pattern));
    if (globPatterns.length) await context.run(async () => {
      for await (const name of glob(globPatterns, { cwd: config.root, exclude: config.ignore })) {
        const file = resolve(config.root, name);
        if (!inside(config.root, file)) throw new Error(`Input must stay inside the project root: ${name}`);
        if (!excluded(file) && (!excludedFiles.has(file) || inputPatterns.includes(slash(relative(config.root, file))))) selected.add(file);
      }
    });
    // Literal paths already name their root; missing literals remain bound.
    for (const pattern of patterns) {
      if (/[*?{}()[\]\\!+@]/.test(pattern)) continue;
      const file = resolve(config.root, pattern);
      if (!inside(config.root, file)) throw new Error(`Input must stay inside the project root: ${pattern}`);
      if (excluded(file)) continue;
      if (excludedFiles.has(file)) {
        // Match glob's explicit runnable-test exception and existence behavior.
        if (!inputPatterns.includes(slash(relative(config.root, file)))) continue;
        const exists = await context.run(() => lstat(file).then(() => true, error => {
          if (error.code === 'ENOENT') return false;
          throw error;
        }));
        if (!exists) continue;
      }
      selected.add(file);
    }
    // A selected directory already covers its descendants; hash each tree once.
    const roots = [];
    for (const file of [...selected].sort()) {
      let parent = dirname(file);
      while (inside(config.root, parent) && parent !== config.root && !selected.has(parent)) parent = dirname(parent);
      if (file !== config.root && selected.has(parent) && !excludedFiles.has(file)) {
        const excluded = context.directoryExcluded(config, parent);
        let current = file;
        while (current !== parent && !excluded(current)) current = dirname(current);
        if (current === parent) continue;
      }
      roots.push(file);
    }
    return roots;
  }
  // A generation shares path identities only until its queued files finish.
  // Later snapshots rediscover every path and recheck metadata.
  const prepare = async initialInventory => {
    const inventory = initialInventory ?? await context.discoverInventory(config);
    const files = selectTests(config, inventory);
    if (!files.length) throw new Error(`No test files found in ${config.testDirectory}`);
    const excludedFiles = new Set(config.excludeTestsFromInputs ? inventory.map(id => resolve(config.root, id)) : []);
    const roots = await selectPaths(config.inputs, excludedFiles);
    const inputOptions = { ...config, allowMissing: true };
    const values = context.projectionMemo(inputOptions, excludedFiles);
    const serialized = context.fingerprintRecords();
    const content = identities => fingerprint(identities, serialized);
    let common, fixtureProjection;
    const identify = async (paths, memo, options, excluded = new Set()) => {
      const settled = await Promise.allSettled(paths.map(file => {
        if (!memo.has(file)) memo.set(file, context.identify([file], options, excluded).then(([value]) => value));
        return memo.get(file);
      }));
      const failure = settled.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      return settled.map(result => result.value);
    };
    const snapshot = { common: '', units: {} };
    const unit = async id => {
      let stage = 'dependency discovery';
      try {
        config.signal?.throwIfAborted();
        const discoverInputs = async () => {
          const started = performance.now();
          const declared = await config.testInputs(id);
          config.diagnostics?.file(config.suite, id, 'dependency-discovery', {
            seconds: (performance.now() - started) / 1000, inputCount: declared?.length,
          });
          return declared;
        };
        const declaredInputs = typeof config.testInputs === 'function'
          ? await (config.diagnostics
            ? config.diagnostics.span(config.suite, 'per-file-dependency-discovery', discoverInputs, { file: id })
            : discoverInputs())
          : Object.entries(config.testInputs ?? {}).filter(([scope]) => scope === id || (scope.endsWith('/') && id.startsWith(scope))).flatMap(([, inputs]) => inputs);
        defineConfig({ testInputs: { [id]: declaredInputs } });
        const dependencies = [...new Set(await selectPaths(declaredInputs, excludedFiles))].sort();
        let fixtures = [];
        if (config.testFixtureInputs) {
          stage = 'fixture discovery';
          const declared = await config.testFixtureInputs(id);
          if (!Array.isArray(declared)) throw new TypeError('testFixtureInputs must return an array of literal paths');
          fixtures = [...new Set(declared.map(file => resolve(config.root, text(file, 'fixture input path'))))].sort();
        }
        config.signal?.throwIfAborted();
        stage = 'input fingerprint';
        common ??= identify(roots, values, inputOptions, excludedFiles).then(content);
        // Await together so all work drains before a failed unit releases its slot.
        const fingerprints = await Promise.allSettled([
          common,
          identify([resolve(config.root, id), ...dependencies], values, inputOptions, excludedFiles),
          (async () => {
            if (!fixtures.length) return [];
            fixtureProjection ??= (async () => {
              const fixtureCacheDirectory = await realpath(config.cacheDirectory).catch(error => {
                if (error.code === 'ENOENT') return config.cacheDirectory;
                throw error;
              });
              const options = { ...config, ignore: [], directoryIgnore: {}, fixtureCacheDirectory, allowMissing: true };
              return { options, memo: context.projectionMemo(options, new Set()) };
            })();
            const { options, memo } = await fixtureProjection;
            return identify(fixtures, memo, options);
          })(),
        ]);
        const failure = fingerprints.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
        snapshot.common = fingerprints[0].value;
        snapshot.units[id] = content([...fingerprints[1].value, ...fingerprints[2].value]);
        return fingerprints[1].value[0][1];
      } catch (error) {
        if (config.signal?.aborted) throw config.signal.reason;
        throw new Error(`${config.suite ?? 'tests'}/${id}: ${stage}: ${error.message}`, { cause: error });
      }
    };
    return { files, value: snapshot, unit };
  };
  const snapshot = async () => {
    const prepared = await prepare();
    const settled = await Promise.allSettled(prepared.files.map(prepared.unit));
    const failure = settled.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    return prepared.value;
  };
  snapshot.prepare = prepare;
  snapshot.close = () => context.close();
  return snapshot;
}
