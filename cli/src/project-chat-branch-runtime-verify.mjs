import { createHash } from 'node:crypto';
import { readChatSelection } from './project-chat-contexts.mjs';
import { readChatBranch } from './project-chat-branches.mjs';
import { readBranchThread } from './project-chat-branch-threads.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = () => {
  throw Object.assign(new Error('Branch attempt creation evidence is invalid.'), { status: 409 });
};

export function verifyBranchAttemptCreation(db, input, ids, threadId) {
  const verified = readBranchThread(db, threadId);
  const link = verified.branchThread;
  const preparation = db
    .prepare('SELECT operationId FROM project_chat_branch_preparations WHERE id=? AND projectId=?')
    .get(link.preparationId, input.projectId);
  const grant = db
    .prepare('SELECT operationId FROM project_chat_parent_grants WHERE id=? AND projectId=?')
    .get(link.parentGrantId, input.projectId);
  const { branch } = readChatBranch(db, { projectId: input.projectId, id: link.preparationId });
  const selection = db
    .prepare('SELECT operationId FROM project_chat_context_selections WHERE id=? AND projectId=?')
    .get(branch.selectionId, input.projectId);
  const selected = readChatSelection(db, {
    projectId: input.projectId,
    id: branch.selectionId
  }).selection;
  if (
    verified.operationId !== ids.creation ||
    link.projectId !== input.projectId ||
    preparation?.operationId !== ids.preparation ||
    grant?.operationId !== ids.grant ||
    selection?.operationId !== ids.selection ||
    branch.title !== input.title ||
    branch.kind !== 'branch' ||
    branch.parentThreadId !== input.threadId ||
    branch.recipient.accountInstance !== input.recipient.accountInstance ||
    selected.messages.length !== input.messages.length
  )
    invalid();
  const pin = db.prepare(`SELECT p.operationId AS pinOperationId,o.operationId AS originOperationId
    FROM project_chat_context_pins p JOIN project_chat_origins o ON o.id=p.originId WHERE p.id=?`);
  const preview = selected.messages.map((message, index) => {
    const evidence = pin.get(message.id);
    if (
      evidence?.pinOperationId !== ids.pins[index] ||
      evidence.originOperationId !== ids.origins[index] ||
      message.turnId !== input.messages[index].turnId ||
      message.role !== input.messages[index].role
    )
      invalid();
    return { turnId: message.turnId, role: message.role, text: message.text };
  });
  if (
    hash(['chat.branch.preview.v1', input.projectId, input.threadId, preview]) !==
    input.previewDigest
  )
    invalid();
  return verified;
}
