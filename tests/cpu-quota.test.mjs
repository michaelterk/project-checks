import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { hasCpuQuota, quotaCpus, runWithCpuQuota } from '../src/cpu-quota.mjs';
import { temporary, put } from './helpers.mjs';
import { setTimeout as delay } from 'node:timers/promises';

test('quota percentages use aggregate host CPUs and reject invalid configuration', () => {
  const host = { cpus: 8, memoryMiB: 8192 };
  assert.equal(quotaCpus({}, host), 7.2);
  assert.equal(quotaCpus({ cpuQuotaPercent: 95 }, host), 7.6);
  assert.equal(quotaCpus({ cpuQuotaPercent: 10 }, host), 0.8);
  for (const cpuQuotaPercent of [null, 0, -1, 101, Infinity, '90']) assert.throws(() => quotaCpus({ cpuQuotaPercent }, host), /cpuQuotaPercent/);
});

test('quota verification traverses missing interfaces and validates inherited limits', { skip: process.platform !== 'linux' }, async () => {
  const read = path => {
    if (path === '/proc/self/cgroup') return '0::/parent/leaf\n';
    if (path.endsWith('/leaf/cpu.max')) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    return '72000 10000\n';
  };
  assert.equal(await hasCpuQuota(7.2, { read }), true);
  assert.equal(await hasCpuQuota(3.6, { read }), false);
  assert.equal(await hasCpuQuota(7.2, { read: path => path === '/proc/self/cgroup' ? '0::/leaf\n' : 'max 100000\n' }), false);
  await assert.rejects(hasCpuQuota(7.2, { read: path => path === '/proc/self/cgroup' ? '0::/leaf\n' : 'invalid' }), /Malformed/);
  await assert.rejects(hasCpuQuota(7.2, { read: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }), /denied/);
});

test('stricter nested quotas cannot escape an owned aggregate scope', { skip: process.platform !== 'linux' }, async () => {
  const read = path => path === '/proc/self/cgroup' ? '0::/parent/project-checks-abc.scope\n' : '72000 10000\n';
  assert.equal(await hasCpuQuota(7.2, { read }), true);
  await assert.rejects(hasCpuQuota(3.6, { read }), /outer runner/);
});

test('real quota covers literal arguments, environment, cwd and detached descendants', { skip: process.platform !== 'linux' }, async t => {
  const root = await temporary(t);
  const output = join(root, 'result');
  const script = await put(root, 'command with spaces.mjs', `
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const group = readFileSync('/proc/self/cgroup', 'utf8').trim().split('::')[1];
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
child.unref();
writeFileSync(${JSON.stringify(output)}, JSON.stringify({ group, quota: readFileSync(join('/sys/fs/cgroup', group, 'cpu.max'), 'utf8'), cwd: process.cwd(), argument: process.argv[2], value: process.env.QUOTA_FIXTURE, child: child.pid }));
process.exitCode = 17;
`);
  const status = await runWithCpuQuota([process.execPath, script, 'literal $(no shell)'], { cwd: root, env: { ...process.env, QUOTA_FIXTURE: 'kept' }, stdio: 'ignore' });
  assert.equal(status, 17);
  const result = JSON.parse(await readFile(output, 'utf8'));
  const [maximum, period] = result.quota.trim().split(/\s+/).map(Number);
  assert.ok(maximum / period <= quotaCpus({}));
  assert.equal(result.cwd, root);
  assert.equal(result.argument, 'literal $(no shell)');
  assert.equal(result.value, 'kept');
  const state = await readFile(`/proc/${result.child}/stat`, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
  assert.ok(state === undefined || ['Z', 'X'].includes(state.slice(state.lastIndexOf(')') + 2).split(' ')[0]));
});

test('cancellation drains the quota scope before returning', { skip: process.platform !== 'linux' }, async t => {
  const root = await temporary(t);
  const ready = join(root, 'ready');
  const controller = new AbortController();
  const command = await put(root, 'waiting.mjs', `
import { writeFileSync, readFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, group: readFileSync('/proc/self/cgroup', 'utf8').trim().split('::')[1] }));
setInterval(() => {}, 1000);
`);
  const running = runWithCpuQuota([process.execPath, command], { signal: controller.signal, stdio: 'ignore' });
  const rejected = assert.rejects(running, { name: 'AbortError' });
  let result;
  const deadline = Date.now() + 10000;
  try {
    while (!result && Date.now() < deadline) {
      result = await readFile(ready, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!result) await delay(10);
    }
  } finally { controller.abort(); }
  await rejected;
  assert.ok(result, 'command reached its readiness barrier');
  const { pid, group } = JSON.parse(result);
  await assert.rejects(readFile(`/proc/${pid}/stat`, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(join('/sys/fs/cgroup', group, 'cgroup.procs'), 'utf8'), { code: 'ENOENT' });
});

test('kernel throttles aggregate CPU under parallel load at the configured cap', { skip: process.platform !== 'linux' }, async t => {
  const root = await temporary(t);
  const output = join(root, 'usage');
  const script = await put(root, 'load.mjs', `
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const group = readFileSync('/proc/self/cgroup', 'utf8').trim().split('::')[1];
const stats = () => Object.fromEntries(readFileSync(join('/sys/fs/cgroup', group, 'cpu.stat'), 'utf8').trim().split('\\n').map(line => line.split(' ')).map(([key, value]) => [key, Number(value)]));
const before = stats();
const start = performance.now();
await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', 'const end=Date.now()+800; while(Date.now()<end){}'], { stdio: 'ignore' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error('load failed')));
})));
const after = stats();
writeFileSync(${JSON.stringify(output)}, JSON.stringify({ cpus: (after.usage_usec-before.usage_usec)/((performance.now()-start)*1000), throttled: after.nr_throttled-before.nr_throttled }));
`);
  const resources = { cpuQuotaPercent: 10 };
  assert.equal(await runWithCpuQuota([process.execPath, script], { resources, stdio: 'ignore' }), 0);
  const usage = JSON.parse(await readFile(output, 'utf8'));
  assert.ok(usage.throttled > 0);
  assert.ok(usage.cpus <= quotaCpus(resources) + 0.15, `measured ${usage.cpus} CPUs`);
});

test('abort during detached-child scope cleanup cannot return success', { skip: process.platform !== 'linux' }, async t => {
  const root = await temporary(t);
  const acknowledged = join(root, 'stopping');
  const release = join(root, 'release');
  const child = await put(root, 'detached.mjs', `
import { existsSync, writeFileSync } from 'node:fs';
process.on('SIGTERM', () => writeFileSync(${JSON.stringify(acknowledged)}, 'stopping'));
setInterval(() => { if (existsSync(${JSON.stringify(release)})) process.exit(0); }, 10);
process.send('ready');
`);
  const parent = await put(root, 'parent.mjs', `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [${JSON.stringify(child)}], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
child.once('message', () => process.exit(0));
`);
  const controller = new AbortController();
  const running = runWithCpuQuota([process.execPath, parent], { signal: controller.signal, stdio: 'ignore' });
  const rejected = assert.rejects(running, { name: 'AbortError' });
  let acknowledgement;
  const deadline = Date.now() + 10000;
  try {
    while (!acknowledgement && Date.now() < deadline) {
      acknowledgement = await readFile(acknowledged, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!acknowledgement) await delay(10);
    }
  } finally {
    controller.abort();
    await put(root, 'release', 'release');
  }
  await rejected;
  assert.ok(acknowledgement, 'scope cleanup reached its SIGTERM barrier');
});
