import { parseArgs, inspect } from 'node:util';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { callService } from './local-client.mjs';
import { ensureDaemon } from './local-service.mjs';
import { callJobService, createJobCredential, inspectJobCredential } from './job-client.mjs';
import { runRestrictedJob } from './scoped-job-worker.mjs';
import { normalizeJobGrant } from './job-capabilities.mjs';

export const jobHelp = `job grant TASK REV PATH --credential FILE --spec-version N --scope-version N --action ACTION [--action ACTION] --ttl SECONDS --operation-id ID
For native grants and requests add --backend native --repository NAME --epoch UUID --provider codex|claude.
job revoke CAP --operation-id ID | job observations TASK [--after N] [--limit N]
job read CAP TASK REV PATH --credential FILE --spec-version N --scope-version N [--after OFFSET] [--limit BYTES]
job search CAP TASK REV PATH --query QUERY [--mode MODE] [--language python] plus native credential and scope flags
job observe CAP TASK REV PATH --credential FILE --spec-version N --scope-version N --stdin --operation-id ID`;
const fail = () => {
  throw Object.assign(Error('Invalid job arguments. See lillia job --help.'), { exitCode: 2 });
};
const nativeFlags = ['backend', 'repository', 'epoch', 'provider'];
const scopeFlags = [...nativeFlags, 'credential', 'spec-version', 'scope-version'];
const signatures = {
  grant: { count: 3, flags: [...scopeFlags, 'action', 'ttl', 'operation-id'] },
  revoke: { count: 1, flags: ['operation-id'] },
  observations: { count: 1, flags: ['after', 'limit'] },
  read: { count: 4, flags: [...scopeFlags, 'after', 'limit'] },
  search: { count: 4, flags: [...scopeFlags, 'query', 'mode', 'language'] },
  observe: { count: 4, flags: [...scopeFlags, 'stdin', 'operation-id'] }
};
function integer(value, min, max) {
  const n = Number(value);
  if (
    typeof value !== 'string' ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(n) ||
    n < min ||
    n > max
  )
    fail();
  return n;
}
async function inputNote() {
  if (process.stdin.isTTY) fail();
  const chunks = [];
  let size = 0;
  for await (const part of process.stdin) {
    size += part.length;
    if (size > 1024) fail();
    chunks.push(part);
  }
  const note = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  if (!note.trim()) fail();
  return note;
}
export async function runJobCli(argv, { workspaceRoot, dataDir }) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        stdin: { type: 'boolean' },
        ...Object.fromEntries(
          [...nativeFlags, 'query', 'mode', 'language'].map((k) => [k, { type: 'string' }])
        ),
        credential: { type: 'string' },
        'spec-version': { type: 'string' },
        'scope-version': { type: 'string' },
        action: { type: 'string', multiple: true },
        ttl: { type: 'string' },
        'operation-id': { type: 'string' },
        after: { type: 'string' },
        limit: { type: 'string' }
      }
    });
  } catch {
    fail();
  }
  const {
    values: f,
    positionals: [verb, ...args]
  } = parsed;
  if (f.help) {
    console.log(jobHelp);
    return;
  }
  const spec = Object.hasOwn(signatures, verb) ? signatures[verb] : null;
  if (
    !spec ||
    args.length !== spec.count ||
    Object.keys(f).some((k) => k !== 'json' && !spec.flags.includes(k))
  )
    fail();
  const operationId = f['operation-id'];
  if (spec.flags.includes('operation-id') && !/^[a-zA-Z0-9._:-]{1,128}$/.test(operationId ?? ''))
    fail();
  const print = (value) =>
    console.log(
      f.json
        ? JSON.stringify({ version: 1, result: value })
        : inspect(value, { depth: null, compact: false })
    );
  const credential = f.credential ? resolve(f.credential) : null,
    scoped = spec.flags.includes('credential');
  if (scoped && !credential) fail();
  const [taskId, revision, path] = verb === 'grant' ? args : args.slice(1);
  const scope = scoped
    ? {
        taskId,
        revision,
        path,
        expectedSpecVersion: integer(f['spec-version'], 1, Number.MAX_SAFE_INTEGER),
        expectedScopeVersion: integer(f['scope-version'], 1, Number.MAX_SAFE_INTEGER)
      }
    : null;
  if (nativeFlags.some((k) => f[k] !== undefined)) {
    if (f.backend !== 'native' || nativeFlags.some((k) => !f[k])) fail();
    for (const k of nativeFlags) scope[k] = f[k];
  }
  // Job clients never probe, start, or call the owner's service.
  if (verb === 'read' || verb === 'observe' || verb === 'search') {
    const packet = {
      version: 1,
      id: args[0],
      workspaceRoot: await realpath(workspaceRoot),
      ...scope,
      action:
        verb === 'read' ? 'file.read' : verb === 'search' ? 'file.search' : 'observation.append'
    };
    if (verb === 'observe') {
      if (!f.stdin) fail();
      packet.text = await inputNote();
      packet.operationId = operationId;
    } else if (verb === 'search') {
      if (scope.backend !== 'native' || !f.query) fail();
      for (const k of ['query', 'mode', 'language']) if (f[k] !== undefined) packet[k] = f[k];
    } else {
      if (f.after !== undefined) packet.offset = integer(f.after, 0, Number.MAX_SAFE_INTEGER);
      if (f.limit !== undefined) packet.limit = integer(f.limit, 1, 16384);
    }
    const reply =
      packet.backend === 'native'
        ? await runRestrictedJob({ dataDir, credentialFile: credential, packet })
        : await callJobService(dataDir, credential, packet);
    return print(reply.result);
  }
  let input;
  if (verb === 'grant') {
    const base = { ...scope, actions: f.action, ttlSeconds: integer(f.ttl, 1, 3600) };
    normalizeJobGrant({ ...base, credentialDigest: '0'.repeat(64) });
    let identity;
    try {
      identity = await createJobCredential(credential);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      identity = await inspectJobCredential(credential);
    }
    input = { ...base, ...identity };
  } else if (verb === 'revoke') {
    input = { id: args[0] };
  } else {
    input = { taskId: args[0] };
    if (f.after !== undefined) input.after = integer(f.after, 0, Number.MAX_SAFE_INTEGER);
    if (f.limit !== undefined) input.limit = integer(f.limit, 1, 100);
  }
  const daemon = await ensureDaemon(dataDir, workspaceRoot);
  try {
    return print(
      (
        await callService(dataDir, {
          name: 'job.' + verb,
          operationId,
          input,
          workspaceRoot: daemon.workspaceRoot
        })
      ).result
    );
  } catch (error) {
    if (operationId && (!error.status || error.status >= 500))
      throw Object.assign(
        Error(
          'Job command outcome unknown. Retry the same input, credential file and operation ID.'
        ),
        { exitCode: 4 }
      );
    throw error;
  }
}
