import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { digest, inside, slash } from './util.mjs';

// Coverage paths describe where measurements belong; they never enter cache keys.
export async function rewriteCoveragePaths(bytes, provider, mapPath) {
  if (provider === 'python') {
    const { DatabaseSync } = await import('node:sqlite');
    const directory = await mkdtemp(join(tmpdir(), 'project-checks-coverage-'));
    let database;
    try {
      const file = join(directory, 'data');
      await writeFile(file, bytes, { mode: 0o600 });
      database = new DatabaseSync(file);
      if (database.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Invalid Python coverage');
      for (const row of database.prepare('SELECT id,path FROM file').all()) {
        database.prepare('UPDATE file SET path = ? WHERE id = ?').run(await mapPath(row.path), row.id);
      }
      database.close(); database = undefined;
      return await readFile(file);
    } finally { database?.close(); await rm(directory, { recursive: true, force: true }); }
  }
  const reports = JSON.parse(gunzipSync(bytes));
  if (!Array.isArray(reports) || !reports.length) throw new Error('Invalid V8 coverage contribution');
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
  return gzipSync(JSON.stringify(reports));
}

const sourceHash = file => readFile(file).then(digest).catch(error => {
  if (error.code === 'ENOENT') return null; // V8 can include synthetic eval scripts.
  throw error;
});

export async function normalizeCoverageArtifact(bytes, { provider, sourceRoot, root = sourceRoot }) {
  const sources = {};
  bytes = await rewriteCoveragePaths(bytes, provider, async name => {
    const source = resolve(sourceRoot, name);
    if (!inside(sourceRoot, source)) throw new Error('Covered source escapes its project root');
    const path = slash(relative(sourceRoot, source));
    const hash = await sourceHash(source);
    if (root !== sourceRoot && hash !== await sourceHash(resolve(root, path))) throw new Error(`Covered source differs: ${path}`);
    sources[path] = hash;
    return path;
  });
  return { bytes, sources };
}

export async function restoreCoverageArtifact(bytes, { provider, root, sources }) {
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) throw new Error('Missing coverage source metadata');
  for (const [path, hash] of Object.entries(sources)) {
    if (isAbsolute(path) || !inside(root, resolve(root, path)) || await sourceHash(resolve(root, path)) !== hash) throw new Error(`Covered source changed: ${path}`);
  }
  return rewriteCoveragePaths(bytes, provider, path => {
    if (!Object.hasOwn(sources, path)) throw new Error('Unbound coverage source');
    const file = resolve(root, path);
    return provider === 'python' ? file : pathToFileURL(file).href;
  });
}
