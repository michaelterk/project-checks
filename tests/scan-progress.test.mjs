import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { runCachedUnits, scanCacheJobs } from '../src/cache.mjs';
import { temporary } from './helpers.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('scan progress reports actual active workers, completed jobs, and stops after drain', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const holds = Array.from({ length: 3 }, () => Promise.withResolvers());
  const lines = [], logger = { log: line => lines.push(line) };
  const running = scanCacheJobs(holds.map(hold => () => hold.promise), {}, 2, { logger, suite: 'fixture' });
  t.after(async () => { holds.forEach(hold => hold.resolve()); await running; });
  await flush();
  assert.deepEqual(lines, ['CACHE_SCAN_PROGRESS: fixture | 0 out of 3 scanned | Workers: 2']);
  holds[0].resolve();
  await flush();
  t.mock.timers.tick(1000);
  assert.equal(lines.at(-1), 'CACHE_SCAN_PROGRESS: fixture | 1 out of 3 scanned | Workers: 2');
  holds[1].resolve();
  await flush();
  t.mock.timers.tick(1000);
  assert.equal(lines.at(-1), 'CACHE_SCAN_PROGRESS: fixture | 2 out of 3 scanned | Workers: 1');
  holds[2].resolve();
  await running;
  assert.equal(lines.at(-1), 'CACHE_SCAN_PROGRESS: fixture | 3 out of 3 scanned | Workers: 0');
  const count = lines.length;
  t.mock.timers.tick(5000);
  assert.equal(lines.length, count, 'completed scans leave no progress timer behind');
});

test('a failed scan reports incomplete progress after every active job drains', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const release = Promise.withResolvers();
  const failure = new Error('scan failed');
  const lines = [];
  const running = scanCacheJobs([
    () => { throw failure; }, () => release.promise, () => 0,
  ], {}, 2, { logger: { log: line => lines.push(line) }, suite: 'broken' });
  const rejected = assert.rejects(running, error => error === failure);
  t.after(async () => { release.resolve(); await rejected; });
  await flush();
  t.mock.timers.tick(1000);
  assert.equal(lines.at(-1), 'CACHE_SCAN_PROGRESS: broken | 1 out of 3 scanned | Workers: 1');
  release.resolve();
  await rejected;
  assert.equal(lines.at(-1), 'CACHE_SCAN_PROGRESS: broken | 2 out of 3 scanned | Workers: 0');
  const count = lines.length;
  t.mock.timers.tick(5000);
  assert.equal(lines.length, count);
});

test('standalone failed scans exclude untouched queued units from progress', async t => {
  const cacheDirectory = await temporary(t);
  const original = fs.readFile;
  const failure = new Error('cannot read cache');
  let reads = 0;
  t.mock.method(fs, 'readFile', (file, ...args) => {
    if (typeof file === 'string' && file.startsWith(`${cacheDirectory}/`)) {
      reads++;
      throw failure;
    }
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const ids = ['first', 'second', 'third'], lines = [];
  await assert.rejects(runCachedUnits({
    cacheDirectory, scanConcurrency: 1, suite: 'broken',
    logger: { log: line => lines.push(line), error: line => lines.push(line) },
    units: ids.map(id => ({ id, identity: 'fixture' })),
    snapshot: () => ({ common: 'same', units: Object.fromEntries(ids.map(id => [id, 'same'])) }),
    execute: () => { throw Error('failed scans cannot execute tests'); },
  }), error => error === failure);
  assert.equal(reads, 1);
  assert.equal(lines.filter(line => line.startsWith('CACHE_SCAN_PROGRESS:')).at(-1),
    'CACHE_SCAN_PROGRESS: broken | 0 out of 3 scanned | Workers: 0');
});
