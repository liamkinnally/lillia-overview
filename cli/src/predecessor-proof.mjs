import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { applicationId } from './goal-store.mjs';
import { physicalOrigin, privateDirectory, verifiedInspection } from './recovery.mjs';
import { createMailRecoveryProjection } from './thread-mail-recovery-projection.mjs';

function stat(file) {
  try {
    return lstatSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
function ownerFile(file) {
  const st = stat(file);
  return st?.isFile() && st.uid === process.getuid() && st.nlink === 1;
}
function immutable(file) {
  const uri = pathToFileURL(file);
  uri.searchParams.set('immutable', '1');
  const db = new DatabaseSync(uri.href, { readOnly: true, allowExtension: false });
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
  return db;
}
const quote = (s) => '"' + s.replaceAll('"', '""') + '"';
function tables(db) {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name)
    .filter((n) => n !== 'settings' && !n.startsWith('research_search') && n !== 'sqlite_sequence');
}
function stampTable(db, table, operationId, projection = null) {
  const columns = db.prepare('PRAGMA table_info(' + quote(table) + ')').all();
  const keys = columns
    .filter((r) => r.pk)
    .sort((a, b) => a.pk - b.pk)
    .map((r) => quote(r.name));
  const where = ['command_receipts', 'pending_effects'].includes(table)
    ? ' WHERE operationId<>?'
    : '';
  const selected = columns
    .filter((c) => table !== 'agent_workspaces' || c.name !== 'identity')
    .map((c) => quote(c.name))
    .join(',');
  const sql =
    'SELECT rowid AS __projectionRowid,' +
    selected +
    ' FROM ' +
    quote(table) +
    where +
    ' ORDER BY ' +
    (keys.join(',') || 'rowid');
  const digest = createHash('sha256');
  for (const original of db.prepare(sql).iterate(...(where ? [operationId] : []))) {
    const row = projection ? projection.row(table, original) : original;
    digest.update('R');
    for (const c of columns.filter((c) => table !== 'agent_workspaces' || c.name !== 'identity')) {
      const v = row[c.name];
      if (v === null) digest.update('N;');
      else {
        const blob = v instanceof Uint8Array,
          value = blob ? v : Buffer.from(String(v));
        digest.update((blob ? 'B' : typeof v) + value.length + ':');
        digest.update(value);
      }
    }
  }
  return digest.digest('hex');
}
function retainedSettings(db) {
  return db
    .prepare(
      "SELECT key,value FROM settings WHERE key IN ('platform.workspace','codex.accountInstance','claude.accountInstance') ORDER BY key"
    )
    .all();
}
function compareData(prior, restored, m) {
  const operationId = m.operationId,
    version = prior.prepare('PRAGMA user_version').get().user_version;
  if (
    prior.prepare('PRAGMA application_id').get().application_id !== applicationId ||
    version !== m.schemaVersion
  )
    return { state: 'schema-mismatch' };
  const epoch = prior
    .prepare("SELECT value FROM settings WHERE key='platform.installationEpoch'")
    .get()?.value;
  if (epoch !== m.predecessorEpoch) return { state: 'origin-mismatch' };
  const own = prior
    .prepare('SELECT receipt,digest FROM command_receipts WHERE operationId=?')
    .get(operationId);
  const recorded = own && JSON.parse(own.receipt);
  const backup = recorded?.backup;
  const expectedEffect = restored
    .prepare('SELECT kind,digest,destination FROM pending_effects WHERE operationId=?')
    .get(operationId);
  const backupReceiptConfirmed =
    recorded?.operationId === operationId &&
    backup?.epoch === epoch &&
    backup?.recoveryPoint === m.recoveryPoint &&
    backup?.database?.sha256 === m.sourceSha256 &&
    expectedEffect?.kind === 'backup.create' &&
    expectedEffect.digest === own.digest &&
    expectedEffect.destination === backup.destination;
  // Compare the predecessor in exactly the same privacy representation as its verified backup.
  const projection = m.projection ? createMailRecoveryProjection(prior) : null;
  const before = tables(restored),
    after = tables(prior),
    changedTables = [];
  for (const name of new Set([...before, ...after])) {
    if (
      !before.includes(name) ||
      !after.includes(name) ||
      stampTable(prior, name, operationId, projection) !== stampTable(restored, name, operationId)
    )
      changedTables.push(name);
  }
  if (projection) {
    const { schemaDigest, ...descriptor } = m.projection;
    if (JSON.stringify(projection.descriptor) !== JSON.stringify(descriptor))
      changedTables.push('private-projection-descriptor');
  }
  const ddl = (db) =>
    db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
  if (JSON.stringify(ddl(prior)) !== JSON.stringify(ddl(restored)))
    changedTables.push('sqlite_schema');
  if (JSON.stringify(retainedSettings(prior)) !== JSON.stringify(retainedSettings(restored)))
    changedTables.push('public-account-or-workspace-settings');
  const laterOperationIds = [];
  const earlier = restored.prepare('SELECT 1 FROM command_receipts WHERE operationId=?');
  let laterOperationCount = 0;
  for (const r of prior
    .prepare('SELECT operationId FROM command_receipts WHERE operationId<>? ORDER BY rowid')
    .iterate(operationId)) {
    if (!earlier.get(r.operationId)) {
      laterOperationCount++;
      if (laterOperationIds.length < 100) laterOperationIds.push(r.operationId);
    }
  }
  const pending = after.includes('pending_effects')
    ? prior.prepare('SELECT operationId,kind FROM pending_effects ORDER BY rowid LIMIT 101').all()
    : [];
  const unresolvedWorkers = prior
    .prepare(
      `SELECT count(*) AS n FROM tasks WHERE status IN ('starting','running','interrupting','waiting_for_input')
    OR (status='recovery_needed' AND recoveryCleared=0)`
    )
    .get().n;
  const unresolvedControls = prior
    .prepare(
      "SELECT count(*) AS n FROM task_controls WHERE state IN ('pending','sent','requested','unconfirmed')"
    )
    .get().n;
  const state = changedTables.length
    ? 'records-differ'
    : pending.length || unresolvedWorkers || unresolvedControls
      ? 'unresolved'
      : backupReceiptConfirmed
        ? 'records-match'
        : 'backup-receipt-unconfirmed';
  return {
    state,
    changedTables,
    backupReceiptConfirmed,
    laterOperationCount,
    laterOperationIds,
    pendingEffects: pending.slice(0, 100),
    pendingEffectsTruncated: pending.length > 100,
    unresolvedWorkers,
    unresolvedControls
  };
}
export function comparePredecessor({ restoredDirectory, predecessorDirectory }) {
  const { manifest: m, filename } = verifiedInspection(restoredDirectory);
  const base = {
    formatVersion: 1,
    observedAt: new Date().toISOString(),
    mode: 'comparison-only',
    dispatchAuthorized: false,
    predecessorRetired: false,
    restoredEpoch: m.epoch,
    predecessorEpoch: m.predecessorEpoch,
    recoveryPoint: m.recoveryPoint,
    externalDestinations:
      'Current provider sessions and external destinations have not been observed.',
    authority: 'No host-wide repository authority lease or retirement proof is issued.'
  };
  if (!m.physicalOrigin) return { ...base, state: 'origin-witness-unavailable' };
  if (!stat(predecessorDirectory)) return { ...base, state: 'predecessor-unavailable' };
  const dir = privateDirectory(predecessorDirectory),
    file = join(dir, 'platform.sqlite'),
    lockFile = join(dir, 'daemon.lock.sqlite');
  if (!ownerFile(file) || physicalOrigin(file, m.predecessorEpoch) !== m.physicalOrigin)
    return { ...base, state: 'origin-mismatch' };
  if (stat(file).size > 256 * 1024 * 1024)
    return { ...base, state: 'predecessor-size-unsupported' };
  if (!ownerFile(lockFile)) return { ...base, state: 'writer-witness-unavailable' };
  const lock = new DatabaseSync(lockFile, { readOnly: true, allowExtension: false });
  try {
    try {
      lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    } catch (e) {
      if (e.errcode === 5 || e.errcode === 6) return { ...base, state: 'predecessor-busy' };
      throw e;
    }
    // An immutable connection does not create SQLite WAL or shared-memory files.
    // An uncheckpointed WAL would make its view stale, so require clean shutdown.
    const dirty = () => ['-wal', '-journal'].some((suffix) => (stat(file + suffix)?.size ?? 0) > 0);
    if (dirty()) return { ...base, state: 'checkpoint-unavailable' };
    const prior = immutable(file);
    try {
      const restored = immutable(filename);
      try {
        const stamp = () => {
          const st = lstatSync(file, { bigint: true });
          return JSON.stringify([st.ino, st.size, st.mtimeNs, st.ctimeNs].map(String));
        };
        const before = stamp();
        const result = compareData(prior, restored, m);
        if (before !== stamp() || dirty()) return { ...base, state: 'predecessor-changed' };
        return { ...base, ...result };
      } finally {
        restored.close();
      }
    } finally {
      prior.close();
    }
  } finally {
    lock.close();
  }
}
