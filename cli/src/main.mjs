import { mkdir, open, readFile, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { CodexRuntime } from './runtime.mjs';
import { startHttpServer } from './server.mjs';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const workspaceRoot = await realpath(process.env.CODEX_CONTROL_WORKSPACE || process.cwd());
const dataDir = path.resolve(process.env.CODEX_CONTROL_DATA_DIR || path.join(projectDir, 'data'));
const port = Number(process.env.CODEX_CONTROL_PORT || 4310);
const maxParallel = Number(process.env.CODEX_CONTROL_MAX_PARALLEL || 2);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error('CODEX_CONTROL_PORT must be between 1 and 65535.');
if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8)
  throw Error('CODEX_CONTROL_MAX_PARALLEL must be between 1 and 8.');
process.umask(0o077);
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const lockPath = path.join(dataDir, 'controller.lock');
try {
  const prior = Number((await readFile(lockPath, 'utf8')).trim());
  if (!Number.isInteger(prior) || prior < 1)
    throw Error(
      'The controller lock is incomplete. Verify no instance is running before removing data/controller.lock.'
    );
  try {
    process.kill(prior, 0);
    throw Error(`Another controller may be running (PID ${prior}).`);
  } catch (error) {
    if (error.code === 'ESRCH') await unlink(lockPath);
    else throw error;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const lock = await open(lockPath, 'wx', 0o600);
await lock.writeFile(String(process.pid));
await lock.close();
let app,
  store,
  controller,
  closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    if (app) await app.close();
    if (controller) await controller.close();
    if (store) store.close();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}
try {
  store = new TaskStore(path.join(dataDir, 'control.sqlite'));
  const runtime = new CodexRuntime({
    command: process.env.CODEX_BIN || 'codex',
    cwd: workspaceRoot
  });
  runtime.on('stderr', (chunk) => process.stderr.write(chunk));
  controller = new Controller({ store, runtime, workspaceRoot, maxParallel });
  app = await startHttpServer({ controller, port });
  console.log(
    `Lillia: http://127.0.0.1:${app.port}\nWorkspace: ${workspaceRoot}\nData: ${dataDir}`
  );
  process.once('SIGINT', () => {
    void shutdown().then(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown().then(() => process.exit(0));
  });
  await controller.start();
  if (controller.runtimeInfo.status === 'error')
    console.error('Runtime unavailable:', controller.runtimeInfo.error);
} catch (error) {
  console.error(error.message);
  await shutdown();
  process.exitCode = 1;
}
