import { inspect, parseArgs } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import {
  constants as C,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  readSync,
  writeFileSync
} from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { ensureDaemon, callService } from './local-service.mjs';
import { materializeCompatibility, compatibilityParent } from './git-compatibility.mjs';

const help = `lillia compat [--json] COMMAND
  open REPOSITORY NATIVE_REVISION GENERATION
  checkout WORKSPACE_ID OWNER_PARENT_DIRECTORY
  export WORKSPACE_ID NEW_BUNDLE_FILE
  submit WORKSPACE_ID LOCAL_BRANCH GIT_COMMIT --bundle-file FILE
  probe TASK_ID LEASE_GENERATION
  inspect REPOSITORY NATIVE_REVISION PATH --generation N --policy DIGEST --provider codex|claude (Claude requires --claude-model MODEL)
  inspection GOAL_ID
  show ID
  open, submit, probe and inspect accept --operation-id ID.`;
const usage = (msg) =>
  Object.assign(new Error(msg + '\nSee lillia compat --help.'), { exitCode: 2 });
function bundleFile(path) {
  const fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true }),
      size = Number(before.size);
    if (
      !before.isFile() ||
      before.uid !== BigInt(process.getuid()) ||
      size <= 0 ||
      size > 512 * 1024
    )
      throw usage('Select an owner-controlled regular Git bundle of at most 512 KiB');
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, bytes, offset, size - offset, offset);
      if (!n) throw usage('Git bundle changed while reading');
      offset += n;
    }
    const after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.ctimeNs !== after.ctimeNs)
      throw usage('Git bundle changed while reading');
    return bytes.toString('base64');
  } finally {
    closeSync(fd);
  }
}
function generation(n) {
  if (!/^[1-9]\d*$/.test(n) || !Number.isSafeInteger(Number(n)))
    throw usage('Select a positive exact generation');
  return Number(n);
}
export function parseCompatCli(argv) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        'operation-id': { type: 'string' },
        'bundle-file': { type: 'string' },
        generation: { type: 'string' },
        policy: { type: 'string' },
        provider: { type: 'string' },
        'claude-model': { type: 'string' }
      }
    });
  } catch (e) {
    throw usage(e.message);
  }
  const {
    values: f,
    positionals: [verb, ...p]
  } = args;
  if (!verb || f.help) return { help };
  const mut = ['open', 'submit', 'probe', 'inspect'].includes(verb);
  const arity = {
    open: 3,
    checkout: 2,
    export: 2,
    submit: 3,
    probe: 2,
    show: 1,
    inspect: 3,
    inspection: 1
  };
  if (
    !Object.hasOwn(arity, verb) ||
    p.length !== arity[verb] ||
    (f['operation-id'] !== undefined && !mut) ||
    Boolean(f['bundle-file']) !== (verb === 'submit')
  )
    throw usage('Unexpected compatibility command arguments');
  if (
    verb !== 'inspect' &&
    ['generation', 'policy', 'provider', 'claude-model'].some((k) => f[k] !== undefined)
  )
    throw usage('Provider and policy selection apply only to inspect');
  let input;
  if (verb === 'inspect') {
    if (
      !['claude', 'codex'].includes(f.provider) ||
      !f.policy ||
      Boolean(f['claude-model']) !== (f.provider === 'claude')
    )
      throw usage('Select a provider, policy digest and generation for the chosen revision');
    input = {
      repository: p[0],
      revision: p[1],
      path: p[2],
      generation: generation(f.generation),
      policyDigest: f.policy,
      provider: f.provider,
      ...(f['claude-model'] !== undefined ? { claudeModel: f['claude-model'] } : {})
    };
  } else if (verb === 'inspection') input = { goalId: p[0] };
  else if (verb === 'open')
    input = { repository: p[0], revisionId: p[1], expectedGeneration: generation(p[2]) };
  else if (verb === 'probe') input = { taskId: p[0], generation: generation(p[1]) };
  else if (verb === 'submit')
    input = {
      workspaceId: p[0],
      branch: p[1],
      expectedGitId: p[2],
      bundle: bundleFile(f['bundle-file'])
    };
  else input = { id: p[0] };
  return {
    verb,
    name: 'compat.' + (['export', 'checkout'].includes(verb) ? 'bundle' : verb),
    input,
    localPath: p[1],
    operationId: mut ? (f['operation-id'] ?? randomUUID()) : undefined,
    json: f.json
  };
}
export async function runCompatCli(argv, context) {
  const req = parseCompatCli(argv);
  if (req.help) {
    console.log(help);
    return;
  }
  const daemon = await ensureDaemon(context.dataDir, context.workspaceRoot);
  let result;
  try {
    ({ result } = await callService(context.dataDir, {
      name: req.name,
      input: req.input,
      operationId: req.operationId,
      workspaceRoot: daemon.workspaceRoot
    }));
  } catch (e) {
    if (req.operationId && (!e.status || e.status >= 500)) {
      e.message += '\nCommand outcome unknown. Retry with --operation-id ' + req.operationId;
      e.exitCode = 4;
    }
    throw e;
  }
  if (req.verb === 'checkout')
    result = materializeCompatibility({ bundle: result, parent: req.localPath, ...context });
  if (req.verb === 'export') {
    const target = resolve(req.localPath),
      parent = compatibilityParent(dirname(target), context);
    if (!/^[\w][\w .-]{0,150}\.bundle$/.test(basename(target)))
      throw usage('Select a fresh .bundle output filename');
    const bytes = Buffer.from(result.base64, 'base64'),
      digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== result.workspace.bundleDigest || bytes.length !== result.workspace.bundleBytes)
      throw Error('Compatibility export digest mismatch');
    const path = join(parent, basename(target)),
      fd = openSync(path, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    result = { workspaceId: result.workspace.id, path, bytes: bytes.length, digest };
  }
  console.log(
    req.json
      ? JSON.stringify({ version: 1, result })
      : inspect(result, { depth: null, colors: process.stdout.isTTY, compact: false })
  );
}
