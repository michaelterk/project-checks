import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { groupRunning } from './command.mjs';

// Keep the pool's worker lifecycle while CPU-heavy input work runs in processes.
export function createInputProcess() {
  const grouped = process.platform !== 'win32';
  const child = fork(new URL('./input-hash-worker.mjs', import.meta.url), [], {
    execArgv: [], detached: grouped, serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { ...process.env, NODE_OPTIONS: undefined },
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.postMessage = message => child.send(message, error => { if (error) child.emit('error', error); });
  const ref = child.ref.bind(child), unref = child.unref.bind(child);
  child.ref = () => { ref(); child.channel?.ref(); };
  child.unref = () => { unref(); child.channel?.unref(); };
  const kill = signal => {
    if (!grouped || !child.pid) return child.kill(signal);
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let terminating;
  child.cancel = () => { void child.terminate().catch(error => child.emit('error', error)); };
  child.terminate = () => terminating ??= (async () => {
    child.ref();
    kill('SIGTERM');
    let timer;
    const escalation = new Promise((_, reject) => {
      timer = setTimeout(() => { try { kill('SIGKILL'); } catch (error) { reject(error); } }, 2000);
    });
    try {
      await Promise.race([closed, escalation]);
      const deadline = performance.now() + 2000;
      while (grouped && child.pid && await groupRunning(child.pid)) {
        kill('SIGKILL');
        if (performance.now() >= deadline) throw new Error('Input worker descendants did not stop');
        await delay(10);
      }
    } finally { clearTimeout(timer); }
  })();
  return child;
}
