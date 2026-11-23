#!/usr/bin/env node
import { constants, createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs, inspect } from 'node:util';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { callService, daemonStatus, ensureDaemon, stopDaemon, MAX_BODY } from './local-service.mjs';
import { maxChatAttachments, maxChatAttachmentBytes } from './chat-attachments.mjs';

const help = `lillia                      Open an interactive Codex project session
  lillia session              Open the same session explicitly
  lillia [--json] COMMAND
  lillia setup                Configure this Git project
  lillia run "issue"          Start a reviewed coding task
  lillia progress [goal]      Read task status
  lillia result [goal]        Export the approved change
  js enroll --file RECIPE.json | recipes | show RECIPE_ID
  authority migrate GIT_TARGET GENERATION REPOSITORY DRAFT NATIVE_REVISION DRAFT_GENERATION CUTOFF DRAIN_GENERATION
  policy status | update | thread | comment | resolve | decide (see lillia policy --help)
  compat open | export | checkout | submit | probe | inspect | inspection | show (see lillia compat --help)
  install manifest | init | stage | status | activate | abandon (see lillia install --help)
  daemon start | status | stop
  daemon start --profile codex-only [--codex-slots 1..4]
  daemon drain-status | drain EXPECTED_GENERATION | resume CUTOFF EXPECTED_GENERATION
  status
  goal create [--worker-provider codex|claude] [--max-attempts N] --criterion TEXT TEXT
  goal create [--worker-provider codex|claude] --expect-output TEXT TEXT
  chat send TEXT [--attach PATH ...] | chat send --stdin | chat read [--before N] [--limit N]
  chat attachment TURN_ID INDEX
  provider usage codex|claude
  goal list [--after N] [--limit N] | goal show ID
  goal develop BASE PATH OBJECTIVE --author codex|claude --reviewer claude|codex [--max-attempts N]
  goal repair GOAL_ID REJECTED_SUBMISSION DECISION
  goal run|pause|resume|cancel ID --version N
  goal amend ID --version N --criterion TEXT TEXT
  goal accept ID --version N --criterion-id ID --task-id ID --note TEXT
  task handoff SOURCE_TASK --version N --provider codex|claude --digest FINAL_SHA256 --context-digest INPUT_MANIFEST_SHA256 --rejected-approach TEXT INSTRUCTIONS
  task submit GOAL_ID [--provider codex|claude] TEXT | task show ID | task cancel ID | task reconcile ID
  research import DIRECTORY | versions | find QUERY | record ID | passage DOC_ID START END
  research run --file PINNED_INPUT.json | runs [--after N] [--limit N] | investigation ID
  research fetch CATALOG_VERSION SOURCE_ID GIT_COMMIT PATH
  research library documents|notes [--after N] [--limit COUNT] | citation DOCUMENT_ID START END
  research note --file NOTE.json | noted NOTE_ID
  research disclosure RUN_ID | grant RUN_ID --digest SHA256 --for-operation ID --to PROVIDER ...
  research permission GRANT_ID | revoke GRANT_ID
  native status | init | drafts | draft create|update | revision | history | tree | file | search | diff (see lillia native --help)
  project start REPO [--profile PROFILE] --operation-id ID OBJECTIVE
  project validation-enroll REPO BASE COMPONENT TEST [--profile darwin-league-sample-profile-vitest-v2] [--operation-id ID]
  project develop REPO BASE --generation N --policy DIGEST --recipe ID --claude-model MODEL --max-attempts N --max-active-seconds N OBJECTIVE
  project retry-review GOAL TASK ATTEMPT CANDIDATE --extra-active-seconds 300 --operation-id ID REASON
  project repair GOAL CANDIDATE REVIEW_DIGEST --max-attempts N --max-active-seconds N --operation-id ID INSTRUCTIONS
  project register [EXPECTED_REVISION] | status | capture ID
  bridge import REPOSITORY GIT_REVISION DRAFT | mapping REPOSITORY DRAFT NATIVE_REVISION
  authority activate REPOSITORY DRAFT NATIVE_REVISION GENERATION [--native-review-path PATH ...] [--checks-file FILE]
  authority status | submissions [--author PRINCIPAL_OR_PROVIDER] [--task-id ID] [--repository ID] [--dependency ID] [--owner ROUTE] [--status STATE] [--after N] [--limit COUNT] | review SUBMISSION_ID
  queue status
  release bisect FAILED_RELEASE GOOD_GENERATION | diagnosis ID
  release revert DIAGNOSIS CURRENT_TARGET GENERATION | proposal ID
  release prepare SUBMISSION_ID NATIVE_TARGET GENERATION [--checks-file FILE] | show ID | artifact ID
  bridge export REPOSITORY DRAFT NATIVE_REVISION DESTINATION.bundle
  bridge abandon EXPORT_OPERATION_ID EXPECTED_DIGEST
  worktree preview BASE PATH [PATH ...] | capture BASE PATH [PATH ...] --preview SHA256 | show ID
  source search REVISION QUERY [--mode path|text] | diff BASE REVISION [PATH]
  source file REVISION PATH [--after BYTE_OFFSET] [--limit BYTES]
  review init BASE [--native-review-path PATH ...] [--checks-file JSON_FILE] | status | show CHANGE_OR_REVISION
  review submit BASE TASK_ID [--requires REVISION ...] [--change ID --previous REVISION_ID]
  review decide REVISION_ID approve|reject --note TEXT
  review attest REVISION_ID REVIEWER_TASK_ID
  review check REVISION_ID TARGET GENERATION | land REVISION_ID CHECK_ID TARGET GENERATION
  backup create DESTINATION | restore ARCHIVE NEW_DIRECTORY | inspect DIRECTORY [KIND [ID]]
  backup inspect DIRECTORY chat|chat.attachment [TURN_ID INDEX] [--thread-id ID]
  backup compare RESTORED_DIRECTORY PREDECESSOR_DIRECTORY
  mail list GOAL_ID [--task-id ID] | post GOAL_ID TASK_ID KIND TEXT --version N
  mail resolve GOAL_ID MESSAGE_ID TEXT --version N [--digest SHA256]
  job grant | revoke | observations | read | observe (see lillia job --help)
  operation show ID
  events [--after ID] [--limit PAGE_SIZE] [--follow]

Use --file PATH or --stdin in place of TEXT. Mutations accept --operation-id ID.
Configure paths with LILLIA_DATA_DIR and LILLIA_WORKSPACE_ROOT.`;
const usage = (message) => Object.assign(new Error(message), { exitCode: 2 });
const options = {
  'context-digest': { type: 'string' },
  'rejected-approach': { type: 'string' },
  profile: { type: 'string' },
  'codex-slots': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  stdin: { type: 'boolean' },
  file: { type: 'string' },
  attach: { type: 'string', multiple: true },
  criterion: { type: 'string', multiple: true },
  'operation-id': { type: 'string' },
  'max-attempts': { type: 'string' },
  after: { type: 'string' },
  before: { type: 'string' },
  limit: { type: 'string' },
  version: { type: 'string' },
  catalog: { type: 'string' },
  'expect-output': { type: 'string', multiple: true },
  'criterion-id': { type: 'string' },
  'task-id': { type: 'string' },
  'thread-id': { type: 'string' },
  note: { type: 'string' },
  'worker-provider': { type: 'string' },
  provider: { type: 'string' },
  mode: { type: 'string' },
  submission: { type: 'string' },
  language: { type: 'string' },
  prefix: { type: 'string' },
  cursor: { type: 'string' },
  follow: { type: 'boolean' },
  repository: { type: 'string' },
  owner: { type: 'string' },
  status: { type: 'string' },
  change: { type: 'string' },
  previous: { type: 'string' },
  dependency: { type: 'string' },
  acceptance: { type: 'string' },
  digest: { type: 'string' },
  requires: { type: 'string', multiple: true },
  'native-review-path': { type: 'string', multiple: true },
  'checks-file': { type: 'string' },
  author: { type: 'string' },
  reviewer: { type: 'string' },
  'owner-policy': { type: 'string' },
  'js-recipe': { type: 'string' },
  planner: { type: 'string' },
  'compat-id': { type: 'string' },
  'revert-id': { type: 'string' },
  'max-active-seconds': { type: 'string' },
  'after-version': { type: 'string' },
  'history-limit': { type: 'string' },
  preview: { type: 'string' },
  'for-operation': { type: 'string' },
  to: { type: 'string', multiple: true },
  'research-grant': { type: 'string' },
  'claude-model': { type: 'string' }
};
const dataDir = resolve(
  process.env.LILLIA_DATA_DIR ||
    process.env.SCION_DATA_DIR ||
    join(homedir(), '.local', 'share', 'scion')
);
const workspaceRoot = resolve(
  process.env.LILLIA_WORKSPACE_ROOT || process.env.SCION_WORKSPACE_ROOT || process.cwd()
);

async function inputText(args, flags) {
  if (args.length + Number(Boolean(flags.stdin)) + Number(flags.file !== undefined) !== 1)
    throw usage('Supply one text argument, --stdin, or --file PATH');
  if (args.length) return args[0];
  if (flags.stdin && process.stdin.isTTY) throw usage('Pipe input or redirect a file for --stdin');
  const parts = [];
  let size = 0;
  for await (const chunk of flags.stdin ? process.stdin : createReadStream(flags.file)) {
    size += chunk.length;
    if (size > MAX_BODY) throw usage('Input exceeds 1 MiB');
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString('utf8');
}

function integer(value, min, max) {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max)
    throw usage('Expected an integer from ' + min + ' to ' + max);
  return n;
}

async function localAttachments(paths) {
  if (paths.length > maxChatAttachments)
    throw usage('A message accepts up to ' + maxChatAttachments + ' attachments.');
  const attachments = [];
  let remaining = maxChatAttachmentBytes;
  for (const path of paths) {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw usage('Choose a regular text file.');
      const parts = [];
      for await (const bytes of file.createReadStream({
        start: 0,
        end: remaining,
        autoClose: false
      })) {
        remaining -= bytes.length;
        if (remaining < 0) throw usage('Attachments exceed the combined 8 KiB size limit.');
        parts.push(bytes);
      }
      attachments.push({
        kind: 'local',
        filename: basename(path),
        base64: Buffer.concat(parts).toString('base64')
      });
    } finally {
      await file.close();
    }
  }
  return attachments;
}

function attachmentLocation(take) {
  return {
    turnId: integer(take('Chat turn'), 1, Number.MAX_SAFE_INTEGER),
    index: integer(take('Attachment index'), 0, maxChatAttachments - 1)
  };
}

async function run() {
  const raw = process.argv.slice(2),
    jobIndex = raw[0] === '--json' ? 1 : 0;
  if (
    (!raw.length && process.stdin.isTTY && process.stdout.isTTY) ||
    (raw.length === 1 && raw[0] === 'session')
  ) {
    const { runTerminalSession } = await import('./terminal-session.mjs');
    return runTerminalSession();
  }
  if (['setup', 'run', 'progress', 'result'].includes(raw[0])) {
    const { runGuidedCli } = await import('./guided-cli.mjs');
    return runGuidedCli(raw);
  }
  if (
    raw[jobIndex] === 'project' &&
    ['validation-enroll', 'develop', 'retry-review', 'start', 'repair'].includes(raw[jobIndex + 1])
  ) {
    const { runProjectCli } = await import('./project-cli.mjs');
    return runProjectCli([...raw.slice(0, jobIndex), ...raw.slice(jobIndex + 1)], {
      dataDir,
      workspaceRoot
    });
  }
  if (raw[jobIndex] === 'policy') {
    const { runPolicyCli } = await import('./policy-cli.mjs');
    return runPolicyCli([...raw.slice(0, jobIndex), ...raw.slice(jobIndex + 1)], {
      dataDir,
      workspaceRoot
    });
  }
  if (raw[jobIndex] === 'compat') {
    const { runCompatCli } = await import('./compat-cli.mjs');
    return runCompatCli([...raw.slice(0, jobIndex), ...raw.slice(jobIndex + 1)], {
      dataDir,
      workspaceRoot
    });
  }
  if (raw[jobIndex] === 'install') {
    const { runInstallCli } = await import('./install-cli.mjs');
    return runInstallCli([...raw.slice(0, jobIndex), ...raw.slice(jobIndex + 1)]);
  }
  if (raw[jobIndex] === 'native') {
    const { runNativeCli } = await import('./native-cli.mjs');
    return runNativeCli([...raw.slice(0, jobIndex), ...raw.slice(jobIndex + 1)], {
      dataDir,
      workspaceRoot
    });
  }
  if (raw[jobIndex] === 'job') {
    const { runJobCli } = await import('./job-cli.mjs');
    return runJobCli([...raw.slice(0, jobIndex), ...raw.slice(jobIndex + 1)], {
      dataDir,
      workspaceRoot
    });
  }
  let parsed;
  try {
    parsed = parseArgs({ options, allowPositionals: true });
  } catch (error) {
    throw usage(error.message);
  }
  const { values: flags, positionals: args } = parsed;
  if (flags.help || !args.length) {
    console.log(help);
    return;
  }
  const group = args.shift();
  const name = [
    'js',
    'provider',
    'chat',
    'queue',
    'release',
    'authority',
    'bridge',
    'goal',
    'task',
    'daemon',
    'research',
    'operation',
    'project',
    'source',
    'review',
    'backup',
    'mail',
    'worktree'
  ].includes(group)
    ? group + '.' + args.shift()
    : group;
  const goalControl = [
    'goal.run',
    'goal.pause',
    'goal.resume',
    'goal.cancel',
    'goal.amend',
    'goal.accept'
  ].includes(name);
  const acceptsText = [
    'chat.send',
    'goal.create',
    'goal.develop',
    'goal.amend',
    'task.submit',
    'task.handoff'
  ].includes(name);
  const control = ['task.cancel', 'task.reconcile'].includes(name);
  const mutation =
    acceptsText ||
    control ||
    goalControl ||
    [
      'js.enroll',
      'authority.migrate',
      'research.fetch',
      'research.note',
      'goal.repair',
      'release.bisect',
      'release.revert',
      'release.prepare',
      'authority.activate',
      'bridge.import',
      'bridge.export',
      'bridge.abandon',
      'daemon.drain',
      'daemon.resume',
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
    ].includes(name);
  const allowed = new Set(['json', 'help']);
  if (name === 'daemon.start') {
    allowed.add('profile');
    allowed.add('codex-slots');
  }
  if (mutation) allowed.add('operation-id');
  if (acceptsText) for (const option of ['stdin', 'file']) allowed.add(option);
  if (name === 'goal.create' || name === 'goal.amend') {
    allowed.add('criterion');
    allowed.add('expect-output');
  }
  if (name === 'goal.create') allowed.add('max-attempts');
  if (name === 'goal.create') allowed.add('worker-provider');
  if (name === 'goal.develop')
    for (const option of [
      'author',
      'reviewer',
      'max-attempts',
      'requires',
      'revert-id',
      'compat-id',
      'owner-policy',
      'js-recipe',
      'planner'
    ])
      allowed.add(option);
  if (name === 'release.prepare') allowed.add('checks-file');
  if (name === 'goal.create' || name === 'goal.develop') allowed.add('max-active-seconds');
  const goalHistory = name === 'goal.show' || (name === 'backup.inspect' && args[1] === 'goal');
  if (goalHistory) for (const option of ['after-version', 'history-limit']) allowed.add(option);
  if (name === 'goal.show') for (const option of ['after', 'limit']) allowed.add(option);
  if (name === 'research.run' || name === 'research.note' || name === 'js.enroll') {
    allowed.add('file');
    allowed.add('stdin');
  }
  if (name === 'research.runs') {
    allowed.add('after');
    allowed.add('limit');
  }
  if (name === 'worktree.capture') allowed.add('preview');
  if (name === 'research.grant')
    for (const opt of ['for-operation', 'to', 'digest']) allowed.add(opt);
  if (name === 'goal.develop') allowed.add('research-grant');
  if (name === 'goal.develop' || name === 'goal.create') allowed.add('claude-model');
  if (name === 'task.handoff')
    for (const option of ['version', 'provider', 'digest', 'context-digest', 'rejected-approach'])
      allowed.add(option);
  if (name === 'task.submit') allowed.add('provider');
  if (goalControl) allowed.add('version');
  if (name === 'goal.accept')
    for (const option of ['criterion-id', 'task-id', 'note']) allowed.add(option);
  if (name === 'authority.submissions')
    for (const key of ['author', 'task-id', 'repository', 'dependency', 'owner', 'status'])
      allowed.add(key);
  if (
    name === 'events' ||
    name === 'goal.list' ||
    name === 'authority.submissions' ||
    name === 'research.library'
  )
    for (const option of ['after', 'limit']) allowed.add(option);
  if (name === 'chat.read') for (const option of ['before', 'limit']) allowed.add(option);
  if (name === 'chat.send') allowed.add('attach');
  if (name === 'events') allowed.add('follow');
  if (['research.import', 'research.find', 'research.passage', 'research.record'].includes(name))
    allowed.add('catalog');
  if (['research.versions', 'research.find'].includes(name)) allowed.add('limit');
  if (name === 'source.search')
    for (const option of ['mode', 'limit', 'after']) allowed.add(option);
  if (name === 'source.file') {
    allowed.add('limit');
    allowed.add('after');
  }
  if (name === 'source.diff' || name === 'project.status') allowed.add('limit');
  if (name === 'review.submit') {
    allowed.add('change');
    allowed.add('previous');
    allowed.add('requires');
  }
  if (name === 'review.init' || name === 'authority.activate') {
    allowed.add('native-review-path');
    allowed.add('checks-file');
  }
  if (name === 'review.decide') allowed.add('note');
  if (name === 'backup.inspect') {
    allowed.add('catalog');
    allowed.add('limit');
    if (args[1] === 'chat') allowed.add('before');
    if (['chat', 'chat.attachment'].includes(args[1])) allowed.add('thread-id');
    if (['native.file', 'native.search'].includes(args[1])) allowed.add('submission');
    if (args[1] === 'native.search')
      for (const k of ['mode', 'language', 'prefix', 'cursor']) allowed.add(k);
  }
  if (name === 'mail.list') for (const option of ['task-id', 'after', 'limit']) allowed.add(option);
  if (name === 'mail.post')
    for (const option of ['version', 'dependency', 'acceptance', 'expect-output', 'stdin', 'file'])
      allowed.add(option);
  if (name === 'mail.resolve')
    for (const option of ['version', 'digest', 'stdin', 'file']) allowed.add(option);
  for (const key of Object.keys(flags))
    if (!allowed.has(key)) throw usage('--' + key + ' is invalid for ' + name);

  let input = {};
  if (flags['claude-model']) input.claudeModel = flags['claude-model'];
  if (flags['max-active-seconds'])
    input.maxActiveSeconds = integer(flags['max-active-seconds'], 1, 604800);
  if (name === 'goal.show') {
    if (flags.after) input.after = integer(flags.after, 0, Number.MAX_SAFE_INTEGER);
    if (flags.limit) input.limit = integer(flags.limit, 1, 100);
  }
  if (goalHistory) {
    if (flags['after-version'] !== undefined)
      input.afterVersion = integer(flags['after-version'], 0, Number.MAX_SAFE_INTEGER);
    if (flags['history-limit'] !== undefined)
      input.historyLimit = integer(flags['history-limit'], 1, 16);
  }
  if (goalControl) {
    input.id = args.shift();
    if (!input.id) throw usage('Goal ID required');
    input.expectedVersion = integer(flags.version, 1, Number.MAX_SAFE_INTEGER);
  }
  const operationId = mutation ? (flags['operation-id'] ?? randomUUID()) : undefined;
  const take = (label) => {
    const value = args.shift();
    if (!value) throw usage(label + ' required');
    return value;
  };
  let rpc = name;
  switch (name) {
    case 'provider.usage':
      input.provider = take('Provider');
      break;
    case 'chat.send':
      input.text = await inputText(args.splice(0), flags);
      if (flags.attach) input.attachments = await localAttachments(flags.attach);
      break;
    case 'chat.attachment':
      Object.assign(input, attachmentLocation(take));
      break;
    case 'chat.read':
      if (flags.before) input.before = integer(flags.before, 1, Number.MAX_SAFE_INTEGER);
      if (flags.limit) input.limit = integer(flags.limit, 1, 32);
      break;
    case 'bridge.import':
      input.repository = take('Repository');
      input.head = take('Retained Git revision');
      input.draft = take('New native draft');
      break;
    case 'bridge.export':
    case 'bridge.mapping':
      input.repository = take('Repository');
      input.draft = take('Native draft');
      input.revisionId = take('Native revision');
      if (name === 'bridge.export') input.destination = resolve(take('New bundle destination'));
      break;
    case 'bridge.abandon':
      input.operationId = take('Original export operation ID');
      input.expectedDigest = take('Expected export digest');
      break;
    case 'goal.repair':
      input.id = take('Blocked goal');
      input.revisionId = take('Rejected submission');
      input.decisionId = take('Rejected decision');
      break;
    case 'goal.develop':
      if (flags.planner) input.plannerProvider = flags.planner;
      if (flags['js-recipe']) input.jsRecipe = flags['js-recipe'];
      if (flags['owner-policy']) input.ownerPolicy = flags['owner-policy'];
      if (flags['compat-id']) input.compatId = flags['compat-id'];
      if (flags['revert-id']) input.revertId = flags['revert-id'];
      if (flags.requires) input.requires = flags.requires;
      input.base = take('Base revision');
      input.path = take('Authorized relative path');
      if (!flags.author || !flags.reviewer)
        throw usage('Supply --author and --reviewer for the two independent roles.');
      input.authorProvider = flags.author;
      input.reviewerProvider = flags.reviewer;
      input.maxAttempts = integer(flags['max-attempts'] ?? (flags.planner ? '3' : '2'), 2, 8);
      if (flags['research-grant']) input.researchGrantId = flags['research-grant'];
      input.objective = await inputText(args.splice(0), flags);
      break;
    case 'mail.list':
      input.goalId = take('Goal ID');
      if (flags['task-id']) input.taskId = flags['task-id'];
      if (flags.after) input.after = integer(flags.after, 0, Number.MAX_SAFE_INTEGER);
      if (flags.limit) input.limit = integer(flags.limit, 1, 100);
      break;
    case 'mail.post':
    case 'mail.resolve':
      input.goalId = take('Goal ID');
      input.expectedVersion = integer(flags.version, 1, Number.MAX_SAFE_INTEGER);
      if (name === 'mail.post') {
        input.recipientTaskId = take('Recipient task ID');
        input.kind = take('Message kind');
        if (flags.dependency) input.dependencyTaskId = flags.dependency;
        if (flags.acceptance) input.acceptance = flags.acceptance;
        if (flags['expect-output']?.length > 1)
          throw usage('Supply one expected dependency output.');
        if (flags['expect-output']) input.expectedOutput = flags['expect-output'][0];
      } else {
        input.messageId = take('Message ID');
        if (flags.digest) input.expectedDigest = flags.digest;
      }
      input.text = await inputText(args.splice(0), flags);
      break;
    case 'backup.create':
      input.destination = resolve(take('Backup destination'));
      break;
    case 'backup.restore':
      input.source = resolve(take('Archive directory'));
      input.destination = resolve(take('New data directory'));
      break;
    case 'backup.compare':
      input.restoredDirectory = resolve(take('Restored directory'));
      input.predecessorDirectory = resolve(take('Original data directory'));
      break;
    case 'backup.inspect':
      input.directory = resolve(take('Restored directory'));
      input.kind = args.shift() ?? 'summary';
      if (input.kind === 'chat.attachment') Object.assign(input, attachmentLocation(take));
      if (flags['thread-id'] !== undefined) input.threadId = flags['thread-id'];
      if (
        [
          'research.noted',
          'native.review',
          'native.release',
          'native.artifact',
          'goal',
          'task',
          'operation',
          'review',
          'research.record',
          'research.passage',
          'investigation',
          'worktree'
        ].includes(input.kind)
      )
        input.id = take('Record ID');
      if (input.kind === 'research.library') input.kindFilter = take('documents or notes');
      if (input.kind === 'research.citation') {
        input.documentId = take('Document ID');
        input.startLine = integer(take('First line'), 1, Number.MAX_SAFE_INTEGER);
        input.endLine = integer(take('Last line'), input.startLine, input.startLine + 99);
      }
      if (
        [
          'native.tree',
          'native.file',
          'native.search',
          'native.revision',
          'native.diff',
          'native.history'
        ].includes(input.kind)
      ) {
        input.repository = take('Repository');
        input.name = take('Draft or mainline');
        input.revisionId = take('Native revision');
        if (input.kind === 'native.file') input.path = take('Path');
        if (input.kind === 'native.diff') input.base = take('Base revision');
        if (input.kind === 'native.search') {
          input.query = take('Query');
          for (const k of ['mode', 'language', 'prefix', 'cursor'])
            if (flags[k] !== undefined) input[k] = flags[k];
        }
        if (flags.submission !== undefined) input.submissionId = flags.submission;
      }
      if (input.kind === 'git.search') input.revision = take('Revision');
      if (input.kind === 'git.file') {
        input.revision = take('Revision');
        input.path = take('File path');
      }
      if (['git.search', 'research.find'].includes(input.kind)) input.query = take('Query');
      if (input.kind === 'git.diff') {
        input.base = take('Base');
        input.revision = take('Revision');
      }
      if (input.kind === 'research.passage') {
        input.startLine = integer(take('First line'), 1, 10000000);
        input.endLine = integer(take('Last line'), input.startLine, 10000000);
      }
      if (flags.catalog) input.version = flags.catalog;
      if (flags.limit) input.limit = integer(flags.limit, 1, input.kind === 'chat' ? 32 : 100);
      if (flags.before) input.before = integer(flags.before, 1, Number.MAX_SAFE_INTEGER);
      break;
    case 'queue.status':
      break;
    case 'js.recipes':
      break;
    case 'js.show':
      input.id = take('JavaScript recipe ID');
      break;
    case 'js.enroll':
      if (!flags.file && !flags.stdin) throw usage('Supply an enrollment with --file or --stdin');
      Object.assign(input, JSON.parse(await inputText([], flags)));
      break;
    case 'authority.migrate':
      input.target = take('Protected Git target');
      input.generation = integer(take('Git generation'), 1, Number.MAX_SAFE_INTEGER);
      input.repository = take('Native repository');
      input.draft = take('Imported draft');
      input.revision = take('Native revision');
      input.expectedGeneration = integer(take('Draft generation'), 1, Number.MAX_SAFE_INTEGER);
      input.cutoff = take('Named drain cutoff');
      input.drainGeneration = integer(take('Drain generation'), 1, Number.MAX_SAFE_INTEGER);
      break;
    case 'release.diagnosis':
    case 'release.proposal':
      input.id = take('Record ID');
      break;
    case 'release.bisect':
      input.releaseId = take('Failed release ID');
      input.goodGeneration = integer(take('Passing generation'), 1, Number.MAX_SAFE_INTEGER);
      break;
    case 'release.revert':
      input.diagnosisId = take('Diagnosis ID');
      input.expectedTarget = take('Native target');
      input.expectedGeneration = integer(take('Target generation'), 1, Number.MAX_SAFE_INTEGER);
      break;
    case 'release.prepare':
      input.revisionId = take('Submission ID');
      input.expectedTarget = take('Landed target');
      input.expectedGeneration = integer(take('Target generation'), 2, Number.MAX_SAFE_INTEGER);
      if (flags['checks-file'])
        input.checks = JSON.parse(await inputText([], { file: flags['checks-file'] }));
      break;
    case 'release.show':
    case 'release.artifact':
      input.id = take('Release candidate ID');
      break;
    case 'authority.submissions':
      for (const k of ['author', 'task-id', 'repository', 'dependency', 'owner', 'status'])
        if (flags[k] !== undefined) input[k === 'task-id' ? 'task' : k] = flags[k];
      if (flags.after !== undefined) input.after = integer(flags.after, 0, Number.MAX_SAFE_INTEGER);
      if (flags.limit !== undefined) input.limit = integer(flags.limit, 1, 100);
      break;
    case 'authority.status':
      break;
    case 'authority.review':
      input.id = take('Submission ID');
      break;
    case 'authority.activate':
    case 'review.init':
      if (name === 'authority.activate') {
        input.repository = take('Native repository');
        input.draft = take('Seed draft');
        input.revision = take('Exact native revision');
        input.expectedGeneration = integer(take('Draft generation'), 1, Number.MAX_SAFE_INTEGER);
        input.allowedPaths = flags['native-review-path'] ?? [];
        input.checks = [];
      } else {
        input.base = take('Base revision');
        if (flags['native-review-path']) input.nativeReviewPaths = flags['native-review-path'];
      }
      if (flags['checks-file']) {
        const body = await inputText([], { file: flags['checks-file'] });
        try {
          input.checks = JSON.parse(body);
        } catch {
          throw usage('Expected a JSON array in the check recipe file.');
        }
      }
      break;
    case 'review.status':
      break;
    case 'review.show':
      input.id = take('Revision or change ID');
      break;
    case 'review.submit':
      input.base = take('Base revision');
      input.taskId = take('Author task ID');
      if (flags.requires) input.requires = flags.requires;
      if (flags.change || flags.previous) {
        if (!flags.change || !flags.previous)
          throw usage('Repair requires --change and --previous together.');
        input.changeId = flags.change;
        input.expectedRevision = flags.previous;
      }
      break;
    case 'review.attest':
      input.revisionId = take('Revision ID');
      input.taskId = take('Reviewer task ID');
      break;
    case 'review.decide':
      input.revisionId = take('Revision ID');
      input.decision = take('Decision');
      if (!flags.note) throw usage('Supply a review note with --note.');
      input.note = flags.note;
      break;
    case 'review.check':
    case 'review.land':
      input.revisionId = take('Revision ID');
      if (name === 'review.land') input.checkId = take('Check ID');
      input.expectedTarget = take('Expected target');
      input.expectedGeneration = integer(take('Expected generation'), 1, Number.MAX_SAFE_INTEGER);
      break;
    case 'worktree.preview':
    case 'worktree.capture':
      input.base = take('Base revision');
      input.paths = [take('Selected path'), ...args.splice(0)];
      if (input.paths.length > 8) throw usage('Select one to eight working files.');
      if (name === 'worktree.capture') {
        if (!flags.preview) throw usage('Supply the working-file preview digest with --preview.');
        input.expectedPreviewDigest = flags.preview;
      }
      break;
    case 'worktree.show':
      input.id = take('Working capture ID');
      break;
    case 'project.register':
      if (args.length) input.expectedRevision = args.shift();
      break;
    case 'project.status':
      if (flags.limit) input.limit = integer(flags.limit, 1, 100);
      break;
    case 'project.capture':
      input.captureId = args.shift();
      if (!input.captureId) throw usage('Capture ID required');
      break;
    case 'source.search':
      input.revision = args.shift();
      input.query = args.shift();
      if (!input.revision || !input.query) throw usage('Supply a revision and search text.');
      if (flags.mode) input.mode = flags.mode;
      if (flags.limit) input.limit = integer(flags.limit, 1, 100);
      if (flags.after) input.after = integer(flags.after, 0, Number.MAX_SAFE_INTEGER);
      break;
    case 'source.file':
      input.revision = take('Revision');
      input.path = take('File path');
      if (flags.after) input.offset = integer(flags.after, 0, Number.MAX_SAFE_INTEGER);
      if (flags.limit) input.limit = integer(flags.limit, 1, 262144);
      break;
    case 'source.diff':
      input.base = args.shift();
      input.revision = args.shift();
      if (!input.base || !input.revision) throw usage('Supply two full retained revision IDs.');
      if (args.length) input.path = args.shift();
      if (flags.limit) input.limit = integer(flags.limit, 1, 200);
      break;
    case 'task.handoff':
      input.sourceTaskId = take('Source task ID');
      input.expectedVersion = integer(flags.version, 1, Number.MAX_SAFE_INTEGER);
      input.provider = flags.provider;
      input.sourceDigest = flags.digest;
      input.contextDigest = flags['context-digest'];
      input.rejectedApproach = flags['rejected-approach'];
      input.instructions = await inputText(args.splice(0), flags);
      break;
    case 'task.submit':
      input.goalId = args.shift();
      if (!input.goalId) throw usage('Goal ID required');
      input.prompt = await inputText(args.splice(0), flags);
      if (flags.provider) input.provider = flags.provider;
      break;
    case 'goal.create':
    case 'goal.amend':
      input.objective = await inputText(args.splice(0), flags);
      input.criteria = [
        ...(flags.criterion ?? []),
        ...(flags['expect-output'] ?? []).map((expected) => ({ type: 'exact-output', expected }))
      ];
      if (flags['max-attempts'] !== undefined)
        input.maxAttempts = integer(flags['max-attempts'], 1, 256);
      if (flags['worker-provider']) input.workerProvider = flags['worker-provider'];
      break;
    case 'operation.show':
      rpc = 'operation';
      input.id = args.shift();
      if (!input.id) throw usage('Operation ID required');
      break;
    case 'goal.accept':
      input.criterionId = flags['criterion-id'];
      input.taskId = flags['task-id'];
      input.note = flags.note;
      if (!input.criterionId || !input.taskId || !input.note)
        throw usage('Supply a criterion ID, worker task ID and review note.');
      break;
    case 'research.fetch':
      input.version = take('Catalog version');
      input.sourceId = take('Catalog source');
      input.commit = take('Full upstream Git commit');
      input.path = take('Path');
      break;
    case 'research.library':
      input.kind = take('documents or notes');
      if (flags.after !== undefined) input.after = integer(flags.after, 0, Number.MAX_SAFE_INTEGER);
      if (flags.limit !== undefined) input.limit = integer(flags.limit, 1, 100);
      break;
    case 'research.citation':
      input.documentId = take('Document ID');
      input.startLine = integer(take('First line'), 1, Number.MAX_SAFE_INTEGER);
      input.endLine = integer(take('Last line'), input.startLine, input.startLine + 99);
      break;
    case 'research.noted':
      input.id = take('Note revision');
      break;
    case 'research.note':
    case 'research.run': {
      const body = await inputText([], flags);
      let record;
      try {
        record = JSON.parse(body);
      } catch {
        throw usage('Expected a JSON input object.');
      }
      if (!record || typeof record !== 'object' || Array.isArray(record))
        throw usage('Expected a JSON input object.');
      input = record;
      break;
    }
    case 'research.investigation':
      input.id = take('Investigation ID');
      break;
    case 'research.disclosure':
    case 'research.permission':
    case 'research.revoke':
      input.id = take('Evidence or permission ID');
      break;
    case 'research.grant':
      input.investigationId = take('Investigation ID');
      if (!flags.digest || !flags['for-operation'] || !flags.to)
        throw usage('Supply --digest, --for-operation and the allowed providers with --to.');
      input.digest = flags.digest;
      input.forOperation = flags['for-operation'];
      input.destinations = flags.to;
      break;
    case 'research.runs':
      if (flags.after) input.after = integer(flags.after, 0, Number.MAX_SAFE_INTEGER);
      if (flags.limit) input.limit = integer(flags.limit, 1, 100);
      break;
    case 'research.import':
      if (!args.length) throw usage('A catalog directory is required');
      input.directory = resolve(args.shift());
      if (flags.catalog) input.expectedVersion = flags.catalog;
      break;
    case 'research.find':
    case 'research.versions':
      if (name === 'research.find') input.query = args.shift() ?? '';
      if (flags.limit) input.limit = integer(flags.limit, 1, 100);
      if (flags.catalog) input.version = flags.catalog;
      break;
    case 'research.passage':
    case 'research.record':
      input.id = args.shift();
      if (!input.id) throw usage('A catalog identifier is required');
      if (flags.catalog) input.version = flags.catalog;
      if (name === 'research.passage') {
        input.startLine = integer(args.shift() ?? '1', 1, Number.MAX_SAFE_INTEGER);
        input.endLine = integer(
          args.shift() ?? String(input.startLine),
          input.startLine,
          Number.MAX_SAFE_INTEGER
        );
      }
      break;
    case 'task.cancel':
    case 'task.reconcile':
    case 'goal.show':
    case 'task.show':
      input.id = args.shift();
      if (!input.id) throw usage('ID required');
      if (!control) rpc = group;
      break;
    case 'events':
      input.after = integer(flags.after ?? '0', 0, Number.MAX_SAFE_INTEGER);
      input.limit = integer(flags.limit ?? '100', 1, 500);
      break;
    case 'goal.list':
      input.after = integer(flags.after ?? '0', 0, Number.MAX_SAFE_INTEGER);
      input.limit = integer(flags.limit ?? '50', 1, 100);
      rpc = 'goals';
      break;
    case 'goal.run':
    case 'goal.pause':
    case 'goal.resume':
    case 'goal.cancel':
    case 'daemon.drain-status':
    case 'daemon.status':
    case 'daemon.stop':
    case 'daemon.start':
    case 'status':
      break;
    case 'daemon.drain':
      input.expectedGeneration = integer(take('Expected generation'), 0, Number.MAX_SAFE_INTEGER);
      break;
    case 'daemon.resume':
      input.cutoff = take('Named cutoff');
      input.expectedGeneration = integer(take('Expected generation'), 1, Number.MAX_SAFE_INTEGER);
      break;
    default:
      throw usage('Unknown command. See lillia --help');
  }
  if (args.length) throw usage('Unexpected positional argument');
  const print = (result) =>
    console.log(
      flags.json
        ? JSON.stringify({ version: 1, result })
        : inspect(result, { depth: null, colors: process.stdout.isTTY, compact: false })
    );
  if (name === 'backup.compare') {
    const { comparePredecessor } = await import('./predecessor-proof.mjs');
    return print(comparePredecessor(input));
  }
  if (name === 'backup.restore' || name === 'backup.inspect') {
    const { restoreBackup, inspectRecovery } = await import('./recovery.mjs');
    return print(name === 'backup.restore' ? restoreBackup(input) : inspectRecovery(input));
  }
  if (name === 'daemon.status') return print(await daemonStatus(dataDir));
  if (name === 'daemon.stop') return print(await stopDaemon(dataDir));

  let requestedProfile;
  if (
    name === 'daemon.start' &&
    (flags.profile !== undefined || flags['codex-slots'] !== undefined)
  ) {
    if (!flags.profile) throw usage('Select --profile codex-only when setting a session count.');
    requestedProfile = {
      mode: flags.profile,
      ...(flags['codex-slots'] === undefined
        ? {}
        : { codexSlots: integer(flags['codex-slots'], 1, 4) })
    };
  }
  const daemon = await ensureDaemon(dataDir, workspaceRoot, requestedProfile);
  if (name === 'daemon.start') return print(daemon);
  const call = () =>
    callService(dataDir, { name: rpc, input, operationId, workspaceRoot: daemon.workspaceRoot });
  if (name === 'events') {
    for (;;) {
      const { result } = await call();
      for (const event of result.events) {
        if (!Number.isSafeInteger(event.id) || event.id <= input.after)
          throw new Error('Invalid event cursor from daemon');
        const line = JSON.stringify({ version: 1, cursor: event.id, event });
        if (!process.stdout.write(line + '\n')) await once(process.stdout, 'drain');
        input.after = event.id;
      }
      if (result.events.length < input.limit) {
        if (!flags.follow) return;
        await delay(500);
      }
    }
  }
  try {
    return print((await call()).result);
  } catch (error) {
    if (mutation && (!error.status || error.status >= 500)) {
      error.message +=
        '\nCommand outcome unknown. Retry the same input with --operation-id ' + operationId;
      error.exitCode = 4;
    }
    throw error;
  }
}

process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});
run().catch((error) => {
  console.error(error.message);
  process.exitCode =
    error.exitCode ??
    (error.status === 409 ? 3 : error.status >= 400 && error.status < 500 ? 2 : 1);
});
