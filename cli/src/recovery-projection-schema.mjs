import { recoveryConflict } from './recovery-format.mjs';
import { GoalStore } from './goal-store.mjs';
import { createHash } from 'node:crypto';
let catalog;
export function trustedRecoverySchema() {
  if (!catalog) {
    const known = new GoalStore(':memory:');
    try {
      known.initialize('/recovery-schema-profile', 58);
      catalog = known.db
        .prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')
        .all()
        .map((row) => ({ ...row }));
    } finally {
      known.close();
    }
  }
  return catalog;
}
export function assertTrustedRecoverySchema(db) {
  const actual = db
    .prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')
    .all();
  const trusted = trustedRecoverySchema();
  if (
    db.prepare('PRAGMA user_version').get().user_version !== 58 ||
    JSON.stringify(actual) !== JSON.stringify(trusted)
  ) {
    const byName = new Map(actual.map((row) => [row.name, row]));
    const missing = trusted.find(
      (row) => JSON.stringify(row) !== JSON.stringify(byName.get(row.name))
    );
    const domain = missing?.name.startsWith('project_chat_') ? 'thread mapping' : missing?.name;
    throw recoveryConflict(
      'Recovery trusted schema profile58 differs' + (domain ? ' for ' + domain : '') + '.'
    );
  }
  return createHash('sha256').update(JSON.stringify(trusted)).digest('hex');
}
