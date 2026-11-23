import { projectExecution } from './project-execution.mjs';
import { codexProjectManifest } from './codex-project-tools.mjs';
import { assertResearchAuthority } from './research-disclosure.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { projectToolNames, projectServer, projectSystemPrompt } from './project-mcp.mjs';
import { claudeModels } from './claude-models.mjs';

export const configDigest = (value) => createHash('sha256').update(value).digest('hex');
const refuse = (message) => Object.assign(new Error(message), { status: 409, code: -32001 });
export const claudeVersion = '2.1.322';
const previousClaudeVersion = '2.1.321';
// Full manifest digests from the installed-version qualification for each role.
const qualifiedClaudeProfiles = new Map([
  [
    'project/author/claude-fable-5-2',
    '9c69da24e82ba664cee32459e547175f3b54ba9f9cbd085dd37d759623206f3f'
  ],
  [
    'project/author/claude-opus-4-6',
    '0019c6bc2ca28236f9b65384ff49f67413fcd46cc7c3002dbe8afcd5f8275667'
  ],
  [
    'project/reviewer/claude-fable-5-2',
    'bc170ad2871d3cf6d8685367a3865f6b704654defe62eb6f3ab40da17df2439a'
  ],
  [
    'project/reviewer/claude-opus-4-6',
    '6384eeaf23ad53fa5f612da87a0f889125411d96c365f6070e1486c598ddcc1a'
  ],
  ['worker/claude-fable-5-2', 'e71282a78f44684a12abbae659f16de313ba7c9aabec494dbed398671a76b5ab'],
  ['worker/claude-opus-4-6', 'c71fc459d045848305fe486e319e863fd82ac6473a3dafec88f3fcdf50324ccb']
]);

export function claudeProfileScope(model, role, version) {
  if (!claudeModels.includes(model) || ![null, 'author', 'reviewer'].includes(role))
    throw refuse('Unrecognized Claude model or role.');
  const base = role === null ? 'worker/' + model : 'project/' + role + '/' + model;
  if (version === previousClaudeVersion) return base;
  if (version !== claudeVersion) throw refuse('Unqualified Claude config version.');
  return base + '@' + version;
}

function verifyClaudeRelease(db, scope, manifest, body) {
  const role = manifest.projectMcp?.role ?? null;
  if (scope !== claudeProfileScope(manifest.model, role, manifest.nativeVersion))
    throw refuse('Claude config scope differs from its model, role or version.');
  if (manifest.nativeVersion === previousClaudeVersion) return;
  const legacy = claudeProfileScope(manifest.model, role, previousClaudeVersion);
  if (qualifiedClaudeProfiles.get(legacy) !== configDigest(body))
    throw refuse('Unqualified Claude configuration for this release.');
  const previous = db
    .prepare(
      "SELECT digest,manifest FROM provider_config_baselines WHERE driver='claude' AND scope=?"
    )
    .get(legacy);
  if (previous) {
    const expected = JSON.stringify({ ...manifest, nativeVersion: previousClaudeVersion });
    if (previous.manifest !== expected || previous.digest !== configDigest(expected))
      throw refuse('Verified native configuration drift across Claude releases.');
  }
  const mismatch = db
    .prepare(
      `SELECT 1 FROM attempt_configs c JOIN attempts a ON a.id=c.attemptId
    WHERE c.driver='claude' AND c.scope IN (?,?) AND a.accountInstance IS NOT
    (SELECT value FROM settings WHERE key='claude.accountInstance') LIMIT 1`
    )
    .get(legacy, scope);
  if (mismatch) throw refuse('The historical profile belongs to a different account instance.');
}
export function installEffectiveConfigs(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS provider_config_baselines(driver TEXT NOT NULL,scope TEXT NOT NULL,digest TEXT NOT NULL,manifest TEXT NOT NULL,
      PRIMARY KEY(driver,scope));
    CREATE TABLE IF NOT EXISTS attempt_configs(attemptId TEXT PRIMARY KEY REFERENCES attempts(id),driver TEXT NOT NULL,scope TEXT NOT NULL,
      digest TEXT NOT NULL,manifest TEXT NOT NULL,contextDigest TEXT NOT NULL,verifiedAt TEXT NOT NULL,
      FOREIGN KEY(driver,scope) REFERENCES provider_config_baselines(driver,scope));`);
}
function projectRole(db, taskId) {
  if (
    !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='project_changes'").get()
  )
    return null;
  const rows = db
    .prepare(
      "SELECT CASE WHEN authorTaskId=? THEN 'author' ELSE 'reviewer' END AS role FROM project_changes WHERE authorTaskId=? OR reviewerTaskId=? LIMIT 2"
    )
    .all(taskId, taskId, taskId);
  if (rows.length > 1) throw refuse('Project task has ambiguous ownership.');
  return rows[0]?.role ?? null;
}
export function matchProjectProfile(driver, scope, manifest) {
  if (
    driver === 'codex' &&
    (scope.startsWith('project/') || manifest.projectDynamic !== undefined)
  ) {
    const role = manifest.projectDynamic?.role;
    const version = manifest.projectDynamic?.version;
    const expected = codexProjectManifest(role, version);
    if (
      scope !== codexProjectProfileScope(manifest.model, role, manifest.nativeVersion, version) ||
      (version === 1 &&
        (manifest.submittedThreadConfig !== undefined ||
          manifest.threadConfigEvidence !== undefined)) ||
      (version < 3 && manifest.codeModeHost !== undefined) ||
      (version >= 3 && manifest.submittedThreadConfig !== undefined) ||
      manifest.reasoningEffort !== (version >= 4 ? 'high' : 'ultra') ||
      manifest.route !== 'chatgpt' ||
      manifest.workDirectory !== 'private-empty' ||
      manifest.projectInstructions !== 'disabled' ||
      manifest.workspaceWrite !== false ||
      manifest.outboundTools !== false ||
      manifest.approvalPolicy !== 'never' ||
      manifest.projectMcp !== undefined ||
      !Object.entries(expected).every(([key, value]) => isDeepStrictEqual(manifest[key], value))
    )
      throw refuse('Invalid Codex project tool or configuration scope.');
    return role;
  }

  const m = scope.match(
    /^project\/(author|reviewer)\/(claude-fable-5-2|claude-opus-4-6)(?:@[^/]+)?$/
  );
  if (!m) {
    if (scope.startsWith('project/') || manifest.projectMcp !== undefined)
      throw refuse('Unrecognized project configuration.');
    return null;
  }
  const [, role, model] = m,
    a = manifest.projectMcp;
  if (
    driver !== 'claude' ||
    scope !== claudeProfileScope(model, role, manifest.nativeVersion) ||
    !a ||
    a.version !== 1 ||
    a.protocol !== 'project-mcp-v1' ||
    a.role !== role ||
    manifest.model !== model ||
    ![a.policyDigest, a.programDigest, a.loaderDigest, a.runtimeDigest].every(
      (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
    ) ||
    a.runtime !== 'v24.22.2' ||
    a.host !== '25.3.0' ||
    manifest.route !== 'claude.ai' ||
    manifest.permissionMode !== 'dontAsk' ||
    manifest.connectorSetDigest !== configDigest(JSON.stringify([projectServer])) ||
    !isDeepStrictEqual(manifest.tools, projectToolNames(role)) ||
    manifest.instructionSources?.suppliedSystemPromptDigest !== configDigest(projectSystemPrompt) ||
    manifest.workspaceWrite !== false ||
    manifest.paidSpend !== 'verified-disabled' ||
    manifest.accountRoute !== 'first-party-existing-pro'
  )
    throw refuse('Invalid project tool or configuration scope.');
  return role;
}
export function pinVerifiedProfile(store, driver, scope, manifest) {
  const role = matchProjectProfile(driver, scope, manifest);
  if (
    driver !== 'claude' &&
    (driver !== 'codex' ||
      (!role &&
        ![
          'worker',
          'thread',
          'worker/gpt-6.2-astra@0.171.0-alpha.13',
          'thread/gpt-6.2-astra@0.171.0-alpha.13',
          'project-worker/gpt-6.2-astra@0.171.0-alpha.13/v3',
          'project-worker/gpt-6.2-astra@0.171.0-alpha.13/v4',
          'project-worker/gpt-6.2-astra@0.171.0-alpha.13/v5'
        ].includes(scope)))
  )
    throw refuse('Unrecognized verified profile scope.');
  const body = JSON.stringify(manifest),
    digest = configDigest(body);
  if (Buffer.byteLength(body) > 32768) throw refuse('Configuration evidence exceeds its bound.');
  if (driver === 'claude') verifyClaudeRelease(store.db, scope, manifest, body);
  store.db
    .prepare('INSERT OR IGNORE INTO provider_config_baselines VALUES(?,?,?,?)')
    .run(driver, scope, digest, body);
  const prior = store.db
    .prepare('SELECT digest,manifest FROM provider_config_baselines WHERE driver=? AND scope=?')
    .get(driver, scope);
  if (prior?.digest !== digest || prior.manifest !== body)
    throw refuse(
      'Verified native configuration drift. Inspect the current profile before authorizing a new run.'
    );
  return { driver, scope, digest, manifest: JSON.parse(body) };
}
export function bindAttemptConfig(store, { taskId, driver, accountInstance, profile }) {
  const save = () => {
    const db = store.db;
    if (typeof taskId !== 'string' || !accountInstance)
      throw refuse('Configuration requires a reserved native attempt.');
    const rows = db
      .prepare(
        `SELECT a.id,c.digest,t.model FROM attempts a JOIN tasks t ON t.id=a.taskId JOIN task_contexts c ON c.taskId=a.taskId AND c.ordinal=a.ordinal
      WHERE a.taskId=? AND a.driver=? AND a.accountInstance=? AND a.status IN ('starting','running') AND t.status=a.status`
      )
      .all(taskId, driver, accountInstance);
    if (rows.length !== 1 || profile.driver !== driver)
      throw refuse('Configuration could not be bound to the exact reserved native attempt.');
    const role = projectRole(db, taskId);
    if (
      role !== matchProjectProfile(driver, profile.scope, profile.manifest) ||
      (role && store.projectDevelopment?.validateDispatch(taskId)?.role !== role)
    )
      throw refuse('Task does not authorize this project configuration.');
    if (driver === 'codex' && role) {
      const flow = db
        .prepare('SELECT input FROM project_changes WHERE authorTaskId=? OR reviewerTaskId=?')
        .get(taskId, taskId);
      const input = flow && JSON.parse(flow.input);
      if ((profile.manifest.projectDynamic.version === 5) !== (input?.version === 3))
        throw refuse('The project profile protocol differs from its admitted workflow.');
      const selected = input && projectExecution(input);
      if (
        selected?.provider !== driver ||
        selected.model !== profile.manifest.model ||
        selected.reasoning !== profile.manifest.reasoningEffort
      )
        throw refuse('The project profile differs from its admitted execution selection.');
    }
    if (driver === 'claude' && rows[0].model !== profile.manifest.model)
      throw refuse('The native model differs from its admitted Claude task.');
    store.taskHandoffs?.validateDispatch(taskId);
    assertResearchAuthority(store, taskId);
    store.harnessGit?.validateDispatch(taskId);
    const row = rows[0],
      body = JSON.stringify(profile.manifest);
    const pin = db
      .prepare('SELECT digest,manifest FROM provider_config_baselines WHERE driver=? AND scope=?')
      .get(driver, profile.scope);
    if (
      !pin ||
      pin.digest !== profile.digest ||
      pin.manifest !== body ||
      configDigest(body) !== profile.digest
    )
      throw refuse('The pinned native profile changed.');
    db.prepare('INSERT OR IGNORE INTO attempt_configs VALUES(?,?,?,?,?,?,?)').run(
      row.id,
      driver,
      profile.scope,
      profile.digest,
      body,
      row.digest,
      new Date().toISOString()
    );
    const bound = db
      .prepare('SELECT digest,scope,contextDigest FROM attempt_configs WHERE attemptId=?')
      .get(row.id);
    if (
      bound.digest !== profile.digest ||
      bound.scope !== profile.scope ||
      bound.contextDigest !== row.digest
    )
      throw refuse('Immutable attempt configuration differs.');
  };
  if (store.db.isTransaction) save();
  else store.transaction(save);
}
export function attemptConfigHistory(db, taskId) {
  return db
    .prepare(
      `SELECT a.id AS attemptId,c.driver,c.scope,c.digest,c.manifest,c.contextDigest,c.verifiedAt
    FROM attempts a LEFT JOIN attempt_configs c ON c.attemptId=a.id WHERE a.taskId=? ORDER BY a.ordinal`
    )
    .all(taskId)
    .map((r) => ({
      ...r,
      state: r.digest ? 'verified' : 'unrecorded',
      manifest: r.manifest ? JSON.parse(r.manifest) : null
    }));
}
export function verifyEffectiveConfigs(db) {
  for (const row of db
    .prepare("SELECT scope,manifest FROM provider_config_baselines WHERE driver='claude'")
    .iterate())
    verifyClaudeRelease(db, row.scope, JSON.parse(row.manifest), row.manifest);
  for (const row of db
    .prepare(
      "SELECT driver,scope,manifest FROM provider_config_baselines WHERE scope LIKE 'project/%' OR json_type(manifest,'$.projectMcp') IS NOT NULL"
    )
    .iterate()) {
    matchProjectProfile(row.driver, row.scope, JSON.parse(row.manifest));
    if (
      !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='project_changes'").get()
    )
      throw refuse('Missing project task authority storage.');
  }
  const projectTable = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='project_changes'")
    .get();
  if (projectTable) {
    const records =
      db.prepare(`SELECT c.driver,c.scope,c.manifest,a.taskId,t.model FROM attempt_configs c JOIN attempts a ON a.id=c.attemptId JOIN tasks t ON t.id=a.taskId
      WHERE c.scope LIKE 'project/%' OR a.taskId IN (SELECT authorTaskId FROM project_changes UNION SELECT reviewerTaskId FROM project_changes)`);
    for (const row of records.iterate()) {
      const manifest = JSON.parse(row.manifest),
        role = projectRole(db, row.taskId);
      if (
        role !== matchProjectProfile(row.driver, row.scope, manifest) ||
        !role ||
        manifest.model !== row.model
      )
        throw refuse('Historical task differs from its project tool scope.');
    }
  }
  for (const r of db
    .prepare(
      'SELECT digest,manifest FROM provider_config_baselines UNION ALL SELECT digest,manifest FROM attempt_configs'
    )
    .iterate())
    if (configDigest(r.manifest) !== r.digest)
      throw refuse('Retained configuration manifest digest mismatch.');
  if (
    db
      .prepare(
        `SELECT 1 FROM attempt_configs c JOIN attempts a ON a.id=c.attemptId LEFT JOIN task_contexts t ON t.taskId=a.taskId AND t.ordinal=a.ordinal
    LEFT JOIN provider_config_baselines b ON b.driver=c.driver AND b.scope=c.scope WHERE c.driver!=a.driver OR b.digest IS NOT c.digest OR
    t.digest IS NOT c.contextDigest OR b.manifest IS NOT c.manifest LIMIT 1`
      )
      .get()
  )
    throw refuse('Retained configuration binding or context mismatch.');
}

export function codexProjectProfileScope(model, role, nativeVersion, version = 3) {
  if (
    model !== 'gpt-6.2-astra' ||
    !['author', 'reviewer'].includes(role) ||
    nativeVersion !== '0.171.0-alpha.13' ||
    ![1, 2, 3, 4, 5].includes(version)
  )
    throw refuse('Unqualified Codex project profile.');
  return `project/${role}/${model}@${nativeVersion}${version === 1 ? '' : '/v' + version}`;
}
