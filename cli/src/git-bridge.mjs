import {
  constants as C,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  readFileSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { NativeStore, validateNativeId, validateNativeLabel } from './native-store.mjs';
import { NativeOperations } from './native-operations.mjs';
import { bounds, budget, exportBundle, need, readBundle, sha256 } from './git-bridge-format.mjs';
const profile = 'git-sha1-v1',
  helper = fileURLToPath(new URL('./git-bridge-publish.mjs', import.meta.url));
const digest = (name, input) => sha256(JSON.stringify([name, input]));
const fields = (o, allowed) =>
  o &&
  typeof o === 'object' &&
  !Array.isArray(o) &&
  allowed.every((k) => Object.hasOwn(o, k)) &&
  Object.keys(o).length === allowed.length;
const safeGitId = (s) => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const contained = (parent, child) => child === parent || child.startsWith(parent + '/');
export function normalizeBridge(name, input) {
  if (name === 'bridge.abandon') {
    need(
      fields(input, ['operationId', 'expectedDigest']) &&
        typeof input.expectedDigest === 'string' &&
        /^[a-f0-9]{64}$/.test(input.expectedDigest),
      'Supply an exact pending export and intent digest.',
      400
    );
    return {
      operationId: validateNativeLabel(input.operationId),
      expectedDigest: input.expectedDigest
    };
  }
  const importing = name === 'bridge.import';
  need(
    (importing || name === 'bridge.export') &&
      fields(
        input,
        importing
          ? ['repository', 'head', 'draft']
          : ['repository', 'draft', 'revisionId', 'destination']
      ),
    'Invalid Git bridge command.',
    400
  );
  const repository = validateNativeLabel(input.repository),
    draft = validateNativeLabel(input.draft);
  if (importing) {
    need(safeGitId(input.head), 'Select an exact retained Git commit.', 400);
    return { repository, head: input.head, draft };
  }
  const revisionId = validateNativeId(input.revisionId),
    destination = input.destination;
  need(
    typeof destination === 'string' &&
      destination.length <= 4096 &&
      path.isAbsolute(destination) &&
      path.normalize(destination) === destination &&
      /^[A-Za-z0-9][A-Za-z0-9._ -]{0,160}\.bundle$/.test(path.basename(destination)),
    'Select a fresh absolute .bundle path.',
    400
  );
  return { repository, draft, revisionId, destination };
}
export function installGitBridge(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS bridge_mappings(repository TEXT NOT NULL,revisionId TEXT NOT NULL REFERENCES native_revisions(id),
      gitId TEXT NOT NULL,PRIMARY KEY(repository,revisionId));
    CREATE TABLE IF NOT EXISTS bridge_imports(operationId TEXT PRIMARY KEY,repository TEXT NOT NULL,name TEXT NOT NULL,
      revisionId TEXT NOT NULL REFERENCES native_revisions(id),gitId TEXT NOT NULL REFERENCES git_revisions(revision),commits INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bridge_exports(operationId TEXT PRIMARY KEY,intent TEXT NOT NULL,stage TEXT NOT NULL,device TEXT NOT NULL,inode TEXT NOT NULL,
      stageDevice TEXT NOT NULL,stageInode TEXT NOT NULL,bytes INTEGER NOT NULL,digest TEXT NOT NULL,gitId TEXT NOT NULL,commits INTEGER NOT NULL,artifact BLOB NOT NULL,phase TEXT NOT NULL);`);
}
function source(db, head) {
  const row = db
    .prepare(
      `SELECT r.project,r.retentionRef,r.bundle FROM git_revisions r WHERE r.revision=? AND length(r.bundle)<=? AND
    (EXISTS(SELECT 1 FROM git_captures c WHERE c.revision=r.revision AND json_extract(c.metadata,'$.revision')=r.revision AND json_extract(c.metadata,'$.projectId')=r.project)
     OR EXISTS(SELECT 1 FROM review_landings l JOIN review_checks k ON k.id=json_extract(l.record,'$.checkId')
       JOIN review_decisions d ON d.id=json_extract(l.record,'$.approvalId') JOIN review_versions v ON v.id=l.version
       JOIN review_main m ON l.generation<=m.generation JOIN git_revisions initial ON initial.revision=m.initial
       WHERE json_extract(l.record,'$.target')=r.revision AND initial.project=r.project AND
         json_extract(k.record,'$.candidate')=r.revision AND json_extract(k.record,'$.state')='passed' AND
         k.version=v.id AND d.version=v.id AND json_extract(d.record,'$.decision')='approve'))`
    )
    .get(head, bounds.packed);
  need(
    row && row.retentionRef === 'refs/scion/retained/' + head,
    'Selected Git commit lacks a registered capture or a retained reviewed landing.'
  );
  return row;
}
function insertMappings(db, repository, map) {
  const insert = db.prepare('INSERT OR IGNORE INTO bridge_mappings VALUES(?,?,?)'),
    read = db.prepare('SELECT gitId FROM bridge_mappings WHERE repository=? AND revisionId=?');
  for (const [native, git] of map) {
    insert.run(repository, native, git);
    need(
      read.get(repository, native)?.gitId === git,
      'Native revision has a conflicting Git mapping.'
    );
  }
}
function syncDir(dir) {
  const fd = openSync(dir, C.O_DIRECTORY | C.O_RDONLY | C.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function identity(file) {
  const s = lstatSync(file, { bigint: true });
  return { device: String(s.dev), inode: String(s.ino) };
}
function parentOf(destination, workspaceRoot, dataDir) {
  const parent = path.dirname(destination);
  need(
    realpathSync(parent) === parent &&
      [workspaceRoot, dataDir].every((p) => !contained(realpathSync(p), destination)),
    'Git export must be separate from the workspace and daemon state in a canonical directory.'
  );
  const st = lstatSync(parent);
  need(
    st.isDirectory() && st.uid === process.getuid() && !(st.mode & 0o022),
    'Git export parent must be owner-controlled and deny group/other writes.'
  );
  for (let dir = parent; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const s = lstatSync(dir);
    need(
      (s.uid === 0 || s.uid === process.getuid()) &&
        (!(s.mode & 0o022) || (s.uid === 0 && s.mode & 0o1000)),
      'Unsafe Git export ancestor ownership.'
    );
  }
  return { parent, ...identity(parent) };
}
function fdIdentity(fd) {
  const s = fstatSync(fd, { bigint: true });
  return { stageDevice: String(s.dev), stageInode: String(s.ino) };
}
function fresh(dest) {
  try {
    lstatSync(dest);
    need(false, 'Git export destination already exists.');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
export class GitBridge {
  constructor(
    store,
    { dataDir, workspaceRoot, afterPublish, afterPrepare, afterReceipt, principal = 'local-owner' }
  ) {
    this.store = store;
    this.db = store.db;
    this.dataDir = dataDir;
    this.root = workspaceRoot;
    this.native = new NativeStore(store);
    this.ops = new NativeOperations(store, { principal });
    this.afterPublish = afterPublish;
    this.afterPrepare = afterPrepare;
    this.afterReceipt = afterReceipt;
  }
  prior(name, input, id) {
    validateNativeLabel(id);
    const d = digest(name, input);
    this.store.checkIntent(id, d);
    const row = this.db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(id);
    if (row) need(row.digest === d, 'Git bridge operation ID belongs to different inputs.');
    return row ? JSON.parse(row.receipt) : null;
  }
  import(raw, id) {
    const input = normalizeBridge('bridge.import', raw),
      { repository, head, draft: name } = input;
    this.ops.query('native.status');
    const prior = this.prior('bridge.import', input, id);
    if (prior) return prior;
    this.ops.checkImportDraft({ repository, name });
    const deadline = budget(),
      retained = source(this.db, head);
    need(
      this.db.prepare("SELECT value FROM settings WHERE key='platform.workspace'").get()?.value ===
        this.root,
      'Git bridge requires the bound owner workspace.'
    );
    const { commits, files } = readBundle(
        Buffer.from(retained.bundle),
        head,
        retained.retentionRef,
        deadline
      ),
      ids = new Map(),
      fileIds = new Map();
    // Stage immutable file objects with the native store's independent durability boundary.
    for (const [oid, bytes] of files) {
      deadline();
      fileIds.set(oid, this.native.putFile({ repository, bytes }).fileId);
    }
    const intentDigest = digest('bridge.import', input);
    return this.store.accept(id, intentDigest, () => {
      this.ops.checkImportDraft({ repository, name });
      for (const [git, r] of commits) {
        deadline();
        const before = commits.get(r.parents[0])?.tree ?? new Map(),
          edits = [];
        for (const key of before.keys())
          if (!r.tree.has(key)) edits.push({ path: key, delete: true });
        for (const [path, e] of r.tree) {
          const old = before.get(path);
          if (old?.mode !== e.mode || old.oid !== e.oid)
            edits.push({ path, mode: e.mode, fileId: fileIds.get(e.oid) });
        }
        const revision = this.native.acceptRevision({
          repository,
          parents: r.parents.map((p) => ids.get(p)),
          edits,
          author: r.author,
          committer: r.committer,
          message: r.message,
          provenance: null
        });
        ids.set(git, revision.revisionId);
      }
      const revisionId = ids.get(head),
        result = this.ops.attachImportedDraft({
          repository,
          name,
          revisionId,
          operationId: id,
          intentDigest
        });
      insertMappings(
        this.db,
        repository,
        [...ids].map(([git, native]) => [native, git])
      );
      this.db
        .prepare('INSERT INTO bridge_imports VALUES(?,?,?,?,?,?)')
        .run(id, repository, name, revisionId, head, commits.size);
      return {
        ...result,
        bridge: {
          direction: 'import',
          profile,
          repository,
          name,
          revisionId,
          gitId: head,
          commits: commits.size
        }
      };
    });
  }
  mapping(input) {
    need(
      fields(input, ['repository', 'draft', 'revisionId']),
      'Select one native revision in a named draft.',
      400
    );
    const { repository, draft: name, revisionId } = input;
    this.ops.query('native.revision', { repository, name, revisionId });
    const row = this.db
      .prepare('SELECT gitId FROM bridge_mappings WHERE repository=? AND revisionId=?')
      .get(repository, revisionId);
    need(row, 'This selected revision has no Git mapping.', 404);
    return { repository, name, revisionId, gitId: row.gitId, profile };
  }
  cleanupAccepted(operationId) {
    const sql = `SELECT j.operationId,j.intent,j.stage,j.stageDevice,j.stageInode,j.gitId,j.commits,j.bytes,j.digest,r.receipt,r.digest AS intentDigest FROM bridge_exports j JOIN command_receipts r USING(operationId) WHERE j.phase='accepted'`;
    const jobs =
      operationId === undefined
        ? this.db.prepare(sql).all()
        : this.db.prepare(sql + ' AND j.operationId=?').all(operationId);
    if (!jobs.length) return { removed: 0, preserved: 0 };
    const canonical = (name) =>
      process.platform === 'darwin' ? name.replace(/^\/(tmp|var)(?=\/|$)/, '/private/$1') : name;
    const directory = realpathSync(this.dataDir),
      st = lstatSync(directory);
    need(
      directory === canonical(this.dataDir) &&
        st.isDirectory() &&
        st.uid === process.getuid() &&
        !(st.mode & 0o077),
      'Invalid private bridge state directory.'
    );
    let removed = 0,
      preserved = 0;
    for (const job of jobs) {
      let fd;
      try {
        const input = normalizeBridge('bridge.export', JSON.parse(job.intent)),
          receipt = JSON.parse(job.receipt);
        const expected = {
          direction: 'export',
          profile,
          repository: input.repository,
          name: input.draft,
          revisionId: input.revisionId,
          gitId: job.gitId,
          commits: job.commits,
          destination: input.destination,
          bytes: job.bytes,
          digest: job.digest
        };
        need(
          receipt.operationId === job.operationId &&
            job.intentDigest === digest('bridge.export', input) &&
            isDeepStrictEqual(receipt.bridge, expected) &&
            canonical(path.dirname(job.stage)) === directory &&
            /^bridge-[a-f0-9-]{36}\.stage$/.test(path.basename(job.stage)),
          'Unexpected bridge stage receipt or location.'
        );
        fd = openSync(job.stage, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
        const current = fstatSync(fd, { bigint: true });
        need(
          current.isFile() &&
            current.uid === BigInt(process.getuid()) &&
            !(current.mode & 0o077n) &&
            String(current.dev) === job.stageDevice &&
            String(current.ino) === job.stageInode &&
            job.bytes <= bounds.packed &&
            current.size === BigInt(job.bytes) &&
            sha256(readFileSync(fd)) === job.digest &&
            isDeepStrictEqual(identity(job.stage), {
              device: job.stageDevice,
              inode: job.stageInode
            }),
          'Bridge stage identity or bytes changed.'
        );
        unlinkSync(job.stage);
        removed++;
      } catch (error) {
        if (error.code !== 'ENOENT') preserved++;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    if (removed) syncDir(directory);
    return { removed, preserved };
  }
  abandon(raw, id) {
    const input = normalizeBridge('bridge.abandon', raw),
      prior = this.prior('bridge.abandon', input, id);
    this.ops.query('native.status');
    if (prior) return prior;
    const { operationId, expectedDigest } = input,
      job = this.db
        .prepare('SELECT intent,gitId FROM bridge_exports WHERE operationId=?')
        .get(operationId);
    const original = job && normalizeBridge('bridge.export', JSON.parse(job.intent));
    need(
      original && digest('bridge.export', original) === expectedDigest && operationId !== id,
      'Named export intent changed or does not exist.'
    );
    this.ops.query('native.revision', {
      repository: original.repository,
      name: original.draft,
      revisionId: original.revisionId
    });
    return this.store.accept(id, digest('bridge.abandon', input), () => {
      const pending = this.db
        .prepare('SELECT * FROM pending_effects WHERE operationId=?')
        .get(operationId);
      need(
        pending?.kind === 'bridge.export' &&
          pending.digest === expectedDigest &&
          pending.destination === original.destination,
        'Only a matching unresolved export can be abandoned.'
      );
      const abandonment = {
        originalOperationId: operationId,
        operationId: id,
        outcome: 'unknown',
        intentDigest: expectedDigest,
        gitId: job.gitId,
        destination: original.destination
      };
      this.db
        .prepare('INSERT INTO command_receipts VALUES(?,?,?)')
        .run(operationId, expectedDigest, JSON.stringify({ operationId, abandoned: abandonment }));
      this.db
        .prepare("UPDATE bridge_exports SET phase='abandoned' WHERE operationId=?")
        .run(operationId);
      this.db.prepare('DELETE FROM pending_effects WHERE operationId=?').run(operationId);
      return { abandonment };
    });
  }
  export(raw, id) {
    const input = normalizeBridge('bridge.export', raw),
      { repository, draft: name, revisionId, destination } = input,
      subject = { repository, name, revisionId };
    this.ops.query('native.revision', subject);
    const prior = this.prior('bridge.export', input, id);
    if (prior) {
      this.cleanupAccepted(id);
      return prior;
    }
    const deadline = budget(),
      parent = parentOf(destination, this.root, this.dataDir),
      out = exportBundle(this.native, repository, revisionId, deadline),
      intentDigest = digest('bridge.export', input);
    let job = this.db.prepare('SELECT * FROM bridge_exports WHERE operationId=?').get(id),
      mode = 'reconcile';
    if (!job) {
      const space = this.db
        .prepare('SELECT count(*) n,coalesce(sum(bytes),0) total FROM bridge_exports')
        .get();
      need(
        space.n < 256 && space.total + out.bytes.length <= 48 * 1024 * 1024,
        'Git export artifact capacity exhausted.'
      );
      fresh(destination);
      need(
        parent.device === identity(this.dataDir).device,
        'Git export requires a destination on the service state volume.'
      );
      const stage = path.join(this.dataDir, 'bridge-' + randomUUID() + '.stage');
      job = {
        operationId: id,
        intent: JSON.stringify(input),
        stage,
        device: parent.device,
        inode: parent.inode,
        stageDevice: '',
        stageInode: '',
        bytes: out.bytes.length,
        digest: sha256(out.bytes),
        gitId: out.head,
        commits: out.mapped.size,
        artifact: out.bytes,
        phase: 'preparing'
      };
      this.store.transaction(() => {
        this.store.checkIntent(id, intentDigest);
        this.db
          .prepare('INSERT INTO pending_effects VALUES(?,?,?,?,?)')
          .run(id, intentDigest, 'bridge.export', destination, new Date().toISOString());
        this.db
          .prepare('INSERT INTO bridge_exports VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(...Object.values(job));
      });
    }
    need(
      job.intent === JSON.stringify(input) &&
        job.device === parent.device &&
        job.inode === parent.inode &&
        job.bytes === job.artifact.length &&
        job.digest === sha256(job.artifact) &&
        job.gitId === out.head,
      'Pending Git export no longer matches its bound parent, immutable revision or prepared bytes.'
    );
    need(
      path.dirname(job.stage) === this.dataDir &&
        /^bridge-[a-f0-9-]{36}\.stage$/.test(path.basename(job.stage)),
      'Git export stage is outside its reserved private location.'
    );
    if (job.phase === 'preparing') {
      let fd;
      try {
        try {
          fd = openSync(job.stage, C.O_RDWR | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          fd = openSync(job.stage, C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK);
        }
        const st = fstatSync(fd),
          bytes = Buffer.from(job.artifact);
        need(
          st.isFile() &&
            st.uid === process.getuid() &&
            !(st.mode & 0o077) &&
            st.nlink === 1 &&
            st.size <= bytes.length,
          'Unexpected private Git export stage.'
        );
        need(
          readFileSync(fd).equals(bytes.subarray(0, st.size)),
          'Private Git export stage differs from its durable input.'
        );
        for (let offset = st.size; offset < bytes.length; ) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
          need(written > 0, 'Git stage write stopped.');
          offset += written;
        }
        fsyncSync(fd);
        syncDir(this.dataDir);
        Object.assign(job, fdIdentity(fd), { phase: 'ready' });
        this.db
          .prepare(
            "UPDATE bridge_exports SET phase='ready',stageDevice=?,stageInode=? WHERE operationId=? AND phase='preparing'"
          )
          .run(job.stageDevice, job.stageInode, id);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    if (job.phase === 'ready') {
      this.afterPrepare?.();
      fresh(destination);
      need(
        this.db
          .prepare(
            "UPDATE bridge_exports SET phase='publishing' WHERE operationId=? AND phase='ready'"
          )
          .run(id).changes === 1,
        'Git export publication changed.'
      );
      mode = 'publish';
    } else need(job.phase === 'publishing', 'Unsupported Git export recovery phase.');
    this.ops.query('native.revision', subject);
    deadline();
    const result = spawnSync(
      process.execPath,
      [
        helper,
        mode,
        job.stage,
        path.basename(destination),
        job.device,
        job.inode,
        job.stageDevice,
        job.stageInode,
        job.digest,
        String(job.bytes)
      ],
      { cwd: parent.parent, env: {}, stdio: 'ignore', timeout: 3000 }
    );
    need(
      result.status === 0,
      'Git export publication is unconfirmed. Inspect the bound destination and preserved stage; no replacement is permitted.'
    );
    need(
      isDeepStrictEqual(identity(parent.parent), { device: job.device, inode: job.inode }),
      'Git export parent changed after publication.'
    );
    this.afterPublish?.();
    const receipt = this.store.accept(id, intentDigest, () => {
      insertMappings(this.db, repository, out.mapped);
      this.db.prepare("UPDATE bridge_exports SET phase='accepted' WHERE operationId=?").run(id);
      return {
        bridge: {
          direction: 'export',
          profile,
          repository,
          name,
          revisionId,
          gitId: out.head,
          commits: out.mapped.size,
          destination,
          bytes: job.bytes,
          digest: job.digest
        }
      };
    });
    this.afterReceipt?.();
    this.cleanupAccepted(id);
    return receipt;
  }
}
export function verifyGitBridge(db) {
  const native = new NativeStore({ db }),
    ops = new NativeOperations({ db }),
    expected = new Map(),
    seen = new Set(),
    nativeCache = new Map(),
    sourceCache = new Map();
  let imports = 0,
    exports = 0,
    abandoned = 0;
  function nativeClosure(repository, revisionId) {
    const key = repository + ' ' + revisionId;
    if (!nativeCache.has(key)) {
      const { head, mapped } = exportBundle(native, repository, revisionId, budget());
      nativeCache.set(key, { head, mapped });
    }
    return nativeCache.get(key);
  }
  for (const row of db
    .prepare(
      "SELECT operationId,digest,receipt FROM command_receipts WHERE json_type(receipt,'$.bridge')='object'"
    )
    .iterate()) {
    const receipt = JSON.parse(row.receipt),
      b = receipt.bridge;
    need(
      receipt.operationId === row.operationId &&
        b.profile === profile &&
        ['import', 'export'].includes(b.direction),
      'Unexpected Git bridge receipt.'
    );
    const key = b.direction === 'import' ? 'bridge_imports' : 'bridge_exports',
      record = db.prepare('SELECT * FROM ' + key + ' WHERE operationId=?').get(row.operationId);
    need(record, 'Bridge receipt lacks its historical operation.');
    ops.query('native.revision', {
      repository: b.repository,
      name: b.name,
      revisionId: b.revisionId
    });
    const out = nativeClosure(b.repository, b.revisionId);
    need(
      out.head === b.gitId && out.mapped.size === b.commits,
      'Native closure differs from the Git bridge receipt.'
    );
    if (b.direction === 'import') {
      const input = { repository: b.repository, head: b.gitId, draft: b.name },
        retained = source(db, b.gitId);
      imports++;
      if (!sourceCache.has(b.gitId))
        sourceCache.set(
          b.gitId,
          new Set(
            readBundle(
              Buffer.from(retained.bundle),
              b.gitId,
              retained.retentionRef,
              budget()
            ).commits.keys()
          )
        );
      const original = sourceCache.get(b.gitId);
      need(
        record.repository === b.repository &&
          record.name === b.name &&
          record.gitId === b.gitId &&
          record.revisionId === b.revisionId &&
          record.commits === b.commits &&
          receipt.draft?.sourceKind === 'git-import' &&
          receipt.draft.revisionId === b.revisionId &&
          receipt.draft.name === b.name &&
          original.size === out.mapped.size &&
          [...out.mapped.values()].every((g) => original.has(g)) &&
          row.digest === digest('bridge.import', input),
        'Git import mapping differs from its selected capture or owner intent.'
      );
    } else {
      exports++;
      const input = normalizeBridge('bridge.export', JSON.parse(record.intent));
      need(
        input.repository === b.repository &&
          input.draft === b.name &&
          input.destination === b.destination &&
          input.revisionId === b.revisionId &&
          record.phase === 'accepted' &&
          record.gitId === b.gitId &&
          record.commits === b.commits &&
          record.digest === b.digest &&
          record.bytes === b.bytes &&
          sha256(record.artifact) === b.digest &&
          record.artifact.length === b.bytes &&
          readBundle(Buffer.from(record.artifact), b.gitId, 'refs/heads/export', budget(), true)
            .commits.size === out.mapped.size &&
          row.digest === digest('bridge.export', input),
        'Git export bytes or intent differ from their receipt.'
      );
    }
    seen.add(row.operationId);
    for (const [nid, gid] of out.mapped) expected.set(b.repository + ' ' + nid, gid);
  }
  for (const row of db
    .prepare(
      "SELECT operationId,digest,receipt FROM command_receipts WHERE json_type(receipt,'$.abandoned')='object'"
    )
    .iterate()) {
    const a = JSON.parse(row.receipt).abandoned,
      job = db.prepare('SELECT * FROM bridge_exports WHERE operationId=?').get(row.operationId);
    const ack = db.prepare('SELECT * FROM command_receipts WHERE operationId=?').get(a.operationId);
    need(
      job?.phase === 'abandoned' &&
        ack &&
        a.outcome === 'unknown' &&
        a.originalOperationId === row.operationId &&
        a.intentDigest === row.digest &&
        a.gitId === job.gitId &&
        digest('bridge.export', normalizeBridge('bridge.export', JSON.parse(job.intent))) ===
          row.digest &&
        JSON.parse(job.intent).destination === a.destination &&
        ack.digest ===
          digest('bridge.abandon', { operationId: row.operationId, expectedDigest: row.digest }) &&
        isDeepStrictEqual(JSON.parse(ack.receipt).abandonment, a) &&
        job.bytes === job.artifact.length &&
        sha256(job.artifact) === job.digest,
      'Git export abandonment lost its independent owner receipt or original intent.'
    );
    abandoned++;
    const original = JSON.parse(job.intent);
    ops.query('native.revision', {
      repository: original.repository,
      name: original.draft,
      revisionId: original.revisionId
    });
    const out = nativeClosure(original.repository, original.revisionId);
    need(
      out.head === job.gitId &&
        out.mapped.size ===
          readBundle(Buffer.from(job.artifact), job.gitId, 'refs/heads/export', budget(), true)
            .commits.size,
      'Abandoned export prepared artifact lost its native subject.'
    );
    seen.add(row.operationId);
  }
  for (const row of db
    .prepare(
      "SELECT receipt FROM command_receipts WHERE json_type(receipt,'$.abandonment')='object'"
    )
    .iterate())
    need(
      seen.has(JSON.parse(row.receipt).abandonment.originalOperationId),
      'Abandonment lacks a permanently fenced original operation.'
    );
  for (const table of ['bridge_exports', 'bridge_imports'])
    for (const r of db.prepare('SELECT operationId FROM ' + table).iterate())
      need(seen.has(r.operationId), 'Git bridge contains an unconfirmed operation.');
  for (const row of db.prepare('SELECT * FROM bridge_mappings').iterate()) {
    const key = row.repository + ' ' + row.revisionId;
    need(
      expected.get(key) === row.gitId,
      'Git revision mapping differs from its acknowledged subject.'
    );
    expected.delete(key);
  }
  need(!expected.size, 'Git bridge mappings are missing.');
  return {
    profile,
    imports,
    exports,
    abandoned,
    mappings: db.prepare('SELECT count(*) n FROM bridge_mappings').get().n
  };
}
