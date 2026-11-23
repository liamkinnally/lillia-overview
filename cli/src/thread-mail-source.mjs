import { chatProject } from './project-chat-origins.mjs';
import { readChatContext } from './project-chat-contexts.mjs';
import { readThreadMailAuthority } from './thread-mail-authority.mjs';

function fail(message) {
  throw Object.assign(new Error(message), { status: 409 });
}
// Internal reads only. The owner route must authorize callers before exposing these.
// Descriptive reads alone are not action authorization.
export function inspectThreadMailSubject(db, projectId, threadId) {
  if (chatProject(db).projectId !== projectId) fail('Mail project mismatch.');
  const thread = db.prepare('SELECT id,title FROM project_chat_threads WHERE id=?').get(threadId);
  if (!thread) fail('Mail thread not found.');
  return { projectId, threadId: thread.id, title: thread.title };
}
export function readThreadMailThread(db, projectId, threadId) {
  inspectThreadMailSubject(db, projectId, threadId);
  return readThreadMailAuthority(db, threadId);
}
// revision is the immutable context-pin ID, not a provider turn or branch receipt.
// The production pin reader verifies exact text against its origin and current source.
export function readThreadMailSource(db, { projectId, threadId, turnId, revision }) {
  inspectThreadMailSubject(db, projectId, threadId);
  const { context } = readChatContext(db, { projectId, id: revision });
  if (context.threadId !== threadId || String(context.turnId) !== turnId)
    fail('Mail source provenance mismatch.');
  return { projectId, threadId, turnId, revision, text: context.text };
}
