import { createHash } from 'node:crypto';
import { chatBranchSchema, inspectParentGrant, readChatBranch } from './project-chat-branches.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail() {
  throw Object.assign(new Error('Branch preparation or grant receipt is invalid.'), {
    status: 409
  });
}
function exactReceipt(text, operationId, key, value) {
  const receipt = JSON.parse(text);
  if (
    !receipt ||
    Object.keys(receipt).length !== 2 ||
    receipt.operationId !== operationId ||
    JSON.stringify(receipt[key]) !== JSON.stringify(value)
  )
    fail();
  return receipt;
}
export function replayBranchPreparation(db, input, operationId, receiptText) {
  try {
    const row = db
      .prepare('SELECT * FROM project_chat_branch_preparations WHERE operationId=?')
      .get(operationId);
    if (
      !row ||
      row.projectId !== input.projectId ||
      row.selectionId !== input.selectionId ||
      row.selectionDigest !== input.selectionDigest ||
      row.kind !== input.kind ||
      row.title !== input.title ||
      row.accountInstance !== input.recipient.accountInstance
    )
      fail();
    return exactReceipt(
      receiptText,
      operationId,
      'branch',
      readChatBranch(db, { projectId: input.projectId, id: row.id }).branch
    );
  } catch {
    fail();
  }
}
export function replayParentGrant(db, input, operationId, receiptText) {
  try {
    const row = db
      .prepare('SELECT * FROM project_chat_parent_grants WHERE operationId=?')
      .get(operationId);
    if (
      !row ||
      row.projectId !== input.projectId ||
      row.selectionId !== input.selectionId ||
      row.selectionDigest !== input.selectionDigest ||
      row.accountInstance !== input.recipient.accountInstance ||
      row.parentGrantId !== input.parentGrantId
    )
      fail();
    return exactReceipt(
      receiptText,
      operationId,
      'parentGrant',
      inspectParentGrant(db, { projectId: input.projectId, id: row.id })
    );
  } catch {
    fail();
  }
}
export function replayParentRevocation(db, input, operationId, receiptText) {
  try {
    const row = db
      .prepare('SELECT grantId FROM project_chat_parent_revocations WHERE operationId=?')
      .get(operationId);
    if (!row || row.grantId !== input.id) fail();
    inspectParentGrant(db, { projectId: input.projectId, id: input.id });
    return exactReceipt(receiptText, operationId, 'revocation', {
      kind: 'chat-parent-revocation-v1',
      projectId: input.projectId,
      grantId: input.id
    });
  } catch {
    fail();
  }
}
export function verifyChatBranches(db) {
  try {
    const schema = db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?');
    for (const [type, name, sql] of chatBranchSchema)
      if (schema.get(type, name)?.sql !== sql) fail();
    for (const row of db
      .prepare('SELECT projectId,id FROM project_chat_branch_preparations')
      .iterate())
      readChatBranch(db, row);
    for (const row of db.prepare('SELECT projectId,id FROM project_chat_parent_grants').iterate())
      inspectParentGrant(db, row);
    for (const row of db
      .prepare(
        `SELECT g.projectId,v.grantId,v.operationId,r.digest,r.receipt FROM project_chat_parent_revocations v
      LEFT JOIN project_chat_parent_grants g ON g.id=v.grantId LEFT JOIN command_receipts r ON r.operationId=v.operationId`
      )
      .iterate()) {
      const input = { projectId: row.projectId, id: row.grantId };
      if (!row.projectId || row.digest !== hash(['chat.parent.revoke', input])) fail();
      replayParentRevocation(db, input, row.operationId, row.receipt);
    }
    const orphan = db
      .prepare(
        `SELECT 1 FROM command_receipts r WHERE
      (CASE WHEN json_valid(r.receipt) THEN json_extract(r.receipt,'$.branch.recordKind') END='chat-branch-preparation-v1' AND NOT EXISTS(SELECT 1 FROM project_chat_branch_preparations p WHERE p.operationId=r.operationId)) OR
      (CASE WHEN json_valid(r.receipt) THEN json_extract(r.receipt,'$.parentGrant.kind') END='chat-parent-grant-v1' AND NOT EXISTS(SELECT 1 FROM project_chat_parent_grants g WHERE g.operationId=r.operationId)) OR
      (CASE WHEN json_valid(r.receipt) THEN json_extract(r.receipt,'$.revocation.kind') END='chat-parent-revocation-v1' AND NOT EXISTS(SELECT 1 FROM project_chat_parent_revocations v WHERE v.operationId=r.operationId)) LIMIT 1`
      )
      .get();
    if (orphan) fail();
  } catch {
    fail();
  }
}
