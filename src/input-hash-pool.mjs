import { integer } from './util.mjs';
import { Worker } from 'node:worker_threads';
import { profileContentRead, profileFilesystemCall, profileHashTransport, profileQueue } from './scan-profile.mjs';

const deserialize = value => {
  const { cause, ...fields } = value;
  return Object.assign(new Error(value.message, cause ? { cause: deserialize(cause) } : undefined), fields);
};

export function scanHashWorkers(admission) {
  // Keep a coordinator CPU and honor existing CPU/quota/memory/resource limits.
  return Math.max(0, Math.min(4, Math.floor(admission.selected.cpuBudget - 1), admission.selected.workers));
}

export function createHashPool({ workers, createWorker = options => new Worker(new URL('./input-hash-worker.mjs', import.meta.url), options) }) {
  integer(workers, 'Input hash workers');
  const cancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const flag = new Int32Array(cancellation);
  const queue = [], slots = [];
  const ended = Promise.withResolvers();
  const profile = profileQueue('input-hash-worker-batches', workers);
  let sequence = 0, closed = false, reason, terminating = false;
  const active = () => slots.filter(slot => slot.jobs).length;
  function finish() {
    if (!closed || terminating || active()) return;
    terminating = true;
    profile?.state(0, 0);
    profile?.close();
    Promise.all(slots.map(slot => slot.worker.terminate())).then(() => ended.resolve(), ended.reject);
  }
  function settle(job, error, message) {
    if (message?.metrics?.opened) profileContentRead(job.file, message.metrics.bytes, 'worker');
    if (message?.metrics?.initialStat) profileFilesystemCall('lstat', job.file, () => {}, 'identify-entry');
    if (message?.metrics?.postStat) profileFilesystemCall('lstat', job.file, () => {}, 'hash-post-read');
    if (closed) job.reject(reason);
    else if (error) job.reject(error);
    else job.resolve(message.hash);
  }
  function fatal(slot, error) {
    // Stop dispatch first; one worker failure never silently retries a file.
    close(error);
    for (const job of slot.jobs?.values() ?? []) settle(job, error);
    slot.jobs = undefined;
    profile?.state(active(), queue.length);
    finish();
  }
  function spawn() {
    const worker = createWorker({ workerData: { cancellation }, execArgv: [], name: 'project-checks-input-hash' });
    const slot = { worker, jobs: undefined };
    slots.push(slot);
    worker.on('message', message => {
      // Validate the complete response before publishing any of its values.
      const seen = new Set();
      if (!slot.jobs || !Array.isArray(message.results) || typeof message.done !== 'boolean'
        || message.results.some(value => !value || !slot.jobs.has(value.id) || seen.has(value.id) || !seen.add(value.id))
        || (message.done && message.results.length !== slot.jobs.size)) {
        fatal(slot, new Error('Invalid input hash worker response')); return;
      }
      profileHashTransport('responses', message.results.length);
      for (const value of message.results) {
        const job = slot.jobs.get(value.id);
        slot.jobs.delete(value.id);
        settle(job, value.error ? deserialize(value.error) : undefined, value);
      }
      if (message.done) slot.jobs = undefined;
      profile?.state(active(), queue.length);
      if (closed) finish();
      else if (message.done) dispatch();
    });
    worker.on('error', error => fatal(slot, error));
    worker.on('exit', code => {
      if (!closed || slot.jobs) fatal(slot, new Error(`Input hash worker exited before closing (code ${code})`));
    });
    return slot;
  }
  function dispatch() {
    while (!closed && queue.length) {
      let slot = slots.find(slot => !slot.jobs);
      if (!slot && slots.length >= workers) return;
      if (!slot) {
        try { slot = spawn(); }
        catch (error) { close(error); return; }
      }
      const jobs = queue.splice(0, 8);
      slot.jobs = new Map(jobs.map(job => [job.id, job]));
      profile?.admit(jobs[0].queuedAt, active(), queue.length);
      profileHashTransport('batches', jobs.length);
      try { slot.worker.postMessage({ jobs: jobs.map(({ id, file, identity, inspect, cached }) => ({ id, file, identity, inspect, cached })) }); }
      catch (error) { fatal(slot, error); }
    }
  }
  function request(file, identity, inspect = false, cached) {
    if (closed) return Promise.reject(reason);
    return new Promise((resolve, reject) => {
      const queuedAt = profile?.state(active(), queue.length + 1);
      queue.push({ id: ++sequence, file, identity, inspect, cached, resolve, reject, queuedAt });
      dispatch();
    });
  }
  function close(error = new Error('Input hash pool closed')) {
    if (!closed) {
      closed = true;
      reason = error;
      Atomics.store(flag, 0, 1);
      queue.splice(0).forEach(job => job.reject(reason));
      profile?.state(active(), 0);
    }
    finish();
    return ended.promise;
  }
  return { hash: (file, identity) => request(file, identity), inspect: (file, cached) => request(file, undefined, true, cached), close };
}
