import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { dashboardDirectory, discardRun, listRuns, readRun } from './dashboard-store.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
]);

export async function startDashboardServer({ root = process.cwd(), port = 0, idleMs = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Dashboard port must be between 0 and 65535');
  root = resolve(root);
  const directory = dashboardDirectory(root);
  await mkdir(join(directory, 'runs'), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  const staticFiles = new Map(await Promise.all([...assets].map(async ([path, [file, type]]) =>
    [path, { type, body: await readFile(new URL(`./dashboard/${file}`, import.meta.url)) }])));
  let origin, lastRequest = Date.now();
  const server = createServer(async (request, response) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
      response.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    // Exact loopback authority prevents DNS rebinding. Mutations also need the
    // same-origin page's token; no CORS or filesystem paths are accepted over HTTP.
    if (request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin) ||
        request.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Local dashboard access only' });
    lastRequest = Date.now();
    try {
      if (request.method === 'GET' && staticFiles.has(request.url)) {
        const asset = staticFiles.get(request.url);
        return send(200, asset.body, asset.type);
      }
      if (request.method === 'GET' && request.url === '/api/runs')
        return send(200, { root, token, serverPid: process.pid, runs: await listRuns(directory) });
      const match = /^\/api\/runs\/([a-f0-9-]{36})$/.exec(request.url);
      if (request.method === 'GET' && match) return send(200, await readRun(directory, match[1]));
      const discard = /^\/api\/runs\/([a-f0-9-]{36})\/discard$/.exec(request.url);
      if (request.method === 'POST' && discard) {
        if (request.headers.origin !== origin || request.headers['x-dashboard-token'] !== token)
          return send(403, { error: 'Refresh this local page before discarding a run' });
        if (request.headers['content-type'] !== 'application/json') return send(415, { error: 'Expected JSON' });
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 1024) return send(413, { error: 'Request too large' });
        }
        const value = JSON.parse(body);
        if (!value || typeof value.excludeTests !== 'boolean' ||
            (value.excludeCurrent !== undefined && typeof value.excludeCurrent !== 'boolean') ||
            Object.keys(value).some(key => !['excludeTests', 'excludeCurrent'].includes(key)))
          return send(400, { error: 'Expected exclusion booleans' });
        await discardRun(directory, root, discard[1], value.excludeTests, value.excludeCurrent ?? false);
        return send(200, { discarded: true });
      }
      send(404, { error: 'Not found' });
    } catch (error) {
      send(error.code === 'ENOENT' ? 404 : 400, { error: error.message });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); accept(); });
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  let closing;
  const close = () => closing ??= (async () => {
    clearInterval(timer);
    await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  })();
  const timer = idleMs ? setInterval(() => {
    if (Date.now() - lastRequest < idleMs) return;
    void listRuns(directory).then(runs => {
      if (!runs.some(run => run.status === 'running' && Date.now() - run.updatedAt < 10000)) void close();
    }).catch(() => { void close(); });
  }, Math.min(idleMs, 30000)) : undefined;
  return { url: origin, close };
}
