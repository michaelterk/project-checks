import { withProcessSignal } from './cancellation.mjs';
import { spawn } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { command as validateCommand, integer } from './util.mjs';
import { classifyReport } from './timeout-reporter.mjs';
import { classifyPlaywrightReport } from './playwright-reporter.mjs';

export function commandEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.NODE_TEST_CONTEXT;
  for (const name of Object.keys(env)) if (env[name] === undefined) delete env[name];
  return env;
}

async function groupRunning(pid) {
  try { process.kill(-pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (process.platform !== 'linux') return true;
  // Orphan zombies can await an external reaper after SIGKILL. They cannot run
  // or retain resources; check only process state/group metadata, never commands.
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try { stat = await readFile(`/proc/${entry}/stat`, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
    const [state, , group] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(group) === pid && state !== 'Z' && state !== 'X') return true;
  }
  return false;
}

export async function runCommand(command, options = {}) {
  return withProcessSignal(options.signal, signal => executeCommand(command, { ...options, signal }));
}

async function executeCommand(command, { cwd = process.cwd(), env = commandEnvironment(), signal, stdio = 'inherit', logger = console, timeoutMs, nodeTest = false, playwrightTest = false, testTimeoutMs, onTimeout } = {}) {
  validateCommand(command);
  if (typeof playwrightTest !== 'boolean') throw new TypeError('playwrightTest must be a boolean');
  if (nodeTest && playwrightTest) throw new TypeError('nodeTest and playwrightTest are mutually exclusive');
  for (const [name, value] of Object.entries({ timeoutMs, testTimeoutMs })) {
    if (value !== undefined && (integer(value, name) > 2147483647)) throw new TypeError(`${name} must be <= 2147483647`);
  }
  const posix = ['linux', 'darwin'].includes(process.platform);
  const managedGroup = posix && (signal !== undefined || nodeTest || playwrightTest || timeoutMs !== undefined);
  if ((nodeTest || playwrightTest || timeoutMs !== undefined) && !posix) throw new Error('Verified timeout execution requires owned process groups on Linux or macOS');
  signal?.throwIfAborted();
  let directory;
  let report;
  let asyncReport;
  let deadlineExpired = false;
  try {
    if (nodeTest || playwrightTest) {
      directory = await mkdtemp(join(tmpdir(), 'project-checks-timeout-'));
      report = join(directory, 'events.jsonl');
    }
    if (playwrightTest) {
      const args = [];
      let reporters = 'line';
      let index = 1;
      for (; index < command.length && command[index] !== '--'; index++) {
        const argument = command[index];
        if (['--workers', '-j', '--retries', '--reporter'].includes(argument)) {
          if (argument === '--reporter') reporters = command[index + 1];
          index++;
        } else if (argument.startsWith('--reporter=')) reporters = argument.slice('--reporter='.length);
        else if (!/^--(?:workers|retries)=|^-j.+/.test(argument)) args.push(argument);
      }
      const reporter = fileURLToPath(new URL('./playwright-reporter.mjs', import.meta.url));
      command = [command[0], ...args, '--workers=1', '--retries=0', `--reporter=${reporters},${reporter}`, ...command.slice(index)];
      env = { ...env, PROJECT_CHECKS_PLAYWRIGHT_REPORT: report };
    }
    if (nodeTest) {
      asyncReport = join(directory, 'async-failures');
      await writeFile(asyncReport, '', { mode: 0o600, flag: 'wx' });
      const monitor = new URL('./async-failure-monitor.mjs', import.meta.url);
      monitor.searchParams.set('report', asyncReport);
      let args = command.slice(1);
      if (testTimeoutMs !== undefined) {
        args = args.filter((argument, index) => argument !== '--test-timeout' && !argument.startsWith('--test-timeout=') && args[index - 1] !== '--test-timeout');
        args.unshift(`--test-timeout=${testTimeoutMs}`);
      }
      const hasReporter = args.some(argument => argument === '--test-reporter' || argument.startsWith('--test-reporter='));
      const hasDestination = args.some(argument => argument === '--test-reporter-destination' || argument.startsWith('--test-reporter-destination='));
      command = [command[0], `--import=${monitor.href}`, ...(hasReporter ? [] : ['--test-reporter=spec', '--test-reporter-destination=stdout']),
        `--test-reporter=${new URL('./timeout-reporter.mjs', import.meta.url).href}`, `--test-reporter-destination=${report}`,
        ...(hasReporter && !hasDestination ? ['--test-reporter-destination=stdout'] : []), ...args];
    }
    signal?.throwIfAborted();
    const status = await new Promise((resolveStatus, reject) => {
      const child = spawn(command[0], command.slice(1), { cwd, env, stdio, shell: false, detached: managedGroup });
      let aborted = false;
      let spawnError = false;
      let cleanupError;
      let killTimer;
      let groupGone = false;
      let terminationDeadline;
      const cooperative = managedGroup && !nodeTest && !playwrightTest;
      const kill = signal => {
        if (!managedGroup) { child.kill(signal); return; }
        if (!child.pid || groupGone) return;
        try { process.kill(-child.pid, signal); }
        catch (error) {
          if (error.code === 'ESRCH') groupGone = true;
          else { cleanupError ??= error; child.kill('SIGKILL'); }
        }
      };
      const terminate = () => {
        if (killTimer) return;
        if (playwrightTest) {
          // Playwright owns detached servers/browser groups. Signal its launcher
          // so native teardown can close them; killing our group cannot do that.
          child.kill('SIGINT');
          killTimer = setTimeout(() => {
            child.kill('SIGINT'); // Native forced teardown after its grace period.
            killTimer = setTimeout(() => {
              cleanupError ??= new Error('Could not establish Playwright native cleanup; refusing further attempts');
              kill('SIGKILL');
            }, 2000);
          }, 2000);
        } else {
          // Shell/npm launchers may exit before inner package owners drain their
          // detached workers. Their group keeps those owners alive during cleanup.
          const grace = cooperative ? 8000 : 2000;
          terminationDeadline = performance.now() + grace;
          kill('SIGTERM');
          killTimer = setTimeout(() => {
            if (cooperative) cleanupError ??= new Error('Could not establish cooperative command cleanup; refusing further attempts');
            kill('SIGKILL');
          }, grace);
        }
      };
      const abort = () => { aborted = true; terminate(); };
      const deadline = timeoutMs === undefined ? undefined : setTimeout(() => {
        deadlineExpired = true;
        logger?.error(`Command exceeded its ${timeoutMs}ms wall deadline.`);
        terminate();
      }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.once('error', error => { spawnError = true; logger?.error(error.message); });
      // Closing the launcher does not establish that its workers have stopped.
      child.once('close', async (code, exitSignal) => {
        clearTimeout(deadline);
        try {
          if (playwrightTest && exitSignal) cleanupError ??= new Error('Playwright exited by signal without confirmed native cleanup; refusing further attempts');
          if (managedGroup && child.pid && !groupGone) {
            if (!(cooperative && terminationDeadline !== undefined)) kill('SIGKILL');
            const until = (cooperative && terminationDeadline !== undefined ? terminationDeadline : performance.now()) + 2000;
            while (!groupGone && await groupRunning(child.pid)) {
              if (performance.now() >= until) throw new Error('Could not establish command process-group quiescence; refusing further attempts');
              await delay(10);
            }
            groupGone = true;
          }
          if (cleanupError) throw cleanupError;
          if (aborted) reject(signal.reason);
          else resolveStatus(!deadlineExpired && !spawnError && Number.isInteger(code) && code >= 0 ? code : 1);
        } catch (error) { reject(error); }
        finally {
          clearTimeout(killTimer);
          signal?.removeEventListener('abort', abort);
        }
      });
      if (asyncReport && child.pid) {
        try {
          writeFileSync(`${asyncReport}.owner.tmp`, String(child.pid), { mode: 0o600, flag: 'wx' });
          renameSync(`${asyncReport}.owner.tmp`, `${asyncReport}.owner`);
        } catch (error) { cleanupError = error; kill('SIGKILL'); }
      }
    });
    let outcome;
    if (report) {
      let contents = '';
      try { contents = await readFile(report, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      outcome = playwrightTest ? classifyPlaywrightReport(contents, { deadlineExpired }) : classifyReport(contents);
      if (asyncReport && (await readFile(asyncReport, 'utf8')).length) outcome.ordinaryFailure = true;
    }
    signal?.throwIfAborted();
    if (deadlineExpired || outcome?.timedOut) onTimeout?.({ ordinaryFailure: Boolean(outcome?.ordinaryFailure || (outcome && !outcome.complete && !deadlineExpired)) });
    return status || (outcome && (!outcome.complete || outcome.timedOut || outcome.ordinaryFailure) ? 1 : 0);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
