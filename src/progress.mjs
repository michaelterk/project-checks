import { text } from './util.mjs';

// Replace outcomes on retry so attempts never inflate the file totals.
export function createProgress({ logger = console, suites } = {}) {
  if (logger && typeof logger.log !== 'function') throw new TypeError('progress logger must provide log');
  if (suites !== undefined) {
    if (!Array.isArray(suites) || new Set(suites).size !== suites.length) throw new TypeError('progress suites must be unique IDs');
    suites.forEach(suite => text(suite, 'progress suite'));
  }
  const started = performance.now();
  const totals = new Map();
  const files = new Map();
  let lastPrinted = -Infinity;
  let closed = false;
  const output = message => logger && logger.log(`\n${message}`);
  function counts() {
    const values = [...files.values()];
    const count = state => values.filter(value => value === state).length;
    const success = count('success'), cached = count('cached');
    const failed = count('failed'), timedOut = count('timed-out');
    return { success, cached, failed, timedOut, running: count('running'), queued: count('queued'), validating: count('validating'),
      finished: success + cached + failed + timedOut, run: values.filter(value => !['cached', 'queued', 'cancelled'].includes(value)).length };
  }
  function report(force = false) {
    if (closed || !totals.size || suites?.some(suite => !totals.has(suite))) return;
    const now = performance.now();
    if (!force && now - lastPrinted < 1000) return;
    lastPrinted = now;
    const value = counts();
    const total = [...totals.values()].reduce((sum, count) => sum + count, 0);
    output(`TEST_PROGRESS: ${value.finished} out of ${total} test files finished | Skipped because cache: ${value.cached} | Failed: ${value.failed} | Timed out: ${value.timedOut} | Queued: ${value.queued} | Running: ${value.running} | Validating: ${value.validating}`);
  }
  // Append ordinary lines in redirected logs; never repaint the terminal.
  const timer = logger ? setInterval(() => report(true), 5000) : undefined;
  return {
    files(suite, total) {
      if (closed) return;
      if (totals.get(suite) === total) return;
      totals.set(suite, total);
      if (total === 0) for (const key of files.keys()) if (key.startsWith(`${suite}\0`)) files.delete(key);
      report(true);
    },
    file(suite, file, event, fields = {}) {
      if (closed) return;
      const key = `${suite}\0${file}`;
      if (event === 'file-queued') files.set(key, 'queued');
      else if (event === 'file-cancelled') files.set(key, 'cancelled');
      else if (event === 'file-validating') files.set(key, 'validating');
      else if (event === 'file-start') files.set(key, 'running');
      else if (event === 'cache-hit') files.set(key, 'cached');
      else if (event === 'file-end') files.set(key,
        fields.timedOut ? 'timed-out' : fields.status === 0 ? 'success'
          : Number.isInteger(fields.status) ? 'failed' : 'interrupted');
      report(event === 'file-end' && fields.status !== 0);
    },
    close(exitCode) {
      if (closed) return;
      clearInterval(timer);
      report(true);
      closed = true;
      const value = counts();
      const outcome = exitCode === 0 ? 'PASS' : exitCode === 130 ? 'INTERRUPTED' : 'FAIL';
      output(`TEST_SUMMARY: Tests run: ${value.run} | Success: ${value.success} | Skipped because cache: ${value.cached} | Failed: ${value.failed} | Timed out: ${value.timedOut} | Duration: ${((performance.now() - started) / 1000).toFixed(2)}s | ${outcome}`);
    },
  };
}

export async function withProgress(options, execute) {
  const shared = options.progress ?? options.diagnostics?.progress;
  const progress = shared ?? createProgress({ logger: options.logger === false ? null : options.logger, suites: [options.suite ?? 'tests'] });
  let exitCode = 2;
  try {
    const result = await execute(progress);
    exitCode = result.exitCode;
    return result;
  } catch (error) {
    if (options.signal?.aborted || error.name === 'AbortError') exitCode = 130;
    throw error;
  } finally { if (shared === undefined) progress.close(exitCode); }
}
