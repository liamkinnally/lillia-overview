import { mailOwnerSchema } from './thread-mail-owner-schema.mjs';
import { verifyMailPreviews } from './thread-mail-preview.mjs';
import { OwnerThreadMail } from './thread-mail-owner.mjs';
import { ThreadMailSqliteStore } from './thread-mail-store.mjs';
import { mailError } from './thread-mail-owner-input.mjs';

export function verifyMailOwner(db) {
  const schema = db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?');
  for (const [type, name, sql] of mailOwnerSchema)
    if (schema.get(type, name)?.sql !== sql) mailError('Owner mail recovery schema differs.');
  verifyMailPreviews(db);
  const expected = new Set(mailOwnerSchema.map((x) => x[1]));
  for (const row of db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE tbl_name IN ('thread_mail_owner_authorizations','thread_mail_owner_actions','thread_mail_owner_previews') AND sql IS NOT NULL"
    )
    .iterate())
    if (!expected.has(row.name)) mailError('Owner mail recovery objects differ.');
  const mail = new OwnerThreadMail({ db }),
    storage = new ThreadMailSqliteStore(db);
  let authorizations = 0,
    actions = 0,
    unowned = 0;
  for (const row of db
    .prepare('SELECT operationId FROM thread_mail_owner_authorizations')
    .iterate()) {
    const operation = storage.get(row.operationId);
    if (!operation) mailError('Owner mail authority has no envelope.');
    mail.authorization(operation.envelope);
    authorizations++;
  }
  for (const row of db.prepare('SELECT operationId FROM thread_mail_owner_actions').iterate()) {
    const action = mail.checkedAction(row.operationId);
    const id = action.name === 'chat.mail.send' ? row.operationId : action.input.id;
    const operation = storage.get(id);
    if (
      !operation ||
      action.result.mail.digest !== operation.digest ||
      JSON.stringify(action.result.mail.envelope) !== JSON.stringify(operation.envelope)
    )
      mailError('Owner mail action envelope differs.');
    if (
      action.name !== 'chat.mail.send' &&
      (!mail.confirmReceipt(
        operation.envelope,
        operation.attemptId,
        operation.receipt,
        operation.digest
      ) ||
        action.input.digest !== operation.digest ||
        action.input.attemptId !== operation.attemptId ||
        action.input.receipt !== operation.receipt ||
        action.input.projectId !== operation.envelope.projectId ||
        action.result.mail.attemptId !== operation.attemptId ||
        action.result.mail.receipt !== operation.receipt ||
        (action.name === 'chat.mail.resolve' &&
          (action.input.resolution !== operation.resolution ||
            action.result.mail.resolution !== operation.resolution)) ||
        action.result.mail.state !==
          (action.name === 'chat.mail.acknowledge' ? 'acknowledged' : 'resolved'))
    )
      mailError('Owner mail action has no verified native delivery.');
    const authorization = mail.authorization(operation.envelope);
    if (
      action.result.mode !== authorization.mode ||
      JSON.stringify(action.result.authorization) !== JSON.stringify(authorization)
    )
      mailError('Owner mail follow-up authorization or mode differs from the send.');
    actions++;
  }
  // Preserve earlier storage-only evidence, but it cannot authorize any owner API/effect.
  for (const row of db.prepare('SELECT operationId FROM thread_mail_operations').iterate())
    if (
      !db
        .prepare('SELECT 1 FROM thread_mail_owner_authorizations WHERE operationId=?')
        .get(row.operationId)
    )
      unowned++;
  return { authorizations, actions, unownedFenced: unowned };
}
