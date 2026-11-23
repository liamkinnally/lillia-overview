import { createServer } from 'node:http';
import { connect } from 'node:net';
import { jobSocketPath } from './job-client.mjs';
import { normalizeSessionProfile } from './session-profile.mjs';
import { chmod, lstat, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { bindManagedWriter } from './installation-gate.mjs';
import { assertWritableInstallation } from './recovery.mjs';
import { localMailOwner } from './thread-mail-owner-input.mjs';

import {
  MAX_BODY,
  MAX_RESPONSE,
  callService,
  checkDirectory,
  socketPath
} from './local-client.mjs';
export { MAX_BODY, callService } from './local-client.mjs';
const queries = new Set([
  'chat.scope.preview',
  'chat.mail.settings',
  'chat.mail.subjects',
  'chat.mail.read',
  'chat.mail.list',
  'project.validation.recipes',
  'compat.inspection',
  'js.recipes',
  'js.show',
  'chat.read',
  'chat.threads',
  'chat.project',
  'chat.origin',
  'chat.context',
  'chat.selection',
  'chat.attachment.pin',
  'chat.branch',
  'chat.branch.preview',
  'chat.branch.attempt',
  'chat.parent.grant',
  'chat.attachment',
  'review.thread',
  'research.library',
  'research.citation',
  'research.noted',
  'compat.show',
  'compat.bundle',
  'release.show',
  'release.artifact',
  'release.diagnosis',
  'release.proposal',
  'queue.status',
  'authority.status',
  'authority.submissions',
  'authority.review',
  'bridge.mapping',
  'native.status',
  'native.drafts',
  'native.ref',
  'native.revision',
  'native.history',
  'native.tree',
  'native.search',
  'native.file',
  'native.diff',
  'provider.usage',
  'job.observations',
  'status',
  'daemon.drain-status',
  'goals',
  'goal',
  'task',
  'events',
  'operation',
  'research.find',
  'research.record',
  'research.versions',
  'research.passage',
  'research.investigation',
  'research.runs',
  'research.disclosure',
  'research.permission',
  'project.status',
  'project.capture',
  'worktree.preview',
  'worktree.show',
  'source.search',
  'source.diff',
  'source.file',
  'review.show',
  'review.status',
  'mail.list'
]);
const commands = new Set([
  'chat.scope.control',
  'chat.mail.preview',
  'chat.mail.configure',
  'chat.mail.send',
  'chat.mail.acknowledge',
  'chat.mail.resolve',
  'project.develop',
  'project.repair',
  'project.start',
  'project.review.retry',
  'project.validation.enroll',
  'compat.inspect',
  'authority.migrate',
  'js.enroll',
  'chat.send',
  'chat.thread.create',
  'chat.origin.create',
  'chat.context.pin',
  'chat.selection.create',
  'chat.branch.prepare',
  'chat.branch.create',
  'chat.branch.start',
  'chat.parent.grant',
  'chat.parent.revoke',
  'chat.attachment.pin',
  'authority.policy',
  'review.comment',
  'review.resolve',
  'review.owner',
  'research.fetch',
  'research.note',
  'compat.open',
  'compat.submit',
  'compat.probe',
  'release.prepare',
  'release.bisect',
  'release.revert',
  'authority.activate',
  'bridge.import',
  'bridge.export',
  'bridge.abandon',
  'native.init',
  'native.draft.create',
  'native.draft.update',
  'job.grant',
  'job.revoke',
  'daemon.drain',
  'daemon.resume',
  'goal.create',
  'goal.repair',
  'goal.develop',
  'goal.run',
  'goal.accept',
  'goal.amend',
  'goal.pause',
  'goal.resume',
  'goal.cancel',
  'task.submit',
  'task.handoff',
  'task.cancel',
  'task.reconcile',
  'research.import',
  'research.run',
  'research.grant',
  'research.revoke',
  'project.register',
  'worktree.capture',
  'review.init',
  'review.submit',
  'review.decide',
  'review.attest',
  'review.check',
  'review.land',
  'backup.create',
  'mail.post',
  'mail.resolve'
]);
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const offline = (error) => ['ENOENT', 'ECONNREFUSED'].includes(error.code);
async function decode(req, route = '/v1/rpc', max = MAX_BODY) {
  if (req.method !== 'POST' || req.url !== route)
    throw Object.assign(new Error('Unknown endpoint'), { status: 404 });
  let size = 0;
  const chunks = [];
  for await (const part of req) {
    size += part.length;
    if (size > max)
      throw Object.assign(new Error('Request exceeds endpoint limit'), { status: 413 });
    chunks.push(part);
  }
  try {
    const obj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error();
    return obj;
  } catch {
    throw badRequest('Expected a JSON object');
  }
}

async function clearStaleJobSocket(path) {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!entry.isSocket() || entry.uid !== process.getuid())
    throw Error('Unexpected job socket entry.');
  await new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      reject(Error('A live job socket already exists.'));
    });
    socket.once('error', (error) => (error.code === 'ECONNREFUSED' ? resolve() : reject(error)));
    socket.setTimeout(1500, () => socket.destroy(Error('Job socket inspection timed out.')));
  });
  const current = await lstat(path);
  if (entry.ino !== current.ino || entry.dev !== current.dev || !current.isSocket())
    throw Error('Job socket changed during startup.');
  await unlink(path);
}

async function listenPrivate(server, path) {
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.setTimeout(10000, (socket) => socket.destroy());
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(path, () => {
      server.off('error', fail);
      ok();
    });
  });
  await chmod(path, 0o600);
}

export async function startService({ dataDir, workspaceRoot, openPlatform, requestedProfile }) {
  await checkDirectory(dataDir, true);
  assertWritableInstallation(dataDir);
  workspaceRoot = await realpath(workspaceRoot ?? process.cwd());
  const lockPath = join(dataDir, 'daemon.lock.sqlite');
  try {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1)
      throw new Error('Unexpected daemon lock file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lock = new DatabaseSync(lockPath);
  let platform, server, jobServer, closing, draining;
  const active = new Set();
  function drain() {
    return (draining ??= Promise.allSettled([...active]).then(() => platform?.close()));
  }
  const instanceId = randomUUID();
  const path = socketPath(dataDir);
  function close() {
    return (closing ??= (async () => {
      try {
        await Promise.all(
          [server, jobServer]
            .filter((s) => s?.listening)
            .map((s) => new Promise((ok, fail) => s.close((error) => (error ? fail(error) : ok()))))
        );
      } finally {
        try {
          await drain();
        } finally {
          lock.close();
        }
      }
    })());
  }
  try {
    try {
      lock.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      if (error.errcode !== 5) throw error;
      throw Object.assign(new Error('Another daemon holds the writer lock'), {
        code: 'WRITER_BUSY'
      });
    }
    const managedWriter = bindManagedWriter(dataDir, lock);
    try {
      await callService(dataDir, { name: 'daemon.status' });
      throw new Error('A live socket already exists');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') await unlink(path);
      else if (error.code !== 'ENOENT') throw error;
    }

    const jobPath = jobSocketPath(dataDir);
    await clearStaleJobSocket(jobPath);
    platform = await openPlatform({
      dataDir,
      workspaceRoot,
      requestedProfile,
      managedWriter,
      serviceWriter: () => (lock.isTransaction && !closing && !draining ? instanceId : null)
    });
    jobServer = createServer(async (req, res) => {
      let status = 200,
        reply;
      try {
        const project = req.url === '/v1/project-mcp';
        const packet = await decode(
          req,
          project ? '/v1/project-mcp' : '/v1/job',
          project ? 224 * 1024 : 16384
        );
        if (closing || draining)
          throw Object.assign(Error('Service is stopping.'), { status: 503 });
        // The enrolled check may use 45s for extraction and 35s for Vitest.
        // Keep the short deadline for headers, bodies and ordinary job operations.
        if (project && packet.tool === 'run_check') req.socket.setTimeout(95000);
        const pending = project ? platform.projectRequest(packet) : platform.jobRequest(packet);
        active.add(pending);
        try {
          const result = await pending;
          if (project) {
            status = result.status;
            reply = result.body;
          } else reply = { result };
        } finally {
          active.delete(pending);
        }
      } catch (error) {
        status =
          Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
            ? error.status
            : 500;
        reply = { error: status === 503 ? 'Service is stopping.' : 'Job request refused.' };
      }
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ version: 1, ...reply }));
    });
    await listenPrivate(jobServer, jobPath);
    server = createServer(async (req, res) => {
      const send = (status, reply) => {
        let body = JSON.stringify({ version: 1, ...reply });
        if (Buffer.byteLength(body) > MAX_RESPONSE) {
          status = 413;
          body = JSON.stringify({
            version: 1,
            error: 'Result exceeds 32 MiB. Request a smaller view.'
          });
        }
        res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
        res.end(body);
      };
      try {
        const {
          version,
          name,
          input = {},
          operationId,
          workspaceRoot: requestedRoot
        } = await decode(req);
        if (version !== 1)
          throw Object.assign(new Error('Protocol version 1 required'), { status: 400 });
        if (requestedRoot !== undefined && requestedRoot !== workspaceRoot)
          throw Object.assign(new Error('Daemon workspace changed'), { status: 409 });
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw badRequest('Invalid input object');
        let result;
        if (name === 'daemon.status' || name === 'daemon.stop') {
          if (name === 'daemon.stop' && input.instanceId !== instanceId)
            throw Object.assign(new Error('Daemon instance changed'), { status: 409 });
          result = {
            running: true,
            instanceId,
            pid: process.pid,
            workspaceRoot,
            sessionProfile: platform.sessionProfile
          };
          if (name === 'daemon.stop') {
            req.socket.setTimeout(60000);
            try {
              await drain();
            } finally {
              // The acknowledgment follows platform shutdown. Release the lock after the socket closes.
              res.once('close', () => {
                close().catch((error) => console.error(error.message));
              });
              if (res.destroyed) void close().catch((error) => console.error(error.message));
            }
          }
        } else {
          if (draining || closing)
            throw Object.assign(new Error('Daemon is stopping'), { status: 503 });
          // Dependency preparation and privacy-projected backups can exceed ordinary RPC timeouts.
          if (['project.start', 'backup.create'].includes(name)) req.socket.setTimeout(180000);
          let pending;
          const actor =
            name.startsWith('chat.mail.') ||
            name === 'chat.scope.control' ||
            name === 'chat.scope.preview'
              ? localMailOwner()
              : undefined;
          if (queries.has(name))
            pending = actor ? platform.query(name, input, actor) : platform.query(name, input);
          else if (commands.has(name)) {
            if (typeof operationId !== 'string' || !operationId.trim())
              throw badRequest('Operation ID required');
            pending = actor
              ? platform.command(name, input, operationId, actor)
              : platform.command(name, input, operationId);
          } else throw badRequest('Unknown operation');
          active.add(pending);
          try {
            result = await pending;
          } finally {
            active.delete(pending);
          }
        }
        send(200, { result });
      } catch (error) {
        const status =
          Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
            ? error.status
            : 500;
        send(status, { error: status >= 500 ? 'Internal service error' : error.message });
      }
    });
    await listenPrivate(server, path);
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function daemonStatus(dir) {
  try {
    return (await callService(dir, { name: 'daemon.status' })).result;
  } catch (error) {
    if (offline(error)) return { running: false };
    throw error;
  }
}

export async function ensureDaemon(dataDir, workspaceRoot, requestedProfile) {
  workspaceRoot = await realpath(workspaceRoot);
  const selected =
    requestedProfile === undefined ? undefined : normalizeSessionProfile(requestedProfile);
  function bound(status) {
    if (status.workspaceRoot !== workspaceRoot)
      throw Object.assign(
        new Error('Daemon is bound to another workspace: ' + status.workspaceRoot),
        { status: 409 }
      );
    if (
      selected &&
      (selected.mode !== status.sessionProfile?.mode ||
        selected.codexSlots !== status.sessionProfile?.codexSlots)
    )
      throw Object.assign(
        new Error(
          'Running daemon has a different session profile. Drain and stop it before switching.'
        ),
        { status: 409 }
      );
    return status;
  }
  const status = await daemonStatus(dataDir);
  if (status.running) return bound(status);
  const entry = fileURLToPath(new URL('./daemon.mjs', import.meta.url));
  const child = spawn(
    process.execPath,
    [
      entry,
      resolve(dataDir),
      resolve(workspaceRoot),
      ...(selected ? [JSON.stringify(selected)] : [])
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
  );
  try {
    const startup = await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('Daemon startup timed out')), 15000);
      child.once('error', (error) => {
        clearTimeout(timer);
        fail(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        fail(new Error('Daemon exited during startup (' + code + ')'));
      });
      child.once('message', (message) => {
        clearTimeout(timer);
        ok(message);
      });
    });
    if (startup.error && startup.code !== 'WRITER_BUSY')
      throw Object.assign(new Error(startup.error), { status: startup.status });
    for (let i = 0; i < 100; i++) {
      const result = await daemonStatus(dataDir);
      if (result.running) return bound(result);
      await delay(50);
    }
    throw new Error('Writer owns the directory but the daemon is unavailable');
  } finally {
    if (child.connected) child.disconnect();
    child.unref();
  }
}

export async function stopDaemon(dir) {
  const initial = await daemonStatus(dir);
  if (!initial.running) return initial;
  const { result } = await callService(dir, {
    name: 'daemon.stop',
    input: { instanceId: initial.instanceId }
  });
  for (let i = 0; i < 100; i++) {
    const status = await daemonStatus(dir);
    if (status.instanceId !== result.instanceId) return status;
    await delay(50);
  }
  throw new Error('Timed out waiting for daemon stop');
}
