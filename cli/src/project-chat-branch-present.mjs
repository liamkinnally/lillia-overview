import { readChatSelection } from './project-chat-contexts.mjs';
import { inspectParentGrant, readChatBranch } from './project-chat-branches.mjs';
import { readBranchThread } from './project-chat-branch-threads.mjs';
import { readBranchAttempt } from './project-chat-branch-runtime.mjs';

export function branchAttemptForThread(db, threadId) {
  const row = db
    .prepare(
      `SELECT a.ownerOperationId FROM project_chat_branch_attempts a
      JOIN project_chat_branch_threads b ON b.operationId=
        CASE WHEN json_valid(a.steps) THEN json_extract(a.steps,'$.creation') END
      WHERE b.threadId=?`
    )
    .get(threadId);
  return row ? projectBranchAttempt(db, row.ownerOperationId) : null;
}

export function projectBranchAttempt(db, ownerOperationId) {
  const attempt = readBranchAttempt(db, ownerOperationId);
  if (attempt.readiness !== 'created-not-delivered')
    throw Object.assign(new Error('Branch creation is not confirmed.'), { status: 409 });
  const created = readBranchThread(db, attempt.thread.id);
  const { branchThread } = created;
  const { branch } = readChatBranch(db, {
    projectId: branchThread.projectId,
    id: branchThread.preparationId
  });
  const grant = inspectParentGrant(db, {
    projectId: branchThread.projectId,
    id: branchThread.parentGrantId
  });
  const { selection } = readChatSelection(db, {
    projectId: branchThread.projectId,
    id: branch.selectionId
  });
  return {
    status: 'created_not_delivered',
    ownerOperationId: attempt.attempt.ownerOperationId,
    attemptId: attempt.attempt.steps.attempt,
    operationId: created.operationId,
    source: {
      projectId: selection.projectId,
      threadId: selection.threadId,
      anchor: { turnId: selection.turnId, role: selection.role },
      messages: selection.messages.map(({ turnId, role }) => ({ turnId, role }))
    },
    recipient: grant.recipient,
    thread: created.thread,
    branchThread
  };
}
