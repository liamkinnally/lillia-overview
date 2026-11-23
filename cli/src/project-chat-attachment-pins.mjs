import { createHash, randomUUID } from 'node:crypto';
import { ProjectChat, normalizeChatSend } from './project-chat.mjs';
import { attachmentInputs } from './chat-attachments.mjs';
import { readChatSelection, replayChatSelection } from './project-chat-contexts.mjs';

export const attachmentPinTables = ['project_chat_attachment_pins'];
const table = `CREATE TABLE project_chat_attachment_pins (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES project_chat_identity(id),
  selectionId TEXT NOT NULL REFERENCES project_chat_context_selections(id),
  turnId INTEGER NOT NULL REFERENCES project_chat_turns(id),
  attachmentIndex INTEGER NOT NULL,
  content TEXT NOT NULL,
  digest TEXT NOT NULL,
  operationId TEXT NOT NULL UNIQUE REFERENCES command_receipts(operationId) DEFERRABLE INITIALLY DEFERRED
)`;
const noUpdate = `CREATE TRIGGER project_chat_attachment_pin_no_update
BEFORE UPDATE ON project_chat_attachment_pins BEGIN SELECT RAISE(ABORT,'immutable chat attachment pin'); END`;
const noDelete = `CREATE TRIGGER project_chat_attachment_pin_no_delete
BEFORE DELETE ON project_chat_attachment_pins BEGIN SELECT RAISE(ABORT,'immutable chat attachment pin'); END`;
const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(message, status = 409) {
  throw Object.assign(new Error(message), { status });
}
export function installAttachmentPins(db) {
  db.exec(table + ';' + noUpdate + ';' + noDelete);
}
export function normalizeAttachmentPin(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 4 ||
    !uuid(input.projectId) ||
    !uuid(input.selectionId) ||
    !Number.isSafeInteger(input.turnId) ||
    input.turnId < 1 ||
    !Number.isSafeInteger(input.index) ||
    input.index < 0
  )
    fail('Invalid chat attachment pin.', 400);
  return {
    projectId: input.projectId,
    selectionId: input.selectionId,
    turnId: input.turnId,
    index: input.index
  };
}
function source(db, input) {
  const { selection } = readChatSelection(db, {
    projectId: input.projectId,
    id: input.selectionId
  });
  const record = db
    .prepare(
      `SELECT s.*,r.digest AS receiptDigest,r.receipt FROM project_chat_context_selections s
    LEFT JOIN command_receipts r ON r.operationId=s.operationId WHERE s.id=?`
    )
    .get(input.selectionId);
  try {
    const selected = {
      projectId: record.projectId,
      originId: record.originId,
      contextIds: JSON.parse(record.contextIds)
    };
    if (record.receiptDigest !== hash(['chat.selection.create', selected]))
      throw Error('selection digest');
    replayChatSelection(db, selected, record.operationId, record.receipt);
  } catch {
    fail('Chat attachment selection receipt is invalid.');
  }
  const turn = db
    .prepare(
      `SELECT t.*,m.threadId FROM project_chat_turns t
    JOIN project_chat_turn_threads m ON m.turnId=t.id WHERE t.id=?`
    )
    .get(input.turnId);
  if (!turn || turn.threadId !== selection.threadId || turn.id > selection.turnId)
    fail('Chat attachment crosses its selected boundary.');
  let file;
  try {
    const scope = JSON.parse(turn.scope || '{}');
    const send = normalizeChatSend({
      text: turn.ownerText,
      attachments: attachmentInputs(scope.attachments ?? [])
    });
    const receipt = db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(turn.operationId);
    const ack = JSON.parse(receipt.receipt);
    if (
      ack?.operationId !== turn.operationId ||
      ack.turnId !== turn.id ||
      (receipt.digest !== hash(['chat.send', { ...send, threadId: turn.threadId }]) &&
        !(turn.threadId === 'root' && receipt.digest === hash(['chat.send', send])))
    )
      throw Error('send receipt');
    file = new ProjectChat({ db }, null).attachment({
      threadId: turn.threadId,
      turnId: turn.id,
      index: input.index
    });
  } catch {
    fail('Chat attachment source or send receipt is invalid.');
  }
  return { selection, file };
}
function metadata(row, selection, file) {
  return {
    id: row.id,
    kind: 'chat-attachment-pin-v1',
    projectId: row.projectId,
    selectionId: row.selectionId,
    threadId: selection.threadId,
    anchorTurnId: selection.turnId,
    anchorRole: selection.role,
    turnId: row.turnId,
    index: row.attachmentIndex,
    attachment: file.attachment,
    digest: row.digest,
    scope: 'selected-attachment',
    status: 'owner-only'
  };
}
export function createAttachmentPin(db, input, operationId) {
  input = normalizeAttachmentPin(input);
  const { selection, file } = source(db, input);
  const row = {
    id: randomUUID(),
    ...input,
    attachmentIndex: input.index,
    content: JSON.stringify(file),
    digest: hash([input, selection.digest, file])
  };
  db.prepare('INSERT INTO project_chat_attachment_pins VALUES(?,?,?,?,?,?,?,?)').run(
    row.id,
    row.projectId,
    row.selectionId,
    row.turnId,
    row.index,
    row.content,
    row.digest,
    operationId
  );
  return { pin: metadata(row, selection, file) };
}
export function readAttachmentPin(db, input) {
  if (!input || Object.keys(input).length !== 2 || !uuid(input.projectId) || !uuid(input.id))
    fail('Invalid attachment pin.', 400);
  const row = db
    .prepare('SELECT * FROM project_chat_attachment_pins WHERE id=? AND projectId=?')
    .get(input.id, input.projectId);
  if (!row) fail('Chat attachment pin not found.', 404);
  const normalized = normalizeAttachmentPin({
    projectId: row.projectId,
    selectionId: row.selectionId,
    turnId: row.turnId,
    index: row.attachmentIndex
  });
  const { selection, file } = source(db, normalized);
  if (
    !uuid(row.id) ||
    row.content !== JSON.stringify(file) ||
    row.digest !== hash([normalized, selection.digest, file])
  )
    fail('Chat attachment pin failed its content check.');
  const details = metadata(row, selection, file);
  try {
    const receipt = db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(row.operationId);
    const parsed = JSON.parse(receipt.receipt);
    if (
      receipt.digest !== hash(['chat.attachment.pin', normalized]) ||
      !parsed ||
      Object.keys(parsed).length !== 2 ||
      parsed.operationId !== row.operationId ||
      JSON.stringify(parsed.pin) !== JSON.stringify(details)
    )
      throw Error('receipt differs');
  } catch {
    fail('Chat attachment pin receipt is invalid.');
  }
  return { pin: { ...details, text: file.text } };
}
export function replayAttachmentPin(db, input, operationId, receiptText) {
  try {
    const row = db
      .prepare('SELECT * FROM project_chat_attachment_pins WHERE operationId=?')
      .get(operationId);
    if (
      !row ||
      row.projectId !== input.projectId ||
      row.selectionId !== input.selectionId ||
      row.turnId !== input.turnId ||
      row.attachmentIndex !== input.index
    )
      throw Error('pin differs');
    const { pin } = readAttachmentPin(db, { projectId: input.projectId, id: row.id });
    const { text, ...details } = pin,
      receipt = JSON.parse(receiptText);
    if (
      !receipt ||
      Object.keys(receipt).length !== 2 ||
      receipt.operationId !== operationId ||
      JSON.stringify(receipt.pin) !== JSON.stringify(details)
    )
      throw Error('receipt differs');
    return receipt;
  } catch {
    fail('Chat attachment pin receipt is invalid.');
  }
}
export function verifyAttachmentPins(db) {
  const invalid = () => fail('Chat attachment pins are invalid.');
  for (const [type, name, sql] of [
    ['table', 'project_chat_attachment_pins', table],
    ['trigger', 'project_chat_attachment_pin_no_update', noUpdate],
    ['trigger', 'project_chat_attachment_pin_no_delete', noDelete]
  ])
    if (
      db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?').get(type, name)?.sql !==
      sql
    )
      invalid();
  for (const row of db
    .prepare(
      `SELECT p.*,r.digest AS receiptDigest,r.receipt FROM project_chat_attachment_pins p LEFT JOIN command_receipts r ON r.operationId=p.operationId`
    )
    .iterate()) {
    try {
      const input = normalizeAttachmentPin({
        projectId: row.projectId,
        selectionId: row.selectionId,
        turnId: row.turnId,
        index: row.attachmentIndex
      });
      if (row.receiptDigest !== hash(['chat.attachment.pin', input])) invalid();
      replayAttachmentPin(db, input, row.operationId, row.receipt);
    } catch {
      invalid();
    }
  }
  if (
    db
      .prepare(
        `SELECT 1 FROM command_receipts r WHERE CASE WHEN json_valid(r.receipt) THEN json_extract(r.receipt,'$.pin.kind') END='chat-attachment-pin-v1' AND NOT EXISTS(SELECT 1 FROM project_chat_attachment_pins p WHERE p.operationId=r.operationId) LIMIT 1`
      )
      .get()
  )
    invalid();
}
