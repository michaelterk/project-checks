const enabled = Boolean(process.env.PROJECT_CHECKS_SCAN_PROFILE);
const stages = new Map();
const queues = new Map();
const units = [];
const filesystemCalls = new Map();
const filesystemSites = new Map(), contentReads = new Map();
const epoch = performance.now();
const hashTransport = { batches: 0, files: 0, responses: 0, resultFiles: 0, maximumBatchSize: 0 };
export async function profileStage(stage, operation, fields = {}) {
  if (!enabled) return operation();
  let value = stages.get(stage);
  if (!value) stages.set(stage, value = { count: 0, milliseconds: 0, maximumMilliseconds: 0, active: 0, peakActive: 0, files: new Map(), slowest: [] });
  value.count++;
  value.active++;
  value.peakActive = Math.max(value.peakActive, value.active);
  if (fields.file) value.files.set(fields.file, (value.files.get(fields.file) ?? 0) + 1);
  const start = performance.now();
  try { return await operation(); }
  finally {
    const milliseconds = performance.now() - start;
    value.active--;
    value.lastFinishedMilliseconds = performance.now() - epoch;
    if (fields.bytes !== undefined) value.bytes = (value.bytes ?? 0) + fields.bytes;
    value.milliseconds += milliseconds;
    value.maximumMilliseconds = Math.max(value.maximumMilliseconds, milliseconds);
    value.slowest.push({ ...fields, milliseconds: Math.round(milliseconds) });
    value.slowest.sort((a, b) => b.milliseconds - a.milliseconds);
    value.slowest.length = Math.min(value.slowest.length, 3);
  }
}
export function profileSummary() {
  const summary = Object.fromEntries([...stages].map(([stage, { files, ...value }]) => [stage, {
    ...value, milliseconds: Math.round(value.milliseconds), maximumMilliseconds: Math.round(value.maximumMilliseconds),
    uniqueFiles: files.size, mostRepeated: [...files].sort((a, b) => b[1] - a[1]).slice(0, 3),
  }]));
  for (const [name, contexts] of queues) summary[name] = { contexts: contexts.map(queue => queue.summary()) };
  if (filesystemCalls.size) summary['input-filesystem-calls'] = Object.fromEntries([...filesystemCalls].map(([name, paths]) => [name, {
    calls: [...paths.values()].reduce((sum, count) => sum + count, 0), uniquePaths: paths.size,
    mostRepeated: [...paths].sort((a, b) => b[1] - a[1]).slice(0, 3),
  }]));
  if (filesystemSites.size) summary['input-filesystem-call-sites'] = Object.fromEntries(filesystemSites);
  if (contentReads.size) summary['input-content-reads'] = {
    reads: [...contentReads.values()].reduce((sum, value) => sum + value.reads, 0),
    streams: [...contentReads.values()].reduce((sum, value) => sum + value.streams, 0),
    bufferedReads: [...contentReads.values()].reduce((sum, value) => sum + value.bufferedReads, 0),
    workerReads: [...contentReads.values()].reduce((sum, value) => sum + value.workerReads, 0),
    bytes: [...contentReads.values()].reduce((sum, value) => sum + value.bytes, 0),
    uniquePaths: contentReads.size, largest: [...contentReads].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 3),
  };
  if (hashTransport.batches) summary['input-hash-transport'] = { ...hashTransport };
  if (units.length) {
    const distribution = values => {
      if (!values.length) return { count: 0, averageMilliseconds: 0, p50Milliseconds: 0, p95Milliseconds: 0, maximumMilliseconds: 0 };
      values.sort((a, b) => a - b);
      return { count: values.length, averageMilliseconds: values.reduce((sum, value) => sum + value, 0) / values.length,
        p50Milliseconds: values[Math.ceil(values.length * 0.50) - 1], p95Milliseconds: values[Math.ceil(values.length * 0.95) - 1], maximumMilliseconds: values.at(-1) };
    };
    const finished = units.filter(unit => unit.finishedMilliseconds !== undefined);
    summary['scan-file-units'] = { count: units.length,
      elapsed: distribution(finished.map(unit => unit.elapsedMilliseconds)),
      queueWait: distribution(finished.map(unit => unit.queueWaitMilliseconds)), records: units };
  }
  return summary;
}
export function profileSync(stage, operation, fields = {}) {
  if (!enabled) return operation();
  let value = stages.get(stage);
  if (!value) stages.set(stage, value = { count: 0, milliseconds: 0, maximumMilliseconds: 0, active: 0, peakActive: 0, files: new Map(), slowest: [] });
  value.count++;
  value.active++;
  value.peakActive = Math.max(value.peakActive, value.active);
  const start = performance.now();
  try { return operation(); }
  finally {
    const milliseconds = performance.now() - start;
    value.active--;
    value.lastFinishedMilliseconds = performance.now() - epoch;
    if (fields.bytes !== undefined) value.bytes = (value.bytes ?? 0) + fields.bytes;
    value.milliseconds += milliseconds;
    value.maximumMilliseconds = Math.max(value.maximumMilliseconds, milliseconds);
    value.slowest.push({ ...fields, milliseconds: Math.round(milliseconds) });
    value.slowest.sort((a, b) => b.milliseconds - a.milliseconds);
    value.slowest.length = Math.min(value.slowest.length, 3);
  }
}


// Occupancy follows admitted context tasks, including tasks awaiting a shared
// hash. This measures the package's queue, not operating-system disk activity.
export function profileQueue(name, capacity, now = () => performance.now()) {
  if (!enabled) return undefined;
  const started = now();
  let last = started, finished, active = 0, waiting = 0;
  let peakActive = 0, peakWaiting = 0, admittedTasks = 0;
  let busyMilliseconds = 0, atCapacityMilliseconds = 0, activeTaskMilliseconds = 0;
  let queueWaitMilliseconds = 0, maximumQueueWaitMilliseconds = 0;
  function account(time) {
    if (finished !== undefined) return;
    const elapsed = time - last;
    if (active) busyMilliseconds += elapsed;
    if (active === capacity) atCapacityMilliseconds += elapsed;
    activeTaskMilliseconds += active * elapsed;
    last = time;
  }
  function state(nextActive, nextWaiting, time = now()) {
    account(time);
    active = nextActive;
    waiting = nextWaiting;
    peakActive = Math.max(peakActive, active);
    peakWaiting = Math.max(peakWaiting, waiting);
    return time;
  }
  const queue = {
    state,
    admit(queuedAt, nextActive, nextWaiting) {
      const time = state(nextActive, nextWaiting);
      admittedTasks++;
      const wait = time - queuedAt;
      queueWaitMilliseconds += wait;
      maximumQueueWaitMilliseconds = Math.max(maximumQueueWaitMilliseconds, wait);
    },
    close() { if (finished === undefined) { account(now()); finished = last; } },
    summary() {
      account(now());
      const lifetimeMilliseconds = (finished ?? last) - started;
      const percent = (part, total) => total ? 100 * part / total : 0;
      return { capacity, active, waiting, peakActive, peakWaiting, admittedTasks,
        lifetimeMilliseconds, busyMilliseconds, atCapacityMilliseconds, activeTaskMilliseconds,
        atCapacityPercentOfLifetime: percent(atCapacityMilliseconds, lifetimeMilliseconds),
        atCapacityPercentOfBusy: percent(atCapacityMilliseconds, busyMilliseconds),
        averageActiveTasks: lifetimeMilliseconds ? activeTaskMilliseconds / lifetimeMilliseconds : 0,
        capacityUtilizationPercent: percent(activeTaskMilliseconds, lifetimeMilliseconds * capacity),
        queueWaitMilliseconds, maximumQueueWaitMilliseconds,
      };
    },
  };
  if (!queues.has(name)) queues.set(name, []);
  queues.get(name).push(queue);
  return queue;
}


export function profileScanUnit(operation) {
  if (!enabled || !operation.scanIdentity) return operation;
  const { suite, file } = operation.scanIdentity;
  const unit = { key: JSON.stringify([suite, file]), suite, file,
    queuedAt: new Date().toISOString(), queuedMilliseconds: performance.now() - epoch };
  units.push(unit);
  return async () => {
    unit.startedAt = new Date().toISOString();
    unit.startedMilliseconds = performance.now() - epoch;
    unit.queueWaitMilliseconds = unit.startedMilliseconds - unit.queuedMilliseconds;
    try { const value = await operation(); unit.status = 'completed'; return value; }
    catch (error) { unit.status = 'failed'; throw error; }
    finally {
      unit.finishedAt = new Date().toISOString();
      unit.finishedMilliseconds = performance.now() - epoch;
      unit.elapsedMilliseconds = unit.finishedMilliseconds - unit.startedMilliseconds;
    }
  };
}


export function profileFilesystemCall(name, path, operation, site) {
  if (enabled) {
    if (site) {
      const key = `${name}/${site}`;
      filesystemSites.set(key, (filesystemSites.get(key) ?? 0) + 1);
    }
    let paths = filesystemCalls.get(name);
    if (!paths) filesystemCalls.set(name, paths = new Map());
    paths.set(path, (paths.get(path) ?? 0) + 1);
  }
  return operation();
}

export function profileContentRead(file, bytes, kind = 'stream') {
  if (!enabled) return;
  const value = contentReads.get(file) ?? { reads: 0, streams: 0, bufferedReads: 0, workerReads: 0, bytes: 0 };
  value.reads++;
  if (kind === 'worker') value.workerReads++;
  else if (kind === 'buffered') value.bufferedReads++;
  else value.streams++;
  value.bytes += bytes;
  contentReads.set(file, value);
}

export async function profileJsonRead(read, fields) {
  if (!enabled) return JSON.parse(await read());
  const json = await profileStage('cache-record-read', async () => {
    const value = await read();
    fields.bytes = Buffer.byteLength(value);
    return value;
  }, fields);
  return profileSync('cache-record-parse', () => JSON.parse(json));
}

export function profileHashTransport(kind, files) {
  if (!enabled) return;
  hashTransport[kind]++;
  if (kind === 'batches') { hashTransport.files += files; hashTransport.maximumBatchSize = Math.max(hashTransport.maximumBatchSize, files); }
  else hashTransport.resultFiles += files;
}
