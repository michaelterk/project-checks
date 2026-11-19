import { createPermits } from './permits.mjs';
import { createVerificationPool } from './verification-pool.mjs';

// Command admission and terminal file completion have separate lifetimes.
export function createFileQueue(plans, admission, signal, { workers = 1, verificationConcurrency, readyFirst = false, prioritizeSuites = false } = {}) {
  const dispatch = new AbortController();
  const dispatchSignal = AbortSignal.any([signal, dispatch.signal]);
  const commands = admission ? null : createPermits(workers, dispatchSignal);
  const verification = createVerificationPool(signal, verificationConcurrency);
  const groups = new Map(plans.map(({ id }) => [id, {
    id, enabled: false, done: Promise.withResolvers(),
    jobs: [], queuedSeconds: 0, active: 0, stopped: false,
  }]));
  function addJobs(id, jobs) {
    const group = groups.get(id);
    for (const run of jobs) {
      group.jobs.push({ group, run });
      group.queuedSeconds += run.priority ?? 0;
    }
  }
  for (const { id, jobs } of plans) addJobs(id, jobs);
  const active = new Set();
  let pumping;
  for (const group of groups.values()) group.done.promise.catch(() => {});
  function next(fitsMemory) {
    let first, best, bestSeconds = -1;
    for (const group of groups.values()) {
      if (!group.jobs.length || !group.enabled || group.stopped || (readyFirst && !group.ready)) continue;
      const head = group.jobs[0];
      first ??= head;
      const job = fitsMemory ? group.jobs.find(job => fitsMemory(job.run.memoryMiB ?? admission.memory)) : head;
      if (!job) continue;
      if (!prioritizeSuites) return job;
      // Even with every worker, the backlog needs at least one longest file
      // and the known command-seconds divided across those workers.
      const seconds = head.run.priority > 0
        ? Math.max(head.run.priority, group.queuedSeconds / (admission?.limit ?? workers)) : 0;
      if (seconds > bestSeconds || (seconds === 0 && bestSeconds === 0 && group.jobs.length > best.group.jobs.length)) {
        best = job;
        bestSeconds = seconds;
      }
    }
    return best ?? first;
  }
  function settle(group) {
    if ((!group.sealed && !group.stopped) || group.jobs.length || group.active) return;
    if (group.error) group.done.reject(group.error);
    else group.done.resolve();
  }
  function stop(group, error) {
    if (group.stopped) return;
    group.stopped = true;
    group.error ??= error;
    if (error) group.onError?.(error);
    group.jobs.length = 0;
    settle(group);
  }
  const abort = () => { for (const group of groups.values()) stop(group, signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  function kick() {
    if (readyFirst && pumping) admission?.wake();
    if (pumping || dispatchSignal.aborted) return;
    pumping = pump().finally(() => {
      pumping = undefined;
      if (next()?.group.ready && !dispatchSignal.aborted) kick();
    });
  }
  async function pump() {
    try {
      while (true) {
        // An earlier dependency-ready suite keeps its place during fixture setup.
        // Stop dispatching while setup is pending. Readiness changes restart the
        // pump so a newly ready earlier dependency can take its original place.
        let candidate = next();
        if (!candidate?.group.ready) return;
        dispatchSignal.throwIfAborted();
        const releaseCredit = await verification.reserve();
        let releaseCommand;
        try {
          if (admission) {
            if (readyFirst) {
              candidate = await admission.acquire({ signal: dispatchSignal, selectFile: next });
              if (!candidate) { releaseCredit(); continue; }
            } else await admission.acquire({ signal: dispatchSignal, memoryMiB: candidate.run.memoryMiB });
            let released = false;
            releaseCommand = () => {
              if (released) return;
              released = true;
              admission.release({ memoryMiB: candidate.run.memoryMiB });
            };
          } else {
            releaseCommand = await commands.acquire();
            if (readyFirst) candidate = next();
          }
        } catch (error) { releaseCredit(); throw error; }
        const job = readyFirst ? candidate : next();
        if (!job || job !== candidate || !job.group.ready || job.group.stopped || dispatchSignal.aborted) {
          releaseCommand();
          releaseCredit();
          dispatchSignal.throwIfAborted();
          continue;
        }
        job.group.jobs.splice(job.group.jobs.indexOf(job), 1);
        job.group.queuedSeconds -= job.run.priority ?? 0;
        if (prioritizeSuites) {
          groups.delete(job.group.id);
          groups.set(job.group.id, job.group);
        }
        job.group.active++;
        const running = Promise.resolve().then(() => job.run({
          releaseExecution: releaseCommand,
          verify: operation => verification.run(operation),
        })).catch(error => stop(job.group, error)).finally(() => {
          releaseCommand();
          releaseCredit();
          job.group.active--;
          active.delete(running);
          settle(job.group);
          kick();
        });
        active.add(running);
      }
    } catch (error) { for (const group of groups.values()) stop(group, error); }
  }
  return {
    addJobs,
    offer(id, run, onError) {
      const group = groups.get(id);
      if (group.stopped) throw group.error ?? new Error('File queue stopped');
      group.onError ??= onError;
      const job = { group, run };
      const ahead = group.jobs.findIndex(({ run: other }) => other.priority < run.priority
        || (other.priority === run.priority && other.fileIndex > run.fileIndex));
      if (ahead < 0) group.jobs.push(job);
      else group.jobs.splice(ahead, 0, job);
      group.queuedSeconds += run.priority ?? 0;
      group.enabled = group.ready = true;
      kick();
    },
    enable(id) { groups.get(id).enabled = true; kick(); },
    run(id) {
      const group = groups.get(id);
      group.ready = group.sealed = true;
      settle(group);
      kick();
      return group.done.promise;
    },
    skip(id, error) { const group = groups.get(id); stop(group, error); kick(); return group.done.promise; },
    async close() {
      signal.removeEventListener('abort', abort);
      // A failed group may leave the pump waiting to admit an unclaimed file.
      dispatch.abort(new DOMException('File queue closed', 'AbortError'));
      await pumping;
      await Promise.all(active);
      verification.close();
      commands?.close();
    },
  };
}
