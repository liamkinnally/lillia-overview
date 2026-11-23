import { chatProject } from './project-chat-origins.mjs';
import { mailOwnerSchema } from './thread-mail-owner-schema.mjs';
import { mailDeliverySchema } from './thread-mail-delivery-schema.mjs';
import { createHash } from 'node:crypto';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fail() {
  throw Object.assign(new Error('Thread mail authority history or schema differs.'), {
    status: 409
  });
}
const state = `CREATE TABLE thread_mail_authority (
  threadId TEXT PRIMARY KEY REFERENCES project_chat_threads(id),
  projectId TEXT NOT NULL REFERENCES project_chat_identity(id),
  version INTEGER NOT NULL CHECK(version>=1 AND version<9007199254740991),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot))
)`;
const events = `CREATE TABLE thread_mail_authority_events (
  threadId TEXT NOT NULL REFERENCES thread_mail_authority(threadId),
  version INTEGER NOT NULL CHECK(version>=1),
  reason TEXT NOT NULL,
  reference TEXT NOT NULL CHECK(json_valid(reference)),
  prior TEXT,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  PRIMARY KEY(threadId,version)
)`;
// These are deny switches, never grants. An exact owner action is still required.
const permissions = `CREATE TABLE thread_mail_permissions (
  threadId TEXT PRIMARY KEY REFERENCES project_chat_threads(id),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  operationId TEXT NOT NULL UNIQUE REFERENCES command_receipts(operationId) DEFERRABLE INITIALLY DEFERRED
)`;
// Persist only authority inputs. Messages, titles, pins and mail states are absent.
// Root participates in its direct relationships; independent side threads do not.
const inputs = `CREATE VIEW thread_mail_authority_inputs AS
SELECT t.id AS threadId,p.id AS projectId,json_array(p.id,t.id,
  (SELECT json_group_array(json_array(key,value)) FROM
    (SELECT key,value FROM settings WHERE key IN ('codex.accountInstance','codex.accountBinding')
      OR (t.id='root' AND key IN ('claude.accountInstance','claude.accountBinding')) ORDER BY key)),
  (SELECT json_group_array(json_array(threadId,projectId,preparationId,parentGrantId,operationId)) FROM
    (SELECT * FROM project_chat_branch_threads WHERE threadId=t.id OR t.id='root' ORDER BY threadId)),
  (WITH RECURSIVE chain(id) AS (
    SELECT parentGrantId FROM project_chat_branch_threads WHERE threadId=t.id OR t.id='root'
    UNION SELECT g.parentGrantId FROM project_chat_parent_grants g JOIN chain c ON c.id=g.id WHERE g.parentGrantId IS NOT NULL
  ) SELECT json_group_array(json_array(id,accountInstance,parentGrantId,operationId,revocation)) FROM
    (SELECT g.*,r.operationId AS revocation FROM project_chat_parent_grants g JOIN chain c ON c.id=g.id
      LEFT JOIN project_chat_parent_revocations r ON r.grantId=g.id ORDER BY g.id)),
  (SELECT enabled FROM thread_mail_permissions WHERE threadId=t.id)
) AS snapshot FROM project_chat_threads t CROSS JOIN project_chat_identity p WHERE p.slot=1`;

function refresh(name, event, table, reason, reference, when = '') {
  return `CREATE TRIGGER ${name} AFTER ${event} ON ${table} ${when}
BEGIN
  INSERT INTO thread_mail_authority_events(threadId,version,reason,reference,prior,snapshot)
  SELECT a.threadId,a.version+1,'${reason}',${reference},a.snapshot,i.snapshot
  FROM thread_mail_authority a JOIN thread_mail_authority_inputs i ON i.threadId=a.threadId
  WHERE a.snapshot!=i.snapshot;
  UPDATE thread_mail_authority SET version=version+1,
    snapshot=(SELECT snapshot FROM thread_mail_authority_inputs i WHERE i.threadId=thread_mail_authority.threadId)
  WHERE snapshot!=(SELECT snapshot FROM thread_mail_authority_inputs i WHERE i.threadId=thread_mail_authority.threadId);
END`;
}
const initialize = `CREATE TRIGGER thread_mail_thread_initialize AFTER INSERT ON project_chat_threads
BEGIN
  INSERT INTO thread_mail_authority SELECT threadId,projectId,1,snapshot FROM thread_mail_authority_inputs WHERE threadId=NEW.id;
  INSERT INTO thread_mail_authority_events SELECT threadId,1,'initialize',json_object('threadId',threadId),NULL,snapshot
  FROM thread_mail_authority WHERE threadId=NEW.id;
END`;
const objects = [
  ['table', 'thread_mail_authority', state],
  ['table', 'thread_mail_authority_events', events],
  ['table', 'thread_mail_permissions', permissions],
  ['view', 'thread_mail_authority_inputs', inputs],
  ['trigger', 'thread_mail_thread_initialize', initialize]
];
objects.push([
  'trigger',
  'thread_mail_permission_no_delete',
  `CREATE TRIGGER thread_mail_permission_no_delete BEFORE DELETE ON thread_mail_permissions
BEGIN SELECT RAISE(ABORT,'mail permission requires an owner receipt'); END`
]);
for (const [event, row] of [
  ['INSERT', 'NEW'],
  ['UPDATE', 'NEW'],
  ['DELETE', 'OLD']
]) {
  const name = 'thread_mail_account_' + event.toLowerCase();
  objects.push([
    'trigger',
    name,
    refresh(
      name,
      event,
      'settings',
      'account-' + event.toLowerCase(),
      `json_object('key',${row}.key,'old',${event === 'INSERT' ? 'NULL' : 'OLD.value'},'value',${event === 'DELETE' ? 'NULL' : 'NEW.value'})`,
      event === 'UPDATE'
        ? "WHEN OLD.key IN ('codex.accountInstance','codex.accountBinding','claude.accountInstance','claude.accountBinding') OR NEW.key IN ('codex.accountInstance','codex.accountBinding','claude.accountInstance','claude.accountBinding')"
        : `WHEN ${row}.key IN ('codex.accountInstance','codex.accountBinding','claude.accountInstance','claude.accountBinding')`
    )
  ]);
}
objects.push([
  'trigger',
  'thread_mail_parent_revoke',
  refresh(
    'thread_mail_parent_revoke',
    'INSERT',
    'project_chat_parent_revocations',
    'parent-revoke',
    "json_object('grantId',NEW.grantId,'operationId',NEW.operationId)"
  )
]);
for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
  const row = event === 'DELETE' ? 'OLD' : 'NEW';
  const name = 'thread_mail_lineage_' + event.toLowerCase();
  objects.push([
    'trigger',
    name,
    refresh(
      name,
      event,
      'project_chat_branch_threads',
      'lineage-' + event.toLowerCase(),
      `json_object('threadId',${row}.threadId,'operationId',${row}.operationId)`
    )
  ]);
  const permission = 'thread_mail_permission_' + event.toLowerCase();
  objects.push([
    'trigger',
    permission,
    refresh(
      permission,
      event,
      'thread_mail_permissions',
      'permission-' + event.toLowerCase(),
      `json_object('threadId',${row}.threadId,'operationId',${row}.operationId,'enabled',${row}.enabled)`
    )
  ]);
}
for (const event of ['UPDATE', 'DELETE']) {
  const name = 'thread_mail_history_no_' + event.toLowerCase();
  objects.push([
    'trigger',
    name,
    `CREATE TRIGGER ${name} BEFORE ${event} ON thread_mail_authority_events
BEGIN SELECT RAISE(ABORT,'immutable mail authority history'); END`
  ]);
}
export const threadMailAuthorityTables = objects.filter((x) => x[0] === 'table').map((x) => x[1]);

export function installThreadMailAuthority(db) {
  if (!db.isTransaction) fail();
  for (const [, , sql] of objects) db.exec(sql);
  db.exec(`INSERT INTO thread_mail_authority SELECT threadId,projectId,1,snapshot FROM thread_mail_authority_inputs;
    INSERT INTO thread_mail_authority_events SELECT threadId,1,'initialize',json_object('threadId',threadId),NULL,snapshot FROM thread_mail_authority;`);
}
export function readThreadMailAuthority(db, threadId) {
  const row = db
    .prepare(
      `SELECT a.*,i.snapshot AS current FROM thread_mail_authority a
    JOIN thread_mail_authority_inputs i ON i.threadId=a.threadId WHERE a.threadId=?`
    )
    .get(threadId);
  if (!row || row.projectId !== chatProject(db).projectId || row.snapshot !== row.current) fail();
  const last = db
    .prepare('SELECT snapshot FROM thread_mail_authority_events WHERE threadId=? AND version=?')
    .get(threadId, row.version);
  if (!last || last.snapshot !== row.snapshot) fail();
  return { projectId: row.projectId, version: row.version };
}

// Internal owner-receipt writer, not a new service capability or a content grant.
export function setThreadMailPermission(db, input, operationId) {
  if (
    !db.isTransaction ||
    !input ||
    Object.keys(input).sort().join(',') !== 'enabled,projectId,threadId' ||
    typeof input.enabled !== 'boolean' ||
    readThreadMailAuthority(db, input.threadId).projectId !== input.projectId
  )
    fail();
  db.prepare(
    `INSERT INTO thread_mail_permissions VALUES(?,?,?) ON CONFLICT(threadId)
    DO UPDATE SET enabled=excluded.enabled,operationId=excluded.operationId`
  ).run(input.threadId, Number(input.enabled), operationId);
  return {
    mailPermission: { projectId: input.projectId, threadId: input.threadId, enabled: input.enabled }
  };
}

export function verifyThreadMailAuthority(db) {
  const get = db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?');
  for (const [type, name, sql] of objects) if (get.get(type, name)?.sql !== sql) fail();
  const expected = new Set(
    [...objects, ...mailOwnerSchema, ...mailDeliverySchema].map((x) => x[1])
  );
  for (const row of db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE (name LIKE 'thread_mail_%' OR tbl_name IN ('thread_mail_authority','thread_mail_authority_events','thread_mail_permissions')) AND sql IS NOT NULL"
    )
    .iterate())
    if (!expected.has(row.name) && row.name !== 'thread_mail_operations') fail();
  let threads = 0,
    count = 0;
  for (const row of db.prepare('SELECT * FROM thread_mail_permissions').iterate()) {
    const input = {
      projectId: chatProject(db).projectId,
      threadId: row.threadId,
      enabled: Boolean(row.enabled)
    };
    const saved = db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(row.operationId);
    if (!saved || saved.digest !== hash(['chat.mail.permission', input])) fail();
    const receipt = JSON.parse(saved.receipt);
    if (
      receipt.operationId !== row.operationId ||
      JSON.stringify(receipt.mailPermission) !== JSON.stringify(input)
    )
      fail();
  }
  for (const t of db.prepare('SELECT id FROM project_chat_threads').iterate()) {
    const current = readThreadMailAuthority(db, t.id);
    let prior = null,
      version = 0;
    for (const event of db
      .prepare('SELECT * FROM thread_mail_authority_events WHERE threadId=? ORDER BY version')
      .iterate(t.id)) {
      if (event.version !== ++version || event.prior !== prior) fail();
      const ref = JSON.parse(event.reference);
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail();
      if (version === 1) {
        if (event.reason !== 'initialize' || ref.threadId !== t.id) fail();
      } else {
        if (event.snapshot === prior) fail();
        if (event.reason === 'parent-revoke') {
          if (
            !db
              .prepare(
                'SELECT 1 FROM project_chat_parent_revocations WHERE grantId=? AND operationId=?'
              )
              .get(ref.grantId, ref.operationId)
          )
            fail();
        } else if (event.reason.startsWith('account-')) {
          if (
            ![
              'codex.accountInstance',
              'codex.accountBinding',
              'claude.accountInstance',
              'claude.accountBinding'
            ].includes(ref.key)
          )
            fail();
        } else if (/^permission-(insert|update)$/.test(event.reason)) {
          const input = {
            projectId: current.projectId,
            threadId: ref.threadId,
            enabled: Boolean(ref.enabled)
          };
          const saved = db
            .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
            .get(ref.operationId);
          if (!saved || saved.digest !== hash(['chat.mail.permission', input])) fail();
          const receipt = JSON.parse(saved.receipt);
          if (
            receipt.operationId !== ref.operationId ||
            JSON.stringify(receipt.mailPermission) !== JSON.stringify(input)
          )
            fail();
        } else if (/^lineage-(insert|update|delete)$/.test(event.reason)) {
          if (
            !db.prepare('SELECT 1 FROM command_receipts WHERE operationId=?').get(ref.operationId)
          )
            fail();
        } else fail();
      }
      prior = event.snapshot;
      count++;
    }
    if (version !== current.version) fail();
    threads++;
  }
  if (
    db.prepare('SELECT count(*) n FROM thread_mail_authority').get().n !== threads ||
    db.prepare('SELECT count(*) n FROM thread_mail_authority_events').get().n !== count
  )
    fail();
  return { threads, events: count };
}

export const threadMailAuthoritySchema = objects;
