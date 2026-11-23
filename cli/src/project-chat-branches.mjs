import { createHash, randomUUID } from 'node:crypto';
import { readChatSelection, replayChatSelection } from './project-chat-contexts.mjs';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
function fail(message, status = 409) {
  throw Object.assign(new Error(message), { status });
}
const table = `CREATE TABLE project_chat_branch_preparations (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES project_chat_identity(id),
  selectionId TEXT NOT NULL REFERENCES project_chat_context_selections(id),
  selectionDigest TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('branch','side-chat')),
  title TEXT NOT NULL,
  accountInstance TEXT NOT NULL,
  operationId TEXT NOT NULL UNIQUE REFERENCES command_receipts(operationId) DEFERRABLE INITIALLY DEFERRED
)`;
const noUpdate = `CREATE TRIGGER project_chat_branch_preparation_no_update
BEFORE UPDATE ON project_chat_branch_preparations BEGIN SELECT RAISE(ABORT,'immutable branch preparation'); END`;
const noDelete = `CREATE TRIGGER project_chat_branch_preparation_no_delete
BEFORE DELETE ON project_chat_branch_preparations BEGIN SELECT RAISE(ABORT,'immutable branch preparation'); END`;
const grantTable = `CREATE TABLE project_chat_parent_grants (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES project_chat_identity(id),
  selectionId TEXT NOT NULL REFERENCES project_chat_context_selections(id),
  selectionDigest TEXT NOT NULL,
  accountInstance TEXT NOT NULL,
  parentGrantId TEXT REFERENCES project_chat_parent_grants(id),
  operationId TEXT NOT NULL UNIQUE REFERENCES command_receipts(operationId) DEFERRABLE INITIALLY DEFERRED
)`;
const revocationTable = `CREATE TABLE project_chat_parent_revocations (
  grantId TEXT PRIMARY KEY REFERENCES project_chat_parent_grants(id),
  operationId TEXT NOT NULL UNIQUE REFERENCES command_receipts(operationId) DEFERRABLE INITIALLY DEFERRED
)`;
const grantUpdate = `CREATE TRIGGER project_chat_parent_grant_no_update
BEFORE UPDATE ON project_chat_parent_grants BEGIN SELECT RAISE(ABORT,'immutable parent grant'); END`;
const grantDelete = `CREATE TRIGGER project_chat_parent_grant_no_delete
BEFORE DELETE ON project_chat_parent_grants BEGIN SELECT RAISE(ABORT,'immutable parent grant'); END`;
const revokeUpdate = `CREATE TRIGGER project_chat_parent_revoke_no_update
BEFORE UPDATE ON project_chat_parent_revocations BEGIN SELECT RAISE(ABORT,'immutable parent revocation'); END`;
const revokeDelete = `CREATE TRIGGER project_chat_parent_revoke_no_delete
BEFORE DELETE ON project_chat_parent_revocations BEGIN SELECT RAISE(ABORT,'immutable parent revocation'); END`;
export const chatBranchTables = [
  'project_chat_branch_preparations',
  'project_chat_parent_grants',
  'project_chat_parent_revocations'
];
export const chatBranchSchema = [
  ['table', chatBranchTables[0], table],
  ['table', chatBranchTables[1], grantTable],
  ['table', chatBranchTables[2], revocationTable],
  ['trigger', 'project_chat_branch_preparation_no_update', noUpdate],
  ['trigger', 'project_chat_branch_preparation_no_delete', noDelete],
  ['trigger', 'project_chat_parent_grant_no_update', grantUpdate],
  ['trigger', 'project_chat_parent_grant_no_delete', grantDelete],
  ['trigger', 'project_chat_parent_revoke_no_update', revokeUpdate],
  ['trigger', 'project_chat_parent_revoke_no_delete', revokeDelete]
];
export function installChatBranches(db) {
  db.exec(
    [
      table,
      noUpdate,
      noDelete,
      grantTable,
      revocationTable,
      grantUpdate,
      grantDelete,
      revokeUpdate,
      revokeDelete
    ].join(';')
  );
}
export function normalizeChatBranch(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 6 ||
    !uuid(input.projectId) ||
    !uuid(input.selectionId) ||
    !/^[0-9a-f]{64}$/.test(input.selectionDigest) ||
    !['branch', 'side-chat'].includes(input.kind) ||
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
    fail('Invalid branch preparation.', 400);
  return {
    projectId: input.projectId,
    selectionId: input.selectionId,
    selectionDigest: input.selectionDigest,
    kind: input.kind,
    title: input.title.trim(),
    recipient: { provider: 'codex', accountInstance: input.recipient.accountInstance }
  };
}
function selectionSource(db, input) {
  const { selection } = readChatSelection(db, {
    projectId: input.projectId,
    id: input.selectionId
  });
  const row = db
    .prepare(
      `SELECT s.*,r.digest AS receiptDigest,r.receipt FROM project_chat_context_selections s
    LEFT JOIN command_receipts r ON r.operationId=s.operationId WHERE s.id=?`
    )
    .get(input.selectionId);
  try {
    const selected = {
      projectId: row.projectId,
      originId: row.originId,
      contextIds: JSON.parse(row.contextIds)
    };
    if (
      row.receiptDigest !== hash(['chat.selection.create', selected]) ||
      selection.digest !== input.selectionDigest
    )
      throw Error('selection differs');
    replayChatSelection(db, selected, row.operationId, row.receipt);
  } catch {
    fail('Branch selection receipt is invalid.');
  }
  return selection;
}
export function normalizeParentGrant(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 5 ||
    !uuid(input.projectId) ||
    !uuid(input.selectionId) ||
    typeof input.selectionDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.selectionDigest) ||
    !(input.parentGrantId === null || uuid(input.parentGrantId)) ||
    !input.recipient ||
    typeof input.recipient !== 'object' ||
    Array.isArray(input.recipient) ||
    Object.keys(input.recipient).length !== 2 ||
    input.recipient.provider !== 'codex' ||
    !uuid(input.recipient.accountInstance)
  )
    fail('Invalid parent grant.', 400);
  return {
    projectId: input.projectId,
    selectionId: input.selectionId,
    selectionDigest: input.selectionDigest,
    recipient: { provider: 'codex', accountInstance: input.recipient.accountInstance },
    parentGrantId: input.parentGrantId
  };
}
function grantView(row, selection) {
  return {
    id: row.id,
    kind: 'chat-parent-grant-v1',
    projectId: row.projectId,
    threadId: selection.threadId,
    selectionId: row.selectionId,
    selectionDigest: row.selectionDigest,
    recipient: { provider: 'codex', accountInstance: row.accountInstance },
    parentGrantId: row.parentGrantId,
    status: 'active'
  };
}
function grantInput(row) {
  return normalizeParentGrant({
    projectId: row.projectId,
    selectionId: row.selectionId,
    selectionDigest: row.selectionDigest,
    recipient: { provider: 'codex', accountInstance: row.accountInstance },
    parentGrantId: row.parentGrantId
  });
}
function grantSource(db, projectId, id, accountInstance, seen, historical = false) {
  if (!uuid(projectId) || !uuid(id) || !uuid(accountInstance) || seen.has(id) || seen.size >= 32)
    fail('Parent grant identity or ancestry is invalid.');
  seen.add(id);
  const row = db
    .prepare('SELECT * FROM project_chat_parent_grants WHERE projectId=? AND id=?')
    .get(projectId, id);
  if (!row) fail('Parent grant not found.', 404);
  const input = grantInput(row),
    selection = selectionSource(db, input),
    grant = grantView(row, selection);
  try {
    const receipt = db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(row.operationId);
    const parsed = JSON.parse(receipt.receipt);
    if (
      receipt.digest !== hash(['chat.parent.grant', input]) ||
      !parsed ||
      Object.keys(parsed).length !== 2 ||
      parsed.operationId !== row.operationId ||
      JSON.stringify(parsed.parentGrant) !== JSON.stringify(grant)
    )
      throw Error('grant receipt differs');
  } catch {
    fail('Parent grant receipt is invalid.');
  }
  if (
    !historical &&
    db.prepare('SELECT 1 FROM project_chat_parent_revocations WHERE grantId=?').get(id)
  )
    fail('Parent grant has been revoked.');
  if (row.accountInstance !== accountInstance) fail('Parent grant recipient differs.');
  if (selection.threadId !== 'root') fail('Parent grant requires established thread lineage.');
  if (row.parentGrantId) {
    const parent = grantSource(db, projectId, row.parentGrantId, accountInstance, seen, historical);
    const allowed = new Map(
      parent.selection.messages.map((message) => [message.originId, JSON.stringify(message)])
    );
    if (
      selection.threadId !== parent.selection.threadId ||
      selection.messages.some(
        (message) => allowed.get(message.originId) !== JSON.stringify(message)
      )
    )
      fail('Child grant exceeds parent selection.');
  }
  return { grant, selection };
}
export function createParentGrant({ store, input, operationId }) {
  const db = store.db;
  if (!db.isTransaction) fail('Parent grant requires an owner receipt transaction.');
  input = normalizeParentGrant(input);
  const selection = selectionSource(db, input),
    setting = db.prepare('SELECT value FROM settings WHERE key=?');
  if (selection.threadId !== 'root') fail('Parent grant requires established thread lineage.');
  if (
    setting.get('codex.accountInstance')?.value !== input.recipient.accountInstance ||
    !setting.get('codex.accountBinding')?.value
  )
    fail('The selected Codex account is unavailable.');
  if (input.parentGrantId) {
    const parent = grantSource(
      db,
      input.projectId,
      input.parentGrantId,
      input.recipient.accountInstance,
      new Set()
    );
    const allowed = new Map(
      parent.selection.messages.map((message) => [message.originId, JSON.stringify(message)])
    );
    if (
      selection.threadId !== parent.selection.threadId ||
      selection.messages.some(
        (message) => allowed.get(message.originId) !== JSON.stringify(message)
      )
    )
      fail('Child grant exceeds parent selection.');
  }
  const row = { id: randomUUID(), ...input, accountInstance: input.recipient.accountInstance };
  db.prepare('INSERT INTO project_chat_parent_grants VALUES(?,?,?,?,?,?,?)').run(
    row.id,
    row.projectId,
    row.selectionId,
    row.selectionDigest,
    row.accountInstance,
    row.parentGrantId,
    operationId
  );
  return { parentGrant: grantView(row, selection) };
}
export function verifyParentGrant(db, { projectId, id, selectionId, accountInstance }) {
  const { grant } = grantSource(db, projectId, id, accountInstance, new Set());
  if (grant.selectionId !== selectionId) fail('Parent grant selection differs.');
  const setting = db.prepare('SELECT value FROM settings WHERE key=?');
  if (
    setting.get('codex.accountInstance')?.value !== accountInstance ||
    !setting.get('codex.accountBinding')?.value
  )
    fail('The selected Codex account is unavailable.');
  return grant;
}
export function inspectParentGrant(db, { projectId, id }) {
  const row = db
    .prepare('SELECT accountInstance FROM project_chat_parent_grants WHERE projectId=? AND id=?')
    .get(projectId, id);
  if (!row) fail('Parent grant not found.', 404);
  return grantSource(db, projectId, id, row.accountInstance, new Set(), true).grant;
}
export function normalizeParentRevocation(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 2 ||
    !uuid(input.projectId) ||
    !uuid(input.id)
  )
    fail('Invalid parent grant revocation.', 400);
  return { projectId: input.projectId, id: input.id };
}
export function revokeParentGrant({ store, input, operationId }) {
  const db = store.db;
  if (!db.isTransaction) fail('Parent revocation requires an owner receipt transaction.');
  input = normalizeParentRevocation(input);
  const row = db
    .prepare('SELECT * FROM project_chat_parent_grants WHERE projectId=? AND id=?')
    .get(input.projectId, input.id);
  if (!row) fail('Parent grant not found.', 404);
  grantSource(db, input.projectId, input.id, row.accountInstance, new Set());
  db.prepare('INSERT INTO project_chat_parent_revocations VALUES(?,?)').run(input.id, operationId);
  return {
    revocation: { kind: 'chat-parent-revocation-v1', projectId: input.projectId, grantId: input.id }
  };
}
function view(row, selection) {
  // shortcut: owner-only preparation, add enforced parent grants before creating a thread or delivering context.
  return {
    id: row.id,
    recordKind: 'chat-branch-preparation-v1',
    projectId: row.projectId,
    parentThreadId: selection.threadId,
    originId: selection.originId,
    anchorTurnId: selection.turnId,
    anchorRole: selection.role,
    selectionId: row.selectionId,
    selectionDigest: row.selectionDigest,
    kind: row.kind,
    title: row.title,
    recipient: { provider: 'codex', accountInstance: row.accountInstance },
    status: 'authority-pending'
  };
}
export function createChatBranch({ store, input, operationId }) {
  const db = store.db;
  if (!db.isTransaction) fail('Branch preparation requires an owner receipt transaction.');
  input = normalizeChatBranch(input);
  const selection = selectionSource(db, input);
  if (selection.threadId !== 'root') fail('Branch preparation requires a root conversation.');
  const setting = db.prepare('SELECT value FROM settings WHERE key=?');
  if (
    setting.get('codex.accountInstance')?.value !== input.recipient.accountInstance ||
    !setting.get('codex.accountBinding')?.value
  )
    fail('The selected Codex account is unavailable.');
  const row = { id: randomUUID(), ...input, accountInstance: input.recipient.accountInstance };
  db.prepare('INSERT INTO project_chat_branch_preparations VALUES(?,?,?,?,?,?,?,?)').run(
    row.id,
    row.projectId,
    row.selectionId,
    row.selectionDigest,
    row.kind,
    row.title,
    row.accountInstance,
    operationId
  );
  return { branch: view(row, selection) };
}
export function readChatBranch(db, input) {
  if (!input || Object.keys(input).length !== 2 || !uuid(input.projectId) || !uuid(input.id))
    fail('Invalid branch preparation.', 400);
  const row = db
    .prepare('SELECT * FROM project_chat_branch_preparations WHERE projectId=? AND id=?')
    .get(input.projectId, input.id);
  if (!row) fail('Branch preparation not found.', 404);
  const normalized = normalizeChatBranch({
    projectId: row.projectId,
    selectionId: row.selectionId,
    selectionDigest: row.selectionDigest,
    kind: row.kind,
    title: row.title,
    recipient: { provider: 'codex', accountInstance: row.accountInstance }
  });
  const selection = selectionSource(db, normalized),
    branch = view(row, selection);
  try {
    const receipt = db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(row.operationId);
    const parsed = JSON.parse(receipt.receipt);
    if (
      receipt.digest !== hash(['chat.branch.prepare', normalized]) ||
      !parsed ||
      Object.keys(parsed).length !== 2 ||
      parsed.operationId !== row.operationId ||
      JSON.stringify(parsed.branch) !== JSON.stringify(branch)
    )
      throw Error('receipt differs');
  } catch {
    fail('Branch preparation receipt is invalid.');
  }
  return { branch };
}
export function readBranchContext() {
  fail('Parent conversation recipient authority is unavailable.');
}
