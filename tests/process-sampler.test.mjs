import assert from 'node:assert/strict';
import test from 'node:test';
import { createProcessSampler } from '../src/process-sampler.mjs';
import { createDiagnostics } from '../src/diagnostics.mjs';

const group = '/user.slice/project-checks-a.scope';
const scope = `/sys/fs/cgroup${group}`;
const missing = () => Object.assign(new Error('gone'), { code: 'ENOENT' });

function fixture() {
  const files = new Map([
    ['/proc/self/cgroup', `0::${group}/child\n`],
    [`${scope}/cgroup.procs`, '1\n2\n2\n'],
    [`${scope}/child/cgroup.procs`, '2\n3\n4\n5\n'],
    ['/proc/1/cgroup', `0::${group}\n`], ['/proc/1/stat', '1 (runner) R 0 0'],
    ['/proc/2/cgroup', `0::${group}\n`], ['/proc/2/stat', '2 (sleeping) S 0 0'],
    ['/proc/3/cgroup', `0::${group}/child\n`], ['/proc/3/stat', '3 (name ) with spaces) R 0 0'],
    ['/proc/5/cgroup', '0::/somewhere-else\n'],
  ]);
  const children = new Map([[scope, ['child']], [`${scope}/child`, []]]);
  const read = path => {
    if (!files.has(path)) throw missing();
    const value = files.get(path);
    if (value instanceof Error) throw value;
    return value;
  };
  const list = path => (children.get(path) ?? []).map(name => ({ name, isDirectory: () => true, isSymbolicLink: () => false }));
  return { files, children, sample: createProcessSampler({ platform: 'linux', read, list }) };
}

test('counts scope descendants once, ignores exited/moved processes, and parses names safely', () => {
  const f = fixture();
  assert.deepEqual(f.sample(), { scope: group, total: 3, runnable: 2 });
  f.files.delete('/proc/3/stat');
  assert.deepEqual(f.sample(), { scope: group, total: 2, runnable: 1 });
});

test('unreadable or malformed states do not report a false runnable zero', () => {
  const f = fixture();
  f.files.set('/proc/2/stat', Object.assign(new Error('denied'), { code: 'EACCES' }));
  assert.deepEqual(f.sample(), { scope: group, total: 3, runnable: null });
  f.files.set('/proc/2/stat', 'invalid');
  assert.equal(f.sample().runnable, null);
});

test('unowned and unsupported environments are unavailable without scanning other processes', () => {
  assert.equal(createProcessSampler({ platform: 'darwin', read: () => { throw new Error('must not read'); } })(), null);
  const read = path => {
    assert.equal(path, '/proc/self/cgroup');
    return '0::/user.slice/session.scope\n';
  };
  assert.equal(createProcessSampler({ platform: 'linux', read })(), null);
  assert.equal(createProcessSampler({ platform: 'linux', read: () => '0::/../../project-checks-a.scope\n' })(), null);
});

test('disappearing child cgroups are tolerated, but a missing scope is unavailable', () => {
  const f = fixture();
  f.files.delete(`${scope}/child/cgroup.procs`);
  assert.deepEqual(f.sample(), { scope: group, total: 2, runnable: 1 });
  f.files.delete(`${scope}/cgroup.procs`);
  assert.equal(f.sample(), null);
});

test('oversized and invalid inventories are unavailable instead of blocking diagnostics', () => {
  const f = fixture();
  f.files.set(`${scope}/cgroup.procs`, '1\n'.repeat(65537));
  assert.equal(f.sample(), null);
  f.files.set(`${scope}/cgroup.procs`, '../1\n');
  assert.equal(f.sample(), null);
  f.files.set(`${scope}/cgroup.procs`, Array.from({ length: 8193 }, (_, i) => `${i + 1}\n`).join(''));
  assert.equal(f.sample(), null);
});

test('summaries retain process peaks after recovery and unavailable samples without driving admission', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const events = [];
  let counts = { scope: group, total: 2, runnable: 1 };
  const diagnostics = createDiagnostics({
    progress: false,
    processSample: () => counts,
    sample: () => ({ busyCpus: 0 }),
    logger: { log: line => events.push(JSON.parse(line.trim().slice('TEST_DIAGNOSTIC '.length))) },
  });
  t.after(() => diagnostics.close(0));
  t.mock.timers.tick(1000);
  diagnostics.suiteStart('unit');
  counts = { scope: group, total: 5, runnable: 4 };
  t.mock.timers.tick(1000);
  counts = { scope: group, total: 3, runnable: null };
  t.mock.timers.tick(1000);
  counts = null;
  t.mock.timers.tick(1000);
  diagnostics.close(0);
  const summary = events.find(event => event.event === 'summary' && event.phase === 'whole-run');
  assert.equal(summary.peakProcesses, 5);
  assert.equal(summary.peakRunnableProcesses, 4);
  assert.equal(summary.processSamples, 4);
  assert.equal(events.filter(event => event.event === 'sample').at(-1).processCounts, null);
  assert.equal(events.filter(event => event.event === 'run-end').length, 1);
});

test('wholly unavailable process measurements leave peaks unavailable', t => {
  const lines = [];
  const diagnostics = createDiagnostics({ processSample: () => null, logger: { log: line => lines.push(line) } });
  diagnostics.close(0);
  assert.match(lines.join('\n'), /PROCESS_SUMMARY: Peak OS processes: unavailable \| Peak runnable processes: unavailable \| Samples: 0/);
});
