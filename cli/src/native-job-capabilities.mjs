import { claudeProfileScope } from './effective-config.mjs';
import { createHash } from 'node:crypto';
import { NativeStore } from './native-store.mjs';

const deny = () => {
  throw Object.assign(Error('Job capability is unavailable for this request.'), { status: 403 });
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function installNativeJobCapabilities(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS native_job_capabilities(id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES native_roles(taskId),
    goalId TEXT NOT NULL REFERENCES native_goals(goalId),specVersion INTEGER NOT NULL,scopeVersion INTEGER NOT NULL,
    repository TEXT NOT NULL,epoch TEXT NOT NULL REFERENCES native_authority(epoch),provider TEXT NOT NULL,
    revision TEXT NOT NULL REFERENCES native_revisions(id),path TEXT NOT NULL,oid TEXT NOT NULL REFERENCES native_files(id),
    workspaceId TEXT NOT NULL REFERENCES agent_workspaces(workspaceId),generation INTEGER NOT NULL,attemptOrdinal INTEGER NOT NULL CHECK(attemptOrdinal>0),actions TEXT NOT NULL,
    grantedAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,revokedAt INTEGER);
    CREATE TABLE IF NOT EXISTS native_job_bindings(capabilityId TEXT PRIMARY KEY REFERENCES native_job_capabilities(id),
    attemptId TEXT NOT NULL REFERENCES attempt_configs(attemptId),configDigest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS native_job_observations(id TEXT PRIMARY KEY,capabilityId TEXT NOT NULL REFERENCES native_job_bindings(capabilityId),
    operationId TEXT NOT NULL,text TEXT NOT NULL,createdAt INTEGER NOT NULL,UNIQUE(capabilityId,operationId));`);
}
export const hasNativeJobs = (db) =>
  !!db
    .prepare("SELECT 1 FROM sqlite_schema WHERE name='native_job_capabilities' AND type='table'")
    .get();
export function nativeRole(db, taskId) {
  return (
    hasNativeJobs(db) &&
    db.prepare('SELECT role,goalId,cycle,promptDigest FROM native_roles WHERE taskId=?').get(taskId)
  );
}
export function nativeJobSubject(store, i) {
  const db = store.db,
    role = nativeRole(db, i.taskId);
  if (!role || !store.nativeDevelopment) deny();
  const flow = store.nativeDevelopment.view(role.goalId);
  if (
    !flow ||
    flow.stage !== role.role ||
    flow[role.role + 'TaskId'] !== i.taskId ||
    flow.cycle !== role.cycle ||
    flow.epoch !== i.epoch ||
    flow.repository !== i.repository ||
    flow.admission[role.role + 'Provider'] !== i.provider
  )
    deny();
  let scope;
  try {
    scope = store.nativeDevelopment.role(i.taskId, role.role);
  } catch (e) {
    if (e.status === 409 || e.status === 404) deny();
    throw e;
  }
  if (scope.ownerPolicy || scope.jsRecipe) deny();
  const lease = db
    .prepare(
      `SELECT w.workspaceId,w.generation,w.grant,a.digest FROM agent_workspaces w JOIN workspace_admissions a
    ON a.taskId=w.taskId AND a.generation=w.generation WHERE w.taskId=? AND w.role=? AND w.state='ready' AND a.profile='darwin-seatbelt-file-v1'`
    )
    .get(i.taskId, role.role);
  const g = lease && JSON.parse(lease.grant);
  if (
    !g ||
    scope.epoch !== i.epoch ||
    scope.path !== i.path ||
    scope.repository !== i.repository ||
    scope.scopeVersion !== i.expectedScopeVersion ||
    g.backend !== 'native' ||
    g.projectId !== i.repository ||
    g.epoch !== i.epoch ||
    g.path !== i.path ||
    g.sourceRevision !== i.revision ||
    g.sourceDigest !== lease.digest ||
    g.promptDigest !== role.promptDigest
  )
    deny();
  const file = new NativeStore(store).file({
    repository: i.repository,
    revisionId: i.revision,
    path: i.path
  });
  if (
    file.mode !== '100644' ||
    file.fileId !== g.sourceOid ||
    digest(file.bytes) !== g.sourceDigest
  )
    deny();
  return { file, workspaceId: lease.workspaceId, generation: lease.generation };
}
export function bindNativeJob(store, i, grant, subject) {
  const db = store.db;
  if (
    grant.provider !== i.provider ||
    grant.epoch !== i.epoch ||
    grant.repository !== i.repository ||
    grant.workspaceId !== subject.workspaceId ||
    grant.generation !== subject.generation ||
    grant.oid !== subject.file.fileId
  )
    deny();
  const row = db
    .prepare(
      `SELECT a.id,a.ordinal,a.accountInstance,a.modelRerouted,c.driver,c.scope,c.digest,c.manifest,c.contextDigest,x.manifest AS context
    FROM attempts a JOIN attempt_configs c ON c.attemptId=a.id JOIN task_contexts x ON x.taskId=a.taskId AND x.ordinal=a.ordinal AND x.digest=c.contextDigest
    JOIN provider_config_baselines b ON b.driver=c.driver AND b.scope=c.scope AND b.manifest=c.manifest AND b.digest=c.digest
    JOIN tasks t ON t.id=a.taskId WHERE a.taskId=? AND a.driver=? AND a.status=t.status AND a.status IN ('starting','running','waiting_for_input')
      AND a.accountInstance=(SELECT value FROM settings WHERE key=?) ORDER BY a.ordinal DESC LIMIT 1`
    )
    .get(i.taskId, i.provider, i.provider + '.accountInstance');
  if (
    !row ||
    row.ordinal !== grant.attemptOrdinal ||
    row.modelRerouted ||
    digest(row.context) !== row.contextDigest ||
    digest(row.manifest) !== row.digest ||
    row.driver !== i.provider
  )
    deny();
  const p = JSON.parse(row.manifest),
    c = JSON.parse(row.context);
  if (
    c.specVersion !== i.expectedSpecVersion ||
    c.taskId !== i.taskId ||
    c.repository !== i.repository ||
    c.authorityEpoch !== i.epoch ||
    p.model !== c.requestedModel ||
    c.scopeVersion !== i.expectedScopeVersion ||
    c.provider !== i.provider ||
    c.workspace?.id !== grant.workspaceId ||
    c.workspace.generation !== grant.generation ||
    c.sourceRevision !== i.revision ||
    c.sourcePath !== i.path ||
    p.workspaceWrite !== false
  )
    deny();
  verifySuppliedTextProfile(i.provider, row.scope, p);
  db.prepare('INSERT OR IGNORE INTO native_job_bindings VALUES(?,?,?)').run(
    grant.id,
    row.id,
    row.digest
  );
  const saved = db
    .prepare('SELECT attemptId,configDigest FROM native_job_bindings WHERE capabilityId=?')
    .get(grant.id);
  if (saved.attemptId !== row.id || saved.configDigest !== row.digest) deny();
  return { ...saved };
}

export function verifySuppliedTextProfile(provider, scope, p) {
  if (p.workspaceWrite !== false) deny();
  if (provider === 'codex') {
    const names = ['AGENTS.md', 'AGENTS.override.md'],
      layers = ['sessionFlags', 'user', 'system'],
      legacyThread = scope === 'thread',
      currentThread =
        scope === 'thread/gpt-6.2-astra@0.171.0-alpha.13' &&
        p.model === 'gpt-6.2-astra' &&
        p.nativeVersion === '0.171.0-alpha.13' &&
        p.reasoningEffort === 'ultra';
    if (
      (!legacyThread && !currentThread) ||
      p.route !== 'chatgpt' ||
      p.tools !== 'supplied-text-only' ||
      p.threadToolInventory !== 'all-connectors-disabled' ||
      p.threadNetworkAccess !== false ||
      p.projectInstructions !== 'disabled' ||
      p.workDirectory !== 'private-empty' ||
      p.threadSandbox !== 'readOnly' ||
      p.approvalPolicy !== 'never' ||
      p.outboundTools !== false ||
      !Array.isArray(p.layers) ||
      p.layers.length !== layers.length ||
      p.layers.some((l, n) => l.source !== layers[n] || !/^[a-f0-9]{64}$/.test(l.revisionDigest)) ||
      !Array.isArray(p.instructionFiles) ||
      p.instructionFiles.length !== 2 ||
      p.instructionFiles.some(
        (f, n) =>
          f.source !== names[n] ||
          !(f.present === false || (f.present === true && /^[a-f0-9]{64}$/.test(f.digest)))
      ) ||
      !Array.isArray(p.nativeInstructionSources) ||
      p.nativeInstructionSources.some(
        (name) => !p.instructionFiles.some((f) => f.source === name && f.present)
      )
    )
      deny();
  } else if (
    scope !== claudeProfileScope(p.model, null, p.nativeVersion) ||
    p.route !== 'claude.ai' ||
    p.permissionMode !== 'dontAsk' ||
    !Array.isArray(p.tools) ||
    p.tools.length ||
    p.paidSpend !== 'verified-disabled' ||
    p.accountRoute !== 'first-party-existing-pro' ||
    p.layers?.length !== 1 ||
    p.layers[0].source !== 'flagSettings' ||
    p.disabledConnectorCount !== 0 ||
    p.connectorSetDigest !== digest('[]') ||
    !p.instructionSources ||
    ['nativeUser', 'managed', 'projectAndAncestor'].some(
      (k) => p.instructionSources[k] !== 'absent'
    )
  )
    deny();
}
