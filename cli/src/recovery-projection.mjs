import { recoveryConflict } from './recovery-format.mjs';
import { DatabaseSync } from 'node:sqlite';
import { inventory } from './recovery-inventory.mjs';
import { applicationId } from './goal-store.mjs';
import { backupId } from './recovery-format.mjs';
import { ResearchCatalog } from './research.mjs';
import {
  trustedRecoverySchema,
  assertTrustedRecoverySchema
} from './recovery-projection-schema.mjs';
import {
  createMailRecoveryProjection,
  retainedRecoverySettings,
  projectionProfile
} from './thread-mail-recovery-projection.mjs';
const quote = (s) => '"' + s.replaceAll('"', '""') + '"';
const shadow = (name) => name.startsWith('research_search_');
export function buildProjectedRecovery(source, target, profile = projectionProfile) {
  if (
    target.prepare('PRAGMA database_list').get().file !== '' ||
    target.prepare('SELECT count(*) n FROM sqlite_schema').get().n !== 0
  )
    throw recoveryConflict('Recovery projection requires an empty memory target.');
  if (profile !== projectionProfile) throw recoveryConflict('Unknown recovery projection profile.');
  if (
    !source.prepare("SELECT value FROM settings WHERE key='platform.installationEpoch'").get()
      ?.value
  )
    throw recoveryConflict('Recovery projection requires a prepared epoch.');
  const schemaDigest = assertTrustedRecoverySchema(source);
  inventory(source, applicationId);
  const projection = createMailRecoveryProjection(source);
  const descriptor = { ...projection.descriptor, schemaDigest };
  const objects = trustedRecoverySchema();
  target.exec(
    'PRAGMA foreign_keys=OFF; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; BEGIN'
  );
  try {
    for (const row of objects)
      if (row.type === 'table' && row.name !== 'sqlite_sequence' && !shadow(row.name))
        target.exec(row.sql);
    for (const table of objects.filter(
      (x) => x.type === 'table' && !shadow(x.name) && x.name !== 'research_search'
    )) {
      const name = table.name,
        columns = source
          .prepare('PRAGMA table_info(' + quote(name) + ')')
          .all()
          .map((x) => x.name);
      if (name === 'sqlite_sequence') target.exec('DELETE FROM sqlite_sequence');
      const insert = target.prepare(
        'INSERT INTO ' +
          quote(name) +
          '(rowid,' +
          columns.map(quote).join(',') +
          ') VALUES(' +
          Array(columns.length + 1)
            .fill('?')
            .join(',') +
          ')'
      );
      for (const original of source
        .prepare('SELECT rowid AS __projectionRowid,* FROM ' + quote(name) + ' ORDER BY rowid')
        .iterate()) {
        if (name === 'settings' && !retainedRecoverySettings.includes(original.key)) continue;
        const row = { ...projection.row(name, original) };
        if (name === 'agent_workspaces') row.identity = null;
        for (const col of columns) {
          try {
            projection.assertSanitized(row[col]);
          } catch {
            throw recoveryConflict(
              'Known private content collision at ' +
                name +
                '.' +
                col +
                ' prevents recovery projection.'
            );
          }
        }
        insert.run(row.__projectionRowid, ...columns.map((c) => row[c]));
      }
    }
    for (const row of objects) if (row.sql && row.type !== 'table') target.exec(row.sql);
    target.exec('PRAGMA user_version=58; PRAGMA application_id=' + backupId);
    new ResearchCatalog({ db: target }).rebuildIndex();
    const fts = (db) =>
      db
        .prepare(
          'SELECT version,id,title,summary,body,keywords FROM research_search ORDER BY version,id'
        )
        .all();
    if (JSON.stringify(fts(source)) !== JSON.stringify(fts(target)))
      throw recoveryConflict('Recovery research search content differs.');
    target.exec('COMMIT; PRAGMA foreign_keys=ON');
  } catch (error) {
    if (target.isTransaction) target.exec('ROLLBACK');
    throw error;
  }
  if (assertTrustedRecoverySchema(target) !== schemaDigest)
    throw recoveryConflict('Recovery constructed schema differs.');
  projection.assertSanitized(JSON.stringify(descriptor));
  const objectsInventory = inventory(target, backupId, descriptor);
  return {
    descriptor,
    objects: objectsInventory,
    assertBytes: projection.assertBytes,
    assertSanitized: projection.assertSanitized
  };
}
export function projectedMemory(source) {
  const db = new DatabaseSync(':memory:');
  try {
    return { db, ...buildProjectedRecovery(source, db) };
  } catch (error) {
    db.close();
    throw error;
  }
}
