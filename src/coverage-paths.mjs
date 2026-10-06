import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { digest, inside, slash } from './util.mjs';
import { profileStage } from './scan-profile.mjs';

// Coverage paths describe where measurements belong; they never enter cache keys.
export async function rewriteCoveragePaths(bytes, provider, mapPath) {
  if (provider === 'python') {
    const { DatabaseSync } = await import('node:sqlite');
    const directory = await mkdtemp(join(tmpdir(), 'project-checks-coverage-'));
    let database, failed = false;
    try {
      const file = join(directory, 'data');
      await writeFile(file, bytes, { mode: 0o600 });
      database = new DatabaseSync(file);
      if (database.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Invalid Python coverage');
      const rows = database.prepare('SELECT id,path FROM file').all();
      const update = database.prepare('UPDATE file SET path = ? WHERE id = ?');
      database.exec('BEGIN');
      try {
        for (const row of rows) update.run(await mapPath(row.path), row.id);
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch { /* Preserve the mapping/update failure. */ }
        throw error;
      }
      database.close(); database = undefined;
      return await readFile(file);
    } catch (error) { failed = true; throw error; }
    finally {
      let cleanupError;
      try { database?.close(); } catch (error) { cleanupError = error; }
      try { await rm(directory, { recursive: true, force: true }); } catch (error) { cleanupError ??= error; }
      if (!failed && cleanupError) throw cleanupError;
    }
  }
  const reports = readV8Reports(bytes);
  await mapV8CoveragePaths(reports, mapPath);
  return gzipSync(JSON.stringify(reports));
}

export function readV8Reports(bytes) {
  const reports = JSON.parse(gunzipSync(bytes));
  if (!Array.isArray(reports) || !reports.length || !reports.every(report => Array.isArray(report.result))) throw new Error('Invalid V8 coverage contribution');
  return reports;
}

// Shared traversal keeps validation, public restoration and aggregation aligned.
export async function mapV8CoveragePaths(reports, mapPath) {
  const mapURL = async value => {
    if (value.startsWith('file:')) return mapPath(fileURLToPath(value));
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) return value;
    return mapPath(value);
  };
  for (const report of reports) {
    if (!Array.isArray(report.result)) throw new Error('Invalid V8 coverage contribution');
    for (const item of report.result) item.url = await mapURL(item.url);
    if (report['source-map-cache']) {
      const maps = {};
      for (const [url, entry] of Object.entries(report['source-map-cache'])) {
        if (entry.data?.sources) entry.data.sources = await Promise.all(entry.data.sources.map(mapURL));
        if (entry.url?.startsWith('file:')) entry.url = await mapURL(entry.url);
        maps[await mapURL(url)] = entry;
      }
      report['source-map-cache'] = maps;
    }
  }
  return reports;
}

const sourceHash = (file, context) => context?.sourceHash ? context.sourceHash(file) : profileStage('coverage-source-read', () => readFile(file).then(digest).catch(error => {
  if (error.code === 'ENOENT') return null; // V8 can include synthetic eval scripts.
  throw error;
}), { file });

export async function normalizeCoverageArtifact(bytes, { provider, sourceRoot, root = sourceRoot, context }) {
  const sources = {};
  bytes = await rewriteCoveragePaths(bytes, provider, async name => {
    const source = resolve(sourceRoot, name);
    if (!inside(sourceRoot, source)) throw new Error('Covered source escapes its project root');
    const path = slash(relative(sourceRoot, source));
    const hash = await sourceHash(source, context);
    if (root !== sourceRoot && hash !== await sourceHash(resolve(root, path), context)) throw new Error(`Covered source differs: ${path}`);
    sources[path] = hash;
    return path;
  });
  return { bytes, sources };
}

export async function validateCoverageSources({ root, sources, context }) {
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) throw new Error('Missing coverage source metadata');
  const entries = Object.entries(sources);
  let next = 0, failure;
  // Bound work per artifact; sourceHash still shares the invocation's I/O queue.
  // Stop taking new sources on failure and drain every active check before exit.
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
    try {
      while (!failure && next < entries.length) {
        const [path, hash] = entries[next++];
        if (isAbsolute(path) || !inside(root, resolve(root, path)) || await sourceHash(resolve(root, path), context) !== hash) throw new Error(`Covered source changed: ${path}`);
      }
    } catch (error) { failure ??= { error }; }
  }));
  if (failure) throw failure.error;
}

export async function validatePortablePythonArtifact(file, options) {
  await validateCoverageSources(options);
  const { DatabaseSync } = await import('node:sqlite');
  let database, failed = false;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    if (database.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Invalid Python coverage');
    for (const row of database.prepare('SELECT id,path FROM file').all()) {
      if (typeof row.path !== 'string' || !Object.hasOwn(options.sources, row.path)) throw new Error(`Unbound coverage source: ${row.path}`);
    }
  } catch (error) { failed = true; throw error; }
  finally {
    try { database?.close(); } catch (error) { if (!failed) throw error; }
  }
}

export async function validatePortableV8Artifact(bytes, options) {
  await validateCoverageSources(options);
  const reports = readV8Reports(bytes);
  await mapV8CoveragePaths(reports, path => {
    if (!Object.hasOwn(options.sources, path)) throw new Error('Unbound coverage source');
    return path;
  });
}

export async function restoreCoverageArtifact(bytes, { provider, root, sources, context }) {
  await validateCoverageSources({ root, sources, context });
  return profileStage('coverage-path-rewrite', () => rewriteCoveragePaths(bytes, provider, path => {
    if (!Object.hasOwn(sources, path)) throw new Error('Unbound coverage source');
    const file = resolve(root, path);
    return provider === 'python' ? file : pathToFileURL(file).href;
  }));
}
