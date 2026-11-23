import { installScopeDeliveryClaims } from './subtree-scope-claim-schema.mjs';
const table = `CREATE TABLE subtree_scope_gates (
  threadId TEXT PRIMARY KEY REFERENCES project_chat_threads(id),
  state TEXT NOT NULL CHECK(state IN ('active','paused')),
  version INTEGER NOT NULL CHECK(version>=1 AND version<9007199254740991)
)`;
const initialize = `CREATE TRIGGER subtree_scope_thread_initialize AFTER INSERT ON project_chat_threads
BEGIN INSERT INTO subtree_scope_gates VALUES(NEW.id,'active',1); END`;
const operations = `CREATE TABLE subtree_scope_operations (
  operationId TEXT PRIMARY KEY REFERENCES command_receipts(operationId) DEFERRABLE INITIALLY DEFERRED,
  projectId TEXT NOT NULL REFERENCES project_chat_identity(id),
  threadId TEXT NOT NULL REFERENCES project_chat_threads(id), receiptDigest TEXT NOT NULL
)`;

// Staged migration primitive only. Backend assigns a version after mail57; no
// runtime auto-install, IF NOT EXISTS, or user_version claim is permitted here.
export function installSubtreeScope(db) {
  if (!db.isTransaction) throw Error('Scope migration requires a transaction.');
  db.exec(table);
  db.exec(initialize);
  db.exec(operations);
  db.exec("INSERT INTO subtree_scope_gates SELECT id,'active',1 FROM project_chat_threads");
  installScopeDeliveryClaims(db);
}
export function verifySubtreeScope(db) {
  for (const [type, name, sql] of [
    ['table', 'subtree_scope_gates', table],
    ['trigger', 'subtree_scope_thread_initialize', initialize],
    ['table', 'subtree_scope_operations', operations]
  ])
    if (
      db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?').get(type, name)?.sql !==
      sql
    )
      throw Error('Scope schema differs.');
  if (
    db
      .prepare(
        `SELECT 1 FROM project_chat_threads t LEFT JOIN subtree_scope_gates g ON g.threadId=t.id
    WHERE g.threadId IS NULL LIMIT 1`
      )
      .get()
  )
    throw Error('Scope gate missing.');
}
