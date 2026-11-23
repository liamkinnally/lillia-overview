import { createHash } from 'node:crypto';
import { assertMailOwner, mailError } from './thread-mail-owner-input.mjs';
import { readMailSubjects } from './thread-mail-settings.mjs';
import { createChatOrigin } from './project-chat-origins.mjs';
import { pinChatContext, readChatContext } from './project-chat-contexts.mjs';
import { OwnerThreadMail } from './thread-mail-owner.mjs';
import { createEnvelope } from './thread-mail.mjs';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const originId = (id) => 'mail.preview.origin:' + hash(id);
const pinId = (id) => 'mail.preview.pin:' + hash(id);
export function normalizeMailPreview(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(',') !==
      'end,recipientThreadId,role,senderThreadId,start,turnId' ||
    !['senderThreadId', 'recipientThreadId'].every(
      (key) => typeof input[key] === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(input[key])
    ) ||
    !['user', 'assistant'].includes(input.role) ||
    !Number.isSafeInteger(input.turnId) ||
    input.turnId < 1 ||
    !Number.isSafeInteger(input.start) ||
    !Number.isSafeInteger(input.end) ||
    input.start < 0 ||
    input.end <= input.start
  )
    mailError('Invalid explicit mail preview.', 400);
  return {
    senderThreadId: input.senderThreadId,
    recipientThreadId: input.recipientThreadId,
    turnId: input.turnId,
    role: input.role,
    start: input.start,
    end: input.end
  };
}
export function applyMailPreview(store, input, operationId, actor) {
  assertMailOwner(actor);
  input = normalizeMailPreview(input);
  if (!store.db.isTransaction) mailError('Mail preview requires the owner transaction.');
  const { projectId, threads, mode } = readMailSubjects(store.db, {}, actor);
  const sender = threads.find((row) => row.threadId === input.senderThreadId);
  const recipient = threads.find((row) => row.threadId === input.recipientThreadId);
  if (
    !sender?.available ||
    !recipient?.available ||
    sender.threadId === recipient.threadId ||
    (sender.threadId !== 'root' && recipient.threadId !== 'root')
  )
    mailError('Mail preview requires ROOT and its available direct branch.', 403);
  const source = { projectId, threadId: sender.threadId, turnId: input.turnId, role: input.role };
  const oid = originId(operationId),
    pid = pinId(operationId);
  const { origin } = store.acceptWithinTransaction(oid, hash(['chat.origin.create', source]), () =>
    createChatOrigin(store.db, source, oid)
  );
  const selected = { projectId, originId: origin.id };
  const { context } = store.acceptWithinTransaction(pid, hash(['chat.context.pin', selected]), () =>
    pinChatContext(store.db, selected, pid)
  );
  const current = readChatContext(store.db, { projectId, id: context.id }).context;
  if (input.end > current.text.length)
    mailError('Mail preview range exceeds its immutable source.', 400);
  const { operationId: ignored, ...envelope } = createEnvelope({
    operationId,
    projectId,
    sender: { threadId: sender.threadId, version: sender.version },
    recipient: { threadId: recipient.threadId, version: recipient.version },
    selection: {
      text: current.text.slice(input.start, input.end),
      source: {
        turnId: String(input.turnId),
        revision: current.id,
        start: input.start,
        end: input.end
      }
    }
  });
  const preview = { kind: 'thread-mail-preview-v1', input, envelope, mode };
  store.db
    .prepare('INSERT INTO thread_mail_owner_previews VALUES(?,?)')
    .run(operationId, JSON.stringify(preview));
  return { preview };
}
function checkedPreview(db, input, id) {
  const row = db
    .prepare('SELECT record FROM thread_mail_owner_previews WHERE operationId=?')
    .get(id);
  const receipt = db
    .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
    .get(id);
  try {
    const preview = JSON.parse(row.record),
      normalized = normalizeMailPreview(preview.input);
    const envelope = createEnvelope({ operationId: id, ...preview.envelope });
    if (
      preview.kind !== 'thread-mail-preview-v1' ||
      !same(input, normalized) ||
      receipt.digest !== hash(['chat.mail.preview', normalized]) ||
      !same(JSON.parse(receipt.receipt), { operationId: id, preview }) ||
      envelope.sender.threadId !== input.senderThreadId ||
      envelope.recipient.threadId !== input.recipientThreadId ||
      envelope.selection.source.turnId !== String(input.turnId) ||
      envelope.selection.source.start !== input.start ||
      envelope.selection.source.end !== input.end ||
      !['start-reply', 'queue-next-reply'].includes(preview.mode)
    )
      throw Error();
    const context = readChatContext(db, {
      projectId: envelope.projectId,
      id: envelope.selection.source.revision
    }).context;
    const pin = db
      .prepare('SELECT operationId FROM project_chat_context_pins WHERE id=?')
      .get(context.id);
    const origin = db
      .prepare('SELECT operationId FROM project_chat_origins WHERE id=?')
      .get(context.originId);
    if (
      context.role !== input.role ||
      pin.operationId !== pinId(id) ||
      origin.operationId !== originId(id)
    )
      throw Error();
    const mail = new OwnerThreadMail({ db });
    mail.selection(envelope);
    mail.relationship(envelope, false);
    return { operationId: id, preview };
  } catch {
    mailError('Mail preview receipt or source differs.');
  }
}
export function replayMailPreview(store, input, id, actor) {
  assertMailOwner(actor);
  input = normalizeMailPreview(input);
  if (!store.db.prepare('SELECT 1 FROM command_receipts WHERE operationId=?').get(id)) return null;
  return checkedPreview(store.db, input, id);
}
export function verifyMailPreviews(db) {
  for (const row of db
    .prepare('SELECT operationId,record FROM thread_mail_owner_previews')
    .iterate()) {
    let input;
    try {
      input = normalizeMailPreview(JSON.parse(row.record).input);
    } catch {
      mailError('Mail preview input is corrupt.');
    }
    checkedPreview(db, input, row.operationId);
  }
  if (
    db
      .prepare(
        `SELECT 1 FROM command_receipts r WHERE CASE WHEN json_valid(receipt)
    THEN json_extract(receipt,'$.preview.kind') END='thread-mail-preview-v1'
    AND NOT EXISTS(SELECT 1 FROM thread_mail_owner_previews p WHERE p.operationId=r.operationId) LIMIT 1`
      )
      .get()
  )
    mailError('Mail preview receipt lost its retained source record.');
}
