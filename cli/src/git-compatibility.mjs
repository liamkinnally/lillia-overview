import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  constants as C,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  readlinkSync,
  lstatSync,
  realpathSync,
  mkdtempSync,
  writeFileSync,
  unlinkSync,
  chmodSync
} from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { runCompatibilityHarness, harnessProfile } from './git-compat-harness.mjs';
import { NativeAuthority } from './native-authority.mjs';
import {
  NativeStore,
  nativeFileId,
  validateNativeId,
  validateNativeLabel
} from './native-store.mjs';
import { exportBundle, readBundle, budget } from './git-bridge-format.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  hash = (x) => digest(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function need(ok, msg, status = 409) {
  if (!ok) throw Object.assign(new Error(msg), { status });
}
function keys(value, names) {
  return (
    value &&
    Object.keys(value).length === names.length &&
    names.every((k) => Object.hasOwn(value, k))
  );
}
const profile = 'owner-native-git-sha1-v1',
  limit = 512 * 1024;
function canonicalBase64(s, max = limit) {
  need(
    typeof s === 'string' && s.length > 0 && s.length <= Math.ceil(max / 3) * 4,
    'Git compatibility bundle exceeds the selected profile',
    400
  );
  const b = Buffer.from(s, 'base64');
  need(b.length <= max && b.toString('base64') === s, 'Noncanonical Git compatibility bundle', 400);
  return b;
}
export function normalizeCompatibility(name, p) {
  if (name === 'compat.probe') {
    need(
      keys(p, ['taskId', 'generation']) &&
        typeof p.taskId === 'string' &&
        /^[a-f0-9-]{36}$/.test(p.taskId) &&
        Number.isSafeInteger(p.generation) &&
        p.generation > 0,
      'Select an exact active native task lease generation',
      400
    );
    return { taskId: p.taskId, generation: p.generation };
  }
  if (name === 'compat.open') {
    need(
      keys(p, ['repository', 'revisionId', 'expectedGeneration']) &&
        Number.isSafeInteger(p.expectedGeneration) &&
        p.expectedGeneration > 0,
      'Select a published native revision and generation',
      400
    );
    return {
      repository: validateNativeLabel(p.repository),
      revisionId: validateNativeId(p.revisionId),
      expectedGeneration: p.expectedGeneration
    };
  }
  need(
    name === 'compat.submit' &&
      keys(p, ['workspaceId', 'branch', 'expectedGitId', 'bundle']) &&
      typeof p.branch === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(p.branch) &&
      typeof p.expectedGitId === 'string' &&
      /^[a-f0-9]{40}$/.test(p.expectedGitId),
    'Select one local branch, exact Git commit and complete bundle',
    400
  );
  canonicalBase64(p.bundle);
  return {
    workspaceId: validateNativeId(p.workspaceId),
    branch: p.branch,
    expectedGitId: p.expectedGitId,
    bundle: p.bundle
  };
}
export const gitCompatibilityTables = [
  'compat_bundles',
  'compat_workspaces',
  'compat_submissions',
  'compat_probes'
];
export function installGitCompatibility(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS compat_probes(id TEXT PRIMARY KEY,operationId TEXT UNIQUE NOT NULL,taskId TEXT NOT NULL REFERENCES goal_tasks(taskId),record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS compat_bundles(digest TEXT PRIMARY KEY,bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS compat_workspaces(id TEXT PRIMARY KEY,operationId TEXT UNIQUE NOT NULL,base TEXT NOT NULL REFERENCES native_revisions(id),
      bundleDigest TEXT NOT NULL REFERENCES compat_bundles(digest),record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS compat_submissions(id TEXT PRIMARY KEY,operationId TEXT UNIQUE NOT NULL,workspaceId TEXT NOT NULL REFERENCES compat_workspaces(id),
      bundleDigest TEXT NOT NULL REFERENCES compat_bundles(digest),record TEXT NOT NULL);`);
}
function load(db, table, id) {
  const row = db.prepare('SELECT record FROM ' + table + ' WHERE id=?').get(id);
  need(row, 'Unknown Git compatibility record', 404);
  return JSON.parse(row.record);
}
function sourceEvent(db, p) {
  need(
    db
      .prepare(
        "SELECT 1 FROM native_ref_events WHERE repository=? AND name='mainline' AND generation=? AND revisionId=?"
      )
      .get(p.repository, p.expectedGeneration, p.revisionId),
    'Native compatibility source generation or confirmed mainline subject changed'
  );
}
function assertOwner(a, r) {
  need(
    a &&
      a.repository === r.repository &&
      (!r.epoch || (a.epoch === r.epoch && a.policyDigest === r.policyDigest)),
    'Git compatibility repository authority changed'
  );
}
function retained(db, id) {
  const row = db
    .prepare('SELECT bytes FROM compat_bundles WHERE digest=? AND length(bytes)<=?')
    .get(id, 12 * 1024 * 1024);
  need(row && digest(row.bytes) === id, 'Retained compatibility bundle is missing or damaged');
  return Buffer.from(row.bytes);
}
function materializable(tree) {
  for (const path of tree.keys())
    need(
      !path.split('/').some((s) => ['.gitattributes', '.gitmodules'].includes(s.toLowerCase())),
      'Checkout attributes or submodule configuration are outside the isolated profile'
    );
}
function workspace(input, operationId, authority, out) {
  const bundleDigest = digest(out.bytes),
    id = hash(['compat.open', operationId, input]);
  return {
    id,
    operationId,
    profile,
    repository: input.repository,
    epoch: authority.epoch,
    policyDigest: authority.policyDigest,
    base: input.revisionId,
    generation: input.expectedGeneration,
    gitBase: out.head,
    bundleDigest,
    bundleBytes: out.bytes.length,
    history: out.mapped.size,
    principal: 'local-owner'
  };
}
function branchInput(w, input, authority, raw) {
  const { commits, files } = readBundle(
      raw,
      input.expectedGitId,
      'refs/heads/' + input.branch,
      budget()
    ),
    tip = commits.get(input.expectedGitId),
    base = commits.get(w.gitBase);
  need(
    base && same(tip.parents, [w.gitBase]) && commits.size === w.history + 1,
    'Git submission must add exactly one direct commit to its mapped native base'
  );
  const changed = [...new Set([...tip.tree.keys(), ...base.tree.keys()])].filter(
    (path) => !same(tip.tree.get(path), base.tree.get(path))
  );
  need(changed.length === 1, 'Git input must replace one existing regular file');
  const path = changed[0],
    from = base.tree.get(path),
    to = tip.tree.get(path);
  need(
    (authority.allowedPaths.includes(path) || authority.ownerReviewPaths?.includes(path)) &&
      from?.mode === '100644' &&
      to?.mode === '100644' &&
      from.oid !== to.oid,
    'Git input exceeds the native single-file grant'
  );
  const bytes = files.get(to.oid),
    text = bytes.toString('utf8');
  need(
    bytes.length <= 4096 &&
      Buffer.from(text).equals(bytes) &&
      !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text),
    'Git change is outside the bounded UTF-8 profile'
  );
  const objective =
    'Apply the exact owner Git change to ' +
    path +
    '. The replacement file is this JSON string: ' +
    JSON.stringify(text);
  need(
    objective.length <= 2000 && Buffer.byteLength(objective) <= 4096,
    'Git proposal exceeds the bounded development objective'
  );
  return {
    path,
    oldFileId: nativeFileId(files.get(from.oid)),
    newFileId: nativeFileId(bytes),
    gitAuthor: tip.author,
    gitCommitter: tip.committer,
    gitMessage: tip.message,
    objective
  };
}
function proposal(w, input, op, body, bytes) {
  return {
    id: hash(['compat.submit', op, w.id, input.branch, input.expectedGitId, digest(bytes)]),
    operationId: op,
    profile,
    repository: w.repository,
    epoch: w.epoch,
    policyDigest: w.policyDigest,
    workspaceId: w.id,
    base: w.base,
    gitBase: w.gitBase,
    branch: input.branch,
    gitCommit: input.expectedGitId,
    bundleDigest: digest(bytes),
    principal: 'local-owner',
    ...body
  };
}
export class GitCompatibility {
  #tokens = new WeakMap();
  constructor(store, { authority, role }) {
    this.db = store.db;
    this.native = new NativeStore(store);
    this.authority = authority;
    this.role = role;
  }
  #worker(input, a) {
    const q = this.db
      .prepare(
        `SELECT w.*,n.stage,n.authorTaskId,n.reviewerTaskId,v.generation AS admitted,v.digest,t.status
      FROM agent_workspaces w JOIN native_goals n ON w.goalId=n.goalId JOIN workspace_admissions v ON v.taskId=w.taskId
      JOIN tasks t ON t.id=w.taskId WHERE w.taskId=?`
      )
      .get(input.taskId);
    need(
      this.role &&
        q &&
        q.generation === input.generation &&
        q.admitted === q.generation &&
        q.state === 'ready' &&
        q.stage === q.role &&
        q[q.role + 'TaskId'] === input.taskId &&
        ['queued', 'starting', 'running', 'waiting_for_input'].includes(q.status),
      'Native Git probe requires the current admitted role lease'
    );
    const scope = this.role(input.taskId, q.role),
      g = JSON.parse(q.grant);
    need(
      scope &&
        g.backend === 'native' &&
        scope.scopeVersion === g.scopeVersion &&
        scope.epoch === g.epoch &&
        scope.repository === g.projectId &&
        g.projectId === a?.repository &&
        a.epoch === g.epoch &&
        scope.path === g.path &&
        a.allowedPaths.includes(g.path) &&
        g.sourceDigest === q.digest,
      'Native role grant changed'
    );
    const file = this.native.file({
      repository: g.projectId,
      revisionId: g.sourceRevision,
      path: g.path
    });
    need(
      file.mode === '100644' && file.fileId === g.sourceOid && digest(file.bytes) === q.digest,
      'Granted native Git probe file changed'
    );
    return {
      repository: g.projectId,
      epoch: g.epoch,
      policyDigest: a.policyDigest,
      taskId: input.taskId,
      role: q.role,
      scopeVersion: g.scopeVersion,
      workspaceId: q.workspaceId,
      generation: q.generation,
      sourceRevision: g.sourceRevision,
      path: g.path,
      fileId: g.sourceOid,
      sourceDigest: g.sourceDigest
    };
  }
  #subject(name, input) {
    const a = this.authority();
    if (name === 'compat.probe') return this.#worker(input, a);
    if (name === 'compat.open') {
      assertOwner(a, input);
      sourceEvent(this.db, input);
      return a;
    }
    const w = load(this.db, 'compat_workspaces', input.workspaceId);
    assertOwner(a, w);
    const head = this.native.ref({ repository: w.repository, name: 'mainline' });
    need(
      head.revisionId === w.base && head.generation === w.generation,
      'Native target advanced beyond the mapped Git workspace'
    );
    return { w, a };
  }
  prepare(name, raw) {
    const input = normalizeCompatibility(name, raw),
      subject = this.#subject(name, input);
    let contents;
    if (name === 'compat.probe') {
      const { repository, sourceRevision, path } = subject,
        { bytes } = this.native.file({ repository, revisionId: sourceRevision, path });
      return runCompatibilityHarness({ sourceRevision, path, bytes }).then((proof) => {
        const token = Object.freeze({ name });
        this.#tokens.set(token, { input, subject, contents: { proof } });
        return token;
      });
    }
    if (name === 'compat.open') {
      const out = exportBundle(this.native, input.repository, input.revisionId, budget());
      const parsed = readBundle(out.bytes, out.head, 'refs/heads/export', budget(), true);
      materializable(parsed.commits.get(out.head).tree);
      contents = { out };
    } else {
      const bytes = canonicalBase64(input.bundle),
        body = branchInput(subject.w, input, subject.a, bytes);
      need(
        this.native.file({
          repository: subject.w.repository,
          revisionId: subject.w.base,
          path: body.path
        }).fileId === body.oldFileId,
        'Git mapped predecessor bytes differ from native source'
      );
      contents = { bytes, body };
    }
    const token = Object.freeze({ name });
    this.#tokens.set(token, { input, subject, contents });
    return token;
  }
  apply(token, op) {
    need(this.db.isTransaction, 'Compatibility admission requires an owner transaction');
    const staged = this.#tokens.get(token);
    need(staged, 'Expected verified compatibility input');
    const { input, contents } = staged,
      s = this.#subject(token.name, input);
    need(same(s, staged.subject), 'Native authorization changed during compatibility preparation');
    if (token.name === 'compat.probe') {
      const probe = {
        id: hash([token.name, op, input]),
        operationId: op,
        trigger: 'local-owner',
        ...s,
        proof: contents.proof
      };
      need(
        this.db.prepare('SELECT count(*) n FROM compat_probes').get().n < 128,
        'Git compatibility probe retention capacity reached'
      );
      this.db
        .prepare('INSERT INTO compat_probes VALUES(?,?,?,?)')
        .run(probe.id, op, input.taskId, JSON.stringify(probe));
      return { probe };
    }
    const opening = token.name === 'compat.open',
      item = opening
        ? workspace(input, op, s, contents.out)
        : proposal(s.w, input, op, contents.body, contents.bytes);
    const bytes = opening ? contents.out.bytes : contents.bytes,
      table = opening ? 'compat_workspaces' : 'compat_submissions';
    need(
      this.db.prepare('SELECT count(*) n FROM ' + table).get().n < 128,
      'Compatibility ledger capacity reached'
    );
    if (this.db.prepare('SELECT 1 FROM compat_bundles WHERE digest=?').get(item.bundleDigest))
      need(
        retained(this.db, item.bundleDigest).equals(bytes),
        'Compatibility artifact identity changed'
      );
    else {
      need(
        this.db.prepare('SELECT coalesce(sum(length(bytes)),0) n FROM compat_bundles').get().n +
          bytes.length <=
          32 * 1024 * 1024,
        'Compatibility bundle retention capacity reached'
      );
      this.db.prepare('INSERT INTO compat_bundles VALUES(?,?)').run(item.bundleDigest, bytes);
    }
    this.db
      .prepare('INSERT INTO ' + table + ' VALUES(?,?,?,?,?)')
      .run(
        item.id,
        op,
        opening ? item.base : item.workspaceId,
        item.bundleDigest,
        JSON.stringify(item)
      );
    return { [opening ? 'workspace' : 'submission']: item };
  }
  view({ id }) {
    validateNativeId(id);
    const w = this.db.prepare('SELECT record FROM compat_workspaces WHERE id=?').get(id);
    const proof = this.db.prepare('SELECT record FROM compat_probes WHERE id=?').get(id);
    const item = w
      ? JSON.parse(w.record)
      : proof
        ? JSON.parse(proof.record)
        : load(this.db, 'compat_submissions', id);
    assertOwner(this.authority(), item);
    return { [w ? 'workspace' : proof ? 'probe' : 'submission']: item };
  }
  bundle({ id }) {
    const { workspace } = this.view({ id });
    need(workspace, 'Select an owner compatibility workspace');
    return { workspace, base64: retained(this.db, workspace.bundleDigest).toString('base64') };
  }
}
export function compatibilityParent(parent, { workspaceRoot, dataDir }) {
  const root = realpathSync(resolve(parent)),
    st = lstatSync(root);
  need(
    st.isDirectory() && st.uid === process.getuid() && !(st.mode & 0o022),
    'Select an owner-controlled parent directory'
  );
  for (const protectedRoot of [workspaceRoot, dataDir]) {
    need(
      typeof protectedRoot === 'string',
      'A bound workspace and private data directory are required'
    );
    const rel = relative(realpathSync(protectedRoot), root);
    need(
      rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel),
      'Git output must be outside the bound workspace and service data'
    );
  }
  for (let here = root; ; here = dirname(here)) {
    const s = lstatSync(here);
    need(
      (s.uid === 0 || s.uid === process.getuid()) &&
        (!(s.mode & 0o022) || (s.uid === 0 && s.mode & 0o1000)),
      'Unsafe compatibility output ancestor'
    );
    try {
      lstatSync(join(here, '.git'));
      need(false, 'Select a parent outside existing Git checkouts');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (here === dirname(here)) break;
  }
  return root;
}
export function materializeCompatibility({ bundle, parent, workspaceRoot, dataDir }) {
  const root = compatibilityParent(parent, { workspaceRoot, dataDir });
  const { workspace: w, base64 } = bundle,
    bytes = canonicalBase64(base64, 12 * 1024 * 1024);
  need(
    w?.profile === profile &&
      w.principal === 'local-owner' &&
      digest(bytes) === w.bundleDigest &&
      bytes.length === w.bundleBytes,
    'Owner checkout bundle identity changed'
  );
  const { commits, files } = readBundle(bytes, w.gitBase, 'refs/heads/export', budget(), true);
  materializable(commits.get(w.gitBase).tree);
  const path = mkdtempSync(join(root, 'workspace-'));
  chmodSync(path, 0o700);
  const git = (...args) =>
    execFileSync(
      '/usr/bin/git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.attributesFile=/dev/null',
        '-c',
        'protocol.allow=never',
        ...args
      ],
      {
        cwd: path,
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_ATTR_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_REPLACE_OBJECTS: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 6000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024
      }
    );
  try {
    git('init', '--quiet', '--template=', '--initial-branch=work');
    const seed = join(path, '.git', 'source.bundle');
    writeFileSync(seed, bytes, { flag: 'wx', mode: 0o600 });
    git('bundle', 'unbundle', seed);
    unlinkSync(seed);
    git('update-ref', 'refs/heads/work', w.gitBase, '0'.repeat(40));
    git('read-tree', '--reset', '-u', w.gitBase);
    need(
      git('rev-parse', 'HEAD').toString().trim() === w.gitBase &&
        git('status', '--porcelain=v1').length === 0,
      'Git checkout differs from the mapped base'
    );
    const directories = new Set();
    for (const e of commits.get(w.gitBase).tree.values()) {
      const name = join(path, e.path),
        expected = files.get(e.oid);
      for (
        let directory = dirname(name);
        directory !== path && !directories.has(directory);
        directory = dirname(directory)
      ) {
        need(lstatSync(directory).isDirectory(), 'Unexpected checkout directory identity');
        directories.add(directory);
      }
      if (e.mode === '120000')
        need(
          lstatSync(name).isSymbolicLink() &&
            readlinkSync(name, { encoding: 'buffer' }).equals(expected),
          'Checked-out symlink target changed'
        );
      else {
        const fd = openSync(name, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
        try {
          const st = fstatSync(fd);
          need(
            st.isFile() &&
              st.nlink === 1 &&
              st.size === expected.length &&
              Boolean(st.mode & 0o111) === (e.mode === '100755') &&
              readFileSync(fd).equals(expected),
            'Checked-out file bytes or executable mode changed'
          );
        } finally {
          closeSync(fd);
        }
      }
    }
    return { workspaceId: w.id, path, gitBase: w.gitBase, nativeBase: w.base };
  } catch (error) {
    throw Object.assign(
      new Error('Git checkout incomplete. The fresh directory was preserved at ' + path),
      { cause: error, status: 409 }
    );
  }
}
export function validateCompatibilityAdmission(db, input, authority) {
  if (!input.compatId) return;
  const p = load(db, 'compat_submissions', input.compatId);
  assertOwner(authority, p);
  need(
    !input.revertId &&
      p.base === input.base &&
      p.path === input.path &&
      p.objective === input.objective,
    'Development admission differs from selected owner Git change'
  );
}
export function compatibilityOrigin(db, grant, bytes) {
  if (!grant.compatId) return null;
  const p = load(db, 'compat_submissions', grant.compatId);
  need(
    grant.base === p.base &&
      grant.path === p.path &&
      grant.objective === p.objective &&
      nativeFileId(bytes) === p.newFileId,
    'Native result differs from exact owner Git change'
  );
  return {
    kind: 'owner-git-submission',
    id: p.id,
    principal: p.principal,
    gitCommit: p.gitCommit,
    gitBase: p.gitBase,
    gitAuthor: p.gitAuthor,
    gitCommitter: p.gitCommitter
  };
}
export function verifyGitCompatibility(
  db,
  { authority = (digest) => new NativeAuthority({ db }).current(digest) } = {}
) {
  const native = new NativeStore({ db });
  let workspaces = 0,
    submissions = 0;
  for (const [name, table, key] of [
    ['compat.open', 'compat_workspaces', 'workspace'],
    ['compat.submit', 'compat_submissions', 'submission']
  ]) {
    for (const row of db.prepare('SELECT * FROM ' + table).iterate()) {
      const saved = JSON.parse(row.record),
        bytes = retained(db, row.bundleDigest),
        op = row.operationId;
      const a = authority(saved.policyDigest);
      assertOwner(a, saved);
      let item, input;
      if (name === 'compat.open') {
        input = {
          repository: saved.repository,
          revisionId: row.base,
          expectedGeneration: saved.generation
        };
        sourceEvent(db, input);
        const rebuilt = exportBundle(native, saved.repository, row.base, budget());
        const parsed = readBundle(bytes, rebuilt.head, 'refs/heads/export', budget(), true);
        materializable(parsed.commits.get(rebuilt.head).tree);
        need(
          parsed.commits.size === rebuilt.mapped.size &&
            [...rebuilt.mapped.values()].every((id) => parsed.commits.has(id)),
          'Git checkout history differs from its native source'
        );
        item = workspace(input, op, a, { ...rebuilt, bytes });
        workspaces++;
      } else {
        const w = load(db, 'compat_workspaces', row.workspaceId);
        input = {
          workspaceId: w.id,
          branch: saved.branch,
          expectedGitId: saved.gitCommit,
          bundle: bytes.toString('base64')
        };
        item = proposal(w, input, op, branchInput(w, input, a, bytes), bytes);
        need(
          native.file({ repository: w.repository, revisionId: w.base, path: item.path }).fileId ===
            item.oldFileId,
          'Historical Git input predecessor differs from native source'
        );
        submissions++;
      }
      const receipt = db
          .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
          .get(op),
        out = receipt && JSON.parse(receipt.receipt);
      need(
        row.id === item.id &&
          same(item, saved) &&
          item.bundleDigest === row.bundleDigest &&
          receipt?.digest === hash([name, input]) &&
          out.operationId === op &&
          same(out[key], saved),
        'Compatibility source, input bytes or owner admission receipt differs'
      );
    }
  }
  need(
    !db
      .prepare(
        `SELECT 1 FROM compat_bundles b WHERE NOT EXISTS(SELECT 1 FROM compat_workspaces w WHERE w.bundleDigest=b.digest)
    AND NOT EXISTS(SELECT 1 FROM compat_submissions s WHERE s.bundleDigest=b.digest) LIMIT 1`
      )
      .get(),
    'Unattributed compatibility bundle'
  );
  for (const row of db
    .prepare(
      "SELECT operationId,receipt FROM command_receipts WHERE json_extract(receipt,'$.workspace.profile')=? OR json_extract(receipt,'$.submission.profile')=?"
    )
    .iterate(profile, profile)) {
    const o = JSON.parse(row.receipt),
      w = o.workspace,
      table = w ? 'compat_workspaces' : 'compat_submissions';
    need(
      db
        .prepare('SELECT 1 FROM ' + table + ' WHERE operationId=? AND id=?')
        .get(row.operationId, (w ?? o.submission).id),
      'Owner compatibility receipt lost its record'
    );
  }
  for (const row of db
    .prepare(
      "SELECT s.record,g.admission FROM native_submissions s JOIN native_goals g ON g.goalId=json_extract(s.record,'$.goalId') WHERE json_type(g.admission,'$.compatId')='text' OR json_type(s.record,'$.origin')='object'"
    )
    .iterate()) {
    const r = JSON.parse(row.record),
      g = JSON.parse(row.admission),
      p = load(db, 'compat_submissions', g.compatId ?? '');
    const bytes = native.file({
      repository: r.repository,
      revisionId: r.commit,
      path: r.path
    }).bytes;
    need(
      r.oldFileId === p.oldFileId &&
        r.newFileId === p.newFileId &&
        same(r.origin, compatibilityOrigin(db, g, bytes)),
      'Native submitted revision lost its owner Git origin or changed bytes'
    );
  }
  for (const row of db
    .prepare("SELECT admission FROM native_goals WHERE json_type(admission,'$.compatId')='text'")
    .iterate()) {
    const g = JSON.parse(row.admission),
      p = load(db, 'compat_submissions', g.compatId);
    need(
      p.base === g.base && p.path === g.path && p.objective === g.objective && !g.revertId,
      'Goal admission differs from its owner Git source'
    );
  }
  let probes = 0;
  for (const row of db.prepare('SELECT * FROM compat_probes').iterate()) {
    const p = JSON.parse(row.record),
      input = { taskId: p.taskId, generation: p.generation },
      a = authority(p.policyDigest);
    assertOwner(a, p);
    const w = db
        .prepare('SELECT grant,role,workspaceId,generation FROM agent_workspaces WHERE taskId=?')
        .get(row.taskId),
      admission = db
        .prepare('SELECT generation,digest FROM workspace_admissions WHERE taskId=?')
        .get(row.taskId),
      grant = w && JSON.parse(w.grant);
    const proof = p.proof,
      q = native.file({ repository: p.repository, revisionId: p.sourceRevision, path: p.path });
    const built = Buffer.from(
      JSON.stringify({
        format: 'git-fixture-json-v1',
        commit: proof.gitId,
        path: p.path,
        value: p.path.endsWith('.json') ? JSON.parse(q.bytes) : q.bytes.toString('utf8')
      })
    );
    const receipt = db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(row.operationId);
    need(
      p.id === row.id &&
        p.id === hash(['compat.probe', row.operationId, input]) &&
        p.operationId === row.operationId &&
        p.trigger === 'local-owner' &&
        p.taskId === row.taskId &&
        p.workspaceId === w?.workspaceId &&
        w.role === p.role &&
        grant?.projectId === p.repository &&
        grant.epoch === p.epoch &&
        p.scopeVersion === grant.scopeVersion &&
        p.path === grant.path &&
        p.sourceRevision === grant.sourceRevision &&
        p.fileId === grant.sourceOid &&
        p.sourceDigest === grant.sourceDigest &&
        admission?.digest === p.sourceDigest &&
        admission.generation === p.generation &&
        proof.profile === harnessProfile &&
        proof.fileId === q.fileId &&
        p.fileId === q.fileId &&
        proof.sourceDigest === digest(q.bytes) &&
        proof.sourceRevision === p.sourceRevision &&
        proof.path === p.path &&
        proof.artifactDigest === digest(built) &&
        proof.artifactBase64 === built.toString('base64') &&
        receipt?.digest === hash(['compat.probe', input]) &&
        same(JSON.parse(receipt.receipt).probe, p),
      'Git worker proof lost its lease, source, observed artifact or owner receipt'
    );
    probes++;
  }
  for (const row of db
    .prepare(
      "SELECT operationId FROM command_receipts WHERE json_extract(receipt,'$.probe.proof.profile')=?"
    )
    .iterate(harnessProfile))
    need(
      db.prepare('SELECT 1 FROM compat_probes WHERE operationId=?').get(row.operationId),
      'Git harness receipt lost its evidence'
    );
  return { workspaces, submissions, probes };
}
