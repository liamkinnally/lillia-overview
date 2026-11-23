import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  writeFileSync
} from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { NativeStore, nativeFileId } from './native-store.mjs';
import { isDeepStrictEqual } from 'node:util';
import { verifyChangeDelegation } from './change-flow.mjs';
import { runIsolatedFile, fileWorkerProfile } from './workspace-sandbox.mjs';
import { readFinalOutput } from './task-context.mjs';

const nofollow = 0x20000000 | constants.O_NONBLOCK; // Darwin O_NOFOLLOW_ANY
const hash = (b) => createHash('sha256').update(b).digest('hex');
const blobId = (b) =>
  createHash('sha1')
    .update('blob ' + b.length + '\0')
    .update(b)
    .digest('hex');
function need(x, m, status = 409) {
  if (!x) throw Object.assign(new Error(m), { status });
}
function fileId(s) {
  return String(s.dev) + ':' + String(s.ino);
}
function privateDir(path) {
  const s = lstatSync(path, { bigint: true });
  need(
    s.isDirectory() &&
      s.uid === BigInt(process.getuid()) &&
      (s.mode & 0o077n) === 0n &&
      realpathSync(path) === path,
    'Unexpected private workspace directory'
  );
  return fileId(s);
}
function ordinary(b) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);
  } catch {}
  need(
    b.length <= 4096 &&
      text !== undefined &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text),
    'Workspace payload exceeds the ordinary UTF-8 text profile'
  );
  return text;
}
function singleName(dir, name) {
  const d = opendirSync(dir);
  try {
    need(
      d.readSync()?.name === name && d.readSync() === null,
      'Workspace inventory contains an extra or missing path'
    );
  } finally {
    d.closeSync();
  }
}
function verifyFiles(cwd, file, identity, options = {}) {
  const ids = [privateDir(cwd)],
    parts = file.split('/');
  let dir = cwd;
  for (const part of parts.slice(0, -1)) {
    singleName(dir, part);
    dir = join(dir, part);
    ids.push(privateDir(dir));
  }
  singleName(dir, parts.at(-1));
  const fd = openSync(join(cwd, file), nofollow | constants.O_RDONLY);
  try {
    const s = fstatSync(fd, { bigint: true });
    ids.push(fileId(s));
    need(
      s.isFile() &&
        s.uid === BigInt(process.getuid()) &&
        s.nlink === 1n &&
        (s.mode & 0o777n) === 0o600n &&
        s.size <= 4096n,
      'Invalid workspace payload identity, mode or size'
    );
    if (identity)
      need(
        JSON.stringify(identity) === JSON.stringify(ids),
        'Workspace directory or file changed identity'
      );
    const b = Buffer.alloc(Number(s.size) + 1);
    let count = 0;
    while (count < b.length) {
      const n = readSync(fd, b, count, b.length - count, count);
      if (!n) break;
      count += n;
    }
    const bytes = b.subarray(0, count);
    need(count === Number(s.size), 'Workspace file changed while reading');
    if (options.expected)
      need(hash(bytes) === options.expected, 'Workspace payload digest changed');
    return { ids, bytes };
  } finally {
    closeSync(fd);
  }
}
export function installAgentWorkspaces(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_workspaces(taskId TEXT PRIMARY KEY REFERENCES goal_tasks(taskId),workspaceId TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,goalId TEXT NOT NULL,grant TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,identity TEXT,
    capture TEXT,detail TEXT)`);
}
export class AgentWorkspaces {
  #tokens = new WeakMap();
  #validations = new WeakSet();
  constructor(store, { dataDir }) {
    this.store = store;
    this.db = store.db;
    this.dir = realpathSync(dataDir);
  }
  #row(id) {
    return this.db.prepare('SELECT * FROM agent_workspaces WHERE taskId=?').get(id);
  }
  #cwd(row) {
    need(/^[a-f0-9-]{36}$/.test(row.workspaceId), 'Invalid workspace identity');
    return join(this.dir, 'agent-workspaces', row.workspaceId);
  }
  view({ taskId }) {
    const r = this.#row(taskId);
    return r
      ? {
          taskId,
          workspaceId: r.workspaceId,
          goalId: r.goalId,
          role: r.role,
          generation: r.generation,
          state: r.state,
          ...JSON.parse(r.grant),
          capture: JSON.parse(r.capture),
          detail: r.detail
        }
      : null;
  }
  #nativeScope(task, goal, role, flow) {
    const scope = this.native.role(task.id, role);
    need(
      scope &&
        scope.taskId === task.id &&
        scope.goalId === goal.id &&
        scope.scopeVersion === goal.scopeVersion &&
        goal.state === 'active' &&
        flow.goalId === goal.id &&
        flow.epoch === scope.epoch &&
        flow.scopeVersion === scope.scopeVersion &&
        flow.stage === role &&
        flow[role + 'TaskId'] === task.id &&
        scope.repository === flow.repository &&
        ['base', 'path', 'objective'].every((k) => scope[k] === flow.admission[k]),
      'Native workspace role no longer owns this exact scope.'
    );
    const { path: file, base, repository, epoch } = scope;
    need(
      typeof file === 'string' &&
        file.length <= 240 &&
        file.split('/').every((p) => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(p)),
      'Unsupported native workspace path'
    );
    const revision = role === 'author' ? null : this.native.review.view(flow.revisionId).revision;
    if (role === 'reviewer')
      need(
        revision &&
          revision.id === flow.revisionId &&
          revision.goalId === goal.id &&
          revision.scopeVersion === scope.scopeVersion &&
          revision.epoch === epoch &&
          revision.repository === repository &&
          revision.base === base &&
          revision.path === file,
        'Native reviewer workspace subject differs from the verified admission.'
      );
    const sourceRevision = revision?.commit ?? base,
      entry = new NativeStore(this.store).file({
        repository,
        revisionId: sourceRevision,
        path: file
      });
    ordinary(entry.bytes);
    need(
      entry.mode === '100644' && (!revision || revision.newFileId === entry.fileId),
      'Native workspace requires the retained reviewed regular file.'
    );
    const owner = realpathSync(
      this.db.prepare("SELECT value FROM settings WHERE key='platform.workspace'").get().value
    );
    const workspace = join(this.dir, 'agent-workspaces');
    const separate = (a, b) => {
      const rel = relative(a, b);
      return !isAbsolute(rel) && (rel === '..' || rel.startsWith('../'));
    };
    need(
      separate(owner, workspace) && separate(workspace, owner),
      'Native workspace must be separate from the owner working tree.'
    );
    const grant = {
      profile: 'native-private-projection-v1',
      backend: 'native',
      projectId: repository,
      epoch,
      base,
      sourceRevision,
      path: file,
      sourceOid: entry.fileId,
      sourceDigest: hash(entry.bytes),
      scopeVersion: scope.scopeVersion,
      scopeDigest: hash(
        JSON.stringify([
          repository,
          epoch,
          base,
          file,
          goal.id,
          scope.scopeVersion,
          scope.objective
        ])
      ),
      promptDigest: hash(task.prompt),
      ...(revision ? { reviewRevisionId: revision.id } : {})
    };
    return { task, grant, bytes: Buffer.from(entry.bytes) };
  }
  #authorize(taskId, role) {
    need(['author', 'reviewer'].includes(role), 'Unsupported workspace role');
    const { task } = this.store.taskView(taskId),
      goal = this.store.goal(task.goalId);
    const nativeFlow = this.native?.view(goal.id);
    if (nativeFlow) return this.#nativeScope(task, goal, role, nativeFlow);
    need(
      goal.state === 'active' && verifyChangeDelegation(this.store, task, role),
      'Workspace requires an active scoped owner delegation'
    );
    const flow = this.db.prepare('SELECT * FROM change_flows WHERE goalId=?').get(task.goalId);
    need(
      flow.stage === role && taskId === flow[role + 'TaskId'],
      'Workspace role no longer owns this phase'
    );
    const admission = JSON.parse(flow.admission),
      prompt = JSON.parse(task.prompt),
      file = admission.path;
    need(
      file.length <= 240 && file.split('/').every((s) => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(s)),
      'Unsupported workspace path'
    );
    let revision = admission.base;
    if (role === 'reviewer') {
      const row = this.db
        .prepare('SELECT record FROM review_versions WHERE id=?')
        .get(flow.revisionId);
      const r = row && JSON.parse(row.record);
      need(
        r &&
          prompt.revisionId === r.id &&
          prompt.packet.commit === r.commit &&
          r.base === admission.base &&
          r.edits.length === 1 &&
          r.edits[0].path === file &&
          !r.edits[0].delete,
        'Reviewer workspace subject changed'
      );
      revision = r.commit;
    }
    const entry = this.db
      .prepare(
        'SELECT p.mode,p.oid,b.bytes,g.project FROM git_paths p JOIN git_blobs b ON b.oid=p.oid JOIN git_revisions g ON g.revision=p.revision WHERE p.revision=? AND p.path=? AND length(b.bytes)<=4096'
      )
      .get(revision, file);
    need(
      entry?.mode === '100644' && blobId(entry.bytes) === entry.oid,
      'Workspace requires an authenticated retained regular file of at most 4 KiB'
    );
    ordinary(entry.bytes);
    const grant = {
      profile: 'private-projection-v1',
      projectId: entry.project,
      base: admission.base,
      sourceRevision: revision,
      path: file,
      sourceOid: entry.oid,
      sourceDigest: hash(entry.bytes),
      scopeVersion: goal.scopeVersion,
      scopeDigest: flow.scopeDigest,
      promptDigest: hash(task.prompt)
    };
    return { task, grant, bytes: Buffer.from(entry.bytes) };
  }
  lease(taskId, role) {
    need(
      process.platform === 'darwin' && !this.db.isTransaction,
      'Workspace provisioning requires the macOS service outside a transaction'
    );
    privateDir(this.dir);
    const { task, grant, bytes } = this.#authorize(taskId, role);
    need(task.status === 'queued', 'Workspace allocation requires an undispatched queued task');
    const existing = this.#row(taskId);
    if (existing) {
      need(
        existing.role === role &&
          existing.state === 'ready' &&
          existing.grant === JSON.stringify(grant),
        'A previous workspace lease requires reconciliation'
      );
      try {
        this.#validate(existing, grant.sourceDigest);
      } catch (error) {
        this.quarantine(taskId, 'Existing workspace changed before dispatch.');
        throw error;
      }
      return { ...this.view({ taskId }), cwd: this.#cwd(existing) };
    }
    const workspaceId = randomUUID(),
      encoded = JSON.stringify(grant);
    this.db
      .prepare("INSERT INTO agent_workspaces VALUES(?,?,?,?,?,1,'allocating',NULL,NULL,NULL)")
      .run(taskId, workspaceId, role, task.goalId, encoded);
    try {
      const home = join(this.dir, 'agent-workspaces');
      try {
        mkdirSync(home, { mode: 0o700 });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      privateDir(home);
      const cwd = this.#cwd({ workspaceId });
      mkdirSync(cwd, { mode: 0o700 });
      privateDir(cwd);
      let parent = cwd;
      for (const part of grant.path.split('/').slice(0, -1)) {
        parent = join(parent, part);
        mkdirSync(parent, { mode: 0o700 });
        privateDir(parent);
      }
      writeFileSync(join(cwd, grant.path), bytes, { flag: 'wx', mode: 0o600 });
      const { ids } = verifyFiles(cwd, grant.path, null, { expected: grant.sourceDigest });
      this.db
        .prepare(
          "UPDATE agent_workspaces SET identity=?,state='ready' WHERE taskId=? AND state='allocating'"
        )
        .run(JSON.stringify(ids), taskId);
      return { ...this.view({ taskId }), cwd };
    } catch (error) {
      this.quarantine(taskId, 'Provisioning did not complete; preserve the directory.');
      throw error;
    }
  }
  #validate(r, expected) {
    try {
      privateDir(this.dir);
      privateDir(join(this.dir, 'agent-workspaces'));
      return verifyFiles(this.#cwd(r), JSON.parse(r.grant).path, JSON.parse(r.identity), {
        expected
      });
    } catch (error) {
      if (error.status) throw error;
      if (error.code)
        throw Object.assign(
          new Error(
            'Workspace inventory changed or cannot be safely accessed (' + error.code + ').'
          ),
          { status: 409 }
        );
      throw error;
    }
  }
  #isolated(r, expectedDigest, op) {
    return runIsolatedFile(
      {
        dataDir: this.dir,
        workspaceId: r.workspaceId,
        path: JSON.parse(r.grant).path,
        identity: JSON.parse(r.identity),
        expectedDigest
      },
      op
    );
  }
  async validateLease({ taskId, generation }) {
    const r = this.#row(taskId);
    need(
      !this.db.isTransaction &&
        r?.generation === generation &&
        ['ready', 'capture_pending'].includes(r.state),
      'Workspace validation requires a current lease generation'
    );
    const { grant } = this.#authorize(taskId, r.role);
    need(r.grant === JSON.stringify(grant), 'Workspace validation grant changed');
    const expected = r.state === 'ready' ? grant.sourceDigest : JSON.parse(r.capture).digest;
    this.#validate(r, expected);
    const result = await this.#isolated(r, expected, { kind: 'validate' });
    const live = this.#row(taskId);
    need(
      live?.generation === generation && live.state === r.state,
      'Workspace changed during isolated validation'
    );
    const proof = Object.freeze({
      taskId,
      generation,
      role: r.role,
      path: grant.path,
      workspaceId: r.workspaceId,
      profile: result.profile,
      digest: result.digest
    });
    this.#validations.add(proof);
    return proof;
  }
  quarantine(taskId, reason) {
    this.db
      .prepare(
        "UPDATE agent_workspaces SET state='uncertain',generation=generation+1,detail=? WHERE taskId=? AND state NOT IN ('uncertain','sealed','reviewed','released')"
      )
      .run(String(reason).slice(0, 300), taskId);
    return this.view({ taskId });
  }
  releaseAbandoned() {
    const hasNative = this.db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='native_goals'")
      .get();
    const fields = 'goalId,scopeVersion,stage,authorTaskId,reviewerTaskId';
    const flows =
      'SELECT ' +
      fields +
      ' FROM change_flows' +
      (hasNative ? ' UNION ALL SELECT ' + fields + ' FROM native_goals' : '');
    const rows = this.db
      .prepare(
        `SELECT w.taskId,t.status,t.recoveryCleared FROM agent_workspaces w
      JOIN (${flows}) f ON f.goalId=w.goalId JOIN goals g ON g.id=f.goalId JOIN tasks t ON t.id=w.taskId
      WHERE w.state='ready' AND (t.status IN ('failed','interrupted','cancelled') OR g.state IN ('cancelled','completed') OR f.stage!=w.role
        OR w.taskId!=CASE w.role WHEN 'author' THEN f.authorTaskId ELSE f.reviewerTaskId END
        OR f.scopeVersion!=(SELECT max(r.version) FROM goal_revisions r WHERE r.id=g.id AND r.changeKind IN ('created','goal.amend')))`
      )
      .all();
    let changed = 0;
    for (const row of rows) {
      const { taskId, status } = row;
      if (status === 'recovery_needed' && !row.recoveryCleared) {
        this.quarantine(taskId, 'The abandoned role has an uncertain provider outcome.');
        changed++;
        continue;
      }
      const attempts = this.db.prepare('SELECT status FROM attempts WHERE taskId=?').all(taskId);
      const terminal = ['completed', 'failed', 'interrupted', 'cancelled'];
      if (
        !(['queued', 'blocked'].includes(status) && !attempts.length) &&
        !(terminal.includes(status) && attempts.every((a) => terminal.includes(a.status)))
      )
        continue;
      if (
        this.db
          .prepare(
            "SELECT 1 FROM task_controls WHERE taskId=? AND state IN ('pending','requested','sent','unconfirmed')"
          )
          .get(taskId)
      )
        continue;
      const lease = this.#row(taskId);
      try {
        this.#validate(lease, JSON.parse(lease.grant).sourceDigest);
      } catch {
        this.quarantine(
          taskId,
          'Abandoned workspace differs from the admitted source. Directory preserved.'
        );
        changed++;
        continue;
      }
      changed += this.db
        .prepare(
          "UPDATE agent_workspaces SET state='released',generation=generation+1,detail='Role ended. Directory preserved.' WHERE taskId=? AND generation=? AND state='ready'"
        )
        .run(taskId, lease.generation).changes;
    }
    return changed;
  }
  recover() {
    need(!this.db.isTransaction, 'Workspace recovery requires its own writer boundary');
    this.releaseAbandoned();
    const rows = this.db
      .prepare(
        "SELECT taskId,state,generation FROM agent_workspaces WHERE state NOT IN ('sealed','reviewed','uncertain','released')"
      )
      .all();
    let uncertain = 0;
    for (const row of rows) {
      const lease = this.#row(row.taskId),
        task = this.store.taskView(row.taskId).task;
      try {
        need(
          ['ready', 'capture_pending'].includes(row.state),
          'Service stopped during a workspace effect'
        );
        need(
          ['queued', 'completed'].includes(task.status),
          'A prior workspace writer is not confirmed quiescent'
        );
        const expected =
          row.state === 'ready'
            ? JSON.parse(lease.grant).sourceDigest
            : JSON.parse(lease.capture).digest;
        this.#validate(lease, expected);
      } catch {
        this.quarantine(
          row.taskId,
          'Prior workspace state needs reconciliation. Directory preserved.'
        );
        uncertain++;
      }
    }
    return { uncertain };
  }
  sealReviewer({ taskId, generation, reviewId, leaseProof }) {
    need(this.db.isTransaction, 'A reviewer workspace closes in the review decision transaction');
    const r = this.#row(taskId);
    need(
      r?.role === 'reviewer' && r.state === 'ready' && r.generation === generation,
      'Reviewer workspace generation changed'
    );
    const { grant } = this.#authorize(taskId, 'reviewer');
    need(r.grant === JSON.stringify(grant), 'Reviewer grant changed');
    need(
      this.#validations.has(leaseProof) &&
        leaseProof.taskId === taskId &&
        leaseProof.generation === generation &&
        leaseProof.workspaceId === r.workspaceId &&
        leaseProof.digest === grant.sourceDigest,
      'Reviewer requires a current isolated workspace validation'
    );
    if (grant.backend === 'native') {
      const view = this.native.review.view(grant.reviewRevisionId),
        review = view.reviews.find((d) => d.id === reviewId);
      const output = readFinalOutput(this.store, taskId);
      this.#nativeContext(r, grant, output.attemptId);
      const context = this.db
        .prepare(
          'SELECT digest FROM task_contexts WHERE taskId=? AND ordinal=(SELECT ordinal FROM attempts WHERE id=?)'
        )
        .get(taskId, output.attemptId);
      need(
        view.revision.commit === grant.sourceRevision &&
          review?.revisionId === grant.reviewRevisionId &&
          review.evidence?.taskId === taskId &&
          review.evidence?.attemptId === output.attemptId &&
          review.evidence?.digest === output.digest &&
          context?.digest === review.evidence?.contextDigest,
        'Native reviewer workspace lacks its exact retained decision and attempt.'
      );
    } else {
      const row = this.db.prepare('SELECT record FROM review_decisions WHERE id=?').get(reviewId);
      const review = row && JSON.parse(row.record);
      const output = readFinalOutput(this.store, taskId);
      need(
        review?.reviewerKind === 'native-agent' &&
          review.reviewerTaskId === taskId &&
          review.evidence?.attemptId === output.attemptId &&
          review.evidence?.digest === output.digest &&
          review.commit === grant.sourceRevision,
        'Reviewer workspace requires its exact retained native decision'
      );
    }
    this.#validate(r, grant.sourceDigest);
    this.db
      .prepare(
        "UPDATE agent_workspaces SET state='reviewed',generation=generation+1 WHERE taskId=? AND generation=?"
      )
      .run(taskId, generation);
    return this.view({ taskId });
  }
  #nativeContext(r, grant, attemptId) {
    const ctx = this.db
      .prepare(
        'SELECT c.manifest,c.digest FROM task_contexts c JOIN attempts a ON a.taskId=c.taskId AND a.ordinal=c.ordinal WHERE a.id=? AND a.taskId=?'
      )
      .get(attemptId, r.taskId);
    const a = this.db
      .prepare('SELECT generation,profile,digest FROM workspace_admissions WHERE taskId=?')
      .get(r.taskId);
    const manifest = ctx && JSON.parse(ctx.manifest);
    need(
      ctx &&
        hash(ctx.manifest) === ctx.digest &&
        a?.digest === grant.sourceDigest &&
        a.profile === fileWorkerProfile &&
        a.generation >= 1 &&
        a.generation <= r.generation &&
        manifest.sourceRevision === grant.sourceRevision &&
        manifest.sourcePath === grant.path &&
        isDeepStrictEqual(manifest.workspace, {
          id: r.workspaceId,
          generation: a.generation,
          role: r.role,
          profile: a.profile,
          sourceDigest: a.digest
        }),
      'Native role output lacks the exact workspace admission and immutable source pins.'
    );
  }
  #answer(r) {
    const { task, grant } = this.#authorize(r.taskId, 'author');
    need(
      r.role === 'author' && r.grant === JSON.stringify(grant),
      'Workspace edit authority changed'
    );
    const output = readFinalOutput(this.store, r.taskId);
    if (grant.backend === 'native') this.#nativeContext(r, grant, output.attemptId);
    const ctx = this.db
      .prepare(
        'SELECT c.digest,c.manifest FROM task_contexts c JOIN attempts a ON a.taskId=c.taskId AND a.ordinal=c.ordinal WHERE a.id=?'
      )
      .get(output.attemptId);
    need(ctx && hash(ctx.manifest) === ctx.digest, 'Unverified native workspace context');
    const m = JSON.parse(ctx.manifest);
    need(
      m.promptDigest === grant.promptDigest &&
        m.input === task.prompt &&
        [m.dependencies, m.mailbox ?? [], m.coordinationRoutes ?? []].every(
          (list) => Array.isArray(list) && !list.length
        ),
      'Native workspace prompt was widened'
    );
    let result;
    try {
      result = JSON.parse(output.text);
    } catch {}
    const e = result?.edits?.[0];
    need(
      result &&
        Object.keys(result).sort().join(',') === 'base,edits' &&
        result.base === grant.base &&
        Array.isArray(result.edits) &&
        result.edits.length === 1 &&
        e &&
        Object.keys(e).sort().join(',') === 'path,text' &&
        e.path === grant.path &&
        typeof e.text === 'string',
      'Native workspace delta differs from its delegated base or path'
    );
    const bytes = Buffer.from(e.text);
    need(ordinary(bytes) === e.text, 'Workspace text does not round-trip');
    return {
      bytes,
      record: {
        version: 1,
        fileWorkerProfile,
        taskId: r.taskId,
        workspaceId: r.workspaceId,
        base: grant.base,
        path: grant.path,
        sourceOid: grant.sourceOid,
        attemptId: output.attemptId,
        outputDigest: output.digest,
        contextDigest: ctx.digest,
        oid: grant.backend === 'native' ? nativeFileId(bytes) : blobId(bytes),
        digest: hash(bytes),
        bytes: bytes.length
      }
    };
  }
  async prepareCapture({ taskId, generation }) {
    need(!this.db.isTransaction, 'Prepare workspace capture before the writer transaction');
    const r = this.#row(taskId);
    need(
      r?.role === 'author' && r.generation === generation,
      'Author workspace lease or generation changed'
    );
    need(
      ['ready', 'capture_pending'].includes(r.state),
      'Workspace ownership is uncertain or closed'
    );
    const { bytes, record } = this.#answer(r);
    if (r.state === 'ready') {
      this.db
        .prepare(
          "UPDATE agent_workspaces SET state='projecting',generation=generation+1 WHERE taskId=? AND generation=?"
        )
        .run(taskId, generation);
      try {
        const oldDigest = JSON.parse(r.grant).sourceDigest;
        this.#validate(r, oldDigest);
        await this.#isolated(r, oldDigest, { kind: 'write', bytes });
        this.#validate(r, record.digest);
        const adopted = this.db
          .prepare(
            "UPDATE agent_workspaces SET state='capture_pending',capture=? WHERE taskId=? AND state='projecting' AND generation=?"
          )
          .run(JSON.stringify(record), taskId, generation + 1);
        need(adopted.changes === 1, 'Workspace generation changed during isolation');
      } catch (error) {
        this.quarantine(taskId, 'Projection failed validation; preserve the directory.');
        throw error;
      }
    } else {
      need(r.capture === JSON.stringify(record), 'Prepared native workspace result changed');
      try {
        this.#validate(r, record.digest);
      } catch (error) {
        this.quarantine(taskId, 'Pending capture changed.');
        throw error;
      }
    }
    const nextGeneration = r.state === 'ready' ? generation + 1 : generation;
    let observed;
    try {
      observed = await this.#isolated(r, record.digest, { kind: 'read' });
    } catch (error) {
      this.quarantine(taskId, 'Isolated verification did not finish. Directory preserved.');
      throw error;
    }
    const current = this.#row(taskId);
    need(
      current?.generation === nextGeneration &&
        current.state === 'capture_pending' &&
        observed.bytes.equals(bytes),
      'Workspace generation or content changed during isolated capture'
    );
    const token = Object.freeze({ taskId, generation: nextGeneration });
    this.#tokens.set(token, record);
    return token;
  }
  sealNativeCapture(token, { revision }) {
    const capture = this.#tokens.get(token),
      lease = capture && this.#row(token.taskId),
      grant = lease && JSON.parse(lease.grant);
    need(
      this.db.isTransaction && grant?.backend === 'native' && typeof revision?.id === 'string',
      'Native workspace sealing requires a current persisted revision.'
    );
    const saved = this.native.review.view(revision.id).revision;
    need(
      saved &&
        isDeepStrictEqual(saved, revision) &&
        saved.epoch === grant.epoch &&
        saved.goalId === lease.goalId &&
        saved.scopeVersion === grant.scopeVersion &&
        saved.repository === grant.projectId &&
        saved.base === grant.base &&
        saved.path === grant.path &&
        saved.oldFileId === grant.sourceOid &&
        saved.newFileId === capture.oid &&
        saved.author?.taskId === lease.taskId &&
        saved.author?.attemptId === capture.attemptId &&
        saved.author?.digest === capture.outputDigest &&
        saved.author?.contextDigest === capture.contextDigest,
      'Native submitted revision differs from the authenticated workspace output.'
    );
    const file = new NativeStore(this.store).file({
      repository: grant.projectId,
      revisionId: saved.commit,
      path: saved.path
    });
    need(
      file.mode === '100644' && file.fileId === capture.oid && hash(file.bytes) === capture.digest,
      'Native immutable revision bytes differ from the workspace capture.'
    );
    return this.#accept(token);
  }
  acceptCapture(token) {
    const r = token && this.#row(token.taskId);
    need(
      r && JSON.parse(r.grant).backend !== 'native',
      'Native workspace must seal against its submitted immutable revision.'
    );
    return this.#accept(token);
  }
  #accept(token) {
    const record = this.#tokens.get(token),
      r = record && this.#row(token.taskId);
    need(
      this.db.isTransaction &&
        r?.state === 'capture_pending' &&
        r.generation === token.generation &&
        r.capture === JSON.stringify(record),
      'Workspace capture requires a current prepared generation in the writer transaction'
    );
    const actual = this.#answer(r);
    need(
      JSON.stringify(actual.record) === r.capture,
      'Authenticated native workspace output changed'
    );
    const { bytes } = this.#validate(r, record.digest);
    need(bytes.equals(actual.bytes), 'Workspace bytes changed after native authentication');
    this.db
      .prepare(
        "UPDATE agent_workspaces SET state='sealed',generation=generation+1 WHERE taskId=? AND generation=?"
      )
      .run(r.taskId, r.generation);
    return {
      taskId: r.taskId,
      base: record.base,
      edits: [{ path: record.path, text: ordinary(bytes) }],
      capture: record
    };
  }
}
