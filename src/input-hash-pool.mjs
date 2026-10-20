import { integer } from './util.mjs';
import { Worker } from 'node:worker_threads';
import { resourceSampler } from './admission.mjs';
import { defaultResources, detectResources, selectConcurrency } from './resources.mjs';
import { profileContentRead, profileFilesystemCall, profileHashTransport, profileQueue } from './scan-profile.mjs';

const deserialize = value => {
  const { cause, ...fields } = value;
  return Object.assign(new Error(value.message, cause ? { cause: deserialize(cause) } : undefined), fields);
};
const workerMemoryMiB = 32;
const batchSize = 16;

// Files, directory enumeration and other metadata work share this admission.
// One worker owns one entry through stat/read/hash; aggregation owns no slot.
export function createHashPool({ workers, resources = {}, host = detectResources(), sample = resourceSampler(),
  createWorker = options => new Worker(new URL('./input-hash-worker.mjs', import.meta.url), options) }) {
  integer(workers, 'Input scanner workers');
  const selected = selectConcurrency(resources, host);
  const cpuBudget = Math.min(selected.cpuBudget, host.cpus * (resources.cpuQuotaPercent ?? defaultResources.cpuQuotaPercent) / 100);
  const reserve = resources.reserveMemoryMiB ?? defaultResources.reserveMemoryMiB;
  // More reader threads than the requested startup count or CPU budget mostly
  // add isolate startup and scheduling cost; batches amortize the waiting I/O.
  const maximum = Math.max(1, Math.min(Math.floor(selected.memoryBudgetMiB / workerMemoryMiB),
    Math.max(workers, Math.ceil(cpuBudget))));
  const cancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const flag = new Int32Array(cancellation), queue = [], slots = new Set(), terminations = new Set();
  const ended = Promise.withResolvers(), profile = profileQueue('input-filesystem-queue', Math.min(workers, maximum));
  let reading = sample();
  const headroom = Number.isFinite(reading.availableMemoryMiB) ? Math.max(1, Math.floor((reading.availableMemoryMiB - reserve) / workerMemoryMiB)) : maximum;
  let limit = Math.min(workers, maximum, headroom), active = 0, sequence = 0, closed = false, reason, timer;
  profile?.resize(limit);
  const report = () => profile?.state(active, queue.length);
  function retire(slot) {
    if (!slots.delete(slot)) return;
    slot.retiring = true;
    const stopping = Promise.resolve().then(() => slot.worker.terminate());
    terminations.add(stopping);
    stopping.then(() => terminations.delete(stopping), error => { terminations.delete(stopping); ended.reject(error); });
    return stopping;
  }
  function trim() {
    for (const slot of slots) if (!slot.jobs && (closed || slots.size > limit)) retire(slot);
  }
  function finish() {
    if (!closed || active) return;
    clearInterval(timer); timer = undefined;
    trim(); profile?.state(0, 0); profile?.close();
    Promise.all([...terminations]).then(() => ended.resolve(), ended.reject);
  }
  function settled(job, error, message) {
    if (message?.metrics?.opened) profileContentRead(job.file, message.metrics.bytes, 'worker');
    if (message?.metrics?.initialStat) profileFilesystemCall('lstat', job.file, () => {}, 'identify-entry');
    if (message?.metrics?.postStat) profileFilesystemCall('lstat', job.file, () => {}, 'hash-post-read');
    if (closed) job.reject(reason);
    else if (error) job.reject(error);
    else job.resolve(message ? message.hash : undefined);
  }
  function complete(slot, jobs, error, messages) {
    if (slot) { slot.jobs = undefined; slot.worker.unref?.(); }
    if (!jobs[0].borrowed) active--;
    jobs.forEach((job, index) => {
      const message = messages?.[index];
      settled(job, error ?? (message?.error ? deserialize(message.error) : undefined), message);
    });
    trim(); report();
    if (closed) finish(); else dispatch();
  }
  function fatal(slot, error) {
    close(error);
    if (slot.jobs) complete(slot, slot.jobs, error);
    else { retire(slot); finish(); }
  }
  function spawn() {
    const worker = createWorker({ workerData: { cancellation }, execArgv: [], name: 'project-checks-input-scanner' });
    const slot = { worker, jobs: undefined, retiring: false };
    slots.add(slot);
    worker.on('message', message => {
      if (!slot.jobs || !Array.isArray(message.results) || message.results.length !== slot.jobs.length || message.done !== true
        || message.results.some((result, index) => result?.id !== slot.jobs[index].id)) {
        fatal(slot, new Error('Invalid input scanner worker response')); return;
      }
      profileHashTransport('responses', message.results.length);
      complete(slot, slot.jobs, undefined, message.results);
    });
    worker.on('error', error => fatal(slot, error));
    worker.on('exit', code => { if (!slot.retiring) fatal(slot, new Error(`Input scanner worker exited before closing (code ${code})`)); });
    return slot;
  }
  function dispatch() {
    while (!closed && queue.length && active < limit) {
      const job = queue.shift();
      active++; profile?.admit(job.queuedAt, active, queue.length);
      if (job.operation) {
        Promise.resolve().then(job.operation).then(value => {
          active--; closed ? job.reject(reason) : job.resolve(value); trim(); report();
          if (closed) finish(); else dispatch();
        }, error => complete(undefined, [job], error));
        continue;
      }
      // Batch only waiting leaf jobs; operations retain their queue position and
      // admission. Each worker still opens at most one file at a time.
      const jobs = [job];
      while (jobs.length < batchSize && queue.length && !queue[0].operation) jobs.push(queue.shift());
      let slot = [...slots].find(slot => !slot.jobs);
      try {
        slot ??= spawn(); slot.worker.ref?.(); slot.jobs = jobs;
        profileHashTransport('batches', jobs.length);
        slot.worker.postMessage({ jobs: jobs.map(({ id, file, identity, inspect, cached }) => ({ id, file, identity, inspect, cached })) });
      } catch (error) {
        if (slot) fatal(slot, error);
        else { close(error); complete(undefined, jobs, error); }
      }
    }
    if (!active && !queue.length) { clearInterval(timer); timer = undefined; }
    report();
  }
  // A leaf that already owns admission can hand its byte read to a worker
  // without queueing a second admission while it waits for that same work.
  function ownedHash(file, identity) {
    if (closed) return Promise.reject(reason);
    return new Promise((resolve, reject) => {
      const job = { id: ++sequence, file, identity, borrowed: true, resolve, reject };
      let slot;
      try {
        slot = [...slots].find(slot => !slot.jobs) ?? spawn();
        slot.worker.ref?.(); slot.jobs = [job];
        profileHashTransport('batches', 1);
        slot.worker.postMessage({ jobs: [{ id: job.id, file, identity }] });
      } catch (error) {
        if (slot) fatal(slot, error);
        else { close(error); reject(error); }
      }
    });
  }
  function tick() {
    reading = sample();
    const memoryFits = !Number.isFinite(reading.availableMemoryMiB) || reading.availableMemoryMiB >= reserve + workerMemoryMiB;
    const pressured = !memoryFits || reading.memoryPressure > 0.05 || reading.pressure > 0.05 || reading.ioPressure > 0.05
      || Number.isFinite(reading.busyCpus) && reading.busyCpus >= cpuBudget;
    if (pressured) limit = Math.max(1, limit - 8);
    else if (queue.length && active >= limit && Number.isFinite(reading.busyCpus) && Number.isFinite(reading.availableMemoryMiB)) {
      // A reduced pool can recover even when adding all eight would overshoot.
      const increment = Math.min(8, Math.max(0, Math.floor(active * (cpuBudget / Math.max(reading.busyCpus, 1e-6) - 1))));
      limit = Math.min(maximum, limit + increment, Math.max(1, Math.floor((reading.availableMemoryMiB - reserve) / workerMemoryMiB)));
    }
    profile?.resize(limit); trim(); dispatch();
  }
  function request(fields) {
    if (closed) return Promise.reject(reason);
    return new Promise((resolve, reject) => {
      const queuedAt = profile?.state(active, queue.length + 1);
      queue.push({ ...fields, id: ++sequence, resolve, reject, queuedAt });
      if (!timer) { reading = sample(); timer = setInterval(tick, 1000); }
      dispatch();
    });
  }
  function close(error = new Error('Input scanner pool closed')) {
    if (!closed) {
      closed = true; reason = error; clearInterval(timer); timer = undefined;
      Atomics.store(flag, 0, 1);
      queue.splice(0).forEach(job => job.reject(reason)); report();
    }
    finish(); return ended.promise;
  }
  return { hash: (file, identity) => request({ file, identity }), inspect: (file, cached) => request({ file, inspect: true, cached }),
    run: operation => request({ operation }), runWithWorker: operation => request({ operation: () => operation(ownedHash) }), state: () => ({ active, waiting: queue.length, limit }), close };
}
