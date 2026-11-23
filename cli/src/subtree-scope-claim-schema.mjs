const table = `CREATE TABLE subtree_scope_delivery_claims (
  controlId TEXT PRIMARY KEY REFERENCES task_controls(id),
  operationId TEXT NOT NULL REFERENCES subtree_scope_operations(operationId),
  record TEXT NOT NULL CHECK(json_valid(record)), digest TEXT NOT NULL
)`;
const objects = [['table', 'subtree_scope_delivery_claims', table]];
for (const event of ['UPDATE', 'DELETE'])
  objects.push([
    'trigger',
    'subtree_scope_claim_no_' + event.toLowerCase(),
    `CREATE TRIGGER subtree_scope_claim_no_${event.toLowerCase()} BEFORE ${event} ON subtree_scope_delivery_claims
BEGIN SELECT RAISE(ABORT,'immutable scope delivery claim'); END`
  ]);

// Backend stages this alongside scope62 in reserved58; never auto-install on send.
export function installScopeDeliveryClaims(db) {
  if (!db.isTransaction) throw Error('Claim migration requires a transaction.');
  for (const [, , sql] of objects) db.exec(sql);
}
export function verifyScopeDeliveryClaims(db) {
  for (const [type, name, sql] of objects)
    if (
      db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?').get(type, name)?.sql !==
      sql
    )
      throw Error('Scope claim schema is unavailable or changed.');
}
