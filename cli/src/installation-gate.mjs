import { createHash } from 'node:crypto';
import {
  constants as F,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const installationRegistryId = 0x53434952;
export function ensureInstallation(ok, message, status = 409) {
  if (!ok) throw Object.assign(Error(message), { status });
}
export function privateFile(file, max) {
  const fd = openSync(file, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    ensureInstallation(
      st.isFile() && st.uid === process.getuid() && st.nlink === 1 && st.size <= max,
      'Unexpected installation file identity.'
    );
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function privateRoot(dir) {
  ensureInstallation(
    typeof dir === 'string' && path.isAbsolute(dir) && realpathSync(dir) === dir,
    'Use a canonical installation directory.'
  );
  const st = lstatSync(dir);
  ensureInstallation(
    st.isDirectory() && st.uid === process.getuid() && !(st.mode & 0o077),
    'Installation directory must be owner-private.'
  );
  return dir;
}
function durableBinding(file) {
  if (!existsSync(file) || lstatSync(file).size < 100) return null;
  const uri = pathToFileURL(file);
  uri.searchParams.set('immutable', '1');
  const db = new DatabaseSync(uri.href, { readOnly: true, allowExtension: false });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='settings'").get())
      return null;
    return (
      db.prepare("SELECT value FROM settings WHERE key='platform.managedPair'").get()?.value ?? null
    );
  } finally {
    db.close();
  }
}
export function verifyPinnedBuild(directory, build, raw) {
  const m = JSON.parse(raw),
    { digest, ...definition } = m,
    sha = (b) => createHash('sha256').update(b).digest('hex');
  ensureInstallation(
    digest === build &&
      sha(JSON.stringify(definition)) === build &&
      definition.runtime === process.version &&
      Array.isArray(m.files) &&
      m.files.length <= 256,
    'Installed compatibility manifest no longer matches the approved build.'
  );
  const wanted = new Map(m.files.map((f) => [f.path, f]));
  function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name,
        name = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        ensureInstallation(
          rel === 'src' || rel.startsWith('src/'),
          'Unexpected installed directory.'
        );
        walk(name, rel + '/');
        continue;
      }
      const f = wanted.get(rel);
      ensureInstallation(
        entry.isFile() &&
          f &&
          f.bytes <= 2 * 1024 * 1024 &&
          sha(privateFile(name, f.bytes)) === f.sha256,
        'Installed program bytes or file inventory changed.'
      );
      wanted.delete(rel);
    }
  }
  walk(directory, '');
  ensureInstallation(!wanted.size, 'Installed program files are missing.');
}
export function assertManagedInstallation(dataDir) {
  const dir = realpathSync(dataDir),
    file = path.join(dir, 'MANAGED.json'),
    dbFile = path.join(dir, 'platform.sqlite');
  const layout =
    path.basename(path.dirname(dir)) === 'pairs' &&
    existsSync(path.join(dir, '..', '..', 'registry.sqlite'));
  const binding = durableBinding(dbFile);
  if (!layout && !binding && !existsSync(file)) return;
  ensureInstallation(
    layout && binding && existsSync(file),
    'Managed data copy has no current installation authority.'
  );
  const root = privateRoot(path.dirname(path.dirname(dir)));
  privateRoot(dir);
  const marker = JSON.parse(privateFile(file, 4096)),
    registry = path.join(root, 'registry.sqlite'),
    st = lstatSync(registry);
  ensureInstallation(
    st.isFile() && st.nlink === 1 && st.uid === process.getuid() && !(st.mode & 0o077),
    'Unexpected installation registry.'
  );
  const db = new DatabaseSync(registry, { readOnly: true, allowExtension: false });
  try {
    ensureInstallation(
      db.prepare('PRAGMA application_id').get().application_id === installationRegistryId,
      'Invalid installation authority.'
    );
    const row = db
      .prepare('SELECT p.* FROM control c JOIN pairs p ON p.id=c.active WHERE c.slot=1')
      .get();
    const origin = realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..')),
      physical = lstatSync(dir, { bigint: true }),
      data = lstatSync(dbFile, { bigint: true });
    ensureInstallation(
      row &&
        dir === path.join(root, 'pairs', row.id) &&
        marker.pair === row.id &&
        binding === row.id &&
        marker.build === row.build &&
        origin === path.join(root, 'builds', row.build) &&
        String(physical.dev) === row.device &&
        String(physical.ino) === row.inode &&
        String(data.ino) === row.databaseInode,
      'Installation pair, data or executable is no longer the active writer.'
    );
    verifyPinnedBuild(
      origin,
      row.build,
      db.prepare('SELECT manifest FROM staged WHERE build=?').get(row.build)?.manifest
    );
    return { id: row.id, root, dir };
  } finally {
    db.close();
  }
}

const leases = new WeakMap();
export function bindManagedWriter(dataDir, lock) {
  const pair = assertManagedInstallation(dataDir);
  if (!pair) return undefined;
  const file = path.join(pair.dir, 'daemon.lock.sqlite');
  ensureInstallation(
    lock.isTransaction && lock.prepare('PRAGMA database_list').get().file === file,
    'Managed installation requires its exact writer lease.'
  );
  lock.prepare('SELECT count(*) FROM sqlite_schema').get();
  const independent = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  let exclusive = false;
  try {
    independent.exec('PRAGMA busy_timeout=0');
    independent.prepare('SELECT count(*) FROM sqlite_schema').get();
  } catch (e) {
    if (e.errcode === 5 || e.errcode === 6) exclusive = true;
    else throw e;
  } finally {
    independent.close();
  }
  ensureInstallation(exclusive, 'Managed installation requires an exclusive writer lease.');
  const token = Object.freeze({});
  leases.set(token, { pair, lock });
  return token;
}
export function assertManagedWriter(dataDir, token) {
  const pair = assertManagedInstallation(dataDir);
  if (!pair) return;
  const held = leases.get(token);
  ensureInstallation(
    held && held.pair.id === pair.id && held.pair.root === pair.root && held.lock.isTransaction,
    'Managed installation requires its live writer lease.'
  );
}
