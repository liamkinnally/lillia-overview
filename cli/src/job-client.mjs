import { constants as F } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { request } from 'node:http';
import { checkDirectory } from './local-client.mjs';
import { validateJobPacket } from './job-capabilities.mjs';

export const jobSocketPath = (dataDir) => path.join(path.resolve(dataDir), 'jobs.sock');
const invalid = () => {
  throw Error('Expected a private job credential in an owner-only directory.');
};
const digest = (s) => createHash('sha256').update(s).digest('hex');
function canonicalAlias(name) {
  if (process.platform === 'darwin' && /^\/(tmp|var)(\/|$)/.test(name)) return '/private' + name;
  return name;
}
export async function safeJobLocation(file) {
  if (
    typeof file !== 'string' ||
    !path.isAbsolute(file) ||
    path.normalize(file) !== file ||
    file.includes('\0') ||
    file.endsWith('/')
  )
    invalid();
  const expected = canonicalAlias(path.dirname(file));
  if ((await realpath(expected)) !== expected) invalid();
  for (let dir = expected; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const st = await lstat(dir),
      stickyRoot = st.uid === 0 && (st.mode & 0o1000) !== 0;
    if (
      !st.isDirectory() ||
      (st.uid !== 0 && st.uid !== process.getuid()) ||
      (st.mode & 0o022 && !stickyRoot)
    )
      invalid();
  }
  const info = await lstat(expected);
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077) invalid();
  return path.join(expected, path.basename(file));
}
async function readSecret(file) {
  const dest = await safeJobLocation(file),
    fd = await open(dest, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
    const info = await fd.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      info.size !== 44
    )
      invalid();
    const data = Buffer.alloc(45);
    const { bytesRead } = await fd.read(data, 0, data.length, 0);
    if (bytesRead !== 44 || data[43] !== 10) invalid();
    const secret = data.subarray(0, 43).toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) invalid();
    return secret;
  } finally {
    await fd.close();
  }
}
export async function createJobCredential(file) {
  const dest = await safeJobLocation(file),
    parent = await open(path.dirname(dest), F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
  try {
    const fd = await open(dest, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
    try {
      const secret = randomBytes(32).toString('base64url');
      await fd.chmod(0o600);
      await fd.writeFile(secret + '\n');
      await fd.sync();
      await parent.sync();
      return { credentialDigest: digest(secret) };
    } finally {
      await fd.close();
    }
  } finally {
    await parent.close();
  }
}
export async function inspectJobCredential(file) {
  return { credentialDigest: digest(await readSecret(file)) };
}

export async function callJobService(dataDir, credentialFile, packet) {
  validateJobPacket(packet, { withSecret: false });
  if (packet.backend === 'native')
    throw Error('Use the restricted native job worker for this packet.');
  await checkDirectory(dataDir, false);
  const socket = jobSocketPath(dataDir),
    info = await lstat(socket);
  if (!info.isSocket() || info.uid !== process.getuid() || info.mode & 0o077)
    throw Error('Unexpected job socket.');
  const secret = await readSecret(credentialFile),
    body = JSON.stringify({ ...packet, secret });
  if (JSON.stringify(packet).includes(secret)) throw Error('Invalid job request.');
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        path: '/v1/job',
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json' }
      },
      (res) => {
        const parts = [];
        let bytes = 0;
        res.on('error', () => reject(Error('Job response interrupted.')));
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 65536) res.destroy();
          else parts.push(chunk);
        });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200)
              throw Object.assign(Error('Job request was refused.'), { status: res.statusCode });
            let response;
            try {
              response = JSON.parse(Buffer.concat(parts).toString('utf8'));
            } catch {
              throw Error('Invalid job response.');
            }
            if (response.version !== 1 || !Object.hasOwn(response, 'result'))
              throw Error('Invalid job response.');
            resolve({ version: 1, result: response.result });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.setTimeout(5000, () => req.destroy());
    req.on('error', () => reject(Error('Job service unavailable.')));
    req.end(body);
  });
}
