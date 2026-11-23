import { assertSubtreeAdmission } from './subtree-scope-owner.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { inspectParentGrant, readChatBranch, verifyParentGrant } from './project-chat-branches.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const invalid = (message = 'Branch thread evidence is invalid.', status = 409) => {
  throw Object.assign(new Error(message), { status });
};
const table = `CREATE TABLE project_chat_branch_threads (
  threadId TEXT PRIMARY KEY REFERENCES project_chat_threads(id),
  projectId TEXT NOT NULL REFERENCES project_chat_identity(id),
  preparationId TEXT NOT NULL UNIQUE REFERENCES project_chat_branch_preparations(id),
  parentGrantId TEXT NOT NULL REFERENCES project_chat_parent_grants(id),
  operationId TEXT NOT NULL UNIQUE REFERENCES command_receipts(operationId) DEFERRABLE INITIALLY DEFERRED
)`;
const noUpdate = `CREATE TRIGGER project_chat_branch_thread_no_update
BEFORE UPDATE ON project_chat_branch_threads BEGIN SELECT RAISE(ABORT,'immutable branch thread'); END`;
const noDelete = `CREATE TRIGGER project_chat_branch_thread_no_delete
BEFORE DELETE ON project_chat_branch_threads BEGIN SELECT RAISE(ABORT,'immutable branch thread'); END`;
export const branchThreadTable = 'project_chat_branch_threads';
export function installBranchThreads(db) {
  db.exec([table, noUpdate, noDelete].join(';'));
}
export function normalizeBranchThread(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 3 ||
    !uuid(input.projectId) ||
    !uuid(input.preparationId) ||
    !uuid(input.parentGrantId)
  )
    invalid('Invalid branch creation.', 400);
  return {
    projectId: input.projectId,
    preparationId: input.preparationId,
    parentGrantId: input.parentGrantId
  };
}
function branchResult(row, preparation) {
  return {
    thread: { id: row.threadId, title: preparation.title },
    branchThread: {
      kind: 'chat-branch-thread-v1',
      projectId: row.projectId,
      threadId: row.threadId,
      preparationId: row.preparationId,
      parentGrantId: row.parentGrantId
    }
  };
}
export function createBranchThread(store, input, operationId) {
  const db = store.db;
  if (!db.isTransaction) invalid('Branch creation requires an owner receipt transaction.');
  input = normalizeBranchThread(input);
  const { branch } = readChatBranch(db, { projectId: input.projectId, id: input.preparationId });
  if (db.prepare('PRAGMA user_version').get().user_version >= 58)
    assertSubtreeAdmission(store, { threadId: branch.parentThreadId });
  verifyParentGrant(db, {
    projectId: input.projectId,
    id: input.parentGrantId,
    selectionId: branch.selectionId,
    accountInstance: branch.recipient.accountInstance
  });
  if (
    db
      .prepare('SELECT 1 FROM project_chat_branch_threads WHERE preparationId=?')
      .get(input.preparationId)
  )
    invalid('This branch preparation already has a thread.');
  const row = { ...input, threadId: randomUUID() };
  db.prepare('INSERT INTO project_chat_threads(id,title) VALUES(?,?)').run(
    row.threadId,
    branch.title
  );
  db.prepare('INSERT INTO project_chat_branch_threads VALUES(?,?,?,?,?)').run(
    row.threadId,
    row.projectId,
    row.preparationId,
    row.parentGrantId,
    operationId
  );
  return branchResult(row, branch);
}
export function readBranchThread(db, threadId) {
  const row = db
    .prepare('SELECT * FROM project_chat_branch_threads WHERE threadId=?')
    .get(threadId);
  if (!row) invalid('Branch thread not found.', 404);
  const input = normalizeBranchThread({
    projectId: row.projectId,
    preparationId: row.preparationId,
    parentGrantId: row.parentGrantId
  });
  const { branch } = readChatBranch(db, { projectId: row.projectId, id: row.preparationId });
  const grant = inspectParentGrant(db, { projectId: row.projectId, id: row.parentGrantId });
  const thread = db.prepare('SELECT title FROM project_chat_threads WHERE id=?').get(threadId);
  if (
    !thread ||
    thread.title !== branch.title ||
    grant.selectionId !== branch.selectionId ||
    grant.selectionDigest !== branch.selectionDigest ||
    grant.recipient.accountInstance !== branch.recipient.accountInstance
  )
    invalid();
  const result = branchResult(row, branch);
  try {
    const saved = db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(row.operationId);
    const receipt = JSON.parse(saved.receipt);
    if (
      saved.digest !== hash(['chat.branch.create', input]) ||
      receipt.operationId !== row.operationId ||
      JSON.stringify(receipt) !== JSON.stringify({ operationId: row.operationId, ...result })
    )
      invalid();
    return receipt;
  } catch {
    invalid();
  }
}
export function replayBranchThread(db, input, operationId, receiptText) {
  const row = db
    .prepare('SELECT * FROM project_chat_branch_threads WHERE operationId=?')
    .get(operationId);
  if (
    !row ||
    row.projectId !== input.projectId ||
    row.preparationId !== input.preparationId ||
    row.parentGrantId !== input.parentGrantId
  )
    invalid();
  const receipt = readBranchThread(db, row.threadId);
  if (JSON.stringify(receipt) !== JSON.stringify(JSON.parse(receiptText))) invalid();
  return receipt;
}
export function verifyBranchThreads(db) {
  const get = db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?');
  for (const [type, name, expected] of [
    ['table', branchThreadTable, table],
    ['trigger', 'project_chat_branch_thread_no_update', noUpdate],
    ['trigger', 'project_chat_branch_thread_no_delete', noDelete]
  ])
    if (get.get(type, name)?.sql !== expected) invalid();
  for (const row of db.prepare('SELECT threadId FROM project_chat_branch_threads').iterate())
    readBranchThread(db, row.threadId);
  if (
    db
      .prepare(
        `SELECT 1 FROM command_receipts r WHERE
    (CASE WHEN json_valid(r.receipt) THEN json_extract(r.receipt,'$.branchThread.kind') END)='chat-branch-thread-v1'
    AND NOT EXISTS(SELECT 1 FROM project_chat_branch_threads b WHERE b.operationId=r.operationId) LIMIT 1`
      )
      .get()
  )
    invalid();
}
