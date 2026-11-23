import { createHash } from 'node:crypto';
import { ThreadMailSqliteStore } from './thread-mail-store.mjs';
import { inspectBranchContext } from './project-chat-branch-delivery.mjs';
export const mailHash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export const mailFail = (message) => {
  throw Object.assign(new Error(message), { status: 409 });
};
export const effectIdentity = (id, attempt) => 'mail-effect:' + mailHash([id, attempt]);
export const receiptIdentity = (id, attempt, thread, turn) =>
  'mail-receipt:' + mailHash([id, attempt, thread, turn]);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function selectedMail(row) {
  return {
    kind: 'selected-owner-thread-mail',
    operationId: row.envelope.operationId,
    digest: row.digest,
    sender: row.envelope.sender,
    recipient: row.envelope.recipient,
    selection: row.envelope.selection
  };
}
export function mailForTurn(db, turnId) {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE name='thread_mail_turn_selections' AND type='table'"
      )
      .get()
  )
    return [];
  return db
    .prepare(
      'SELECT operationId,record FROM thread_mail_turn_selections WHERE turnId=? ORDER BY operationId'
    )
    .all(turnId)
    .map((row) => {
      const mail = new ThreadMailSqliteStore(db).get(row.operationId);
      const record = JSON.parse(row.record);
      if (!mail || !equal(selectedMail(mail), record))
        mailFail('Mail selected turn input differs.');
      return record;
    });
}
export function boundMailEffect(db, id) {
  const effect = db.prepare('SELECT * FROM thread_mail_effects WHERE operationId=?').get(id);
  if (!effect) mailFail('Mail effect binding unavailable.');
  const row = new ThreadMailSqliteStore(db).get(id);
  const turn = db
    .prepare(
      `SELECT c.*,m.threadId FROM project_chat_turns c
    JOIN project_chat_turn_threads m ON m.turnId=c.id WHERE c.id=?`
    )
    .get(effect.turnId);
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(effect.taskId);
  const attempt = db.prepare('SELECT * FROM attempts WHERE id=?').get(effect.attemptId);
  const context =
    attempt &&
    db
      .prepare('SELECT * FROM task_contexts WHERE taskId=? AND ordinal=?')
      .get(task?.id, attempt.ordinal);
  if (
    !row ||
    !turn ||
    !task ||
    !attempt ||
    !context ||
    turn.taskId !== task.id ||
    attempt.taskId !== task.id ||
    row.attemptId !== effect.effectId ||
    effect.effectId !== effectIdentity(id, attempt.id) ||
    row.envelope.recipient.threadId !== turn.threadId ||
    attempt.driver !== 'codex' ||
    attempt.accountInstance !== effect.accountInstance ||
    mailHash(task.prompt) !== effect.promptDigest ||
    context.digest !== effect.contextDigest ||
    mailHash(context.manifest) !== context.digest
  )
    mailFail('Mail task/attempt/context identity differs.');
  const manifest = JSON.parse(context.manifest);
  if (
    manifest.taskId !== task.id ||
    manifest.ordinal !== attempt.ordinal ||
    manifest.input !== task.prompt ||
    manifest.accountInstance !== effect.accountInstance ||
    manifest.provider !== 'codex' ||
    manifest.promptDigest !== effect.promptDigest ||
    !equal(manifest.threadMail, mailForTurn(db, turn.id))
  )
    mailFail('Mail dispatch manifest differs.');
  let payload;
  try {
    payload = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf('\n') + 1));
  } catch {
    mailFail('Mail composed prompt differs.');
  }
  if (
    task.prompt.length > 19500 ||
    payload.ownerMessage !== turn.ownerText ||
    !equal(payload.incomingThreadMail, mailForTurn(db, turn.id))
  )
    mailFail('Mail composed selection differs.');
  if (turn.threadId !== 'root') {
    const original = inspectBranchContext(db, {
      projectId: row.envelope.projectId,
      threadId: turn.threadId
    });
    if (!equal(payload.parentContext, original)) mailFail('Mail original parent context differs.');
  }
  return { effect, row, turn, task, attempt, manifest };
}
export function confirmedMailReceipt(db, envelope, effectId, digest) {
  if (
    !db.prepare("SELECT 1 FROM sqlite_schema WHERE name='thread_mail_native_confirmations'").get()
  )
    return null;
  try {
    const bound = boundMailEffect(db, envelope.operationId),
      { effect, row, attempt } = bound;
    if (effect.effectId !== effectId || row.digest !== digest || !equal(row.envelope, envelope))
      return null;
    const request = db
      .prepare('SELECT * FROM thread_mail_native_requests WHERE attemptId=?')
      .get(attempt.id);
    const proof = db
      .prepare('SELECT * FROM thread_mail_native_confirmations WHERE attemptId=?')
      .get(attempt.id);
    if (
      !request ||
      !proof ||
      request.taskId !== effect.taskId ||
      request.inputDigest !== effect.promptDigest ||
      request.contextDigest !== effect.contextDigest ||
      request.accountInstance !== effect.accountInstance ||
      request.accountBinding !== effect.accountBinding ||
      proof.nativeThreadId !== request.nativeThreadId ||
      attempt.threadId !== request.nativeThreadId ||
      (attempt.turnId && attempt.turnId !== proof.nativeTurnId) ||
      typeof proof.nativeTurnId !== 'string' ||
      !proof.nativeTurnId ||
      proof.nativeTurnId.length > 256
    )
      return null;
    const expected = {
      kind: 'native-turn-start-response',
      attemptId: attempt.id,
      taskId: effect.taskId,
      nativeThreadId: request.nativeThreadId,
      nativeTurnId: proof.nativeTurnId,
      inputDigest: request.inputDigest,
      contextDigest: request.contextDigest,
      accountInstance: request.accountInstance,
      accountBinding: request.accountBinding
    };
    if (!equal(JSON.parse(proof.record), expected)) return null;
    return receiptIdentity(
      envelope.operationId,
      attempt.id,
      proof.nativeThreadId,
      proof.nativeTurnId
    );
  } catch {
    return null;
  }
}
export function verifyMailReceipt(db, envelope, effectId, receipt, digest) {
  return (
    typeof receipt === 'string' && confirmedMailReceipt(db, envelope, effectId, digest) === receipt
  );
}
