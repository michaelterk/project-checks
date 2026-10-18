import { randomUUID } from 'node:crypto';

const finished = new Set(['passed', 'cached', 'failed', 'timed-out']);
export const failedFile = file => ['failed', 'timed-out'].includes(file.state);

// This observer never changes admission, evidence, or the invocation's exit code.
export function createDashboardState({ root, target, suites = [], now = Date.now } = {}) {
  const startedAt = now();
  const run = { version: 1, id: randomUUID(), pid: process.pid, root, target,
    startedAt, updatedAt: startedAt, endedAt: null, status: 'running', exitCode: null, error: null };
  const totals = new Map(suites.map(suite => [suite, null]));
  const files = new Map(), commands = new Map();
  let excluded = 0;
  let resources = null;
  function entry(suite, file) {
    const key = JSON.stringify([suite, file]);
    if (!files.has(key)) files.set(key, { suite, file, root, state: 'scanning', seconds: null,
      expectedSeconds: null, startedAt: null, endedAt: null, order: files.size });
    return files.get(key);
  }
  return {
    event(value) {
      if (run.endedAt !== null) return;
      const { event, suite, file } = value;
      run.updatedAt = now();
      if (event === 'inventory') for (const name of value.files) entry(suite, name).root = value.root;
      if (event === 'file-estimates') for (const item of value.files) entry(suite, item.file).expectedSeconds = item.seconds || null;
      if (event === 'file-order') value.files.forEach((name, index) => { entry(suite, name).order = index; });
      if (event === 'progress-files') totals.set(suite, value.total);
      if (event === 'progress-file') {
        if (value.kind === 'file-excluded') {
          if (files.delete(JSON.stringify([suite, file]))) {
            totals.set(suite, Math.max(0, (totals.get(suite) ?? 0) - 1)); excluded++;
          }
          return;
        }
        const item = entry(suite, file);
        const states = { 'file-queued': 'queued', 'file-start': 'running', 'file-validating': 'validating',
          'cache-hit': 'cached', 'file-cancelled': 'cancelled' };
        item.state = states[value.kind] ?? (value.timedOut ? 'timed-out' : value.status === 0 ? 'passed'
          : Number.isInteger(value.status) ? 'failed' : 'interrupted');
        if (value.kind === 'file-start') {
          item.startedAt = now(); item.endedAt = null; item.seconds = null;
        }
        if (finished.has(item.state) || ['cancelled', 'interrupted'].includes(item.state)) item.endedAt = now();
        if (Number.isInteger(value.status)) item.exitCode = value.status;
      }
      if (event === 'file-end') entry(suite, file).seconds = value.seconds;
      if (event === 'check-start') commands.set(suite, { suite, state: 'running', startedAt: now() });
      if (event === 'check-end') commands.set(suite, { ...commands.get(suite), suite,
        state: value.exitCode === 0 ? 'passed' : 'failed', exitCode: value.exitCode, endedAt: now() });
      if (event === 'sample') resources = { sampledAt: now(), cpuPercent: value.cpuPercent,
        cpuPressure: value.cpuPressure, cpuWindowSeconds: value.cpuWindowSeconds,
        cpuObservedSeconds: value.cpuObservedSeconds,
        availableMemoryMiB: value.availableMemoryMiB, processes: value.processCounts,
        workers: value.admission ? { active: value.admission.active, limit: value.admission.limit,
          capacity: value.admission.capacity } : null, stages: value.stages };
      if (event === 'run-error') run.error = value.message;
    },
    finish(exitCode) {
      if (run.endedAt !== null) return;
      run.endedAt = run.updatedAt = now();
      run.exitCode = exitCode;
      run.status = exitCode === 0 ? 'passed' : exitCode === 130 ? 'interrupted' : 'failed';
      if (run.status === 'failed' && !run.error && ![...files.values()].some(failedFile) && ![...commands.values()].some(command => command.state === 'failed'))
        run.error = `Invocation failed (exit ${exitCode}). Check the terminal output for setup, coverage or final validation errors.`;
      for (const item of files.values()) if (!finished.has(item.state)) {
        item.state = item.startedAt === null ? 'cancelled' : 'interrupted'; item.endedAt = now();
      }
      for (const item of commands.values()) if (item.state === 'running') item.state = 'interrupted';
    },
    snapshot() {
      const values = [...files.values()];
      const counts = Object.fromEntries(['scanning', 'queued', 'running', 'validating', 'passed', 'cached', 'failed', 'timed-out', 'cancelled', 'interrupted']
        .map(state => [state, values.filter(file => file.state === state).length]));
      counts.total = [...totals.values()].every(total => total !== null)
        ? [...totals.values()].reduce((a, b) => a + b, 0) : null;
      counts.finished = values.filter(file => finished.has(file.state)).length;
      counts.excluded = excluded;
      const elapsedSeconds = ((run.endedAt ?? now()) - startedAt) / 1000;
      const pending = values.filter(file => ['queued', 'running'].includes(file.state));
      const measured = values.filter(file => file.seconds > 0 && finished.has(file.state) && file.state !== 'cached');
      const fallback = measured.length ? measured.reduce((sum, file) => sum + file.seconds, 0) / measured.length : null;
      const durations = pending.map(file => {
        const expected = file.expectedSeconds ?? fallback;
        if (expected === null) return null;
        const elapsed = file.state === 'running' ? (now() - file.startedAt) / 1000 : 0;
        // An overdue file makes the estimate uncertain; never show zero while it runs.
        return Math.max(expected - elapsed, expected * 0.1, 1);
      });
      const workers = Math.max(1, resources?.workers?.limit ?? 1);
      const etaSeconds = run.endedAt !== null ? 0 : counts.total === null || counts.scanning || !pending.length || durations.includes(null)
        ? null : Math.max(...durations, durations.reduce((a, b) => a + b, 0) / workers);
      return structuredClone({ ...run, elapsedSeconds, etaSeconds, counts, resources,
        suites: [...totals.keys()], files: values, commands: [...commands.values()] });
    },
  };
}
