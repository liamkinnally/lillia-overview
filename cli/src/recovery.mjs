import { assertTrustedRecoverySchema } from './recovery-projection-schema.mjs';
import { projectedMemory } from './recovery-projection.mjs';
import {
  createMailRecoveryProjection,
  verifyProjectedSettings
} from './thread-mail-recovery-projection.mjs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants as F,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { applicationId, schemaVersion } from './goal-store.mjs';
import { assertManagedInstallation } from './installation-gate.mjs';
import { ResearchCatalog } from './research.mjs';
import {
  formatVersion,
  projectedFormatVersion,
  supportedManifest,
  supportedSchema,
  backupId,
  inspectId,
  hashed,
  check,
  schema
} from './recovery-format.mjs';
import { inventory } from './recovery-inventory.mjs';
import { readInspection } from './recovery-inspection.mjs';
export { checkRetainedEvidence, verifyGitCutoverHistory } from './recovery-inventory.mjs';

const maxDatabaseBytes = 256 * 1024 * 1024;
const maxManifestBytes = 16 * 1024 * 1024;
const { version: appVersion } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);
const retainedSettings = [
  'chat.incomingThreadMail',
  'platform.sessionProfile',
  'paused',
  'platform.workspace',
  'platform.installationEpoch',
  'codex.accountInstance',
  'claude.accountInstance'
];
const excluded = [
  'Mutable human and agent workspaces, including unsubmitted files and unsaved editor buffers',
  'Native credentials, account binding digests and salts, daemon sessions, leases and provider callbacks',
  'External targets and effects beyond this recovery point'
];

function statIfPresent(file) {
  try {
    return lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function safePath(input) {
  check(
    typeof input === 'string' &&
      path.isAbsolute(input) &&
      !input.includes('\0') &&
      !input.split('/').includes('..'),
    'Use an absolute recovery path without traversal.',
    400
  );
  // macOS publishes these two standard aliases for its physical temporary paths.
  const selected = path.resolve(input);
  return process.platform === 'darwin'
    ? selected.replace(/^\/(tmp|var)(?=\/|$)/, '/private/$1')
    : selected;
}

function validateParent(input) {
  const file = safePath(input);
  const parent = path.dirname(file);
  check(file !== parent, 'Invalid recovery destination.');
  let dir = parent;
  for (;;) {
    const st = lstatSync(dir);
    const trustedOwner = st.uid === process.getuid() || st.uid === 0;
    check(
      st.isDirectory() &&
        trustedOwner &&
        (!(st.mode & 0o022) || (st.uid === 0 && st.mode & 0o1000)),
      'Unsafe writable or symlinked recovery directory.'
    );
    if (dir === '/') break;
    dir = path.dirname(dir);
  }
  check(realpathSync(parent) === parent, 'Symlinked recovery directory.');
  return file;
}

export function privateDirectory(input) {
  const dir = validateParent(input);
  const st = lstatSync(dir);
  check(
    st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o077) === 0,
    'Expected an owner-private recovery directory.'
  );
  return dir;
}

function syncDirectory(dir) {
  const fd = openSync(dir, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writePrivate(file, bytes) {
  const fd = openSync(file, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function privateDescriptor(file, max) {
  const fd = openSync(file, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    check(
      st.isFile() &&
        st.uid === process.getuid() &&
        st.nlink === 1 &&
        !(st.mode & 0o077) &&
        st.size <= max,
      'Unsafe recovery file type, permissions, link count or size.'
    );
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

function fileInfo(file) {
  const fd = privateDescriptor(file, maxDatabaseBytes);
  try {
    const buffer = Buffer.allocUnsafe(128 * 1024),
      digest = createHash('sha256');
    let size = 0,
      n;
    while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      size += n;
      check(size <= maxDatabaseBytes, 'Recovery database exceeds the configured limit.');
      digest.update(buffer.subarray(0, n));
    }
    return { bytes: size, sha256: digest.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

function readManifest(dir, name) {
  const fd = privateDescriptor(path.join(dir, name), maxManifestBytes);
  try {
    const data = JSON.parse(readFileSync(fd, 'utf8'));
    check(
      supportedManifest(data) && supportedSchema(data.schemaVersion),
      'Unsupported recovery manifest or schema.'
    );
    return data;
  } finally {
    closeSync(fd);
  }
}

function openDatabase(file, readOnly = false) {
  const db = new DatabaseSync(file, { readOnly, allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY');
    if (readOnly) db.exec('PRAGMA query_only=ON');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function quiescent(db, operationId, destination) {
  const task = db
    .prepare(
      `SELECT 1 FROM tasks WHERE status IN ('starting','running','waiting_for_input','interrupting')
    OR (status='recovery_needed' AND recoveryCleared=0) LIMIT 1`
    )
    .get();
  const control = db
    .prepare(
      "SELECT 1 FROM task_controls WHERE state IN ('pending','requested','sent','unconfirmed') LIMIT 1"
    )
    .get();
  const effects = db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='pending_effects'")
    .get();
  const pending =
    effects &&
    db
      .prepare('SELECT operationId,kind,destination FROM pending_effects LIMIT 2')
      .all()
      .some(
        (row) =>
          row.operationId !== operationId ||
          row.kind !== 'backup.create' ||
          safePath(row.destination) !== destination
      );
  const leases = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_workspaces'")
    .get();
  const mutation =
    leases &&
    db
      .prepare(
        "SELECT 1 FROM agent_workspaces WHERE state IN ('allocating','projecting','capture_pending') LIMIT 1"
      )
      .get();
  check(
    !task && !control && !pending && !mutation,
    'Quiescence required: active work, uncertain effects or pending owner controls remain.'
  );
}

function verifyDirectory(input, mode) {
  const dir = privateDirectory(input);
  const restored = mode === 'inspect-only';
  const name = restored ? 'RECOVERY.json' : 'manifest.json',
    database = restored ? 'platform.sqlite' : 'snapshot.sqlite';
  const names = readdirSync(dir).sort();
  check(
    names.length === 3 &&
      names.includes('RECOVERY.FENCE') &&
      names.includes(name) &&
      names.includes(database),
    'Incomplete recovery artifact or unexpected side files.'
  );
  const manifest = readManifest(dir, name);
  check(
    manifest.mode === mode && manifest.database && typeof manifest.epoch === 'string',
    'Invalid recovery artifact mode or epoch.'
  );
  const filename = path.join(dir, database);
  const actual = fileInfo(filename);
  check(
    actual.bytes === manifest.database.bytes && actual.sha256 === manifest.database.sha256,
    'Recovery database digest or size mismatch.'
  );
  const metadata = { ...manifest };
  delete metadata.database;
  const verified = openDatabase(filename, true);
  try {
    schema(verified, restored ? inspectId : backupId, manifest.schemaVersion);
    const anchor = verified
      .prepare("SELECT value FROM settings WHERE key='recovery.manifest'")
      .get();
    check(
      anchor && isDeepStrictEqual(JSON.parse(anchor.value), metadata),
      'Recovery manifest metadata differs from its anchored snapshot.'
    );
    check(
      !(
        !manifest.projection &&
        manifest.schemaVersion >= 57 &&
        createMailRecoveryProjection(verified).hasBindings
      ),
      'Private-bearing legacy recovery archives require an explicit supported projection; conversion is unavailable.'
    );
    if (manifest.projection) {
      const actualObjects = inventory(
        verified,
        restored ? inspectId : backupId,
        manifest.projection,
        manifest
      );
      check(
        isDeepStrictEqual(actualObjects, manifest.objects),
        'Projected recovery object inventory differs.'
      );
    }
  } finally {
    verified.close();
  }
  return { dir, manifest, filename };
}

// Node rename() may silently replace an empty user directory. Publish only when
// the host filesystem implements an atomic, exclusive directory rename.
const recoveryFence = 'Recovery artifact. Execution is fenced.\n';
const activation =
  'Unavailable. Retire or fence predecessor installations and reconcile possible later external effects before any future promotion.';
function restoredMetadata(manifest, epoch, restoredAt, sourceSha256, objects) {
  return {
    formatVersion: manifest.formatVersion,
    ...(manifest.projection ? { projection: manifest.projection } : {}),
    appVersion,
    schemaVersion: manifest.schemaVersion,
    mode: 'inspect-only',
    epoch,
    predecessorEpoch: manifest.epoch,
    physicalOrigin: manifest.physicalOrigin ?? null,
    recoveryPoint: manifest.recoveryPoint,
    restoredAt,
    sourceSha256,
    operationId: manifest.operationId,
    objects,
    excluded,
    activation
  };
}

function publishDirectory(dest, build) {
  const parent = path.dirname(dest);
  const stage = mkdtempSync(path.join(parent, '.scion-recovery-'));
  const owned = lstatSync(stage);
  let published = false;
  try {
    writePrivate(path.join(stage, 'RECOVERY.FENCE'), recoveryFence);
    const result = build(stage);
    const script = [
      'import ctypes, os, sys',
      'libc=ctypes.CDLL(None,use_errno=True)',
      'source,target=map(os.fsencode,sys.argv[1:])',
      'if sys.platform=="darwin": result=libc.renamex_np(source,target,4)',
      'elif sys.platform.startswith("linux"): result=libc.renameat2(-100,source,-100,target,1)',
      'else: sys.exit(95)',
      'sys.exit(0 if result==0 else ctypes.get_errno())'
    ].join('\n');
    try {
      execFileSync('/usr/bin/python3', ['-I', '-S', '-c', script, stage, dest], {
        env: { PATH: '/usr/bin:/bin' },
        cwd: '/',
        timeout: 5000,
        stdio: 'ignore'
      });
    } catch (error) {
      if (error.status === 17) throw new Error('Recovery destination already exists.');
      throw Object.assign(
        new Error(
          'Atomic no-overwrite directory publication is unavailable on this host or filesystem.'
        ),
        { publicationUncertain: Boolean(error.signal || error.code === 'ETIMEDOUT') }
      );
    }
    published = true;
    syncDirectory(parent);
    return result;
  } catch (error) {
    if (published) error.publicationUncertain = true;
    throw error;
  } finally {
    if (!published) {
      const current = statIfPresent(stage);
      if (current?.ino === owned.ino && current.dev === owned.dev)
        rmSync(stage, { recursive: true, force: true });
    }
  }
}

function publish(db, dir, file, metadata, marker, projection) {
  const filename = path.join(dir, file);
  // Reserve with private permissions. SQLite accepts an existing zero-length output.
  const partial = path.join(dir, 'database.partial');
  const encoded = JSON.stringify(metadata);
  check(
    Buffer.byteLength(encoded) <= maxManifestBytes,
    'Recovery inventory exceeds the supported manifest limit.'
  );
  set(db, 'recovery.manifest', encoded);
  if (metadata.projection) {
    verifyProjectedSettings(db, metadata);
    const image = db.serialize();
    check(image.length <= maxDatabaseBytes, 'Recovery database exceeds the configured limit.');
    const expected = { bytes: image.length, sha256: hashed(image) };
    projection?.assertBytes(image);
    projection?.assertSanitized(JSON.stringify({ ...metadata, database: expected }));
    writePrivate(partial, image);
  } else {
    writePrivate(partial, Buffer.alloc(0));
    db.prepare('VACUUM INTO ?').run(partial);
  }
  const fd = privateDescriptor(partial, maxDatabaseBytes);
  try {
    fchmodSync(fd, 0o400);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  linkSync(partial, filename);
  unlinkSync(partial);
  const manifest = { ...metadata, database: fileInfo(filename) };
  const bytes = Buffer.from(JSON.stringify(manifest));
  check(
    bytes.length <= maxManifestBytes,
    'Recovery inventory exceeds the supported manifest limit.'
  );
  const incomplete = path.join(dir, 'manifest.partial');
  writePrivate(incomplete, bytes);
  linkSync(incomplete, path.join(dir, marker));
  unlinkSync(incomplete);
  syncDirectory(dir);
  return manifest;
}

function set(db, key, value) {
  db.prepare(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, value);
}

function scratchCopy(source, work) {
  // Keep the unfiltered SQLite image in memory, including when a backup is interrupted.
  const uri = 'file:scion-recovery-' + randomUUID() + '?mode=memory&cache=shared';
  const scratch = openDatabase(uri);
  try {
    check(
      scratch.prepare('PRAGMA database_list').get().file === '',
      'This SQLite build cannot create an in-memory recovery image.'
    );
    source.prepare('VACUUM INTO ?').run(uri);
    return work(scratch);
  } finally {
    scratch.close();
  }
}

export function validateBackupRequest({ store, destination, operationId }) {
  const db = store.db;
  check(!db.isTransaction, 'Create a recovery point outside an existing SQLite transaction.');
  check(
    typeof operationId === 'string' && operationId.length > 0 && operationId.length <= 128,
    'A backup operation ID is required.',
    400
  );
  schema(db, applicationId, schemaVersion);
  const dest = validateParent(destination);
  const epoch = db
    .prepare("SELECT value FROM settings WHERE key='platform.installationEpoch'")
    .get()?.value;
  if (statIfPresent(dest)) {
    const { manifest } = verifyDirectory(dest, 'backup');
    check(
      epoch && manifest.epoch === epoch && manifest.operationId === operationId,
      'Backup destination already exists for a different operation.'
    );
    return { destination: dest, epoch, existing: manifest };
  }
  quiescent(db, operationId, dest);
  const size =
    db.prepare('PRAGMA page_size').get().page_size *
    db.prepare('PRAGMA page_count').get().page_count;
  check(size <= maxDatabaseBytes, 'Recovery database exceeds the 256 MiB format limit.');
  return { destination: dest, epoch, existing: null };
}

export function createBackup(options) {
  const db = options.store.db;
  const { destination, existing, epoch: priorEpoch } = validateBackupRequest(options);
  if (existing) return existing;
  try {
    const epoch = priorEpoch || randomUUID();
    if (!priorEpoch) set(db, 'platform.installationEpoch', epoch);
    const recoveryPoint = new Date().toISOString();
    return scratchCopy(db, (scratch) => {
      if (schemaVersion === 58) assertTrustedRecoverySchema(scratch);
      inventory(scratch, applicationId);
      const privateMail = createMailRecoveryProjection(scratch);
      if (privateMail.hasBindings) {
        check(schemaVersion === 58, 'Private-bearing legacy export is unsupported.');
        const projected = projectedMemory(scratch);
        try {
          const metadata = {
            formatVersion: projectedFormatVersion,
            appVersion,
            schemaVersion,
            mode: 'backup',
            epoch,
            recoveryPoint,
            operationId: options.operationId,
            projection: projected.descriptor,
            objects: projected.objects,
            excluded,
            physicalOrigin: physicalOrigin(db.prepare('PRAGMA database_list').get().file, epoch)
          };
          projected.assertSanitized(JSON.stringify(metadata));
          // Restore has no raw bindings. Check its fixed fields while they are available.
          projected.assertSanitized(recoveryFence);
          projected.assertSanitized(
            JSON.stringify(restoredMetadata(metadata, epoch, recoveryPoint, '', projected.objects))
          );
          for (const word of [
            'paused',
            'true',
            'recovery.mode',
            'recovery.predecessorEpoch',
            'platform.installationEpoch',
            'recovery.manifest',
            'snapshot.sqlite',
            'manifest.json',
            'platform.sqlite',
            'RECOVERY.json',
            'RECOVERY.FENCE'
          ])
            projected.assertSanitized(word);
          return publishDirectory(destination, (dir) =>
            publish(projected.db, dir, 'snapshot.sqlite', metadata, 'manifest.json', projected)
          );
        } finally {
          projected.db.close();
        }
      }
      scratch
        .prepare(
          'DELETE FROM settings WHERE key NOT IN (' +
            retainedSettings.map(() => '?').join(',') +
            ')'
        )
        .run(...retainedSettings);
      if (
        scratch
          .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_workspaces'")
          .get()
      )
        scratch.exec('UPDATE agent_workspaces SET identity=NULL');
      scratch.exec('PRAGMA application_id=' + backupId);
      const objects = inventory(scratch, backupId);
      return publishDirectory(destination, (dir) =>
        publish(
          scratch,
          dir,
          'snapshot.sqlite',
          {
            formatVersion,
            appVersion,
            schemaVersion,
            mode: 'backup',
            epoch,
            recoveryPoint,
            operationId: options.operationId,
            objects,
            excluded,
            physicalOrigin: physicalOrigin(db.prepare('PRAGMA database_list').get().file, epoch)
          },
          'manifest.json'
        )
      );
    });
  } catch (error) {
    try {
      if (!error.publicationUncertain && !statIfPresent(destination)) error.noEffect = true;
    } catch {}
    throw error;
  }
}

// Bind only the physical original selected by this filesystem observation. This
// value is insufficient to grant host-wide writer authority or retire a clone.
export function physicalOrigin(filename, epoch) {
  if (!filename) return null;
  const physical = realpathSync(filename);
  const st = lstatSync(physical, { bigint: true });
  return hashed(
    JSON.stringify([
      'scion-origin-v1',
      epoch,
      physical,
      String(st.dev),
      String(st.ino),
      String(st.birthtimeNs)
    ])
  );
}
export function verifiedInspection(directory) {
  return verifyDirectory(directory, 'inspect-only');
}

export function restoreBackup({ source, destination }) {
  const dest = validateParent(destination);
  check(!statIfPresent(dest), 'Restore requires a new data directory.');
  const { manifest, filename } = verifyDirectory(source, 'backup');
  const archive = openDatabase(filename, true);
  try {
    const objects = inventory(archive, backupId, manifest.projection, manifest);
    check(
      JSON.stringify(objects) === JSON.stringify(manifest.objects),
      'Recovery object inventory differs from the manifest.'
    );
    // VACUUM INTO needs a writable connection pragma even though the archive file itself is opened read-only.
    archive.exec('PRAGMA query_only=OFF');
    return scratchCopy(archive, (scratch) => {
      const epoch = randomUUID();
      scratch.exec('PRAGMA application_id=' + inspectId);
      set(scratch, 'paused', 'true');
      set(scratch, 'recovery.mode', 'inspect-only');
      set(scratch, 'recovery.predecessorEpoch', manifest.epoch);
      set(scratch, 'platform.installationEpoch', epoch);
      new ResearchCatalog({ db: scratch }).rebuildIndex();
      return publishDirectory(dest, (dir) =>
        publish(
          scratch,
          dir,
          'platform.sqlite',
          restoredMetadata(
            manifest,
            epoch,
            new Date().toISOString(),
            manifest.database.sha256,
            objects
          ),
          'RECOVERY.json'
        )
      );
    });
  } finally {
    archive.close();
  }
}

export function assertWritableInstallation(dataDir) {
  const dir = safePath(dataDir);
  check(
    !statIfPresent(path.join(dir, 'RECOVERY.FENCE')) &&
      !statIfPresent(path.join(dir, 'RECOVERY.json')) &&
      !statIfPresent(path.join(dir, 'snapshot.sqlite')),
    'This recovery directory is fenced against execution.'
  );
  const file = path.join(dir, 'platform.sqlite');
  const st = statIfPresent(file);
  if (!st) return assertManagedInstallation(dir);
  check(st.isFile(), 'Invalid platform database type.');
  const fd = openSync(file, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
    check(fstatSync(fd).isFile(), 'Invalid platform database type.');
    const header = Buffer.alloc(100);
    if (readSync(fd, header, 0, 100, 0) >= 72)
      check(
        ![backupId, inspectId].includes(header.readUInt32BE(68)),
        'This recovery database is fenced against execution.'
      );
  } finally {
    closeSync(fd);
  }
  assertManagedInstallation(dir);
}

export function inspectRecovery({ directory, kind = 'summary', id, ...input }) {
  const { manifest, filename } = verifyDirectory(directory, 'inspect-only');
  const db = openDatabase(filename, true);
  try {
    const tables = schema(db, inspectId, manifest.schemaVersion);
    return readInspection(db, manifest, tables, kind, id, input);
  } finally {
    db.close();
  }
}
