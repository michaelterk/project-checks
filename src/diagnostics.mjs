import { cpus } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resourceSampler } from './admission.mjs';
import { createProgress } from './progress.mjs';
import { createProcessSampler } from './process-sampler.mjs';

export function createDiagnostics(options = {}) {
  const logger = options.logger === false ? null : (options.logger ?? console);
  const progress = options.progress === false ? false : createProgress({ logger, suites: options.suites });
  const run = `${new Date().toISOString()}-${process.pid}-${randomUUID()}`;
  const suites = new Map();
  const stages = new Map();
  let admission;
  let sampleBoundary = () => {};

  function diagnostic(event, fields = {}) {
    logger?.log(
      '\nTEST_DIAGNOSTIC ' +
        JSON.stringify({ time: new Date().toISOString(), run, pid: process.pid, event, ...fields }),
    );
  }
  function diagnosticSuite(suite, total = 0) {
    sampleBoundary();
    suites.set(suite, {
      counts: { total, queued: total, running: 0, cached: 0, completed: 0, recheckingSnapshots: 0 },
      running: new Set(),
    });
    diagnostic('suite-start', { suite });
  }
  function diagnosticSuiteEnd(suite) {
    sampleBoundary();
    suites.delete(suite);
    diagnostic('suite-transition', { suite });
  }
  function diagnosticFiles(suite, total) {
    if (!suites.has(suite)) diagnosticSuite(suite);
    const { counts } = suites.get(suite);
    counts.total = counts.queued = total;
  }
  function diagnosticFile(suite, file, event, fields = {}) {
    if (!suites.has(suite)) diagnosticSuite(suite);
    const { counts, running } = suites.get(suite);
    if (event === 'file-start') {
      if (fields.retry) counts.completed--;
      else counts.queued--;
      running.add(file);
    }
    if (event === 'file-end') {
      running.delete(file);
      counts.completed++;
    }
    if (event === 'cache-hit') {
      counts.queued--;
      counts.cached++;
    }
    counts.running = running.size;
    diagnostic(event, { suite, file, ...fields, counts });
  }
  async function diagnosticSpan(suite, stage, operation, fields = {}) {
    if (stage === 'python-compilation') sampleBoundary();
    const start = performance.now();
    const key = JSON.stringify([suite, stage]);
    const value = stages.get(key) ?? { suite, stage, active: 0 };
    stages.set(key, value);
    value.active++;
    const counts = suites.get(suite)?.counts;
    if (stage === 'snapshot-recheck') counts.recheckingSnapshots++;
    diagnostic('span-start', { suite, stage, ...fields });
    try {
      return await operation();
    } finally {
      if (stage === 'python-compilation') sampleBoundary();
      if (!--value.active) stages.delete(key);
      if (stage === 'snapshot-recheck') counts.recheckingSnapshots--;
      diagnostic('span-end', { suite, stage, seconds: (performance.now() - start) / 1000, ...fields });
    }
  }

  function startDiagnostics() {
    const sample = options.sample ?? resourceSampler();
    const sampleProcesses = options.processSample ?? createProcessSampler();
    const cpuCount = options.cpuCount ?? cpus().length;
    const started = performance.now();
    let previous = started;
    const summaries = new Map();
    function tick() {
      const now = performance.now();
      const seconds = (now - previous) / 1000;
      previous = now;
      const reading = sample();
      const processCounts = sampleProcesses();
      const cpuPercent = (100 * reading.busyCpus) / cpuCount;
      const phase =
        [...suites.keys()].sort().join('+') ||
        ([...stages.values()].some((value) => value.stage === 'python-compilation') ? 'python-compilation' : 'setup');
      for (const name of ['whole-run', phase]) {
        const sum = summaries.get(name) ?? {
          seconds: 0,
          cpuSeconds: 0,
          observedSeconds: 0,
          secondsAtLeast80: 0,
          secondsBelow80: 0,
          processSamples: 0,
          peakProcesses: null,
          peakRunnableProcesses: null,
        };
        sum.seconds += seconds;
        if (processCounts !== null) {
          sum.processSamples++;
          sum.peakProcesses = Math.max(sum.peakProcesses ?? 0, processCounts.total);
          if (processCounts.runnable !== null) sum.peakRunnableProcesses = Math.max(sum.peakRunnableProcesses ?? 0, processCounts.runnable);
        }
        if (Number.isFinite(cpuPercent)) {
          sum.observedSeconds += seconds;
          sum.cpuSeconds += cpuPercent * seconds;
          sum[cpuPercent >= 80 ? 'secondsAtLeast80' : 'secondsBelow80'] += seconds;
        }
        summaries.set(name, sum);
      }
      diagnostic('sample', {
        elapsedSeconds: seconds,
        cpuPercent,
        cpuPressure: reading.pressure,
        memoryPressure: reading.memoryPressure,
        availableMemoryMiB: reading.availableMemoryMiB,
        processCounts,
        stages: [...stages.values()],
        suites: Object.fromEntries([...suites].map(([name, value]) => [name, value.counts])),
        runningFiles: [...suites].flatMap(([suite, value]) => [...value.running].map((file) => ({ suite, file }))),
        admission: admission?.inspect(),
      });
    }
    sampleBoundary = tick;
    diagnostic('run-start', { cpuCount });
    const timer = setInterval(tick, 1000);
    let closed = false;
    return (exitCode) => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      tick();
      sampleBoundary = () => {};
      for (const [phase, sum] of summaries) {
        diagnostic('summary', {
          phase,
          seconds: sum.seconds,
          observedSeconds: sum.observedSeconds,
          meanCpuPercent: sum.observedSeconds ? sum.cpuSeconds / sum.observedSeconds : null,
          secondsAtLeast80: sum.secondsAtLeast80,
          secondsBelow80: sum.secondsBelow80,
          processSamples: sum.processSamples,
          peakProcesses: sum.peakProcesses,
          peakRunnableProcesses: sum.peakRunnableProcesses,
        });
      }
      const whole = summaries.get('whole-run');
      if (progress) logger?.log(`\nPROCESS_SUMMARY: Peak OS processes: ${whole.peakProcesses ?? 'unavailable'} | Peak runnable processes: ${whole.peakRunnableProcesses ?? 'unavailable'} | Samples: ${whole.processSamples}`);
      diagnostic('run-end', { exitCode, seconds: (performance.now() - started) / 1000 });
      progress && progress.close(exitCode);
    };
  }

  const close = startDiagnostics();
  return {
    progress,
    event: diagnostic,
    suiteStart: diagnosticSuite,
    suiteEnd: diagnosticSuiteEnd,
    files: diagnosticFiles,
    file: diagnosticFile,
    span: diagnosticSpan,
    observeAdmission(value) {
      admission = value;
    },
    close,
  };
}
