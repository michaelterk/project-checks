import assert from 'node:assert/strict';
import test from 'node:test';
import { detectResources, selectConcurrency } from '../src/index.mjs';

test('CPU, memory, reserves and caps independently bound worker counts', () => {
  const host = { cpus: 8, memoryMiB: 16384 };
  assert.equal(selectConcurrency({}, host).workers, 8);
  assert.equal(selectConcurrency({ memoryMiBPerWorker: 4096 }, host).workers, 4);
  assert.equal(selectConcurrency({ reserveCpus: 2 }, host).workers, 6);
  assert.equal(selectConcurrency({ reserveMemoryMiB: 4096, memoryMiBPerWorker: 4096 }, host).workers, 3);
  assert.equal(selectConcurrency({ maxWorkers: 2 }, host).workers, 2);
  assert.equal(selectConcurrency({ reserveCpus: 8, reserveMemoryMiB: 16384 }, host).workers, 1);
});

test('fractional CPU costs and nested shares use the original host budget', () => {
  const host = { cpus: 8, memoryMiB: 16384 };
  const policy = { cpuPercent: 400, cpusPerWorker: 0.5, reserveMemoryMiB: 2048, memoryMiBPerWorker: 384 };
  assert.equal(selectConcurrency(policy, host).workers, 37);
  assert.equal(selectConcurrency({ ...policy, divisor: 2 }, host).workers, 18);
  assert.equal(selectConcurrency({ ...policy, divisor: 4 }, host).workers, 9);
  assert.equal(selectConcurrency({ cpuPercent: 150, reserveCpus: 1 }, { cpus: 3, memoryMiB: 65536 }).cpuBudget, 3);
});

test('invalid policies fail and resource detection reports the current host', () => {
  const host = detectResources();
  assert.ok(host.cpus >= 1 && host.memoryMiB >= 1);
  for (const value of [0, -1, NaN, Infinity, '200', null]) assert.throws(() => selectConcurrency({ cpuPercent: value }, host), /cpuPercent/);
  for (const key of ['divisor', 'maxWorkers', 'memoryMiBPerWorker']) {
    for (const value of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => selectConcurrency({ [key]: value }, host), new RegExp(key));
  }
  for (const cpuQuotaPercent of [0, -1, 101, NaN, Infinity, '90', null]) assert.throws(() => selectConcurrency({ cpuQuotaPercent }, host), /cpuQuotaPercent/);
  assert.throws(() => selectConcurrency({ unknown: 1 }, host), /Unknown/);
  assert.throws(() => selectConcurrency({ cpuPercent: Number.MAX_VALUE }, host), /Adjusted CPUs/);
});


test('inherited fractional quotas bound resource shares without shrinking CPU capacity', () => {
  const host = { cpus: 8, memoryMiB: 16384, cpuQuotaCpus: 7.2 };
  assert.equal(selectConcurrency({}, host).cpuBudget, 7.2);
  assert.equal(selectConcurrency({ divisor: 2 }, host).cpuBudget, 3.6);
  assert.equal(selectConcurrency({}, { ...host, cpuQuotaCpus: 0.8 }).cpuBudget, 0.8);
  for (const cpuQuotaCpus of [0, -1, NaN, '7']) assert.throws(() => selectConcurrency({}, { ...host, cpuQuotaCpus }), /Inherited CPU/);
});
