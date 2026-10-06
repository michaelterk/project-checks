import { createPermits } from './permits.mjs';
import { createVerificationPool } from './verification-pool.mjs';

// Command admission and terminal file completion have separate lifetimes.
export function createFileQueue(plans, admission, signal, { workers = 1 } = {}) {
  const dispatch = new AbortController();
  const dispatchSignal = AbortSignal.any([signal, dispatch.signal]);
  const commands = admission ? null : createPermits(workers, dispatchSignal);
  const verification = createVerificationPool(admission?.capacity ?? workers, signal);
  const groups = new Map(plans.map(({ id, jobs }) => [id, {
    enabled: false, done: Promise.withResolvers(),
    remaining: jobs.length, active: 0, stopped: false,
  }]));
  const queue = plans.flatMap(({ id, jobs }) => jobs.map(run => ({ group: groups.get(id), run, claimed: false })));
  const active = new Set();
  let pumping;
  for (const group of groups.values()) group.done.promise.catch(() => {});
  const next = () => queue.find(job => !job.claimed && job.group.enabled && !job.group.stopped);
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
        const releaseCredit = await verification.reserve();
        let releaseCommand;
        try {
          if (admission) {
            await admission.acquire({ signal: dispatchSignal });
            let released = false;
            releaseCommand = () => {
              if (released) return;
              released = true;
              admission.release();
            };
          } else releaseCommand = await commands.acquire();
        } catch (error) { releaseCredit(); throw error; }
        const job = next();
        if (!job || !job.group.ready || dispatchSignal.aborted) {
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
