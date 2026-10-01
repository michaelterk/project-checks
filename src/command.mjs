import { spawn } from 'node:child_process';
import { command as validateCommand } from './util.mjs';

export function commandEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.NODE_TEST_CONTEXT;
  for (const name of Object.keys(env)) if (env[name] === undefined) delete env[name];
  return env;
}

export async function runCommand(command, { cwd = process.cwd(), env = commandEnvironment(), signal, stdio = 'inherit', logger = console } = {}) {
  validateCommand(command);
  signal?.throwIfAborted();
  return new Promise((resolveStatus, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, env, stdio, shell: false });
    let aborted = false;
    let spawnError = false;
    let killTimer;
    const abort = () => {
      aborted = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', error => { spawnError = true; logger?.error(error.message); });
    // Wait for close, so all output is drained before the next stage starts.
    child.once('close', code => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (aborted) reject(signal.reason);
      else resolveStatus(!spawnError && Number.isInteger(code) && code >= 0 ? code : 1);
    });
  });
}
