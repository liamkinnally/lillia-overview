import { OwnerThreadMail } from './thread-mail-owner.mjs';
import { ThreadMailSqliteStore } from './thread-mail-store.mjs';
import { localMailOwner } from './thread-mail-owner-input.mjs';
import {
  boundMailEffect,
  mailHash,
  mailFail,
  confirmedMailReceipt
} from './thread-mail-effects.mjs';

const enabled = (db) =>
  db.prepare("SELECT 1 FROM sqlite_schema WHERE name='thread_mail_effects' AND type='table'").get();
function effects(db, taskId) {
  return typeof taskId === 'string' && enabled(db)
    ? db
        .prepare('SELECT operationId FROM thread_mail_effects WHERE taskId=? ORDER BY operationId')
        .all(taskId)
    : [];
}
// Called synchronously by the verified native adapter immediately before its one RPC.
// A retained request is uncertainty, never permission to send it again.
// shortcut: Codex owner chat only, extend after another adapter retains exact submission proof.
export function beginMailNativeRequest(store, scope) {
  const rows = effects(store.db, scope.taskId);
  if (!rows.length) return false;
  const db = store.db,
    mail = new OwnerThreadMail(store);
  return mail.storage.transaction(() => {
    let first;
    for (const entry of rows) {
      const bound = boundMailEffect(db, entry.operationId),
        { row, effect, attempt, task } = bound;
      if (
        row.state !== 'uncertain' ||
        !['starting', 'running'].includes(attempt.status) ||
        attempt.threadId !== scope.nativeThreadId ||
        effect.accountInstance !== scope.accountInstance ||
        effect.accountBinding !== scope.accountBinding ||
        JSON.stringify(scope.input) !== JSON.stringify([{ type: 'text', text: task.prompt }])
      )
        mailFail('Mail native request input or account differs.');
      mail.core.authorize(localMailOwner(), 'send', row.envelope);
      mail.core.validate(row.envelope);
      if (first && first.attemptId !== effect.attemptId)
        mailFail('Mail reservation attempt differs.');
      first = effect;
    }
    if (
      db.prepare('SELECT 1 FROM thread_mail_native_requests WHERE attemptId=?').get(first.attemptId)
    )
      mailFail('Mail native request is already uncertain or confirmed.');
    db.prepare('INSERT INTO thread_mail_native_requests VALUES(?,?,?,?,?,?,?)').run(
      first.attemptId,
      scope.taskId,
      scope.nativeThreadId,
      first.promptDigest,
      first.contextDigest,
      scope.accountInstance,
      scope.accountBinding
    );
    return true;
  });
}
// Only a response to the bound turn/start RPC supplies this confirmation. Merely
// observing a queued task, created thread or arbitrary turn/started does not.
export function recordMailNativeConfirmation(store, scope, nativeTurnId) {
  const rows = effects(store.db, scope.taskId);
  if (!rows.length) return false;
  if (typeof nativeTurnId !== 'string' || !nativeTurnId || nativeTurnId.length > 256)
    mailFail('Mail native response lacks an exact turn identity.');
  const db = store.db,
    storage = new ThreadMailSqliteStore(db);
  storage.transaction(() => {
    const bound = boundMailEffect(db, rows[0].operationId),
      { effect, attempt } = bound;
    const request = db
      .prepare('SELECT * FROM thread_mail_native_requests WHERE attemptId=?')
      .get(effect.attemptId);
    if (
      !request ||
      request.nativeThreadId !== scope.nativeThreadId ||
      request.accountInstance !== scope.accountInstance ||
      request.accountBinding !== scope.accountBinding ||
      request.taskId !== scope.taskId ||
      mailHash(scope.input?.[0]?.text ?? '') !== request.inputDigest ||
      JSON.stringify(scope.input) !== JSON.stringify([{ type: 'text', text: bound.task.prompt }]) ||
      (attempt.turnId && attempt.turnId !== nativeTurnId)
    )
      mailFail('Mail confirmation belongs to a different bound request.');
    const record = {
      kind: 'native-turn-start-response',
      attemptId: effect.attemptId,
      taskId: effect.taskId,
      nativeThreadId: request.nativeThreadId,
      nativeTurnId,
      inputDigest: request.inputDigest,
      contextDigest: request.contextDigest,
      accountInstance: request.accountInstance,
      accountBinding: request.accountBinding
    };
    const previous = db
      .prepare('SELECT record FROM thread_mail_native_confirmations WHERE attemptId=?')
      .get(effect.attemptId);
    if (previous) {
      if (previous.record !== JSON.stringify(record))
        mailFail('Mail native confirmation identity changed.');
    } else
      db.prepare('INSERT INTO thread_mail_native_confirmations VALUES(?,?,?,?)').run(
        effect.attemptId,
        request.nativeThreadId,
        nativeTurnId,
        JSON.stringify(record)
      );
  });
  return true;
}
// This is local reconciliation of an already confirmed effect. It never issues RPCs.
export function reconcileMailDeliveries(store) {
  if (!enabled(store.db)) return false;
  const mail = new OwnerThreadMail(store);
  let changed = false;
  for (const entry of store.db
    .prepare("SELECT operationId FROM thread_mail_operations WHERE state='uncertain'")
    .all()) {
    const row = mail.storage.get(entry.operationId);
    const receipt = confirmedMailReceipt(store.db, row.envelope, row.attemptId, row.digest);
    if (!receipt) continue;
    mail.core.deliver(localMailOwner(), entry.operationId, row.attemptId, receipt);
    changed = true;
  }
  return changed;
}
