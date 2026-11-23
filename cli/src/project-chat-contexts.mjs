import { createHash, randomUUID } from 'node:crypto';
import { readChatOrigin } from './project-chat-origins.mjs';

export const chatContextTables = ['project_chat_context_pins'];
const table = `CREATE TABLE project_chat_context_pins (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES project_chat_identity(id),
  originId TEXT NOT NULL REFERENCES project_chat_origins(id),
  text TEXT NOT NULL,
  digest TEXT NOT NULL,
  operationId TEXT NOT NULL UNIQUE REFERENCES command_receipts(operationId) DEFERRABLE INITIALLY DEFERRED
)`;
const noUpdate = `CREATE TRIGGER project_chat_context_no_update
BEFORE UPDATE ON project_chat_context_pins BEGIN SELECT RAISE(ABORT,'immutable chat context'); END`;
const noDelete = `CREATE TRIGGER project_chat_context_no_delete
BEFORE DELETE ON project_chat_context_pins BEGIN SELECT RAISE(ABORT,'immutable chat context'); END`;
const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(message, status = 409) {
  throw Object.assign(new Error(message), { status });
}
function inputFields(input, second) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 2 ||
    !Object.hasOwn(input, 'projectId') ||
    !Object.hasOwn(input, second) ||
    !uuid(input.projectId) ||
    !uuid(input[second])
  )
    fail('Invalid chat context selection.', 400);
  return { projectId: input.projectId, [second]: input[second] };
}
export function normalizeChatContext(input) {
  return inputFields(input, 'originId');
}
export function installChatContexts(db) {
  db.exec(table + ';' + noUpdate + ';' + noDelete);
}
function source(db, input) {
  const origin = readChatOrigin(db, { projectId: input.projectId, id: input.originId }).origin;
  const turn = db
    .prepare(
      `SELECT t.ownerText,t.reply,t.state FROM project_chat_turns t
    JOIN project_chat_turn_threads m ON m.turnId=t.id WHERE t.id=? AND m.threadId=?`
    )
    .get(origin.turnId, origin.threadId);
  if (!turn) fail('Chat context origin not found.', 404);
  if (origin.role === 'assistant' && (turn.state !== 'completed' || typeof turn.reply !== 'string'))
    fail('Chat context origin is not complete.');
  const text = origin.role === 'user' ? turn.ownerText : turn.reply;
  const selector = {
    projectId: origin.projectId,
    threadId: origin.threadId,
    turnId: origin.turnId,
    role: origin.role
  };
  if (typeof text !== 'string' || hash([selector, text]) !== origin.sourceDigest)
    fail('Chat context origin failed its content check.');
  return { origin, text };
}
function metadata(row, origin) {
  return {
    id: row.id,
    kind: 'chat-context-pin-v1',
    projectId: row.projectId,
    originId: row.originId,
    threadId: origin.threadId,
    turnId: origin.turnId,
    role: origin.role,
    sourceDigest: origin.sourceDigest,
    digest: row.digest,
    scope: 'message-text',
    status: 'owner-only'
  };
}
function checked(db, row) {
  const { origin, text } = source(db, { projectId: row.projectId, originId: row.originId });
  if (
    !uuid(row.id) ||
    row.text !== text ||
    row.digest !== hash([row.projectId, row.originId, origin.sourceDigest, text])
  )
    fail('Chat context pin failed its content check.');
  return { origin, text };
}
export function pinChatContext(db, input, operationId) {
  input = normalizeChatContext(input);
  const { origin, text } = source(db, input);
  // shortcut: only owner-selected message text is pinned, add authorized files and delivery before enabling side chat.
  const row = {
    id: randomUUID(),
    ...input,
    text,
    digest: hash([input.projectId, input.originId, origin.sourceDigest, text])
  };
  db.prepare(
    `INSERT INTO project_chat_context_pins(id,projectId,originId,text,digest,operationId)
    VALUES(?,?,?,?,?,?)`
  ).run(row.id, row.projectId, row.originId, row.text, row.digest, operationId);
  return { context: metadata(row, origin) };
}
export function readChatContext(db, input) {
  input = inputFields(input, 'id');
  const row = db
    .prepare('SELECT * FROM project_chat_context_pins WHERE id=? AND projectId=?')
    .get(input.id, input.projectId);
  if (!row) fail('Chat context not found.', 404);
  const { origin, text } = checked(db, row);
  return { context: { ...metadata(row, origin), text } };
}
export function verifyChatContexts(db) {
  const invalid = () => fail('Project chat context pins are invalid.');
  const schema = db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?');
  for (const [type, name, sql] of [
    ['table', 'project_chat_context_pins', table],
    ['trigger', 'project_chat_context_no_update', noUpdate],
    ['trigger', 'project_chat_context_no_delete', noDelete]
  ])
    if (schema.get(type, name)?.sql !== sql) invalid();
  for (const row of db
    .prepare(
      `SELECT p.*,r.digest AS receiptDigest,r.receipt FROM project_chat_context_pins p
    LEFT JOIN command_receipts r ON r.operationId=p.operationId`
    )
    .iterate()) {
    try {
      const input = normalizeChatContext({ projectId: row.projectId, originId: row.originId });
      const { origin } = checked(db, row);
      const receipt = JSON.parse(row.receipt);
      if (
        row.receiptDigest !== hash(['chat.context.pin', input]) ||
        receipt.operationId !== row.operationId ||
        JSON.stringify(receipt.context) !== JSON.stringify(metadata(row, origin))
      )
        invalid();
    } catch {
      invalid();
    }
  }
  if (
    db
      .prepare(
        `SELECT 1 FROM command_receipts r WHERE CASE WHEN json_valid(r.receipt)
    THEN json_extract(r.receipt,'$.context.kind') END='chat-context-pin-v1'
    AND NOT EXISTS(SELECT 1 FROM project_chat_context_pins p WHERE p.operationId=r.operationId) LIMIT 1`
      )
      .get()
  )
    invalid();
}

export const chatSelectionTables = ['project_chat_context_selections'];
const selectionTable = `CREATE TABLE project_chat_context_selections (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES project_chat_identity(id),
  originId TEXT NOT NULL REFERENCES project_chat_origins(id),
  contextIds TEXT NOT NULL,
  digest TEXT NOT NULL,
  operationId TEXT NOT NULL UNIQUE REFERENCES command_receipts(operationId) DEFERRABLE INITIALLY DEFERRED
)`;
const selectionUpdate = `CREATE TRIGGER project_chat_selection_no_update
BEFORE UPDATE ON project_chat_context_selections BEGIN SELECT RAISE(ABORT,'immutable chat selection'); END`;
const selectionDelete = `CREATE TRIGGER project_chat_selection_no_delete
BEFORE DELETE ON project_chat_context_selections BEGIN SELECT RAISE(ABORT,'immutable chat selection'); END`;

export function installChatSelections(db) {
  db.exec(selectionTable + ';' + selectionUpdate + ';' + selectionDelete);
}
export function normalizeChatSelection(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 3 ||
    !uuid(input.projectId) ||
    !uuid(input.originId) ||
    !Array.isArray(input.contextIds) ||
    input.contextIds.length < 1 ||
    input.contextIds.length > 32 ||
    !input.contextIds.every(uuid) ||
    new Set(input.contextIds).size !== input.contextIds.length
  )
    fail('Invalid chat message selection.', 400);
  return {
    projectId: input.projectId,
    originId: input.originId,
    contextIds: [...input.contextIds]
  };
}
function selectionMessages(db, input) {
  const anchor = readChatOrigin(db, { projectId: input.projectId, id: input.originId }).origin;
  const messages = input.contextIds.map(
    (id) => readChatContext(db, { projectId: input.projectId, id }).context
  );
  let previous = null,
    size = 0;
  for (const message of messages) {
    const pin = db
      .prepare(
        `SELECT p.operationId,r.digest,r.receipt FROM project_chat_context_pins p
      LEFT JOIN command_receipts r ON r.operationId=p.operationId WHERE p.id=?`
      )
      .get(message.id);
    let receipt;
    try {
      receipt = JSON.parse(pin.receipt);
    } catch {
      fail('Chat selection source receipt is invalid.');
    }
    const { text, ...pinMetadata } = message;
    if (
      pin.digest !==
        hash(['chat.context.pin', { projectId: input.projectId, originId: message.originId }]) ||
      receipt?.operationId !== pin.operationId ||
      JSON.stringify(receipt.context) !== JSON.stringify(pinMetadata)
    )
      fail('Chat selection source receipt is invalid.');
    const position = [message.turnId, message.role === 'user' ? 0 : 1];
    const end = [anchor.turnId, anchor.role === 'user' ? 0 : 1];
    if (
      message.threadId !== anchor.threadId ||
      position[0] > end[0] ||
      (position[0] === end[0] && position[1] > end[1]) ||
      (previous &&
        (position[0] < previous[0] || (position[0] === previous[0] && position[1] <= previous[1])))
    )
      fail('Chat selection crosses its source boundary.');
    previous = position;
    size += Buffer.byteLength(text);
  }
  if (messages.at(-1).originId !== anchor.id || size > 262144)
    fail('Chat selection must end at the selected origin and fit the size limit.');
  return { anchor, messages };
}
function selectionMetadata(row, anchor) {
  // shortcut: owner-only message text, add file and recipient grants before delivery.
  return {
    id: row.id,
    kind: 'chat-message-selection-v1',
    projectId: row.projectId,
    originId: row.originId,
    threadId: anchor.threadId,
    turnId: anchor.turnId,
    role: anchor.role,
    digest: row.digest,
    scope: 'selected-message-text',
    status: 'owner-only',
    files: [],
    providerDestinations: []
  };
}
export function createChatSelection(db, input, operationId) {
  input = normalizeChatSelection(input);
  const { anchor, messages } = selectionMessages(db, input);
  const row = { id: randomUUID(), ...input, digest: hash([input, messages]) };
  db.prepare('INSERT INTO project_chat_context_selections VALUES(?,?,?,?,?,?)').run(
    row.id,
    row.projectId,
    row.originId,
    JSON.stringify(row.contextIds),
    row.digest,
    operationId
  );
  return { selection: selectionMetadata(row, anchor) };
}
export function readChatSelection(db, input) {
  input = inputFields(input, 'id');
  const row = db
    .prepare('SELECT * FROM project_chat_context_selections WHERE id=? AND projectId=?')
    .get(input.id, input.projectId);
  if (!row) fail('Chat selection not found.', 404);
  const selection = normalizeChatSelection({
    projectId: row.projectId,
    originId: row.originId,
    contextIds: JSON.parse(row.contextIds)
  });
  const { anchor, messages } = selectionMessages(db, selection);
  if (row.digest !== hash([selection, messages])) fail('Chat selection failed its content check.');
  return { selection: { ...selectionMetadata(row, anchor), messages } };
}
export function replayChatSelection(db, input, operationId, receiptText) {
  try {
    const row = db
      .prepare('SELECT * FROM project_chat_context_selections WHERE operationId=?')
      .get(operationId);
    if (
      !row ||
      row.projectId !== input.projectId ||
      row.originId !== input.originId ||
      row.contextIds !== JSON.stringify(input.contextIds)
    )
      throw new Error('Selection differs');
    const { selection } = readChatSelection(db, { projectId: input.projectId, id: row.id });
    const { messages, ...metadata } = selection;
    const receipt = JSON.parse(receiptText);
    if (
      !receipt ||
      Object.keys(receipt).length !== 2 ||
      receipt.operationId !== operationId ||
      JSON.stringify(receipt.selection) !== JSON.stringify(metadata)
    )
      throw new Error('Receipt differs');
    return receipt;
  } catch {
    fail('Chat selection receipt is invalid.');
  }
}
export function verifyChatSelections(db) {
  const invalid = () => fail('Project chat selections are invalid.');
  const schema = db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?');
  for (const [type, name, sql] of [
    ['table', 'project_chat_context_selections', selectionTable],
    ['trigger', 'project_chat_selection_no_update', selectionUpdate],
    ['trigger', 'project_chat_selection_no_delete', selectionDelete]
  ])
    if (schema.get(type, name)?.sql !== sql) invalid();
  for (const row of db
    .prepare(
      `SELECT s.*,r.digest AS receiptDigest,r.receipt
    FROM project_chat_context_selections s LEFT JOIN command_receipts r ON r.operationId=s.operationId`
    )
    .iterate()) {
    try {
      const input = normalizeChatSelection({
        projectId: row.projectId,
        originId: row.originId,
        contextIds: JSON.parse(row.contextIds)
      });
      const { selection } = readChatSelection(db, { projectId: row.projectId, id: row.id });
      const { messages, ...metadata } = selection;
      const receipt = JSON.parse(row.receipt);
      if (
        !uuid(row.id) ||
        JSON.stringify(input.contextIds) !== row.contextIds ||
        row.receiptDigest !== hash(['chat.selection.create', input]) ||
        receipt.operationId !== row.operationId ||
        JSON.stringify(receipt.selection) !== JSON.stringify(metadata)
      )
        invalid();
    } catch {
      invalid();
    }
  }
  if (
    db
      .prepare(
        `SELECT 1 FROM command_receipts r WHERE CASE WHEN json_valid(r.receipt)
    THEN json_extract(r.receipt,'$.selection.kind') END='chat-message-selection-v1'
    AND NOT EXISTS(SELECT 1 FROM project_chat_context_selections s WHERE s.operationId=r.operationId) LIMIT 1`
      )
      .get()
  )
    invalid();
}
