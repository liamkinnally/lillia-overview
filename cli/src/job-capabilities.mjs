import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { NativeSearch, normalizeSearch } from './native-search.mjs';
import { GitProject } from './git-project.mjs';

import {
  hasNativeJobs,
  nativeRole,
  nativeJobSubject,
  bindNativeJob
} from './native-job-capabilities.mjs';
export { installNativeJobCapabilities } from './native-job-capabilities.mjs';

const deny = () => {
  throw Object.assign(Error('Job capability is unavailable for this request.'), { status: 403 });
};
const requireInput = (condition) => {
  if (!condition) throw Object.assign(Error('Invalid job capability input.'), { status: 400 });
};
const conflict = () => {
  throw Object.assign(Error('Job observation conflicts with its operation ID or allowance.'), {
    status: 409
  });
};
const hash = (s) => createHash('sha256').update(s).digest('hex');
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const version = (value) => Number.isSafeInteger(value) && value > 0;
const legacyActions = ['file.read', 'observation.append'];
const allowedActions = (backend) =>
  backend === 'native' ? [...legacyActions, 'file.search'] : legacyActions;
const nativeKeys = ['backend', 'repository', 'epoch', 'provider'];
const scopeKeys = ['taskId', 'expectedSpecVersion', 'expectedScopeVersion', 'revision', 'path'];
const exact = (input, fields) =>
  input &&
  typeof input === 'object' &&
  !Array.isArray(input) &&
  Object.keys(input).every((k) => fields.includes(k));
function validScope(i) {
  return (
    id(i.taskId) &&
    version(i.expectedSpecVersion) &&
    version(i.expectedScopeVersion) &&
    typeof i.revision === 'string' &&
    (i.backend === 'native'
      ? /^[0-9a-f]{64}$/.test(i.revision) &&
        id(i.repository) &&
        /^[a-f0-9-]{36}$/.test(i.epoch) &&
        ['codex', 'claude'].includes(i.provider)
      : /^[0-9a-f]{40}$/.test(i.revision)) &&
    typeof i.path === 'string' &&
    Buffer.byteLength(i.path) <= 4096 &&
    !/[\u0000-\u001f\u007f]/.test(i.path) &&
    i.path.split('/').every((p) => p && p !== '.' && p !== '..')
  );
}

export function normalizeJobGrant(i) {
  const actions = allowedActions(i?.backend);
  requireInput(
    exact(i, [
      ...scopeKeys,
      ...(i?.backend === 'native' ? nativeKeys : []),
      'actions',
      'ttlSeconds',
      'credentialDigest'
    ]) &&
      validScope(i) &&
      Array.isArray(i.actions) &&
      i.actions.length > 0 &&
      i.actions.length <= actions.length &&
      i.actions.every((a) => actions.includes(a)) &&
      new Set(i.actions).size === i.actions.length &&
      Number.isSafeInteger(i.ttlSeconds) &&
      i.ttlSeconds >= 1 &&
      i.ttlSeconds <= 3600 &&
      typeof i.credentialDigest === 'string' &&
      /^[0-9a-f]{64}$/.test(i.credentialDigest)
  );
  return {
    ...(i.backend === 'native'
      ? { backend: 'native', repository: i.repository, epoch: i.epoch, provider: i.provider }
      : {}),
    taskId: i.taskId,
    expectedSpecVersion: i.expectedSpecVersion,
    expectedScopeVersion: i.expectedScopeVersion,
    revision: i.revision,
    path: i.path,
    actions: [...i.actions].sort(),
    ttlSeconds: i.ttlSeconds,
    credentialDigest: i.credentialDigest
  };
}

export function installJobCapabilities(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS job_capabilities(
    id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES goal_tasks(taskId),goalId TEXT NOT NULL REFERENCES goals(id),specVersion INTEGER NOT NULL,
    scopeVersion INTEGER NOT NULL,projectId TEXT NOT NULL,revision TEXT NOT NULL REFERENCES git_revisions(revision),path TEXT NOT NULL,
    oid TEXT NOT NULL REFERENCES git_blobs(oid),actions TEXT NOT NULL,grantedAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,revokedAt INTEGER);
    CREATE TABLE IF NOT EXISTS job_observations(
    id TEXT PRIMARY KEY,capabilityId TEXT NOT NULL REFERENCES job_capabilities(id),operationId TEXT NOT NULL,text TEXT NOT NULL,
    createdAt INTEGER NOT NULL,UNIQUE(capabilityId,operationId));`);
}

function publicGrant(db, grantId) {
  let row = db.prepare('SELECT * FROM job_capabilities WHERE id=?').get(grantId);
  if (!row && hasNativeJobs(db)) {
    const native = db.prepare('SELECT * FROM native_job_capabilities WHERE id=?').get(grantId);
    if (native) row = { backend: 'native', ...native };
  }
  return row ? { ...row, actions: JSON.parse(row.actions) } : null;
}
function pin(db, revision, path) {
  return db
    .prepare(
      `SELECT r.project,p.mode,p.oid FROM git_paths p JOIN git_revisions r ON r.revision=p.revision
    WHERE p.revision=? AND p.path=? AND EXISTS(SELECT 1 FROM git_captures c WHERE c.revision=r.revision)`
    )
    .get(revision, path);
}
const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);
export function validateJobPacket(i, { withSecret = true } = {}) {
  const common = [
    'version',
    'id',
    'workspaceRoot',
    'action',
    ...scopeKeys,
    ...(i?.backend === 'native' ? nativeKeys : []),
    ...(withSecret ? ['secret'] : [])
  ];
  const actions = allowedActions(i?.backend),
    reading = i?.action === 'file.read',
    searching = i?.action === 'file.search';
  requireInput(
    exact(i, [
      ...common,
      ...(reading
        ? ['offset', 'limit']
        : searching
          ? ['query', 'mode', 'language']
          : ['operationId', 'text'])
    ]) &&
      i.version === 1 &&
      id(i.id) &&
      validScope(i) &&
      typeof i.workspaceRoot === 'string' &&
      i.workspaceRoot.startsWith('/') &&
      Buffer.byteLength(i.workspaceRoot) <= 4096 &&
      actions.includes(i.action) &&
      (!withSecret || (typeof i.secret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(i.secret))) &&
      (reading
        ? (i.offset === undefined || (Number.isSafeInteger(i.offset) && i.offset >= 0)) &&
          (i.limit === undefined ||
            (Number.isSafeInteger(i.limit) && i.limit >= 1 && i.limit <= 16384))
        : searching
          ? !!normalizeSearch(i)
          : id(i.operationId) &&
            typeof i.text === 'string' &&
            i.text.trim() &&
            Buffer.byteLength(i.text) <= 1024 &&
            !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(i.text))
  );
}

export class JobCapabilities {
  constructor(store, { workspaceRoot, clock = Date.now, beforeCommit }) {
    this.store = store;
    this.db = store.db;
    this.root = workspaceRoot;
    this.clock = clock;
    this.beforeCommit = beforeCommit;
    this.project = new GitProject(store, { workspaceRoot });
    this.search = new NativeSearch();
  }
  now(revoking = false) {
    const observed = this.clock();
    if (!Number.isSafeInteger(observed) || observed < 0) deny();
    this.db
      .prepare(
        "INSERT INTO settings VALUES('job.clock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(settings.value AS INTEGER)<CAST(excluded.value AS INTEGER)"
      )
      .run(String(observed));
    const highWater = Number(
      this.db.prepare("SELECT value FROM settings WHERE key='job.clock'").get().value
    );
    if (observed < highWater && !revoking) deny();
    return highWater;
  }
  current(taskId) {
    return this.db
      .prepare(
        `SELECT gt.specVersion,gt.goalVersion,g.id AS goalId FROM goal_tasks gt JOIN goals g ON g.id=gt.goalId JOIN tasks t ON t.id=gt.taskId
      WHERE gt.taskId=? AND g.state='active' AND t.status IN ('queued','starting','running','waiting_for_input')`
      )
      .get(taskId);
  }
  applyScope(i) {
    const task = this.current(i.taskId);
    if (
      !task ||
      task.specVersion !== i.expectedSpecVersion ||
      this.store.goal(task.goalId).scopeVersion !== i.expectedScopeVersion ||
      task.goalVersion < i.expectedScopeVersion ||
      this.db.prepare("SELECT value FROM settings WHERE key='platform.workspace'").get()?.value !==
        this.root
    )
      deny();
    return task;
  }
  grant(input) {
    if (!this.db.isTransaction) deny();
    const i = normalizeJobGrant(input),
      task = this.applyScope(i);
    const native = i.backend === 'native' ? nativeJobSubject(this.store, i) : null;
    const file = native?.file ?? pin(this.db, i.revision, i.path);
    if (
      !file ||
      !['100644', '100755'].includes(file.mode) ||
      (!native && nativeRole(this.db, i.taskId))
    )
      deny();
    // One credential per grant. A revoked verifier remains until archival.
    if (
      this.db
        .prepare("SELECT 1 FROM settings WHERE key GLOB 'job.auth.*' AND value=?")
        .get(i.credentialDigest)
    )
      deny();
    const grantId = randomUUID(),
      now = this.now();
    if (native) {
      const attemptOrdinal = this.db
        .prepare(
          `SELECT coalesce((SELECT max(ordinal) FROM attempts WHERE taskId=t.id),0)+(t.status='queued') AS ordinal
        FROM tasks t WHERE t.id=?`
        )
        .get(i.taskId).ordinal;
      if (!version(attemptOrdinal)) deny();
      this.db
        .prepare(
          'INSERT INTO native_job_capabilities VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)'
        )
        .run(
          grantId,
          i.taskId,
          task.goalId,
          task.specVersion,
          i.expectedScopeVersion,
          i.repository,
          i.epoch,
          i.provider,
          i.revision,
          i.path,
          file.fileId,
          native.workspaceId,
          native.generation,
          attemptOrdinal,
          JSON.stringify(i.actions),
          now,
          now + i.ttlSeconds * 1000
        );
    } else
      this.db
        .prepare('INSERT INTO job_capabilities VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)')
        .run(
          grantId,
          i.taskId,
          task.goalId,
          task.specVersion,
          i.expectedScopeVersion,
          file.project,
          i.revision,
          i.path,
          file.oid,
          JSON.stringify(i.actions),
          now,
          now + i.ttlSeconds * 1000
        );
    this.db
      .prepare('INSERT INTO settings VALUES(?,?)')
      .run('job.auth.' + grantId, i.credentialDigest);
    return publicGrant(this.db, grantId);
  }
  revoke(grantId) {
    if (!this.db.isTransaction || !id(grantId)) deny();
    const row = publicGrant(this.db, grantId);
    if (!row) deny();
    this.db
      .prepare(
        'UPDATE ' +
          (row.backend === 'native' ? 'native_job_capabilities' : 'job_capabilities') +
          ' SET revokedAt=coalesce(revokedAt,?) WHERE id=?'
      )
      .run(this.now(true), grantId);
    return publicGrant(this.db, grantId);
  }
  authorize(i) {
    const verifier = this.db
      .prepare('SELECT value FROM settings WHERE key=?')
      .get('job.auth.' + i.id)?.value;
    if (!verifier || !same(Buffer.from(verifier), Buffer.from(hash(i.secret)))) deny();
    const now = this.now(),
      row = publicGrant(this.db, i.id);
    if (
      !row ||
      row.revokedAt !== null ||
      now < row.grantedAt ||
      now >= row.expiresAt ||
      i.workspaceRoot !== this.root ||
      i.taskId !== row.taskId ||
      i.expectedSpecVersion !== row.specVersion ||
      i.expectedScopeVersion !== row.scopeVersion ||
      i.revision !== row.revision ||
      i.path !== row.path ||
      !row.actions.includes(i.action)
    )
      deny();
    const task = this.applyScope(i);
    if ((i.backend ?? null) !== (row.backend ?? null) || task.goalId !== row.goalId) deny();
    if (row.backend === 'native') {
      const subject = nativeJobSubject(this.store, i),
        binding = bindNativeJob(this.store, i, row, subject);
      return { now, row, subject, binding };
    }
    if (nativeRole(this.db, i.taskId)) deny();
    const file = pin(this.db, row.revision, row.path);
    if (
      task.goalId !== row.goalId ||
      !file ||
      file.project !== row.projectId ||
      file.oid !== row.oid ||
      !['100644', '100755'].includes(file.mode)
    )
      deny();
    return { now, row };
  }
  observations({ taskId, after = 0, limit = 25 }) {
    requireInput(
      id(taskId) &&
        Number.isSafeInteger(after) &&
        after >= 0 &&
        Number.isSafeInteger(limit) &&
        limit >= 1 &&
        limit <= 100
    );
    const prefix = nativeRole(this.db, taskId) ? 'native_' : '';
    const rows = this.db
      .prepare(
        `SELECT o.rowid AS cursor,o.id,o.capabilityId,o.operationId,o.text,o.createdAt,
      g.taskId,g.goalId,g.specVersion,g.scopeVersion FROM ${prefix}job_observations o JOIN ${prefix}job_capabilities g ON g.id=o.capabilityId
      WHERE g.taskId=? AND o.rowid>? ORDER BY o.rowid LIMIT ?`
      )
      .all(taskId, after, limit + 1);
    return {
      observations: rows.slice(0, limit),
      cursor: rows.length > limit ? rows[limit - 1].cursor : null
    };
  }
  async request(packet) {
    validateJobPacket(packet);
    const i = { ...packet },
      admission = this.authorize(i);
    if (
      i.action === 'observation.append' &&
      (i.text.includes(i.secret) || i.operationId.includes(i.secret))
    )
      deny();
    let file;
    if (i.action === 'file.read') {
      const offset = i.offset ?? 0,
        limit = i.limit ?? 16384;
      if (admission.subject) {
        const { bytes, fileId, mode } = admission.subject.file;
        requireInput(offset <= bytes.length);
        const end = Math.min(bytes.length, offset + limit);
        file = {
          backend: 'native',
          repository: i.repository,
          revision: i.revision,
          path: i.path,
          fileId,
          mode,
          offset,
          size: bytes.length,
          nextOffset: end < bytes.length ? end : null,
          base64: bytes.subarray(offset, end).toString('base64'),
          ...admission.binding
        };
      } else file = this.project.file({ revision: i.revision, path: i.path, offset, limit });
    }
    if (i.action === 'file.search') {
      const { file: source, workspaceId, generation } = admission.subject,
        { attemptId, configDigest } = admission.binding;
      const search = this.search.search(
        {
          repository: i.repository,
          revisionId: i.revision,
          authorization: ['native-job', i.id, workspaceId, generation, attemptId, configDigest],
          entries: [{ path: i.path, fileId: source.fileId, mode: source.mode }],
          read: () => source
        },
        i
      );
      file = { ...search, attemptId, configDigest };
    }
    await this.beforeCommit?.();
    // No asynchronous work between final authorization and returning bytes or recording the observation.
    this.authorize(i);
    if (file) return file;
    return this.store.transaction(() => {
      const { now } = this.authorize(i);
      const table = i.backend === 'native' ? 'native_job_observations' : 'job_observations';
      const prior = this.db
        .prepare('SELECT * FROM ' + table + ' WHERE capabilityId=? AND operationId=?')
        .get(i.id, i.operationId);
      if (prior) {
        if (prior.text !== i.text) conflict();
        return { ...prior };
      }
      if (
        this.db.prepare('SELECT count(*) n FROM ' + table + ' WHERE capabilityId=?').get(i.id).n >=
        32
      )
        conflict();
      const observation = {
        id: randomUUID(),
        capabilityId: i.id,
        operationId: i.operationId,
        text: i.text,
        createdAt: now
      };
      this.db
        .prepare('INSERT INTO ' + table + ' VALUES(?,?,?,?,?)')
        .run(...Object.values(observation));
      return observation;
    });
  }
}

export function verifyJobCapabilities(db) {
  const check = (condition) => {
    if (!condition)
      throw Object.assign(
        Error('Job capability, observation or owner receipt failed recovery closure.'),
        { status: 409 }
      );
  };
  const receipts = new Map();
  for (const row of db
    .prepare(
      "SELECT receipt FROM command_receipts WHERE json_type(receipt,'$.capability.id')='text'"
    )
    .iterate()) {
    const grant = JSON.parse(row.receipt).capability;
    if (!receipts.has(grant.id)) receipts.set(grant.id, []);
    receipts.get(grant.id).push(grant);
  }
  const query =
    'SELECT id FROM job_capabilities' +
    (hasNativeJobs(db) ? ' UNION ALL SELECT id FROM native_job_capabilities' : '');
  for (const row of db.prepare(query).iterate()) {
    const grant = publicGrant(db, row.id),
      history = receipts.get(row.id) ?? [],
      original = { ...grant, revokedAt: null };
    const native = grant.backend === 'native',
      target = native ? null : pin(db, grant.revision, grant.path),
      task = db.prepare('SELECT * FROM goal_tasks WHERE taskId=?').get(grant.taskId);
    const historical = db
      .prepare(
        "SELECT 1 FROM goal_revisions WHERE id=? AND version=? AND changeKind IN ('created','goal.amend')"
      )
      .get(grant.goalId, grant.scopeVersion);
    const milliseconds = grant.expiresAt - grant.grantedAt;
    check(
      task?.goalId === grant.goalId &&
        task.specVersion >= grant.specVersion &&
        version(grant.specVersion) &&
        historical &&
        (native ||
          (target?.project === grant.projectId &&
            target.oid === grant.oid &&
            ['100644', '100755'].includes(target.mode))) &&
        Number.isSafeInteger(grant.grantedAt) &&
        Number.isSafeInteger(grant.expiresAt) &&
        milliseconds >= 1000 &&
        milliseconds <= 3600000 &&
        milliseconds % 1000 === 0 &&
        Array.isArray(grant.actions) &&
        grant.actions.length > 0 &&
        grant.actions.every((a) => allowedActions(grant.backend).includes(a)) &&
        new Set(grant.actions).size === grant.actions.length
    );
    check(
      history.some((r) => isDeepStrictEqual(r, original)) &&
        history.every((r) => isDeepStrictEqual(r, original) || isDeepStrictEqual(r, grant))
    );
    if (grant.revokedAt !== null)
      check(
        Number.isSafeInteger(grant.revokedAt) &&
          grant.revokedAt >= grant.grantedAt &&
          history.some((r) => isDeepStrictEqual(r, grant))
      );
    if (native) {
      const lease = db
        .prepare(
          `SELECT w.workspaceId,w.grant,w.generation,r.role,g.repository,g.epoch,g.admission FROM agent_workspaces w
        JOIN native_roles r ON r.taskId=w.taskId AND r.goalId=w.goalId JOIN native_goals g ON g.goalId=r.goalId WHERE w.taskId=? AND w.goalId=?`
        )
        .get(grant.taskId, grant.goalId);
      const subject = lease && JSON.parse(lease.grant);
      check(
        version(grant.attemptOrdinal) &&
          lease &&
          lease.workspaceId === grant.workspaceId &&
          version(grant.generation) &&
          lease.generation >= grant.generation &&
          lease.epoch === grant.epoch &&
          lease.repository === grant.repository &&
          JSON.parse(lease.admission)[lease.role + 'Provider'] === grant.provider &&
          subject.backend === 'native' &&
          subject.path === grant.path &&
          subject.sourceRevision === grant.revision &&
          subject.sourceOid === grant.oid &&
          subject.scopeVersion === grant.scopeVersion
      );
      const binding = db
        .prepare('SELECT * FROM native_job_bindings WHERE capabilityId=?')
        .get(grant.id);
      if (binding) {
        const verified = db
          .prepare(
            `SELECT a.ordinal,c.digest,x.manifest,x.digest AS contextDigest FROM attempts a JOIN attempt_configs c ON a.id=c.attemptId
          JOIN task_contexts x ON x.taskId=a.taskId AND x.ordinal=a.ordinal AND x.digest=c.contextDigest WHERE a.id=? AND a.taskId=? AND c.driver=?`
          )
          .get(binding.attemptId, grant.taskId, grant.provider);
        const ctx = verified && JSON.parse(verified.manifest);
        check(
          verified?.ordinal === grant.attemptOrdinal &&
            verified.digest === binding.configDigest &&
            hash(verified.manifest) === verified.contextDigest &&
            ctx.repository === grant.repository &&
            ctx.authorityEpoch === grant.epoch &&
            ctx.workspace?.id === grant.workspaceId &&
            ctx.workspace.generation === grant.generation &&
            ctx.sourceRevision === grant.revision &&
            ctx.sourcePath === grant.path
        );
      }
    }
    receipts.delete(row.id);
    const observations = db
      .prepare(
        'SELECT * FROM ' +
          (native ? 'native_job_observations' : 'job_observations') +
          ' WHERE capabilityId=? LIMIT 33'
      )
      .all(row.id);
    check(
      observations.length <= 32 &&
        observations.every(
          (o) =>
            grant.actions.includes('observation.append') &&
            id(o.id) &&
            id(o.operationId) &&
            typeof o.text === 'string' &&
            o.text.trim() &&
            Buffer.byteLength(o.text) <= 1024 &&
            Number.isSafeInteger(o.createdAt) &&
            o.createdAt >= grant.grantedAt &&
            o.createdAt < grant.expiresAt &&
            (grant.revokedAt === null || o.createdAt <= grant.revokedAt)
        )
    );
  }
  check(
    !receipts.size &&
      !db
        .prepare(
          'SELECT 1 FROM job_observations o LEFT JOIN job_capabilities c ON c.id=o.capabilityId WHERE c.id IS NULL LIMIT 1'
        )
        .get()
  );
}
