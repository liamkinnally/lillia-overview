import { createHash } from 'node:crypto';

const MiB = 1024 * 1024;
const limits = {
  file: 4 * MiB,
  tree: 24 * MiB,
  files: 8192,
  rawFiles: 64 * MiB,
  revisions: 1024,
  canonical: 16 * MiB,
  depth: 256,
  parents: 8,
  frame: 2 * MiB
};
const oid = /^[a-f0-9]{64}$/,
  tag = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function check(ok, msg, status = 409) {
  if (!ok) throw Object.assign(new Error(msg), { status });
}
function keys(o, required, optional = []) {
  check(
    o &&
      typeof o === 'object' &&
      !Array.isArray(o) &&
      required.every((k) => Object.hasOwn(o, k)) &&
      Object.keys(o).every((k) => required.includes(k) || optional.includes(k)),
    'Unexpected native metadata fields',
    400
  );
}
function opId(s) {
  check(
    typeof s === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(s),
    'Invalid native operation identity',
    400
  );
  return s;
}
function label(s) {
  check(typeof s === 'string' && tag.test(s), 'Unsupported native identifier', 400);
  return s;
}
function objectId(s) {
  check(typeof s === 'string' && oid.test(s), 'Expected an exact native object ID', 400);
  return s;
}
function text(s, max, empty = false) {
  check(
    typeof s === 'string' &&
      s.isWellFormed() &&
      (empty || s.length) &&
      Buffer.byteLength(s) <= max &&
      !s.includes('\0'),
    'Unsupported native UTF-8 metadata',
    400
  );
  return s;
}
function filePath(p) {
  check(
    typeof p === 'string' &&
      p.length <= 240 &&
      p.split('/').length <= 32 &&
      p
        .split('/')
        .every(
          (s) =>
            (/^[A-Za-z0-9_.][A-Za-z0-9_. -]*$/.test(s) || /^\[[A-Za-z_][A-Za-z0-9_]*\]$/.test(s)) &&
            !/[. ]$/.test(s) &&
            s.toLowerCase() !== '.git' &&
            !/^(con|nul|aux|prn|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)
        ),
    'Unsafe or unsupported native path',
    400
  );
  return p;
}
function ident(kind, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  return createHash('sha256')
    .update('scion-native\0' + kind + '\0v1\0')
    .update(length)
    .update(payload)
    .digest('hex');
}
export function nativeRevisionId(revision) {
  return ident('revision', frame(revision));
}
export function nativeFileId(bytes) {
  check(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'Expected native file bytes', 400);
  check(bytes.length <= limits.file, 'Native file exceeds 4 MiB', 400);
  return ident('file', bytes);
}
function actor(a) {
  keys(a, ['name', 'email', 'seconds', 'offset']);
  const name = text(a.name, 512),
    email = text(a.email, 512);
  check(
    !/[\r\n]/.test(name + email) &&
      Number.isSafeInteger(a.seconds) &&
      !Object.is(a.seconds, -0) &&
      typeof a.offset === 'string' &&
      /^[+-](?:[01][0-9]|2[0-3])[0-5][0-9]$/.test(a.offset),
    'Invalid native actor time or identity',
    400
  );
  return [name, email, a.seconds, a.offset];
}
function frame(r) {
  keys(r, ['repository', 'parents', 'edits', 'author', 'committer', 'message'], ['provenance']);
  const repo = label(r.repository);
  check(
    Array.isArray(r.parents) && r.parents.length <= limits.parents,
    'Expected at most eight ordered native parents',
    400
  );
  const parents = r.parents.map(objectId);
  check(new Set(parents).size === parents.length, 'Duplicate native parent', 400);
  check(
    Array.isArray(r.edits) && r.edits.length <= limits.files,
    'Native changeset exceeds edit capacity',
    400
  );
  const edits = r.edits
    .map((e) => {
      if (e?.delete === true) {
        keys(e, ['path', 'delete']);
        return [filePath(e.path)];
      }
      keys(e, ['path', 'mode', 'fileId']);
      check(['100644', '100755', '120000'].includes(e.mode), 'Unsupported native entry mode', 400);
      return [filePath(e.path), e.mode, objectId(e.fileId)];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  check(!edits.some((e, i) => i && edits[i - 1][0] === e[0]), 'Duplicate native edit', 400);
  let provenance = null;
  if (r.provenance != null) {
    keys(r.provenance, ['principal', 'taskId']);
    provenance = [
      label(r.provenance.principal),
      r.provenance.taskId === null ? null : label(r.provenance.taskId)
    ];
  }
  const raw = Buffer.from(
    JSON.stringify([
      repo,
      parents,
      edits,
      actor(r.author),
      actor(r.committer),
      text(r.message, 65536, true),
      provenance
    ])
  );
  check(raw.length <= limits.frame, 'Native changeset exceeds 2 MiB');
  return raw;
}
function decode(raw) {
  try {
    const blob = JSON.parse(utf8.decode(raw));
    check(Array.isArray(blob) && blob.length === 7, 'Invalid native revision frame');
    const [repository, parents, rows, au, co, message, p] = blob;
    const person = (x) => ({ name: x[0], email: x[1], seconds: x[2], offset: x[3] });
    const edits = rows.map((e) =>
      e.length === 1 ? { path: e[0], delete: true } : { path: e[0], mode: e[1], fileId: e[2] }
    );
    const r = {
      repository,
      parents,
      edits,
      author: person(au),
      committer: person(co),
      message,
      provenance: p === null ? null : { principal: p[0], taskId: p[1] }
    };
    check(frame(r).equals(raw), 'Noncanonical native revision');
    return r;
  } catch {
    throw Object.assign(new Error('Native revision canonical integrity check failed'), {
      status: 409
    });
  }
}
function applyEdits(tree, revision, descriptors) {
  for (const edit of revision.edits) {
    const prior = tree.get(edit.path);
    if (edit.delete) {
      check(prior, 'Native deletion refers to an absent path');
      tree.delete(edit.path);
    } else {
      check(
        prior?.mode !== edit.mode || prior?.fileId !== edit.fileId,
        'Native changeset includes a redundant replacement'
      );
      const d = descriptors.get(edit.fileId);
      check(d && (edit.mode !== '120000' || d.link), 'Unsupported native symlink target bytes');
      tree.set(edit.path, edit);
    }
  }
  check(tree.size <= limits.files, 'Native tree exceeds path capacity');
  const names = new Map();
  let total = 0;
  for (const [p, e] of tree) {
    total += descriptors.get(e.fileId).size;
    check(total <= limits.tree, 'Native tree exceeds logical byte capacity');
    const parts = p.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      prefix += (i ? '/' : '') + parts[i];
      const key = prefix.toLowerCase(),
        dir = i < parts.length - 1,
        value = (dir ? 'd:' : 'f:') + prefix;
      check(!names.has(key) || names.get(key) === value, 'Native path case or directory collision');
      names.set(key, value);
    }
  }
}
export function installNativeOperations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS native_owner(slot INTEGER PRIMARY KEY CHECK(slot=1),repository TEXT UNIQUE NOT NULL,workspaceDigest TEXT NOT NULL,operationId TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS native_drafts(repository TEXT NOT NULL REFERENCES native_owner(repository),name TEXT NOT NULL,operationId TEXT UNIQUE NOT NULL,PRIMARY KEY(repository,name));`);
}
export {
  filePath as validateNativePath,
  label as validateNativeLabel,
  objectId as validateNativeId
};
export function installNativeStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS native_files(id TEXT PRIMARY KEY,bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS native_file_grants(repository TEXT NOT NULL,fileId TEXT NOT NULL REFERENCES native_files(id),PRIMARY KEY(repository,fileId));
    CREATE TABLE IF NOT EXISTS native_revisions(id TEXT PRIMARY KEY,repository TEXT NOT NULL,canonical BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS native_refs(repository TEXT NOT NULL,name TEXT NOT NULL,revisionId TEXT NOT NULL REFERENCES native_revisions(id),
      generation INTEGER NOT NULL,PRIMARY KEY(repository,name));
    CREATE TABLE IF NOT EXISTS native_ref_events(sequence INTEGER PRIMARY KEY,operationId TEXT UNIQUE NOT NULL,repository TEXT NOT NULL,name TEXT NOT NULL,
      expectedRevision TEXT REFERENCES native_revisions(id),expectedGeneration INTEGER NOT NULL,revisionId TEXT NOT NULL REFERENCES native_revisions(id),
      generation INTEGER NOT NULL,at TEXT NOT NULL,UNIQUE(repository,name,generation));`);
}
export class NativeStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }
  #writer() {
    check(this.db.isTransaction, 'Native mutation requires the writer transaction');
    check(
      this.db.prepare('PRAGMA synchronous').get().synchronous >= 2,
      'FULL SQLite synchronization required for native acceptance'
    );
    const mode = this.db.prepare('PRAGMA journal_mode').get().journal_mode;
    check(
      ['wal', 'delete', 'truncate', 'persist'].includes(mode) &&
        !!this.db.prepare('PRAGMA database_list').get().file,
      'A durable SQLite journal is required for native acceptance'
    );
  }
  putFile({ repository, bytes }) {
    label(repository);
    check(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'Expected native file bytes', 400);
    check(bytes.length <= limits.file, 'Native file exceeds 4 MiB', 400);
    check(
      !this.db.isTransaction,
      'File storage requires a prior independent committed transaction'
    );
    const content = Buffer.from(bytes),
      fileId = nativeFileId(content);
    return this.store.transaction(() => {
      this.#writer();
      const existing = this.db
        .prepare('SELECT length(bytes) AS size FROM native_files WHERE id=?')
        .get(fileId);
      if (existing)
        check(
          existing.size === content.length &&
            Buffer.from(
              this.db.prepare('SELECT bytes FROM native_files WHERE id=?').get(fileId).bytes
            ).equals(content),
          'Native file identity integrity conflict'
        );
      else {
        const space = this.db
          .prepare('SELECT count(*) AS n,coalesce(sum(length(bytes)),0) AS total FROM native_files')
          .get();
        check(
          space.n < 16384 && space.total + content.length <= limits.rawFiles,
          'Native retained file capacity exhausted'
        );
        this.db.prepare('INSERT INTO native_files VALUES(?,?)').run(fileId, content);
      }
      const prior = this.db
        .prepare('SELECT 1 FROM native_file_grants WHERE repository=? AND fileId=?')
        .get(repository, fileId);
      if (!prior) {
        check(
          this.db.prepare('SELECT count(*) AS n FROM native_file_grants').get().n < 32768,
          'Native grant capacity exhausted'
        );
        this.db.prepare('INSERT INTO native_file_grants VALUES(?,?)').run(repository, fileId);
      }
      return { fileId, bytes: content.length };
    });
  }
  #bytes(repository, id) {
    const sql =
      ' FROM native_file_grants g JOIN native_files f ON f.id=g.fileId WHERE g.repository=? AND g.fileId=?';
    const allowed = this.db.prepare('SELECT length(f.bytes) AS size' + sql).get(repository, id);
    check(
      allowed && allowed.size <= limits.file,
      'Native file grant is missing or exceeds the supported limit'
    );
    const bytes = Buffer.from(this.db.prepare('SELECT f.bytes' + sql).get(repository, id).bytes);
    check(ident('file', bytes) === id, 'Native file digest integrity check failed');
    return bytes;
  }
  #revision(repository, id) {
    const row = this.db
      .prepare(
        'SELECT canonical FROM native_revisions WHERE repository=? AND id=? AND length(canonical)<=?'
      )
      .get(repository, id, limits.frame);
    check(row, 'Native parent or revision is unavailable in the requested repository', 404);
    const raw = Buffer.from(row.canonical);
    check(ident('revision', raw) === id, 'Native revision digest integrity check failed');
    const r = decode(raw);
    check(r.repository === repository, 'Native revision repository binding changed');
    return r;
  }
  // Validate every parent, then walk the first-parent forest. Undo each branch's
  // edits as it unwinds so wide histories need just one mutable manifest.
  #reconstruct(repository, roots, want = null, proposed = null, verifiedFiles = null) {
    const nodes = new Map(),
      gray = new Set(),
      height = new Map(),
      descriptors = new Map(),
      children = new Map();
    const visit = (id, depth) => {
      check(
        depth <= limits.depth && !gray.has(id),
        'Native ancestry depth or cycle is unsupported'
      );
      if (nodes.has(id)) return;
      gray.add(id);
      const r = id === proposed?.id ? proposed.revision : this.#revision(repository, id);
      let h = 1;
      for (const parent of r.parents) {
        visit(parent, depth + 1);
        h = Math.max(h, height.get(parent) + 1);
      }
      check(
        h <= limits.depth && nodes.size < limits.revisions,
        'Native ancestry capacity exceeded'
      );
      for (const e of r.edits)
        if (!e.delete && !descriptors.has(e.fileId)) {
          if (verifiedFiles) {
            const desc = verifiedFiles.get(e.fileId);
            check(
              desc &&
                this.db
                  .prepare('SELECT 1 FROM native_file_grants WHERE repository=? AND fileId=?')
                  .get(repository, e.fileId),
              'Native file lacks its repository grant'
            );
            descriptors.set(e.fileId, desc);
          } else {
            const b = this.#bytes(repository, e.fileId);
            descriptors.set(e.fileId, {
              size: b.length,
              link: b.length > 0 && b.length <= 4096 && !b.includes(0)
            });
          }
        }
      const parent = r.parents[0] ?? null;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(id);
      nodes.set(id, r);
      height.set(id, h);
      gray.delete(id);
    };
    for (const id of roots) visit(id, 1);
    const tree = new Map();
    let selected;
    function reconstruct(id) {
      const r = nodes.get(id),
        prior = r.edits.map((e) => tree.get(e.path));
      applyEdits(tree, r, descriptors);
      if (id === want) selected = new Map(tree);
      for (const child of children.get(id) ?? []) reconstruct(child);
      for (let i = 0; i < r.edits.length; i++) {
        const path = r.edits[i].path;
        if (prior[i]) tree.set(path, prior[i]);
        else tree.delete(path);
      }
    }
    for (const root of children.get(null) ?? []) reconstruct(root);
    return { nodes, tree: selected };
  }
  acceptRevision(raw) {
    this.#writer();
    const canonical = frame(raw),
      id = ident('revision', canonical),
      r = decode(canonical);
    this.#reconstruct(r.repository, [id], null, { id, revision: r });
    const prior = this.db
      .prepare(
        'SELECT repository,canonical FROM native_revisions WHERE id=? AND length(canonical)<=?'
      )
      .get(id, limits.frame);
    if (prior)
      check(
        prior.repository === r.repository && canonical.equals(prior.canonical),
        'Native revision identity conflict'
      );
    else {
      const space = this.db
        .prepare(
          'SELECT count(*) AS n,coalesce(sum(length(canonical)),0) AS bytes FROM native_revisions'
        )
        .get();
      check(
        space.n < limits.revisions && space.bytes + canonical.length <= limits.canonical,
        'Native retained revision capacity exhausted'
      );
      this.db
        .prepare('INSERT INTO native_revisions VALUES(?,?,?)')
        .run(id, r.repository, canonical);
    }
    return { revisionId: id, ...r };
  }
  revision({ repository, revisionId }) {
    label(repository);
    objectId(revisionId);
    return { revisionId, ...this.#revision(repository, revisionId) };
  }
  select({ repository, revisionId }) {
    label(repository);
    objectId(revisionId);
    const { tree } = this.#reconstruct(repository, [revisionId], revisionId);
    const entries = [...tree.values()]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((e) => Object.freeze({ ...e }));
    const read = (path) => {
      filePath(path);
      const e = tree.get(path);
      check(e, 'Native path is absent at the selected revision', 404);
      return { repository, revisionId, ...e, bytes: this.#bytes(repository, e.fileId) };
    };
    return { repository, revisionId, entries, read };
  }
  tree(subject) {
    const { repository, revisionId, entries } = this.select(subject);
    return { repository, revisionId, entries };
  }
  file({ repository, revisionId, path }) {
    return this.select({ repository, revisionId }).read(path);
  }
  ref({ repository, name }) {
    label(repository);
    label(name);
    const row = this.db
      .prepare('SELECT revisionId,generation FROM native_refs WHERE repository=? AND name=?')
      .get(repository, name);
    return {
      repository,
      name,
      revisionId: row?.revisionId ?? null,
      generation: row?.generation ?? 0
    };
  }
  #forward(nodes, from, to) {
    if (from === null) return;
    let p = nodes.get(to)?.parents[0];
    while (p && p !== from) p = nodes.get(p)?.parents[0];
    check(from === p, 'Native ref requires a forward first-parent descendant');
  }
  advanceRef(input) {
    this.#writer();
    keys(input, [
      'repository',
      'name',
      'expectedRevision',
      'expectedGeneration',
      'revisionId',
      'operationId'
    ]);
    const { repository, name, expectedRevision, expectedGeneration, revisionId, operationId } =
      input;
    label(repository);
    label(name);
    opId(operationId);
    objectId(revisionId);
    if (expectedRevision !== null) objectId(expectedRevision);
    check(
      Number.isSafeInteger(expectedGeneration) &&
        expectedGeneration >= 0 &&
        (expectedRevision === null) === (expectedGeneration === 0),
      'Invalid native ref expectation',
      400
    );
    const earlier = this.db
      .prepare('SELECT * FROM native_ref_events WHERE operationId=?')
      .get(operationId);
    if (earlier) {
      check(
        Object.entries(input).every(([k, v]) => earlier[k] === v),
        'Native ref operation ID is bound to a different request'
      );
      return { ...earlier };
    }
    const prior = this.ref({ repository, name });
    check(
      prior.revisionId === expectedRevision && prior.generation === expectedGeneration,
      'Native ref target or generation changed'
    );
    const graph = this.#reconstruct(repository, [revisionId]);
    this.#forward(graph.nodes, expectedRevision, revisionId);
    check(
      this.db.prepare('SELECT count(*) AS n FROM native_ref_events').get().n < 32768,
      'Native ref history capacity exhausted'
    );
    const generation = expectedGeneration + 1;
    this.db.exec('SAVEPOINT native_ref_atomic');
    try {
      if (expectedGeneration === 0)
        this.db
          .prepare('INSERT INTO native_refs VALUES(?,?,?,?)')
          .run(repository, name, revisionId, generation);
      else
        check(
          this.db
            .prepare(
              'UPDATE native_refs SET revisionId=?,generation=? WHERE repository=? AND name=? AND revisionId=? AND generation=?'
            )
            .run(revisionId, generation, repository, name, expectedRevision, expectedGeneration)
            .changes === 1,
          'Native ref generation changed'
        );
      this.db
        .prepare(
          `INSERT INTO native_ref_events(operationId,repository,name,expectedRevision,expectedGeneration,revisionId,generation,at)
        VALUES(?,?,?,?,?,?,?,?)`
        )
        .run(
          operationId,
          repository,
          name,
          expectedRevision,
          expectedGeneration,
          revisionId,
          generation,
          new Date().toISOString()
        );
      const event = {
        ...this.db.prepare('SELECT * FROM native_ref_events WHERE operationId=?').get(operationId)
      };
      this.db.exec('RELEASE native_ref_atomic');
      return event;
    } catch (error) {
      this.db.exec('ROLLBACK TO native_ref_atomic; RELEASE native_ref_atomic');
      throw error;
    }
  }
  verify() {
    const groups = new Map(),
      nodes = new Map(),
      landed = new Map(),
      verifiedFiles = new Map();
    const space = this.db
      .prepare('SELECT count(*) AS n,coalesce(sum(length(bytes)),0) AS size FROM native_files')
      .get();
    const history = this.db
      .prepare(
        'SELECT count(*) AS n,coalesce(sum(length(canonical)),0) AS size FROM native_revisions'
      )
      .get();
    check(
      space.n <= 16384 &&
        space.size <= limits.rawFiles &&
        history.n <= limits.revisions &&
        history.size <= limits.canonical &&
        this.db.prepare('SELECT count(*) AS n FROM native_file_grants').get().n <= 32768 &&
        this.db.prepare('SELECT count(*) AS n FROM native_ref_events').get().n <= 32768,
      'Native recovery capacity exceeded'
    );
    let files = 0,
      revisions = 0,
      events = 0;
    for (const f of this.db
      .prepare('SELECT id,length(bytes) AS size FROM native_files')
      .iterate()) {
      check(f.size <= limits.file, 'Native retained file exceeds size bound');
      const bytes = this.db.prepare('SELECT bytes FROM native_files WHERE id=?').get(f.id).bytes;
      check(ident('file', bytes) === f.id, 'Native file digest integrity check failed');
      verifiedFiles.set(f.id, {
        size: bytes.length,
        link: bytes.length > 0 && bytes.length <= 4096 && !bytes.includes(0)
      });
      files++;
    }
    for (const g of this.db
      .prepare(
        'SELECT g.repository,g.fileId,f.id FROM native_file_grants g LEFT JOIN native_files f ON g.fileId=f.id'
      )
      .iterate()) {
      label(g.repository);
      check(g.id === g.fileId, 'Native file grant is dangling');
    }
    for (const row of this.db.prepare('SELECT id,repository FROM native_revisions').iterate()) {
      label(row.repository);
      objectId(row.id);
      if (!groups.has(row.repository)) groups.set(row.repository, []);
      groups.get(row.repository).push(row.id);
      revisions++;
    }
    for (const [repo, ids] of groups)
      nodes.set(repo, this.#reconstruct(repo, ids, null, null, verifiedFiles).nodes);
    for (const e of this.db
      .prepare('SELECT * FROM native_ref_events ORDER BY sequence')
      .iterate()) {
      label(e.name);
      opId(e.operationId);
      check(
        e.sequence === events + 1 &&
          typeof e.at === 'string' &&
          Number.isFinite(Date.parse(e.at)) &&
          new Date(e.at).toISOString() === e.at,
        'Invalid native publication sequence or timestamp'
      );
      const key = JSON.stringify([e.repository, e.name]),
        previous = landed.get(key);
      const graph = nodes.get(e.repository);
      check(
        graph?.has(e.revisionId) &&
          e.expectedRevision === (previous?.revisionId ?? null) &&
          e.expectedGeneration === (previous?.generation ?? 0) &&
          e.generation === e.expectedGeneration + 1,
        'Native ref event chain is inconsistent'
      );
      this.#forward(graph, e.expectedRevision, e.revisionId);
      landed.set(key, e);
      events++;
    }
    for (const row of this.db.prepare('SELECT * FROM native_refs').iterate()) {
      const key = JSON.stringify([row.repository, row.name]),
        e = landed.get(key);
      check(
        e && e.revisionId === row.revisionId && e.generation === row.generation,
        'Native ref differs from its event history'
      );
      landed.delete(key);
    }
    check(!landed.size, 'Native ref is absent for a recorded publication');
    return { files, revisions, events };
  }
}
