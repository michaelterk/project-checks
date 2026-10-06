import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PROJECT_CHECKS_SCAN_PROFILE = '1';
const { profileQueue, profileSummary } = await import('../src/scan-profile.mjs');
const { createSnapshotContext } = await import('../src/inputs.mjs');

test('queue metrics account exact occupancy intervals and admitted queue wait', () => {
  let time = 0;
  const queue = profileQueue('deterministic-queue', 2, () => time);
  const first = queue.state(0, 1);
  queue.admit(first, 1, 0);
  time = 2;
  const second = queue.state(1, 1);
  time = 4;
  queue.admit(second, 2, 0);
  time = 7;
  queue.state(1, 0);
  time = 10;
  queue.state(0, 0);
  queue.close();
  time = 100;
  assert.deepEqual(queue.summary(), {
    capacity: 2, active: 0, waiting: 0, peakActive: 2, peakWaiting: 1, admittedTasks: 2,
    lifetimeMilliseconds: 10, busyMilliseconds: 10, atCapacityMilliseconds: 3, activeTaskMilliseconds: 13,
    atCapacityPercentOfLifetime: 30, atCapacityPercentOfBusy: 30,
    averageActiveTasks: 1.3, capacityUtilizationPercent: 65,
    queueWaitMilliseconds: 2, maximumQueueWaitMilliseconds: 2,
  });
});

test('shared context records admitted tasks separately from queued requests', async () => {
  const context = createSnapshotContext({ inputConcurrency: 2 });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let active = 0, peak = 0;
  const operations = Array.from({ length: 5 }, () => context.run(async () => {
    peak = Math.max(peak, ++active);
    if (active === 2) entered.resolve();
    await release.promise;
    active--;
  }));
  try {
    await entered.promise;
    const pending = profileSummary()['input-filesystem-queue'].contexts.at(-1);
    assert.equal(pending.capacity, 2);
    assert.equal(pending.active, 2);
    assert.equal(pending.waiting, 3);
    assert.equal(pending.peakActive, 2);
    assert.equal(pending.peakWaiting, 3);
    assert.equal(pending.admittedTasks, 2);
  } finally { release.resolve(); }
  await Promise.all(operations);
  await context.close();
  const completed = profileSummary()['input-filesystem-queue'].contexts.at(-1);
  assert.equal(completed.active, 0);
  assert.equal(completed.waiting, 0);
  assert.equal(completed.admittedTasks, 5);
  assert.equal(peak, 2);
  assert.ok(completed.atCapacityMilliseconds <= completed.busyMilliseconds);
  assert.ok(completed.busyMilliseconds <= completed.lifetimeMilliseconds);
  assert.ok(completed.maximumQueueWaitMilliseconds <= completed.queueWaitMilliseconds);
});

test('disabled queue profiling neither samples time nor records contexts', async () => {
  const previous = process.env.PROJECT_CHECKS_SCAN_PROFILE;
  delete process.env.PROJECT_CHECKS_SCAN_PROFILE;
  try {
    const disabled = await import('../src/scan-profile.mjs?disabled-profile-test');
    assert.equal(disabled.profileQueue('disabled', 2, () => { throw new Error('must not sample time'); }), undefined);
    assert.deepEqual(disabled.profileSummary(), {});
  } finally { process.env.PROJECT_CHECKS_SCAN_PROFILE = previous; }
});

test('file unit timestamps cover actual worker execution and separate queue delay', async () => {
  const { profileScanUnit } = await import('../src/scan-profile.mjs');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const operation = Object.assign(async () => { entered.resolve(); await release.promise; }, {
    scanIdentity: { suite: 'timestamps', file: 'test/a.test.mjs' },
  });
  const run = profileScanUnit(operation);
  const queued = profileSummary()['scan-file-units'].records.at(-1);
  assert.equal(queued.startedAt, undefined);
  assert.ok(Number.isFinite(Date.parse(queued.queuedAt)));
  const running = run();
  await entered.promise;
  assert.equal(queued.finishedAt, undefined);
  release.resolve();
  await running;
  const summary = profileSummary()['scan-file-units'];
  assert.equal(queued.key, JSON.stringify(['timestamps', 'test/a.test.mjs']));
  assert.ok(queued.startedMilliseconds >= queued.queuedMilliseconds);
  assert.ok(queued.finishedMilliseconds >= queued.startedMilliseconds);
  assert.equal(queued.queueWaitMilliseconds, queued.startedMilliseconds - queued.queuedMilliseconds);
  assert.equal(queued.elapsedMilliseconds, queued.finishedMilliseconds - queued.startedMilliseconds);
  assert.ok(Number.isFinite(Date.parse(queued.finishedAt)));
  assert.equal(summary.elapsed.count, 1);
  assert.equal(summary.elapsed.p50Milliseconds, queued.elapsedMilliseconds);
  assert.equal(summary.elapsed.p95Milliseconds, queued.elapsedMilliseconds);
});


test('filesystem diagnostics distinguish call sites and count actual streamed bytes', async () => {
  const { profileFilesystemCall, profileContentRead } = await import('../src/scan-profile.mjs');
  assert.equal(profileFilesystemCall('fixture-stat', '/fixture/source', () => 42, 'fresh-proof'), 42);
  profileContentRead('/fixture/source', 12);
  profileContentRead('/fixture/source', 7);
  const summary = profileSummary();
  assert.equal(summary['input-filesystem-call-sites']['fixture-stat/fresh-proof'], 1);
  assert.deepEqual(summary['input-content-reads'], { reads: 2, streams: 2, bufferedReads: 0, workerReads: 0, bytes: 19, uniquePaths: 1, largest: [['/fixture/source', { reads: 2, streams: 2, bufferedReads: 0, workerReads: 0, bytes: 19 }]] });
});


test('cache record diagnostics distinguish asynchronous reading from synchronous parsing', async () => {
  const { profileJsonRead } = await import('../src/scan-profile.mjs');
  const json = '{"name":"á"}';
  assert.deepEqual(await profileJsonRead(async () => json, { file: 'fixture' }), { name: 'á' });
  const summary = profileSummary();
  assert.equal(summary['cache-record-read'].count, 1);
  assert.equal(summary['cache-record-read'].bytes, Buffer.byteLength(json));
  assert.equal(summary['cache-record-parse'].count, 1);
});
