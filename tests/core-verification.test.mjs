import assert from 'node:assert/strict';
import test from 'node:test';
import { cpuCapacity } from '../src/cpu-limits.mjs';
import { defineConfig } from '../src/config.mjs';
import { createVerificationPool } from '../src/verification-pool.mjs';

test('core-scaled validators admit four per core and bound in-flight files to sixteen per core', { timeout: 5000 }, async t => {
  const cores = cpuCapacity();
  assert.doesNotThrow(() => defineConfig({ verificationConcurrency: '4N' }));
  const pool = createVerificationPool(new AbortController().signal, '4N');
  t.after(() => pool.close());
  const credits = await Promise.all(Array.from({ length: cores * 16 }, () => pool.reserve()));
  let overflow = false;
  const next = pool.reserve().then(release => { overflow = true; release(); });
  const gate = Promise.withResolvers(), full = Promise.withResolvers();
  t.after(() => gate.resolve());
  let started = 0, active = 0, peak = 0;
  const jobs = Array.from({ length: cores * 4 + 1 }, () => pool.run(async () => {
    peak = Math.max(peak, ++active);
    if (++started === cores * 4) full.resolve();
    await gate.promise;
    active--;
  }));
  await full.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, cores * 4);
  assert.equal(overflow, false);
  credits[0]();
  await next;
  assert.equal(overflow, true);
  credits.slice(1).forEach(release => release());
  gate.resolve();
  await Promise.all(jobs);
  assert.equal(peak, cores * 4);
  assert.equal(active, 0);
});
