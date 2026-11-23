import { parseArgs, inspect } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFileSync, openSync, constants as C, fstatSync, closeSync } from 'node:fs';
import { callService, ensureDaemon } from './local-service.mjs';

const help = `lillia policy [--json] COMMAND
  status | update REPOSITORY EXPECTED_POLICY_DIGEST --file POLICY.json
  thread REVISION
  comment REVISION old|new LINE comment|blocking TEXT
  resolve REVISION FINDING_ID NOTE
  decide REVISION PATCH_DIGEST approve|reject NOTE
  Mutations accept --operation-id ID. Policy files contain ordinaryPaths, ownerReviewPaths and checks.`;
const usage = (msg) =>
  Object.assign(new Error(msg + '\nSee lillia policy --help.'), { exitCode: 2 });
function file(path) {
  const fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 32768)
      throw usage('Select a regular policy JSON file of at most 32 KiB');
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    if (
      !value ||
      Object.keys(value).length !== 3 ||
      !['ordinaryPaths', 'ownerReviewPaths', 'checks'].every((k) => Array.isArray(value[k]))
    )
      throw usage('Policy must name the three array fields');
    return value;
  } finally {
    closeSync(fd);
  }
}
export async function runPolicyCli(argv, { dataDir, workspaceRoot }) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        file: { type: 'string' },
        'operation-id': { type: 'string' }
      }
    });
  } catch (e) {
    throw usage(e.message);
  }
  const {
    values: f,
    positionals: [raw, ...p]
  } = parsed;
  const op = raw === 'update' ? 'set' : raw === 'decide' ? 'owner' : raw;
  if (!op || f.help) {
    console.log(help);
    return;
  }
  const arity = { status: 0, set: 2, thread: 1, comment: 5, resolve: 3, owner: 4 };
  if (
    !Object.hasOwn(arity, op) ||
    p.length !== arity[op] ||
    Boolean(f.file) !== (op === 'set') ||
    (['thread', 'status'].includes(op) && f['operation-id'])
  )
    throw usage('Unexpected native policy arguments');
  const name =
    op === 'set' ? 'authority.policy' : op === 'status' ? 'authority.status' : 'review.' + op;
  let input;
  if (op === 'status') input = {};
  else if (op === 'set') input = { repository: p[0], expectedPolicyDigest: p[1], ...file(f.file) };
  else if (op === 'thread') input = { revisionId: p[0] };
  else if (op === 'comment') {
    if (!/^[1-9]\d*$/.test(p[2])) throw usage('Choose a one-based exact line number');
    input = { revisionId: p[0], side: p[1], line: Number(p[2]), kind: p[3], text: p[4] };
  } else if (op === 'resolve') input = { revisionId: p[0], findingId: p[1], note: p[2] };
  else input = { revisionId: p[0], patchDigest: p[1], decision: p[2], note: p[3] };
  const daemon = await ensureDaemon(dataDir, workspaceRoot),
    operationId = ['thread', 'status'].includes(op)
      ? undefined
      : (f['operation-id'] ?? randomUUID());
  try {
    const { result } = await callService(dataDir, {
      name,
      input,
      workspaceRoot: daemon.workspaceRoot,
      operationId
    });
    console.log(
      f.json
        ? JSON.stringify({ version: 1, result })
        : inspect(result, { depth: null, colors: process.stdout.isTTY, compact: false })
    );
  } catch (e) {
    if (operationId && (!e.status || e.status >= 500)) {
      e.message +=
        '\nCommand outcome unknown. Retry the same arguments with --operation-id ' + operationId;
      e.exitCode = 4;
    }
    throw e;
  }
}
