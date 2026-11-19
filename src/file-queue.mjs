import { createPermits } from './permits.mjs';
import { createVerificationPool } from './verification-pool.mjs';

// Command admission and terminal file completion have separate lifetimes.
export function createFileQueue(plans, admission, signal, { workers = 1, verificationConcurrency, readyFirst = false } = {}) {
  const dispatch = new AbortController();
  const dispatchSignal = AbortSignal.any([signal, dispatch.signal]);
  const commands = admission ? null : createPermits(workers, dispatchSignal);
  const verification = createVerificationPool(signal, verificationConcurrency);
  const groups = new Map(plans.map(({ id }) => [id, {
    enabled: false, done: Promise.withResolvers(),
    jobs: [], remaining: 0, active: 0, stopped: false,
  }]));
  function addJobs(id, jobs) {
    const group = groups.get(id);
    for (const run of jobs) group.jobs.push({ group, run });
    group.remaining += jobs.length;
  }
  for (const { id, jobs } of plans) addJobs(id, jobs);
  const active = new Set();
  let pumping;
  for (const group of groups.values()) group.done.promise.catch(() => {});
  function next(fitsMemory) {
    let first;
    for (const group of groups.values()) {
      if (!group.enabled || group.stopped || (readyFirst && !group.ready)) continue;
      for (const job of group.jobs) {
        if (job.claimed) continue;
        first ??= job;
        if (!fitsMemory || fitsMemory(job.run.memoryMiB ?? admission.memory)) return job;
      }
    }
    return first;
  }
  function settle(group) {
    if (group.remaining || group.active) return;
    if (group.error) group.done.reject(group.error);
    else group.done.resolve();
  }
  function stop(group, error) {
    group.stopped = true;
    group.error ??= error;
    group.remaining = 0;
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
      while (next()) {
        // An earlier dependency-ready suite keeps its place during fixture setup.
        // Stop dispatching while setup is pending. Readiness changes restart the
        // pump so a newly ready earlier dependency can take its original place.
        if (!next().group.ready) return;
        dispatchSignal.throwIfAborted();
        let candidate = next();
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
          } else releaseCommand = await commands.acquire();
        } catch (error) { releaseCredit(); throw error; }
        const job = readyFirst ? candidate : next();
        if (!job || job !== candidate || !job.group.ready || job.group.stopped || dispatchSignal.aborted) {
          releaseCommand();
          releaseCredit();
          dispatchSignal.throwIfAborted();
          continue;
        }
        job.claimed = true;
        job.group.remaining--;
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
    enable(id) { groups.get(id).enabled = true; kick(); },
    run(id) {
      const group = groups.get(id);
      group.ready = true;
      settle(group);
      kick();
      return group.done.promise;
    },
    skip(id, error) { stop(groups.get(id), error); kick(); },
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
