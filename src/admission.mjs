import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { detectResources, selectConcurrency } from './resources.mjs';

function pressureTime(resource) {
  try { return Number(readFileSync(`/proc/pressure/${resource}`, 'utf8').match(/^some .*total=(\d+)/m)?.[1]); }
  catch { return NaN; }
}

function cpuTimes() {
  const processors = cpus();
  let total = 0;
  let idle = 0;
  for (const { times } of processors) {
    total += Object.values(times).reduce((sum, value) => sum + value, 0);
    idle += times.idle;
  }
  return { total, idle, count: processors.length, pressure: pressureTime('cpu'), memoryPressure: pressureTime('memory'), time: performance.now() };
}

export function resourceSampler() {
  let previous = cpuTimes();
  return () => {
    const current = cpuTimes();
    const elapsed = current.time - previous.time;
    const total = current.total - previous.total;
    const value = {
      busyCpus: total > 0 ? current.count * (1 - (current.idle - previous.idle) / total) : NaN,
      pressure: elapsed > 0 ? (current.pressure - previous.pressure) / (elapsed * 1000) : NaN,
      memoryPressure: elapsed > 0 ? (current.memoryPressure - previous.memoryPressure) / (elapsed * 1000) : NaN,
      availableMemoryMiB: process.availableMemory() / 1024 ** 2,
    };
    previous = current;
    return value;
  };
}

// One run-local CPU weight. RAM reservations stay conservative; sampled free RAM
// cannot establish smaller per-worker peaks or guarantee protection from spikes.
export class Admission {
  constructor(policy, units, { host = detectResources(), sample = resourceSampler(), signal } = {}) {
    this.policy = policy;
    this.sample = sample;
    this.reading = sample();
    const available = this.reading.availableMemoryMiB;
    this.host = host;
    this.selected = selectConcurrency(policy, this.host);
    this.memory = policy.memoryMiBPerWorker ?? 256;
    this.reserve = policy.reserveMemoryMiB ?? 0;
    this.capacity = Math.max(1, Math.min(units, Math.floor(this.selected.memoryBudgetMiB / this.memory), policy.maxWorkers ?? Infinity));
    const initial = Math.max(1, Math.min(this.capacity, Math.floor(this.selected.cpuBudget / 2),
      Number.isFinite(available) ? Math.floor((available - this.reserve) / this.memory) : Infinity));
    this.weight = this.selected.cpuBudget / (initial + 1e-6);
    this.active = 0;
    this.peak = 0;
    this.spare = 0;
    this.pressured = 0;
    this.waiters = new Set();
    this.minimumMemory = Number.isFinite(available) ? available : Infinity;
    this.cpuSum = 0;
    this.samples = 0;
    this.signal = signal;
    this.abort = () => this.wake();
    signal?.addEventListener('abort', this.abort, { once: true });
  }

  wake() { for (const wake of this.waiters) wake(); }

  get limit() {
    return Math.min(this.capacity, selectConcurrency({ ...this.policy, cpusPerWorker: this.weight }, this.host).workers);
  }

  tick() {
    this.reading = this.sample();
    const { busyCpus, pressure, memoryPressure, availableMemoryMiB } = this.reading;
    if (Number.isFinite(availableMemoryMiB)) this.minimumMemory = Math.min(this.minimumMemory, availableMemoryMiB);
    if (this.active && Number.isFinite(busyCpus)) {
      this.cpuSum += busyCpus;
      this.samples++;
      const budget = this.selected.cpuBudget;
      const memoryFits = !Number.isFinite(availableMemoryMiB) || availableMemoryMiB >= this.reserve + this.memory;
      const spare = this.active >= this.limit && busyCpus < budget * 0.85 && !(pressure > 0.05) && !(memoryPressure > 0.05) && memoryFits;
      const pressured = !memoryFits || memoryPressure > 0.05 || busyCpus > budget + 0.2 || (pressure > 0.15 && busyCpus >= budget * 0.9);
      this.spare = spare ? this.spare + 1 : 0;
      this.pressured = pressured ? this.pressured + 1 : 0;
      let next = this.limit;
      if (this.spare >= 3 && next < this.capacity) next++;
      else if (this.pressured >= 3 && next > 1) next--;
      if (next !== this.limit) {
        this.weight = budget / (next + 1e-6);
        this.spare = this.pressured = 0;
      }
    } else this.spare = this.pressured = 0;
    this.wake();
  }

  async acquire() {
    this.timer ??= setInterval(() => this.tick(), 1000);
    while (true) {
      this.signal?.throwIfAborted();
      if (this.closed) throw new Error('Resource admission stopped');
      const available = this.reading.availableMemoryMiB;
      const fits = this.selected.memoryBudgetMiB >= this.memory && (!Number.isFinite(available) || available >= this.reserve + this.memory);
      const pressured = this.reading.memoryPressure > 0.05;
      if (this.active < this.limit && fits && !pressured) {
        this.active++;
        this.peak = Math.max(this.peak, this.active);
        this.blockedSince = undefined;
        return;
      }
      if (!this.active && (!fits || pressured)) {
        this.blockedSince ??= performance.now();
        if (performance.now() - this.blockedSince >= 30000) throw new Error(`Insufficient memory headroom or sustained memory pressure for a ${this.memory} MiB test worker after 30 seconds`);
      }
      await new Promise(resolve => {
        const wake = () => { this.waiters.delete(wake); resolve(); };
        this.waiters.add(wake);
      });
    }
  }

  release() {
    this.active--;
    this.wake();
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.signal?.removeEventListener('abort', this.abort);
    this.wake();
  }

  report(logger, suite) {
    if (!this.peak) return;
    const cpu = this.samples ? `${(100 * this.cpuSum / this.samples / this.host.cpus).toFixed(0)}% CPU capacity used` : 'CPU not yet sampled';
    const memory = Number.isFinite(this.minimumMemory) ? `${Math.floor(this.minimumMemory)} MiB minimum available RAM` : 'RAM unavailable';
    logger?.log(`${suite}: peak ${this.peak} workers, ${cpu}, ${memory}; effective CPU weight ${this.weight.toFixed(2)}`);
  }
}
