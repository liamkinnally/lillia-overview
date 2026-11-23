import { mailDeliverySchema, mailDeliveryTables } from './thread-mail-delivery-schema.mjs';
import { OwnerThreadMail } from './thread-mail-owner.mjs';
import {
  selectedMail,
  mailForTurn,
  mailHash,
  mailFail,
  boundMailEffect,
  confirmedMailReceipt
} from './thread-mail-effects.mjs';
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function verifyMailDelivery(db) {
  const schema = db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?');
  for (const [type, name, sql] of mailDeliverySchema)
    if (schema.get(type, name)?.sql !== sql) mailFail('Mail delivery recovery schema differs.');
  const expected = new Set(mailDeliverySchema.map((x) => x[1]));
  for (const table of mailDeliveryTables)
    for (const row of db
      .prepare('SELECT name FROM sqlite_schema WHERE tbl_name=? AND sql IS NOT NULL')
      .all(table))
      if (!expected.has(row.name)) mailFail('Mail delivery recovery objects differ.');
  const mail = new OwnerThreadMail({ db });
  for (const row of db.prepare('SELECT * FROM thread_mail_reply_requests').iterate()) {
    const operation = mail.storage.get(row.operationId),
      auth = operation && mail.authorization(operation.envelope);
    const turn = db.prepare('SELECT * FROM project_chat_turns WHERE id=?').get(row.turnId);
    const mapping = db
      .prepare('SELECT threadId FROM project_chat_turn_threads WHERE turnId=?')
      .get(row.turnId);
    if (
      !auth ||
      auth.mode !== 'start-reply' ||
      turn?.operationId !== row.replyOperationId ||
      row.replyOperationId !== 'chat.mail.reply:' + mailHash(row.operationId) ||
      mapping?.threadId !== operation.envelope.recipient.threadId
    )
      mailFail('Mail reply request authority differs.');
  }
  for (const row of db.prepare('SELECT * FROM thread_mail_turn_selections').iterate()) {
    const operation = mail.storage.get(row.operationId);
    const mapping = db
      .prepare('SELECT threadId FROM project_chat_turn_threads WHERE turnId=?')
      .get(row.turnId);
    if (
      !operation ||
      operation.envelope.recipient.threadId !== mapping?.threadId ||
      !equal(JSON.parse(row.record), selectedMail(operation))
    )
      mailFail('Mail selected turn provenance differs.');
    mail.authorization(operation.envelope);
    mailForTurn(db, row.turnId);
  }
  for (const row of db.prepare('SELECT operationId FROM thread_mail_effects').iterate())
    boundMailEffect(db, row.operationId);
  for (const row of db.prepare('SELECT * FROM thread_mail_native_requests').iterate()) {
    const effects = db
      .prepare('SELECT operationId FROM thread_mail_effects WHERE attemptId=?')
      .all(row.attemptId);
    if (!effects.length) mailFail('Mail native request has no bound envelope.');
    for (const entry of effects) {
      const { effect, attempt } = boundMailEffect(db, entry.operationId);
      if (
        row.taskId !== effect.taskId ||
        row.nativeThreadId !== attempt.threadId ||
        row.inputDigest !== effect.promptDigest ||
        row.contextDigest !== effect.contextDigest ||
        row.accountInstance !== effect.accountInstance ||
        row.accountBinding !== effect.accountBinding
      )
        mailFail('Mail native request context differs.');
    }
  }
  for (const row of db
    .prepare('SELECT attemptId FROM thread_mail_native_confirmations')
    .iterate()) {
    const effects = db
      .prepare('SELECT operationId FROM thread_mail_effects WHERE attemptId=?')
      .all(row.attemptId);
    if (!effects.length) mailFail('Mail native confirmation has no bound effect.');
    for (const entry of effects) {
      const operation = mail.storage.get(entry.operationId);
      if (!confirmedMailReceipt(db, operation.envelope, operation.attemptId, operation.digest))
        mailFail('Mail native confirmation proof differs.');
    }
  }
  return Object.fromEntries(
    mailDeliveryTables.map((name) => [name, db.prepare('SELECT count(*) n FROM ' + name).get().n])
  );
}
