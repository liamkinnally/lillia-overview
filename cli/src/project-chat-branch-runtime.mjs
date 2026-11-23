import { createHash } from 'node:crypto';
import { assertBranchSelectionBudget } from './project-chat-branch-delivery.mjs';
import { chatProject, createChatOrigin } from './project-chat-origins.mjs';
import { createChatSelection, pinChatContext } from './project-chat-contexts.mjs';
import { createChatBranch, createParentGrant } from './project-chat-branches.mjs';
import { createBranchThread } from './project-chat-branch-threads.mjs';
import { verifyBranchAttemptCreation } from './project-chat-branch-runtime-verify.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status });
};
const table = `CREATE TABLE project_chat_branch_attempts (
  ownerOperationId TEXT PRIMARY KEY,
  attemptOperationId TEXT NOT NULL UNIQUE REFERENCES command_receipts(operationId) DEFERRABLE INITIALLY DEFERRED,
  intent TEXT NOT NULL,
  intentDigest TEXT NOT NULL,
  steps TEXT NOT NULL
)`;
const noUpdate = `CREATE TRIGGER project_chat_branch_attempt_no_update
BEFORE UPDATE ON project_chat_branch_attempts BEGIN SELECT RAISE(ABORT,'immutable branch attempt'); END`;
const noDelete = `CREATE TRIGGER project_chat_branch_attempt_no_delete
BEFORE DELETE ON project_chat_branch_attempts BEGIN SELECT RAISE(ABORT,'immutable branch attempt'); END`;
export const branchRuntimeTable = 'project_chat_branch_attempts';
export function installBranchRuntime(db) {
  db.exec([table, noUpdate, noDelete].join(';'));
}

function selection(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 3 ||
    !uuid(input.projectId) ||
    input.threadId !== 'root' ||
    !Array.isArray(input.messages) ||
    input.messages.length < 1 ||
    input.messages.length > 32
  )
    fail('Invalid branch selection.', 400);
  let previous = null;
  const messages = input.messages.map((message) => {
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      Object.keys(message).length !== 2 ||
      !Number.isSafeInteger(message.turnId) ||
      message.turnId < 1 ||
      !['user', 'assistant'].includes(message.role)
    )
      fail('Invalid branch message identity.', 400);
    const position = [message.turnId, message.role === 'user' ? 0 : 1];
    if (
      previous &&
      (position[0] < previous[0] || (position[0] === previous[0] && position[1] <= previous[1]))
    )
      fail('Branch messages must be unique and ordered.', 400);
    previous = position;
    return { turnId: message.turnId, role: message.role };
  });
  return { projectId: input.projectId, threadId: 'root', messages };
}
export function previewBranchSelection(db, input) {
  input = selection(input);
  if (chatProject(db).projectId !== input.projectId) fail('Branch project not found.', 404);
  const source = db.prepare(`SELECT t.ownerText,t.reply,t.state FROM project_chat_turns t
    JOIN project_chat_turn_threads m ON m.turnId=t.id WHERE t.id=? AND m.threadId=?`);
  let size = 0;
  const messages = input.messages.map(({ turnId, role }) => {
    const row = source.get(turnId, input.threadId);
    if (!row) fail('Branch message not found.', 404);
    if (role === 'assistant' && (row.state !== 'completed' || typeof row.reply !== 'string'))
      fail('Select a completed assistant message.');
    const text = role === 'user' ? row.ownerText : row.reply;
    if (typeof text !== 'string') fail('Branch message is unavailable.');
    size += Buffer.byteLength(text);
    return { turnId, role, text };
  });
  if (size > 262144) fail('Selected messages exceed the context limit.', 400);
  assertBranchSelectionBudget({
    anchor: { threadId: input.threadId, ...input.messages.at(-1) },
    messages
  });
  return {
    ...input,
    messages,
    anchor: input.messages.at(-1),
    digest: hash(['chat.branch.preview.v1', input.projectId, input.threadId, messages])
  };
}
export function normalizeBranchAttempt(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 6 ||
    typeof input.previewDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.previewDigest) ||
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    input.title.trim().length > 100 ||
    /[\x00-\x1f\x7f]/u.test(input.title) ||
    !input.recipient ||
    typeof input.recipient !== 'object' ||
    Array.isArray(input.recipient) ||
    Object.keys(input.recipient).length !== 2 ||
    input.recipient.provider !== 'codex' ||
    !uuid(input.recipient.accountInstance)
  )
    fail('Invalid branch attempt.', 400);
  return {
    ...selection({
      projectId: input.projectId,
      threadId: input.threadId,
      messages: input.messages
    }),
    previewDigest: input.previewDigest,
    title: input.title.trim(),
    recipient: { provider: 'codex', accountInstance: input.recipient.accountInstance }
  };
}
function steps(ownerOperationId, count) {
  const id = (name, index = null) => 'branch.' + hash([ownerOperationId, name, index]);
  return {
    attempt: id('attempt'),
    origins: Array.from({ length: count }, (_, i) => id('origin', i)),
    pins: Array.from({ length: count }, (_, i) => id('pin', i)),
    selection: id('selection'),
    grant: id('grant'),
    preparation: id('preparation'),
    creation: id('creation')
  };
}
function operationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))
    fail('Invalid operation ID.', 400);
  return value;
}
function attemptView(ownerOperationId, input, ids) {
  return {
    kind: 'chat-branch-attempt-v1',
    ownerOperationId,
    intentDigest: hash(['chat.branch.start', input]),
    steps: ids
  };
}
function checkedAttempt(db, ownerOperationId) {
  const row = db
    .prepare('SELECT * FROM project_chat_branch_attempts WHERE ownerOperationId=?')
    .get(operationId(ownerOperationId));
  if (!row) fail('Branch attempt not found.', 404);
  try {
    const input = normalizeBranchAttempt(JSON.parse(row.intent)),
      ids = steps(ownerOperationId, input.messages.length);
    const attempt = attemptView(ownerOperationId, input, ids);
    const receipt = db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(ids.attempt);
    if (
      row.attemptOperationId !== ids.attempt ||
      row.intent !== JSON.stringify(input) ||
      row.intentDigest !== attempt.intentDigest ||
      row.steps !== JSON.stringify(ids) ||
      receipt.digest !== hash(['chat.branch.attempt', attempt]) ||
      JSON.stringify(JSON.parse(receipt.receipt)) !==
        JSON.stringify({ operationId: ids.attempt, attempt })
    )
      fail('Branch attempt evidence is invalid.');
    return { input, ids, attempt };
  } catch {
    fail('Branch attempt evidence is invalid.');
  }
}
export function reserveBranchAttempt(store, input, ownerOperationId) {
  ownerOperationId = operationId(ownerOperationId);
  input = normalizeBranchAttempt(input);
  const ids = steps(ownerOperationId, input.messages.length),
    attempt = attemptView(ownerOperationId, input, ids);
  const reserved = [
    ownerOperationId,
    ids.attempt,
    ...ids.origins,
    ...ids.pins,
    ids.selection,
    ids.grant,
    ids.preparation,
    ids.creation
  ];
  if (new Set(reserved).size !== reserved.length) fail('Branch operation IDs overlap.', 400);
  return store.transaction(() => {
    const existing = store.db
      .prepare('SELECT ownerOperationId FROM project_chat_branch_attempts WHERE ownerOperationId=?')
      .get(ownerOperationId);
    if (existing) {
      const prior = checkedAttempt(store.db, ownerOperationId);
      if (prior.attempt.intentDigest !== attempt.intentDigest)
        fail('This operation ID already belongs to different inputs.');
      return readBranchAttempt(store.db, ownerOperationId);
    }
    const occupied = store.db.prepare(
      'SELECT 1 FROM command_receipts WHERE operationId=? UNION ALL SELECT 1 FROM pending_effects WHERE operationId=? LIMIT 1'
    );
    for (const id of reserved)
      if (occupied.get(id, id)) fail('A branch operation ID is already in use.');
    store.acceptWithinTransaction(ids.attempt, hash(['chat.branch.attempt', attempt]), () => {
      store.db
        .prepare('INSERT INTO project_chat_branch_attempts VALUES(?,?,?,?,?)')
        .run(
          ownerOperationId,
          ids.attempt,
          JSON.stringify(input),
          attempt.intentDigest,
          JSON.stringify(ids)
        );
      return { attempt };
    });
    return { operationId: ownerOperationId, readiness: 'reserved', attempt };
  });
}
export function readBranchAttempt(db, ownerOperationId) {
  const { input, ids, attempt } = checkedAttempt(db, ownerOperationId);
  const row = db
    .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
    .get(ownerOperationId);
  if (!row) {
    const occupied = db.prepare(
      'SELECT 1 FROM command_receipts WHERE operationId=? UNION ALL SELECT 1 FROM pending_effects WHERE operationId=? LIMIT 1'
    );
    for (const id of [
      ...ids.origins,
      ...ids.pins,
      ids.selection,
      ids.grant,
      ids.preparation,
      ids.creation
    ])
      if (occupied.get(id, id)) fail('Branch attempt has incomplete or conflicting effects.');
    return { operationId: ownerOperationId, readiness: 'reserved', attempt };
  }
  try {
    const receipt = JSON.parse(row.receipt);
    const creation = db
      .prepare('SELECT threadId FROM project_chat_branch_threads WHERE operationId=?')
      .get(ids.creation);
    const verified = verifyBranchAttemptCreation(db, input, ids, creation.threadId);
    const expected = {
      operationId: ownerOperationId,
      readiness: 'created-not-delivered',
      attempt,
      result: { thread: verified.thread, branchThread: verified.branchThread }
    };
    if (
      row.digest !== hash(['chat.branch.start', input]) ||
      JSON.stringify(receipt) !== JSON.stringify(expected)
    )
      fail('Branch attempt receipt differs.');
    return {
      operationId: ownerOperationId,
      readiness: expected.readiness,
      attempt,
      ...expected.result
    };
  } catch {
    fail('Branch attempt receipt is invalid.');
  }
}
export function advanceBranchAttempt(store, ownerOperationId) {
  const previous = readBranchAttempt(store.db, ownerOperationId);
  if (previous.readiness === 'created-not-delivered') return previous;
  const { input, ids, attempt } = checkedAttempt(store.db, ownerOperationId);
  store.accept(ownerOperationId, hash(['chat.branch.start', input]), () => {
    const occupied = store.db.prepare(
      'SELECT 1 FROM command_receipts WHERE operationId=? UNION ALL SELECT 1 FROM pending_effects WHERE operationId=? LIMIT 1'
    );
    for (const id of [
      ...ids.origins,
      ...ids.pins,
      ids.selection,
      ids.grant,
      ids.preparation,
      ids.creation
    ])
      if (occupied.get(id, id)) fail('A branch operation ID is already in use.');
    if (
      previewBranchSelection(store.db, {
        projectId: input.projectId,
        threadId: input.threadId,
        messages: input.messages
      }).digest !== input.previewDigest
    )
      fail('Branch preview changed; review the selection again.');
    const pins = input.messages.map((message, index) => {
      const originInput = { projectId: input.projectId, threadId: input.threadId, ...message };
      const { origin } = store.acceptWithinTransaction(
        ids.origins[index],
        hash(['chat.origin.create', originInput]),
        () => createChatOrigin(store.db, originInput, ids.origins[index])
      );
      const pinInput = { projectId: input.projectId, originId: origin.id };
      const { context } = store.acceptWithinTransaction(
        ids.pins[index],
        hash(['chat.context.pin', pinInput]),
        () => pinChatContext(store.db, pinInput, ids.pins[index])
      );
      return context;
    });
    const selectionInput = {
      projectId: input.projectId,
      originId: pins.at(-1).originId,
      contextIds: pins.map((pin) => pin.id)
    };
    const { selection: selected } = store.acceptWithinTransaction(
      ids.selection,
      hash(['chat.selection.create', selectionInput]),
      () => createChatSelection(store.db, selectionInput, ids.selection)
    );
    const grantInput = {
      projectId: input.projectId,
      selectionId: selected.id,
      selectionDigest: selected.digest,
      recipient: input.recipient,
      parentGrantId: null
    };
    const { parentGrant } = store.acceptWithinTransaction(
      ids.grant,
      hash(['chat.parent.grant', grantInput]),
      () => createParentGrant({ store, input: grantInput, operationId: ids.grant })
    );
    const preparationInput = {
      projectId: input.projectId,
      selectionId: selected.id,
      selectionDigest: selected.digest,
      kind: 'branch',
      title: input.title,
      recipient: input.recipient
    };
    const { branch } = store.acceptWithinTransaction(
      ids.preparation,
      hash(['chat.branch.prepare', preparationInput]),
      () => createChatBranch({ store, input: preparationInput, operationId: ids.preparation })
    );
    const createInput = {
      projectId: input.projectId,
      preparationId: branch.id,
      parentGrantId: parentGrant.id
    };
    const created = store.acceptWithinTransaction(
      ids.creation,
      hash(['chat.branch.create', createInput]),
      () => createBranchThread(store, createInput, ids.creation)
    );
    return {
      readiness: 'created-not-delivered',
      attempt,
      result: { thread: created.thread, branchThread: created.branchThread }
    };
  });
  return readBranchAttempt(store.db, ownerOperationId);
}
export function verifyBranchRuntime(db) {
  const object = db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?');
  for (const [type, name, sql] of [
    ['table', branchRuntimeTable, table],
    ['trigger', 'project_chat_branch_attempt_no_update', noUpdate],
    ['trigger', 'project_chat_branch_attempt_no_delete', noDelete]
  ])
    if (object.get(type, name)?.sql !== sql) fail('Branch attempt schema is invalid.');
  for (const row of db
    .prepare('SELECT ownerOperationId FROM project_chat_branch_attempts')
    .iterate())
    readBranchAttempt(db, row.ownerOperationId);
  if (
    db
      .prepare(
        `SELECT 1 FROM command_receipts r WHERE
    (CASE WHEN json_valid(r.receipt) THEN json_extract(r.receipt,'$.attempt.kind') END)='chat-branch-attempt-v1'
    AND NOT EXISTS(SELECT 1 FROM project_chat_branch_attempts a WHERE a.attemptOperationId=r.operationId OR a.ownerOperationId=r.operationId) LIMIT 1`
      )
      .get()
  )
    fail('Branch attempt receipt is missing its record.');
}
