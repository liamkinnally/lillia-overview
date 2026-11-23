import { OwnerThreadMail } from './thread-mail-owner.mjs';
import { localMailOwner } from './thread-mail-owner-input.mjs';
import { normalizeChatSend } from './project-chat.mjs';
import {
  selectedMail,
  mailHash,
  mailFail,
  mailForTurn,
  effectIdentity
} from './thread-mail-effects.mjs';

const enabled = (db) =>
  db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE name='thread_mail_turn_selections' AND type='table'"
    )
    .get();
function eligible(store, row) {
  const mail = new OwnerThreadMail(store);
  mail.core.authorize(localMailOwner(), 'send', row.envelope);
  mail.core.validate(row.envelope);
  return mail.authorization(row.envelope);
}
export function admitMailReplies(store, chat) {
  if (!enabled(store.db)) return false;
  const db = store.db,
    mail = new OwnerThreadMail(store);
  const rows = db
    .prepare(
      `SELECT m.operationId FROM thread_mail_operations m
    JOIN thread_mail_owner_authorizations a ON a.operationId=m.operationId
    WHERE m.state='pending' AND json_extract(a.record,'$.mode')='start-reply'
    AND NOT EXISTS(SELECT 1 FROM thread_mail_reply_requests r WHERE r.operationId=m.operationId)
    AND NOT EXISTS(SELECT 1 FROM thread_mail_turn_selections s WHERE s.operationId=m.operationId)
    ORDER BY m.operationId`
    )
    .iterate();
  // Stream past skipped rows; only admitted replies consume the work cap.
  let changed = false,
    admitted = 0;
  for (const entry of rows) {
    const row = mail.storage.get(entry.operationId);
    try {
      eligible(store, row);
    } catch {
      continue;
    }
    const busy = db
      .prepare(
        `SELECT 1 FROM project_chat_turns c JOIN project_chat_turn_threads m ON m.turnId=c.id
      WHERE m.threadId=? AND c.state IN ('queued','awaiting') LIMIT 1`
      )
      .get(row.envelope.recipient.threadId);
    if (busy) continue;
    if (
      db
        .prepare("SELECT count(*) n FROM project_chat_turns WHERE state IN ('queued','awaiting')")
        .get().n >= 32
    )
      break;
    try {
      store.transaction(() => {
        eligible(store, row);
        const input = normalizeChatSend({
          text: 'Discuss the selected incoming thread mail. Do not start or delegate work.',
          threadId: row.envelope.recipient.threadId
        });
        const op = 'chat.mail.reply:' + mailHash(entry.operationId);
        const result = store.acceptWithinTransaction(op, mailHash(['chat.send', input]), () =>
          chat.send(input, op)
        );
        db.prepare('INSERT INTO thread_mail_reply_requests VALUES(?,?,?)').run(
          entry.operationId,
          result.turnId,
          op
        );
      });
    } catch (error) {
      // The admission transaction has rolled back; keep this mail pending until resume.
      if (error.code === 'scope_admission_paused') continue;
      throw error;
    }
    changed = true;
    if (++admitted === 32) break;
  }
  return changed;
}
export function prepareMailTurn(store, turn) {
  if (!enabled(store.db)) return;
  if (!store.db.isTransaction) mailFail('Mail selection requires the real turn transaction.');
  const db = store.db,
    threadId = db
      .prepare('SELECT threadId FROM project_chat_turn_threads WHERE turnId=?')
      .get(turn.id)?.threadId;
  const mail = new OwnerThreadMail(store);
  // shortcut: four envelopes per reply, expand only with explicit prompt-budget coverage.
  // Its immutable request cannot move to another turn, so select the eligible owner first.
  let selected = 0;
  for (const entry of db
    .prepare(
      `SELECT m.operationId FROM thread_mail_operations m JOIN thread_mail_owner_authorizations a ON a.operationId=m.operationId
    WHERE m.state='pending' AND json_extract(m.envelope,'$.recipient.threadId')=?
    AND NOT EXISTS(SELECT 1 FROM thread_mail_turn_selections s WHERE s.operationId=m.operationId)
    AND NOT EXISTS(SELECT 1 FROM thread_mail_reply_requests r WHERE r.operationId=m.operationId AND r.turnId!=?)
    ORDER BY EXISTS(SELECT 1 FROM thread_mail_reply_requests r WHERE r.operationId=m.operationId AND r.turnId=?) DESC,m.operationId`
    )
    .iterate(threadId, turn.id, turn.id)) {
    const row = mail.storage.get(entry.operationId);
    try {
      eligible(store, row);
    } catch {
      continue;
    }
    db.prepare('INSERT INTO thread_mail_turn_selections VALUES(?,?,?)').run(
      entry.operationId,
      turn.id,
      JSON.stringify(selectedMail(row))
    );
    if (++selected === 4) break;
  }
}
export function reserveMailEffects(store, task, attempt, prompt, manifest) {
  if (!enabled(store.db) || !store.isProjectChatTask(task.id)) return;
  const db = store.db,
    turn = db.prepare('SELECT id FROM project_chat_turns WHERE taskId=?').get(task.id);
  const selected = mailForTurn(db, turn.id);
  if (!selected.length) return;
  if (
    !db.isTransaction ||
    task.prompt !== prompt ||
    manifest.input !== task.prompt ||
    manifest.provider !== 'codex' ||
    JSON.stringify(manifest.threadMail) !== JSON.stringify(selected)
  )
    mailFail('Mail reservation prompt/context differs.');
  const mail = new OwnerThreadMail(store);
  for (const item of selected) {
    const row = mail.storage.get(item.operationId),
      auth = eligible(store, row);
    const effectId = effectIdentity(item.operationId, attempt.id);
    mail.core.begin(localMailOwner(), item.operationId, effectId);
    db.prepare('INSERT INTO thread_mail_effects VALUES(?,?,?,?,?,?,?,?,?)').run(
      item.operationId,
      effectId,
      task.id,
      attempt.id,
      turn.id,
      mailHash(prompt),
      mailHash(manifest),
      manifest.accountInstance,
      auth.relationship.accountBinding
    );
  }
}
