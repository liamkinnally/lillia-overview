import { createHash, randomUUID } from 'node:crypto';

export const originTables = ['project_chat_identity', 'project_chat_origins'];
const identityTable = `CREATE TABLE project_chat_identity (
  slot INTEGER PRIMARY KEY CHECK(slot=1),
  id TEXT NOT NULL UNIQUE
)`;
const originTable = `CREATE TABLE project_chat_origins (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES project_chat_identity(id),
  threadId TEXT NOT NULL REFERENCES project_chat_threads(id),
  turnId INTEGER NOT NULL REFERENCES project_chat_turns(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  sourceDigest TEXT NOT NULL,
  operationId TEXT NOT NULL UNIQUE REFERENCES command_receipts(operationId) DEFERRABLE INITIALLY DEFERRED
)`;
const identityUpdate = `CREATE TRIGGER project_chat_identity_no_update
BEFORE UPDATE ON project_chat_identity BEGIN SELECT RAISE(ABORT,'immutable project identity'); END`;
const identityDelete = `CREATE TRIGGER project_chat_identity_no_delete
BEFORE DELETE ON project_chat_identity BEGIN SELECT RAISE(ABORT,'immutable project identity'); END`;
const originUpdate = `CREATE TRIGGER project_chat_origin_no_update
BEFORE UPDATE ON project_chat_origins BEGIN SELECT RAISE(ABORT,'immutable chat origin'); END`;
const originDelete = `CREATE TRIGGER project_chat_origin_no_delete
BEFORE DELETE ON project_chat_origins BEGIN SELECT RAISE(ABORT,'immutable chat origin'); END`;
const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(message, status = 409) {
  throw Object.assign(new Error(message), { status });
}
export function installChatOrigins(db) {
  db.exec(
    identityTable +
      ';' +
      originTable +
      ';' +
      identityUpdate +
      ';' +
      identityDelete +
      ';' +
      originUpdate +
      ';' +
      originDelete
  );
  db.prepare('INSERT INTO project_chat_identity(slot,id) VALUES(1,?)').run(randomUUID());
}
export function normalizeChatOrigin(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 4 ||
    !uuid(input.projectId) ||
    !(input.threadId === 'root' || uuid(input.threadId)) ||
    !Number.isSafeInteger(input.turnId) ||
    input.turnId < 1 ||
    !['user', 'assistant'].includes(input.role)
  )
    fail('Invalid chat origin.', 400);
  return {
    projectId: input.projectId,
    threadId: input.threadId,
    turnId: input.turnId,
    role: input.role
  };
}
export function chatProject(db) {
  const row = db.prepare('SELECT id FROM project_chat_identity WHERE slot=1').get();
  if (!row || !uuid(row.id)) fail('Project chat identity unavailable.');
  return { projectId: row.id };
}
function source(db, input) {
  if (chatProject(db).projectId !== input.projectId) fail('Project chat origin not found.', 404);
  const row = db
    .prepare(
      `SELECT t.ownerText,t.reply,t.state FROM project_chat_turns t
    JOIN project_chat_turn_threads m ON m.turnId=t.id WHERE t.id=? AND m.threadId=?`
    )
    .get(input.turnId, input.threadId);
  if (!row) fail('Project chat origin not found.', 404);
  if (input.role === 'assistant' && (row.state !== 'completed' || typeof row.reply !== 'string'))
    fail('Select a completed assistant message.');
  return input.role === 'user' ? row.ownerText : row.reply;
}
function view(row) {
  return {
    id: row.id,
    projectId: row.projectId,
    threadId: row.threadId,
    turnId: row.turnId,
    role: row.role,
    sourceDigest: row.sourceDigest,
    status: 'origin-only'
  };
}
export function createChatOrigin(db, input, operationId) {
  input = normalizeChatOrigin(input);
  const text = source(db, input);
  const row = { id: randomUUID(), ...input, sourceDigest: hash([input, text]) };
  db.prepare(
    `INSERT INTO project_chat_origins(id,projectId,threadId,turnId,role,sourceDigest,operationId)
    VALUES(?,?,?,?,?,?,?)`
  ).run(row.id, row.projectId, row.threadId, row.turnId, row.role, row.sourceDigest, operationId);
  return { origin: view(row) };
}
export function readChatOrigin(db, input) {
  if (!input || Object.keys(input).length !== 2 || !uuid(input.projectId) || !uuid(input.id))
    fail('Invalid chat origin.', 400);
  if (chatProject(db).projectId !== input.projectId) fail('Project chat origin not found.', 404);
  const row = db
    .prepare('SELECT * FROM project_chat_origins WHERE id=? AND projectId=?')
    .get(input.id, input.projectId);
  if (!row) fail('Project chat origin not found.', 404);
  return { origin: view(row) };
}
export function verifyChatOrigins(db) {
  const invalid = () => fail('Project chat origin records are invalid.');
  const schema = db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?');
  for (const [type, name, sql] of [
    ['table', 'project_chat_identity', identityTable],
    ['table', 'project_chat_origins', originTable],
    ['trigger', 'project_chat_identity_no_update', identityUpdate],
    ['trigger', 'project_chat_identity_no_delete', identityDelete],
    ['trigger', 'project_chat_origin_no_update', originUpdate],
    ['trigger', 'project_chat_origin_no_delete', originDelete]
  ])
    if (schema.get(type, name)?.sql !== sql) invalid();
  const identities = db.prepare('SELECT slot,id FROM project_chat_identity').all();
  if (identities.length !== 1 || identities[0].slot !== 1 || !uuid(identities[0].id)) invalid();
  for (const row of db
    .prepare(
      `SELECT o.*,r.digest,r.receipt FROM project_chat_origins o
    LEFT JOIN command_receipts r ON r.operationId=o.operationId`
    )
    .iterate()) {
    try {
      const input = normalizeChatOrigin({
        projectId: row.projectId,
        threadId: row.threadId,
        turnId: row.turnId,
        role: row.role
      });
      const receipt = JSON.parse(row.receipt);
      if (
        !uuid(row.id) ||
        row.sourceDigest !== hash([input, source(db, input)]) ||
        row.digest !== hash(['chat.origin.create', input]) ||
        receipt.operationId !== row.operationId ||
        JSON.stringify(receipt.origin) !== JSON.stringify(view(row))
      )
        invalid();
    } catch {
      invalid();
    }
  }
}
