import { request } from 'node:http';
import { lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const MAX_BODY = 1024 * 1024;
export const MAX_RESPONSE = 32 * MAX_BODY;
export const socketPath = (dir) => join(resolve(dir), 'daemon.sock');

export async function checkDirectory(dir, create) {
  if (process.getuid === undefined) throw new Error('A POSIX host is required');
  if (Buffer.byteLength(socketPath(dir)) > 103)
    throw new Error('Data directory path exceeds local socket path limit');
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077)
    throw new Error('Data directory must be private and owner-controlled (0700)');
}

async function checkSocket(path) {
  const info = await lstat(path);
  if (!info.isSocket() || info.uid !== process.getuid())
    throw new Error('Unexpected file at daemon socket path');
}

export async function callService(dir, payload) {
  await checkDirectory(dir, false);
  const path = socketPath(dir);
  await checkSocket(path);
  const body = JSON.stringify({ version: 1, ...payload });
  if (Buffer.byteLength(body) > MAX_BODY)
    throw Object.assign(new Error('Request exceeds 1 MiB'), { status: 413 });
  return new Promise((ok, fail) => {
    const req = request(
      {
        socketPath: path,
        method: 'POST',
        path: '/v1/rpc',
        agent: false,
        headers: { 'content-type': 'application/json' }
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('error', fail);
        let size = 0;
        res.on('data', (chunk) => {
          size += Buffer.byteLength(chunk);
          if (size > MAX_RESPONSE) res.destroy(new Error('Daemon response exceeded 32 MiB'));
          else data += chunk;
        });
        res.on('end', () => {
          try {
            const reply = JSON.parse(data);
            if (reply.version !== 1) throw new Error('Incompatible daemon protocol');
            if (res.statusCode !== 200)
              throw Object.assign(new Error(reply.error || 'Daemon error'), {
                status: res.statusCode
              });
            ok(reply);
          } catch (error) {
            fail(error);
          }
        });
      }
    );
    req.on('error', fail);
    req.setTimeout(
      ['project.start', 'backup.create'].includes(payload.name)
        ? 180000
        : payload.name === 'daemon.stop'
          ? 60000
          : 5000,
      () => req.destroy(new Error('Daemon request timed out'))
    );
    req.end(body);
  });
}
