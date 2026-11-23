import { assertMailOwner, mailError } from './thread-mail-owner-input.mjs';
import { chatProject } from './project-chat-origins.mjs';
import { readThreadMailAuthority } from './thread-mail-authority.mjs';
import { readBranchThread } from './project-chat-branch-threads.mjs';
import { readChatBranch, verifyParentGrant } from './project-chat-branches.mjs';

export function normalizeMailSetting(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).join(',') !== 'mode' ||
    !['start-reply', 'queue-next-reply'].includes(input.mode)
  )
    mailError('Invalid incoming thread mail setting.', 400);
  return { mode: input.mode };
}
export function readMailSetting(db, input, actor) {
  assertMailOwner(actor);
  if (!input || Object.keys(input).length) mailError('Invalid mail settings read.', 400);
  const mode =
    db.prepare("SELECT value FROM settings WHERE key='chat.incomingThreadMail'").get()?.value ??
    'start-reply';
  normalizeMailSetting({ mode });
  return { mode };
}
export function applyMailSetting(db, input, actor) {
  assertMailOwner(actor);
  input = normalizeMailSetting(input);
  if (!db.isTransaction) mailError('Mail settings require the owner transaction.');
  db.prepare(
    "INSERT INTO settings(key,value) VALUES('chat.incomingThreadMail',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(input.mode);
  return { mode: input.mode };
}
export function readMailSubjects(db, input, actor) {
  assertMailOwner(actor);
  if (!input || Object.keys(input).length) mailError('Invalid mail subjects read.', 400);
  const { projectId } = chatProject(db),
    threads = [];
  for (const row of db.prepare('SELECT id,title FROM project_chat_threads ORDER BY rowid').all()) {
    let available = true;
    if (row.id !== 'root') {
      if (!db.prepare('SELECT 1 FROM project_chat_branch_threads WHERE threadId=?').get(row.id))
        continue;
      const { branchThread } = readBranchThread(db, row.id);
      const { branch } = readChatBranch(db, { projectId, id: branchThread.preparationId });
      if (branch.kind !== 'branch' || branch.parentThreadId !== 'root') continue;
      try {
        verifyParentGrant(db, {
          projectId,
          id: branchThread.parentGrantId,
          selectionId: branch.selectionId,
          accountInstance: branch.recipient.accountInstance
        });
      } catch {
        available = false;
      }
    }
    if (
      db.prepare('SELECT enabled FROM thread_mail_permissions WHERE threadId=?').get(row.id)
        ?.enabled === 0
    )
      available = false;
    const authority = readThreadMailAuthority(db, row.id);
    threads.push({ threadId: row.id, title: row.title, version: authority.version, available });
  }
  return { projectId, threads, mode: readMailSetting(db, {}, actor).mode };
}
