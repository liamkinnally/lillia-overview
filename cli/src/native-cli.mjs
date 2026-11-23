import searchHelp from './native-search-help.json' with { type: 'json' };
import { parseArgs, inspect } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { ensureDaemon, callService, MAX_BODY } from './local-service.mjs';

const help = `lillia native [--json] COMMAND
  status | init REPOSITORY
  drafts REPOSITORY | ref REPOSITORY DRAFT
  draft create REPOSITORY DRAFT [--from-draft NAME --from-revision ID]
  draft update REPOSITORY DRAFT EXPECTED_REVISION GENERATION --message TEXT (--file EDITS.json | --stdin)
  revision|history|tree REPOSITORY DRAFT REVISION
  file REPOSITORY DRAFT REVISION PATH [--offset BYTE] [--limit BYTES]
  search REPOSITORY DRAFT REVISION QUERY [--mode text|path|regex|glob|definition] [--language python] [--prefix PATH] [--submission ID]
  diff REPOSITORY DRAFT REVISION BASE [--path PATH]
  Use --cursor CURSOR and --limit COUNT on paginated views. Mutations accept --operation-id ID.

Search examples
${Object.entries(searchHelp.modes)
  .map(([mode, { example, hint }]) => '  ' + mode + '  ' + JSON.stringify(example) + '  ' + hint)
  .join('\n')}`;
const usage = (msg) =>
  Object.assign(new Error(msg + '\nSee lillia native --help.'), { exitCode: 2 });
const flags = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  stdin: { type: 'boolean' }
};
for (const k of [
  'from-draft',
  'from-revision',
  'message',
  'file',
  'operation-id',
  'offset',
  'limit',
  'mode',
  'prefix',
  'path',
  'cursor',
  'language',
  'submission'
])
  flags[k] = { type: 'string' };
const specs = {
  status: [0],
  init: [1, 'operation-id'],
  drafts: [1, 'limit', 'cursor'],
  ref: [2],
  'draft.create': [2, 'from-draft', 'from-revision', 'operation-id'],
  'draft.update': [4, 'message', 'file', 'stdin', 'operation-id'],
  revision: [3, 'limit', 'cursor'],
  history: [3, 'limit', 'cursor'],
  tree: [3, 'limit', 'cursor', 'prefix'],
  file: [4, 'limit', 'offset', 'submission'],
  search: [4, 'limit', 'cursor', 'prefix', 'mode', 'language', 'submission'],
  diff: [4, 'limit', 'cursor', 'prefix', 'path']
};
function number(value, min, max) {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max)
    throw usage('Invalid numeric option');
  return n;
}
async function editInput(flags) {
  if (flags.stdin && process.stdin.isTTY) throw usage('Pipe an edit array into --stdin');
  const stream = flags.stdin ? process.stdin : createReadStream(flags.file);
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_BODY) throw usage('Edit input exceeds 1 MiB');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    );
    if (Array.isArray(value)) return value;
  } catch {}
  throw usage('Expected a UTF-8 JSON array of native file edits');
}
export async function parseNativeCli(argv, { readEdits = editInput } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: flags });
  } catch (e) {
    throw usage(e.message);
  }
  const { values: f, positionals: terms } = parsed;
  if (f.help || !terms.length) return { help };
  let op = terms.shift();
  if (op === 'draft') op += '.' + terms.shift();
  const spec = Object.hasOwn(specs, op) ? specs[op] : null;
  if (
    !spec ||
    terms.length !== spec[0] ||
    Object.keys(f).some((k) => k !== 'json' && !spec.includes(k))
  )
    throw usage('Invalid native command, arguments or options');
  const [repository, name, revisionId, last] = terms,
    input = {};
  if (repository !== undefined) input.repository = repository;
  if (name !== undefined) input.name = name;
  if (revisionId !== undefined && op !== 'draft.update') input.revisionId = revisionId;
  if (
    op === 'draft.create' &&
    (Object.hasOwn(f, 'from-draft') || Object.hasOwn(f, 'from-revision'))
  ) {
    if (!f['from-draft'] || !f['from-revision'])
      throw usage('Supply both --from-draft and --from-revision');
    input.sourceDraft = f['from-draft'];
    input.sourceRevision = f['from-revision'];
  }
  if (op === 'draft.update') {
    if (!f.message || Number(Boolean(f.stdin)) + Number(f.file !== undefined) !== 1)
      throw usage('Supply --message and either --file or --stdin');
    input.expectedRevision = revisionId;
    input.expectedGeneration = number(last, 1, Number.MAX_SAFE_INTEGER);
    input.message = f.message;
    input.edits = await readEdits(f);
  }
  if (op === 'search') input.query = last;
  if (op === 'file') input.path = last;
  if (op === 'diff') input.base = last;
  if (f.submission !== undefined) input.submissionId = f.submission;
  for (const k of ['path', 'mode', 'prefix', 'cursor', 'language'])
    if (f[k] !== undefined) input[k] = f[k];
  if (f.limit !== undefined) input.limit = number(f.limit, 1, op === 'file' ? 65536 : 100);
  if (f.offset !== undefined) input.offset = number(f.offset, 0, Number.MAX_SAFE_INTEGER);
  const mutation = spec.includes('operation-id');
  if (f['operation-id'] !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(f['operation-id']))
    throw usage('Invalid operation ID');
  return {
    name: 'native.' + op,
    input,
    json: Boolean(f.json),
    operationId: mutation ? (f['operation-id'] ?? randomUUID()) : undefined
  };
}
export async function runNativeCli(argv, { dataDir, workspaceRoot }) {
  const req = await parseNativeCli(argv);
  if (req.help) {
    console.log(req.help);
    return;
  }
  const daemon = await ensureDaemon(dataDir, workspaceRoot);
  try {
    const { result } = await callService(dataDir, {
      name: req.name,
      input: req.input,
      operationId: req.operationId,
      workspaceRoot: daemon.workspaceRoot
    });
    console.log(
      req.json
        ? JSON.stringify({ version: 1, result })
        : inspect(result, { depth: null, colors: process.stdout.isTTY, compact: false })
    );
  } catch (e) {
    if (req.operationId && (!e.status || e.status >= 500)) {
      e.message +=
        '\nCommand outcome unknown. Retry the same input with --operation-id ' + req.operationId;
      e.exitCode = 4;
    }
    throw e;
  }
}
