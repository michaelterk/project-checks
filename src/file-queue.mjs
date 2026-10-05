// One invocation owns this queue. Jobs retain their suite's execution/evidence
// closures; only the dispatcher claims files and acquires normal worker slots.
export function createFileQueue(plans, admission, signal) {
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
  function kick() {
    if (pumping || signal.aborted) return;
    pumping = pump().finally(() => {
      pumping = undefined;
      if (next()?.group.ready && !signal.aborted) kick();
    });
  }
  async function pump() {
    try {
      while (next()) {
        // An earlier dependency-ready suite keeps its place during fixture setup.
        // Stop dispatching while setup is pending. Readiness changes restart the
        // pump so a newly ready earlier dependency can take its original place.
        if (!next().group.ready) return;
        signal.throwIfAborted();
        await admission.acquire({ signal });
        const job = next();
        if (!job || !job.group.ready || signal.aborted) {
          admission.release();
          signal.throwIfAborted();
          continue;
        }
        job.claimed = true;
        job.group.remaining--;
        job.group.active++;
        const running = Promise.resolve().then(job.run).catch(error => stop(job.group, error)).finally(() => {
          admission.release();
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
      await pumping;
      await Promise.all(active);
    },
  };
}
