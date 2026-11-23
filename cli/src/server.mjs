import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);
const fail = (message, status) => Object.assign(new Error(message), { status });
async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
    throw fail('Send an application/json request.', 415);
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) throw fail('Request body is too large.', 413);
    chunks.push(chunk);
  }
  let result;
  try {
    result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw fail('Invalid JSON request.', 400);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw fail('Send a JSON object.', 400);
  return result;
}
export async function startHttpServer({ controller, port = 4310 }) {
  const csrfToken = randomBytes(32).toString('hex');
  const clients = new Set();
  let flushTimer;
  let sequence = 0;
  const snapshot = () => ({ ...controller.snapshot(), csrfToken });
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const sendState = (res) => {
    if (res.destroyed) return;
    if (res.writableLength > 1048576) {
      res.destroy();
      return;
    }
    res.write(`id: ${++sequence}\nevent: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
  };
  const onChange = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      for (const res of clients) sendState(res);
    }, 40);
    flushTimer.unref();
  };
  controller.on('change', onChange);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );
    try {
      const localPort = req.socket.localPort;
      const hosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`]);
      const host = req.headers.host;
      if (!hosts.has(host)) throw fail('Untrusted Host header.', 403);
      if (req.headers.origin && req.headers.origin !== `http://${host}`)
        throw fail('Cross-origin requests are not allowed.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site')
        throw fail('Cross-site requests are not allowed.', 403);
      const url = new URL(req.url, `http://${host}`);
      const route = url.pathname;
      if (req.method === 'GET') {
        if (route === '/api/state') {
          json(res, 200, snapshot());
          return;
        }
        if (route === '/api/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
          });
          clients.add(res);
          sendState(res);
          req.on('close', () => clients.delete(res));
          return;
        }
        const match = route.match(/^\/api\/tasks\/([^/]+)$/);
        if (match) {
          json(res, 200, controller.details(decodeURIComponent(match[1])));
          return;
        }
        if (assets.has(route)) {
          const [filename, type] = assets.get(route);
          const bytes = await readFile(
            fileURLToPath(new URL('../public/' + filename, import.meta.url))
          );
          res.writeHead(200, { 'Content-Type': type });
          res.end(bytes);
          return;
        }
        throw fail('Not found.', 404);
      }
      if (req.method !== 'POST') throw fail('Method not allowed.', 405);
      const supplied = Buffer.from(String(req.headers['x-csrf-token'] || ''));
      const expected = Buffer.from(csrfToken);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        throw fail('Reload the app and try again; the request token is missing or expired.', 403);
      const body = await readJson(req);
      if (route === '/api/tasks') {
        json(res, 201, { task: await controller.createTask(body) });
        return;
      }
      const taskRoute = route.match(/^\/api\/tasks\/([^/]+)\/(continue|interrupt)$/);
      if (taskRoute) {
        const id = decodeURIComponent(taskRoute[1]);
        if (taskRoute[2] === 'continue') {
          json(res, 201, { task: await controller.continueTask(id, body) });
          return;
        }
        await controller.interruptTask(id);
        json(res, 200, { ok: true });
        return;
      }
      const approval = route.match(/^\/api\/approvals\/([^/]+)$/);
      if (approval) {
        await controller.respondToRequest(decodeURIComponent(approval[1]), body);
        json(res, 200, { ok: true });
        return;
      }
      if (route === '/api/control') {
        controller.setPaused(body.paused);
        json(res, 200, { ok: true });
        return;
      }
      if (route === '/api/runtime/reconnect') {
        await controller.reconnect();
        json(res, 200, { ok: true });
        return;
      }
      throw fail('Not found.', 404);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, error.status || 500, {
        error: error.status
          ? error.message
          : 'An internal error occurred. Check the server terminal.'
      });
      if (!error.status) console.error(error);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const heartbeat = setInterval(() => {
    for (const res of clients) if (!res.destroyed) res.write(': keepalive\n\n');
  }, 15000);
  heartbeat.unref();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(heartbeat);
    controller.off('change', onChange);
    throw error;
  }
  return {
    server,
    port: server.address().port,
    close: async () => {
      controller.off('change', onChange);
      clearInterval(heartbeat);
      clearTimeout(flushTimer);
      for (const res of clients) res.end();
      clients.clear();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      });
    }
  };
}
