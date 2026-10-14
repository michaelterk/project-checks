import { fork } from 'node:child_process';
import { startDashboardServer } from './dashboard-server.mjs';
import { commandEnvironment } from './command.mjs';

export async function launchDashboard(root, port = 0) {
  const child = fork(new URL('./dashboard-launch.mjs', import.meta.url), [], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
    env: commandEnvironment({ PROJECT_CHECKS_DASHBOARD_SERVER: '1' }),
  });
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => fail(new Error('Dashboard startup timed out')), 10000);
    const fail = error => { clearTimeout(timer); child.kill(); reject(error); };
    child.once('error', fail);
    child.once('exit', () => fail(new Error('Dashboard stopped during startup')));
    child.once('message', message => {
      clearTimeout(timer);
      if (message.error) return fail(new Error(message.error));
      child.removeAllListeners('exit');
      child.disconnect();
      child.unref();
      accept(message.url);
    });
    child.send({ root, port });
  });
}

if (process.env.PROJECT_CHECKS_DASHBOARD_SERVER === '1' && process.send) {
  process.once('message', async ({ root, port }) => {
    try {
      const dashboard = await startDashboardServer({ root, port, idleMs: 30 * 60 * 1000 });
      process.send({ url: dashboard.url });
      const stop = () => { void dashboard.close(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    } catch (error) {
      process.send({ error: error.message });
      process.exitCode = 2;
    }
  });
}
