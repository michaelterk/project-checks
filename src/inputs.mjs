import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createHashPool } from './input-hash-pool.mjs';
import { inputMetadata } from './input-hash-sync.mjs';
import { directoryExclusions, inputExclusions } from './input-exclusions.mjs';
import { createLocalInputPool } from './input-local.mjs';
import { inputProcess, createProcessSnapshot } from './input-task.mjs';
import { glob, lstat as fsLstat, readdir as fsReaddir, readlink as fsReadlink, realpath as fsRealpath } from 'node:fs/promises';
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

// One queue bounds leaf work. Visitors enqueue children without awaiting them.
export function createSnapshotContext({ signal, inputConcurrency,
  scanConcurrency = defaultConfig.scanConcurrency, resources, local = false, digestCache } = {}) {
  if (inputConcurrency !== undefined) inputLimit(inputConcurrency);
  if (scanConcurrency !== undefined) inputLimit(scanConcurrency);
  const digests = digestCache ?? new Map(), exclusions = new Map();
  const directoryRoots = new Map(), directoryDecisions = new Map();
  let closed = false, closeReason, closing;
  let sourceScan, scanProjections, scanRecords, scanInventories, scanLeaves, scanDirectories, inputGeneration;
  const pool = local ? createLocalInputPool() : createHashPool({ workers: inputConcurrency ?? scanConcurrency, resources });
  const acceptedSources = new Map();
  const run = (operation, options) => pool.run(operation, options);
  const excluded = config => inputExclusions(config, exclusions);
  function directoryExcluded(config, root) {
    const key = JSON.stringify([config.root, config.directoryIgnore ?? defaultDirectoryIgnore]);
    let roots = directoryRoots.get(key);
    if (!roots) directoryRoots.set(key, roots = new Map());
    if (!roots.has(root)) roots.set(root, directoryExclusions(config, root, directoryDecisions));
    return roots.get(root);
  }
  function freshEntry(file) {
    return pool.runWithWorker(async hash => {
      const info = await lstat(file, { bigint: true }, 'identify-entry');
      if (!info.isFile()) return { kind: info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'other' };
      const identity = inputMetadata(info);
      let entry = digests.get(file);
      if (entry?.identity !== identity) {
        entry = { identity };
        entry.hash = hash(file, identity).catch(error => {
          if (digests.get(file) === entry) digests.delete(file);
          throw error;
        });
        digests.set(file, entry);
      }
      return { kind: 'file', identity, hash: await entry.hash };
    });
  }
  function inspectEntry(file, fresh = false) {
    const memo = fresh ? undefined : scanLeaves;
    if (!memo) return freshEntry(file);
    if (memo.has(file)) return memo.get(file);
    const preceding = digests.get(file);
    const operation = (async () => {
      const cached = preceding ? { identity: preceding.identity, hash: await preceding.hash } : undefined;
      if (closed) throw closeReason;
      const value = await profileStage('input-worker-inspection', () => pool.inspect(file, cached), { file });
      if (value.kind === 'file' && digests.get(file) === preceding) {
        if (!preceding || preceding.identity !== value.identity) digests.set(file, { identity: value.identity, hash: Promise.resolve(value.hash) });
      }
      return value;
    })().catch(error => {
      if (memo?.get(file) === operation) memo.delete(file);
      if (digests.get(file) === preceding) digests.delete(file);
      throw error;
    });
    memo?.set(file, operation);
    return operation;
  }
  // Resolve aliases afresh, then inspect/hash the canonical regular file in one job.
  const freshSourceHash = file => profileStage('coverage-source-check', async () => {
    try {
      const canonical = await run(() => realpath(file));
      const value = await inspectEntry(canonical);
      if (value.kind !== 'file') throw new TypeError(`Covered source must be a regular file: ${file}`);
      return value.hash;
    } catch (error) {
      if (error.code === 'ENOENT') return null; // V8 synthetic eval scripts.
      throw error;
    }
  }, { file });
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
  function beginScanGeneration() {
    if (sourceScan) throw new Error('Input scan generation already active');
    inputGeneration = randomUUID();
    sourceScan = new Map();
    scanProjections = new Map();
    scanRecords = new WeakMap();
    scanInventories = new Map();
    scanLeaves = new Map();
    scanDirectories = new Map();
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
    sourceScan = scanProjections = scanRecords = scanInventories = scanLeaves = scanDirectories = inputGeneration = undefined;
    acceptedSources.clear();
    return pool.close(reason);
  }
  async function finishScanGeneration() {
    // Disable memoization before the independent freshness gate; every accepted
    // path is checked, including synthetic missing sources and symlink targets.
    sourceScan = scanProjections = scanRecords = scanInventories = scanLeaves = scanDirectories = inputGeneration = undefined;
    const proofs = [...acceptedSources];
    acceptedSources.clear();

    const settled = await profileStage('coverage-source-acceptance', () => Promise.allSettled(proofs.map(async ([file, expected]) => {
      if (await freshSourceHash(file) !== expected) throw new Error(`Covered source changed during cache scan: ${file}`);
    })));
    const failure = settled.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  function identify(files, config, excludedFiles = new Set()) {
    const filterConfig = { root: config.root, cacheDirectory: config.cacheDirectory,
      ignore: [...config.ignore], directoryIgnore: config.directoryIgnore
        ? { directories: [...(config.directoryIgnore.directories ?? [])], files: [...(config.directoryIgnore.files ?? [])] } : undefined };
    const excludedPaths = [...excludedFiles];
    return new Promise((resolveIdentities, reject) => {
      const values = new Array(files.length);
      let remaining = 0;
      const failures = [];
      function enqueue(file, ancestors, assign, directoryRoot, logical = file) {
        remaining++;
        // A directory releases its scanner slot before it queues child jobs.
        // Aggregation stays on the coordinator and never waits inside admission.
        (async () => {
          if (failures.length) return;
          let value;
          try { value = await inspectEntry(file, Boolean(config.regularFilesOnly)); }
          catch (error) {
            if (error.code === 'ENOENT' && config.allowMissing && !config.regularFilesOnly) { assign(['missing']); return; }
            throw error;
          }
          if (config.regularFilesOnly && value.kind !== 'file') throw new TypeError(`Artifact must be a regular file: ${file}`);
          if (value.kind === 'file') { assign(['file', value.hash]); return; }
          if (value.kind === 'symlink') {
            const { readlinkTarget, target } = await run(async () => {
              const readlinkTarget = await readlink(file);
              const target = await realpath(file).catch(error => {
                if (error.code === 'ENOENT' && config.allowMissing) return resolve(dirname(file), readlinkTarget);
                throw error;
              });
              return { readlinkTarget, target };
            });
            const identity = ['symlink', readlinkTarget, null];
            assign(identity);
            if (ancestors.has(target)) identity[2] = ['cycle', target];
            else enqueue(target, ancestors, nested => { identity[2] = nested; }, directoryRoot, logical);
          } else if (value.kind === 'directory') {
            let discovery = scanDirectories?.get(file);
            if (!discovery) {
              discovery = run(async () => ({ canonical: await realpath(file),
                children: (await readdir(file, { withFileTypes: true })).map(entry => entry.name).sort() }));
              scanDirectories?.set(file, discovery);
              discovery.catch(() => { if (scanDirectories?.get(file) === discovery) scanDirectories.delete(file); });
            }
            const { canonical, children: names } = await discovery;
            if (config.fixtureCacheDirectory && (inside(config.cacheDirectory, file) || inside(config.fixtureCacheDirectory, canonical))) {
              throw new Error(`Fixture directory must stay outside cacheDirectory: ${file}`);
            }
            if (ancestors.has(canonical)) { assign(['cycle', canonical]); return; }
            const nested = new Set(ancestors).add(canonical);
            const kept = await pool.filterDirectory({ file, logical, names, root: directoryRoot,
              config: filterConfig, excludedFiles: excludedPaths });
            const children = kept.map(name => ({ file: join(file, name), logical: join(logical, name), value: [name, null] }));
            assign(['directory', children.map(entry => entry.value)]);
            for (const entry of children) enqueue(entry.file, nested, identity => { entry.value[1] = identity; }, directoryRoot, entry.logical);
          } else throw new Error(`Unsupported input type: ${file}`);
        })().catch(error => { if (!failures.length) failures.push(error); }).finally(() => {
          if (!--remaining) failures.length ? reject(failures[0]) : resolveIdentities(values);
        });
      }
      files.forEach((file, index) => enqueue(file, new Set(), identity => { values[index] = identity; }, file));
      if (!remaining) resolveIdentities(values);
    });
  }
  const close = (reason = new Error('Input context closed')) => {
    if (closing) return closing;
    if (!closed) closeReason = reason;
    closed = true;
    const hashing = cancelScanGeneration(closeReason);
    signal?.removeEventListener('abort', abort);
    closing = Promise.resolve(hashing).then(() => {});
    return closing;
  };
  const abort = () => { void close(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return { run, inputGeneration: () => inputGeneration, inputTask: pool.inputTask, scanState: pool.state, excluded, directoryExcluded, identify, discoverInventory, projectionMemo, fingerprintRecords: () => scanRecords ?? new WeakMap(), sourceHash, beginScanGeneration, acceptSourceProof, cancelScanGeneration, finishScanGeneration, digests, exclusions, close };
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
  const remote = config[inputProcess];
  if (remote && context.inputTask && remote.testInputs === config.testInputs && remote.inputProjection === config.inputProjection)
    return createProcessSnapshot(config, context, selectTests, createSnapshot);
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
  const prepare = async (initialInventory, { common: suppliedCommon } = {}) => {
    const inventory = initialInventory ?? await context.discoverInventory(config);
    const files = selectTests(config, inventory);
    if (!files.length) throw new Error(`No test files found in ${config.testDirectory}`);
    const excludedFiles = new Set(config.excludeTestsFromInputs ? inventory.map(id => resolve(config.root, id)) : []);
    const roots = suppliedCommon === undefined ? await selectPaths(config.inputs, excludedFiles) : [];
    const inputOptions = { ...config, allowMissing: true };
    const values = context.projectionMemo(inputOptions, excludedFiles);
    const serialized = context.fingerprintRecords();
    const content = identities => fingerprint(identities, serialized);
    let common = suppliedCommon === undefined ? undefined : Promise.resolve(suppliedCommon), fixtureProjection;
    const project = async (paths, identities, kind, id) => {
      if (!config.inputProjection) return content(identities);
      const value = await config.inputProjection(paths.map((path, index) => ({ path, identity: identities[index] })), { kind, id, signal: config.signal, generation: serialized, identify: paths => {
        const options = { ...inputOptions };
        return identify(paths.map(path => resolve(path)), context.projectionMemo(options, new Set()), options);
      } });
      config.signal?.throwIfAborted();
      const encoded = JSON.stringify(value);
      if (encoded === undefined || !isDeepStrictEqual(JSON.parse(encoded), value)) throw new TypeError('inputProjection must return plain JSON data');
      return digest(JSON.stringify(['project-checks-projection-v1', value]));
    };
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
    const getCommon = () => common ??= identify(roots, values, inputOptions, excludedFiles)
      .then(identities => project(roots, identities, 'common'));
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
        // Await together so all work drains before a failed unit releases its slot.
        const fingerprints = await Promise.allSettled([
          getCommon(),
          identify([resolve(config.root, id), ...dependencies], values, inputOptions, excludedFiles),
          (async () => {
            if (!fixtures.length) return [];
            fixtureProjection ??= (async () => {
              const fixtureCacheDirectory = await context.run(() => realpath(config.cacheDirectory)).catch(error => {
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
        snapshot.units[id] = await project([resolve(config.root, id), ...dependencies, ...fixtures],
          [...fingerprints[1].value, ...fingerprints[2].value], 'unit', id);
        return fingerprints[1].value[0][1];
      } catch (error) {
        if (config.signal?.aborted) throw config.signal.reason;
        throw new Error(`${config.suite ?? 'tests'}/${id}: ${stage}: ${error.message}`, { cause: error });
      }
    };
    return { files, value: snapshot, unit, common: getCommon };
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
