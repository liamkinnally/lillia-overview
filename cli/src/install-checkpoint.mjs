import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { GoalStore, applicationId, schemaVersion } from './goal-store.mjs';
import { ServiceDrain } from './service-drain.mjs';
import { createBackup, validateBackupRequest } from './recovery.mjs';
import { assertTrustedRecoverySchema } from './recovery-projection-schema.mjs';
import { ensureInstallation as need, privateFile, privateRoot } from './installation-gate.mjs';

const validId = (s) => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(s);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const separate = (a, b) => a !== b && !a.startsWith(b + path.sep) && !b.startsWith(a + path.sep);

// A reviewed installer may checkpoint a stopped predecessor, but cannot run its jobs.
// Holding both locks keeps activation and the predecessor daemon out until the receipt is durable.
export function stoppedCheckpoint(input, operationId, { registry, active, verifiedBuild, clean }) {
  const { root, build, expectedGeneration, cutoff } = input;
  need(
    /^[a-f0-9]{64}$/.test(build) &&
      Number.isSafeInteger(expectedGeneration) &&
      expectedGeneration > 0 &&
      validId(cutoff) &&
      validId(operationId),
    'Invalid installation checkpoint selection.',
    400
  );
  const destination = path.join(
    realpathSync(path.dirname(input.destination)),
    path.basename(input.destination)
  );
  const authority = registry(root);
  let lock, database;
  try {
    authority.exec('BEGIN IMMEDIATE');
    const current = active(authority, root);
    need(current.generation === expectedGeneration, 'Checkpoint generation changed.');
    need(
      !authority.prepare("SELECT 1 FROM upgrades WHERE phase='preparing'").get(),
      'A prepared upgrade already owns the installation.'
    );
    const executable = realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
    need(
      executable === path.join(root, 'builds', build),
      'Run checkpoint through the staged pinned executable.'
    );
    need(
      authority.prepare('SELECT 1 FROM staged WHERE build=?').get(build),
      'Checkpoint build is not staged.'
    );
    const next = verifiedBuild(root, build),
      prior = verifiedBuild(root, current.build);
    need(
      next.manifest.schema === schemaVersion && prior.manifest.schema === schemaVersion,
      'Checkpoint requires the same supported schema in both builds.'
    );
    need(
      separate(destination, root) && separate(destination, current.workspaceRoot),
      'Checkpoint destination must be separate from the installation and project.'
    );
    privateRoot(current.dataDirectory);
    const file = path.join(current.dataDirectory, 'platform.sqlite');
    const marker = JSON.parse(privateFile(path.join(current.dataDirectory, 'MANAGED.json'), 4096));
    const row = authority.prepare('SELECT * FROM pairs WHERE id=?').get(current.pair);
    const physical = lstatSync(current.dataDirectory, { bigint: true });
    const data = lstatSync(file, { bigint: true });
    need(
      marker.pair === current.pair &&
        marker.build === current.build &&
        data.isFile() &&
        data.nlink === 1n &&
        data.uid === BigInt(process.getuid()) &&
        String(physical.dev) === row.device &&
        String(physical.ino) === row.inode &&
        String(data.ino) === row.databaseInode,
      'Checkpoint pair physical identity or marker changed.'
    );
    const lockFile = path.join(current.dataDirectory, 'daemon.lock.sqlite');
    privateFile(lockFile, 1024 * 1024);
    lock = new DatabaseSync(lockFile, { allowExtension: false });
    lock.exec('PRAGMA busy_timeout=0;BEGIN EXCLUSIVE');
    clean(file);
    database = new DatabaseSync(file, { allowExtension: false });
    database.exec(
      'PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;PRAGMA busy_timeout=0'
    );
    need(
      database.prepare('PRAGMA application_id').get().application_id === applicationId &&
        database.prepare('PRAGMA user_version').get().user_version === schemaVersion &&
        database.prepare("SELECT value FROM settings WHERE key='platform.managedPair'").get()
          ?.value === current.pair &&
        database.prepare("SELECT value FROM settings WHERE key='platform.workspace'").get()
          ?.value === current.workspaceRoot,
      'Checkpoint database schema or installation binding changed.'
    );
    assertTrustedRecoverySchema(database);
    // Reuse receipt transactions without TaskStore's constructor or any schema initialization.
    const store = Object.assign(Object.create(GoalStore.prototype), { db: database });
    const drain = new ServiceDrain(store),
      state = drain.view();
    need(
      state.mode === 'draining' && state.cutoff === cutoff,
      'Checkpoint requires the exact named drain cutoff.'
    );
    const digest = hash(['backup.create', { destination }]);
    const old = database
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(operationId);
    if (old) {
      need(old.digest === digest, 'This operation ID already belongs to different inputs.');
      return JSON.parse(old.receipt);
    }
    store.checkIntent(operationId, digest);
    const finish = drain.enter('backup.create', operationId, digest);
    try {
      const options = { store, destination, operationId };
      validateBackupRequest(options);
      store.reserveEffect(operationId, digest, 'backup.create', destination);
      let backup;
      try {
        backup = createBackup(options);
      } catch (error) {
        if (error.noEffect === true)
          database
            .prepare('DELETE FROM pending_effects WHERE operationId=? AND digest=?')
            .run(operationId, digest);
        throw error;
      }
      const {
        mode,
        formatVersion,
        schemaVersion: version,
        epoch,
        recoveryPoint,
        database: snapshot,
        excluded
      } = backup;
      const receipt = store.accept(operationId, digest, () => ({
        backup: {
          destination,
          mode,
          formatVersion,
          schemaVersion: version,
          epoch,
          recoveryPoint,
          database: snapshot,
          excluded
        }
      }));
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return receipt;
    } finally {
      finish();
    }
  } finally {
    database?.close();
    lock?.close();
    if (authority.isTransaction) authority.exec('ROLLBACK');
    authority.close();
  }
}
