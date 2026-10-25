import { fork } from 'node:child_process';

// Keep the pool's worker lifecycle while CPU-heavy input work runs in processes.
export function createInputProcess() {
  const child = fork(new URL('./input-hash-worker.mjs', import.meta.url), [], {
    execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { ...process.env, NODE_OPTIONS: undefined },
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.postMessage = message => child.send(message, error => { if (error) child.emit('error', error); });
  const ref = child.ref.bind(child), unref = child.unref.bind(child);
  child.ref = () => { ref(); child.channel?.ref(); };
  child.unref = () => { unref(); child.channel?.unref(); };
  child.cancel = () => child.kill('SIGTERM');
  child.terminate = () => {
    child.ref();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    return closed;
  };
  return child;
}
