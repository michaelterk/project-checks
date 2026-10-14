import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { put, temporary } from './helpers.mjs';

const cli = new URL('../bin/project-checks.mjs', import.meta.url).pathname;

test('CLI dashboard survives command exit, preserves failures and cache results, and isolates run manifests', async t => {
  const root = await temporary(t);
  await put(root, 'test/pass.test.mjs', '');
  await put(root, 'test/fail.test.mjs', '');
  await put(root, 'project-checks.config.json', JSON.stringify({
    inputs: [], coverage: false, stdio: 'ignore',
    command: [process.execPath, '-e', "process.exit(process.argv[1].includes('fail') ? 7 : 0)", '{file}'],
  }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync(process.execPath, [cli, '--dashboard', '--workers', '1'], {
      cwd: root, encoding: 'utf8', timeout: 30000,
    });
    const url = /^DASHBOARD: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(result.stdout)?.[1];
    assert.ok(url, result.stderr + result.stdout);
    const response = await fetch(`${url}/api/runs`);
    const data = await response.json();
    try {
      assert.equal(result.status, 7, result.stderr + result.stdout);
      assert.equal(data.runs.length, attempt + 1);
      assert.equal(data.runs[0].status, 'failed');
      assert.equal(data.runs[0].counts.total, 2);
      assert.equal(data.runs[0].counts.failed, 1);
      assert.equal(data.runs[0].counts.cached, attempt);
      assert.equal(data.runs[0].counts.passed, 1 - attempt);
    } finally { process.kill(data.serverPid, 'SIGTERM'); }
  }
});

test('CLI help and dashboard options reject accidental listener use', () => {
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.match(run(['--help']).stdout, /--dashboard/);
  for (const args of [['--dashboard-port', '2'], ['resources', '--dashboard'], ['--dashboard-port', '65536'], ['--dashboard-port', '-1']]) {
    assert.equal(run(args).status, 2);
  }
});
