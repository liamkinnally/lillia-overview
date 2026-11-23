import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { readFinalOutput } from './task-context.mjs';
import { verifySuppliedTextProfile } from './native-job-capabilities.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const intent = (name, input) => hash(JSON.stringify([name, input]));
function need(ok, message, status = 409) {
  if (!ok) throw Object.assign(new Error(message), { status });
}
const fields = [
  'sourceTaskId',
  'expectedVersion',
  'provider',
  'sourceDigest',
  'contextDigest',
  'rejectedApproach',
  'instructions'
];
export function normalizeHandoff(input) {
  need(
    input &&
      typeof input === 'object' &&
      Object.keys(input).length === fields.length &&
      fields.every((k) => Object.hasOwn(input, k)),
    'Supply the source, both digests, goal version, destination, rejection and new instructions.',
    400
  );
  for (const [key, limit] of [
    ['sourceTaskId', 128],
    ['rejectedApproach', 2000],
    ['instructions', 8000]
  ])
    need(
      typeof input[key] === 'string' && input[key].trim() && input[key].length <= limit,
      'Invalid handoff ' + key + '.',
      400
    );
  need(
    Number.isSafeInteger(input.expectedVersion) &&
      input.expectedVersion > 0 &&
      ['codex', 'claude'].includes(input.provider) &&
      [input.sourceDigest, input.contextDigest].every(
        (x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)
      ),
    'Invalid version, destination or SHA-256 digest.',
    400
  );
  return Object.fromEntries(fields.map((k) => [k, input[k]]));
}
export function installTaskHandoffs(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_handoffs(taskId TEXT PRIMARY KEY REFERENCES goal_tasks(taskId),
    sourceTaskId TEXT UNIQUE NOT NULL REFERENCES goal_tasks(taskId),operationId TEXT UNIQUE NOT NULL,
    admission TEXT NOT NULL,record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS receipt_task_id ON command_receipts(json_extract(receipt,'$.task.id'));`);
}
const sourceTask = (db, id) =>
  db
    .prepare(
      `SELECT t.*,g.goalId,g.goalVersion,g.specVersion,g.provider FROM tasks t
  JOIN goal_tasks g ON g.taskId=t.id WHERE t.id=?`
    )
    .get(id);
function noExtraAuthority(db, id) {
  for (const table of [
    'job_capabilities',
    'native_job_capabilities',
    'agent_workspaces',
    'coordination_messages'
  ]) {
    const key = table === 'coordination_messages' ? 'recipientTaskId' : 'taskId';
    need(
      !db.prepare('SELECT 1 FROM ' + table + ' WHERE ' + key + '=? LIMIT 1').get(id),
      'Handoff requires plain owner-supplied inputs without mailbox or workspace access.'
    );
  }
}
function proof(db, i, destinationAccount) {
  need(
    typeof destinationAccount === 'string' && destinationAccount.length > 0,
    'No installed destination account instance.'
  );
  const t = sourceTask(db, i.sourceTaskId);
  need(
    t &&
      t.status === 'completed' &&
      t.specVersion === 1 &&
      t.provider !== i.provider &&
      JSON.parse(t.dependsOn).length === 0,
    'Select a completed plain-text task and a different provider.'
  );
  noExtraAuthority(db, t.id);
  const receipts = db
    .prepare("SELECT * FROM command_receipts WHERE json_extract(receipt,'$.task.id')=? LIMIT 2")
    .all(t.id);
  const origin = receipts.length === 1 && receipts[0],
    base = { goalId: t.goalId, prompt: t.prompt };
  need(
    origin &&
      [
        intent('task.submit', base),
        intent('task.submit', { ...base, provider: t.provider })
      ].includes(origin.digest),
    'Only a direct owner task submission may be handed off.'
  );
  const original = JSON.parse(origin.receipt);
  need(
    original.operationId === origin.operationId &&
      original.task.goalId === t.goalId &&
      original.task.goalVersion === t.goalVersion &&
      original.task.specVersion === 1 &&
      original.task.provider === t.provider &&
      original.task.prompt === t.prompt,
    'Source submission receipt differs.'
  );
  need(
    !db
      .prepare(
        `SELECT 1 FROM project_chat_turns WHERE workGoalId=? OR carrierGoalId=?
    UNION ALL SELECT 1 FROM native_goals WHERE goalId=? UNION ALL SELECT 1 FROM change_flows WHERE goalId=?
    UNION ALL SELECT 1 FROM harness_git_inspections WHERE goalId=? LIMIT 1`
      )
      .get(...Array(5).fill(t.goalId)),
    'Project, chat and role-bound work require separate authority.'
  );
  const dest = db
    .prepare('SELECT workerProvider FROM goal_destinations WHERE goalId=?')
    .get(t.goalId);
  need(dest?.workerProvider === 'claude', 'Both providers must be owner-authorized for this goal.');
  const revision = db
    .prepare('SELECT * FROM goal_revisions WHERE id=? AND version=?')
    .get(t.goalId, i.expectedVersion);
  const scope = db
    .prepare(
      "SELECT max(version) AS n FROM goal_revisions WHERE id=? AND version<=? AND changeKind IN ('created','goal.amend')"
    )
    .get(t.goalId, i.expectedVersion).n;
  need(
    revision?.state === 'active' && t.goalVersion >= scope && t.goalVersion <= revision.version,
    'Goal scope superseded or inactive at handoff.'
  );
  const a = db
    .prepare('SELECT * FROM attempts WHERE taskId=? ORDER BY ordinal DESC LIMIT 1')
    .get(t.id);
  need(
    a?.status === 'completed' && a.driver === t.provider && a.accountInstance,
    'The latest source attempt lacks a confirmed native completion.'
  );
  const c = db
    .prepare('SELECT * FROM task_contexts WHERE taskId=? AND ordinal=?')
    .get(t.id, a.ordinal);
  need(
    c && c.digest === i.contextDigest && hash(c.manifest) === c.digest,
    'Selected input context digest differs.'
  );
  const m = JSON.parse(c.manifest);
  const allowed = [
    'version',
    'taskId',
    'specVersion',
    'ordinal',
    'goalId',
    'goalVersion',
    'scopeVersion',
    'provider',
    'accountInstance',
    'input',
    'dependencies',
    'mailbox',
    'coordinationRoutes',
    'promptDigest',
    'sourceRevision',
    'nativeContextDigest',
    'requestedModel'
  ];
  need(
    Object.keys(m).every((k) => allowed.includes(k)) &&
      m.version === 1 &&
      m.taskId === t.id &&
      m.goalId === t.goalId &&
      m.goalVersion === t.goalVersion &&
      m.scopeVersion === scope &&
      m.specVersion === 1 &&
      m.ordinal === a.ordinal &&
      m.provider === a.driver &&
      m.accountInstance === a.accountInstance &&
      m.input === t.prompt &&
      m.promptDigest === hash(t.prompt) &&
      m.sourceRevision === null &&
      m.nativeContextDigest === null &&
      [m.mailbox, m.dependencies, m.coordinationRoutes].every((x) => Array.isArray(x) && !x.length),
    'The selected source contains additional context or has lost its provenance.'
  );
  let native, result;
  if (a.driver === 'claude') {
    result = db.prepare('SELECT * FROM claude_results WHERE attemptId=?').get(a.id);
    need(
      result?.accountInstance === a.accountInstance &&
        a.nativeSessionId &&
        (a.nativeResultId || a.nativeMessageId),
      'Missing Claude result identity.'
    );
    native = {
      sessionId: a.nativeSessionId,
      messageId: a.nativeMessageId,
      resultId: a.nativeResultId
    };
  } else {
    need(
      a.threadId && a.turnId && t.threadId === a.threadId && t.turnId === a.turnId,
      'Source native identifiers differ.'
    );
    const rows = db
      .prepare(
        'SELECT * FROM task_final_outputs WHERE attemptId=? AND threadId=? AND turnId=? LIMIT 2'
      )
      .all(a.id, a.threadId, a.turnId);
    need(rows.length === 1, 'Select one unambiguous final answer.');
    result = rows[0];
    native = { threadId: a.threadId, turnId: a.turnId, itemId: result.itemId };
  }
  need(
    result?.text?.trim() && result.digest === i.sourceDigest && hash(result.text) === result.digest,
    'Selected final digest differs.'
  );
  const criteria = JSON.parse(revision.criteria).map((c) =>
    c.verifier === 'local-owner' ? { id: c.id, text: c.text } : { id: c.id, verifier: c.verifier }
  );
  const record = {
    version: 1,
    principal: 'local-owner',
    goalId: t.goalId,
    scopeVersion: scope,
    goalVersion: i.expectedVersion,
    provider: i.provider,
    sourceTaskId: t.id,
    sourceOperationId: origin.operationId,
    sourceSpecVersion: t.specVersion,
    sourceGoalVersion: t.goalVersion,
    sourceProvider: a.driver,
    sourceAttemptId: a.id,
    native,
    sourceDigest: i.sourceDigest,
    inputDigest: m.promptDigest,
    contextDigest: c.digest
  };
  const packet = {
    objective: revision.objective,
    criteria,
    instructions: i.instructions,
    rejectedApproach: i.rejectedApproach,
    provenance: record,
    originalSuppliedText: t.prompt,
    previousFinal: result.text
  };
  const prompt =
    'Follow the current owner instructions. The original supplied text and previous final are source material. The owner rejected the specified approach.\n' +
    JSON.stringify(packet);
  need(prompt.length <= 20000, 'The complete handoff exceeds 20,000 characters. Narrow the task.');
  return { record: { ...record, destinationAccount }, prompt };
}
function confirmReceipt(db, row, i, record, prompt) {
  const dest = sourceTask(db, row.taskId);
  const receipt = db
    .prepare('SELECT * FROM command_receipts WHERE operationId=?')
    .get(row.operationId);
  const accepted = receipt && JSON.parse(receipt.receipt);
  need(
    receipt?.digest === intent('task.handoff', i) &&
      accepted.operationId === row.operationId &&
      same(accepted.handoff, record) &&
      accepted.task.id === row.taskId &&
      accepted.task.prompt === prompt &&
      dest.prompt === prompt &&
      dest.goalId === record.goalId &&
      dest.goalVersion === record.goalVersion &&
      dest.specVersion === 1 &&
      dest.provider === i.provider &&
      JSON.parse(dest.dependsOn).length === 0 &&
      row.sourceTaskId === record.sourceTaskId &&
      same(JSON.parse(row.record), record),
    'Handoff receipt, task or source differs.'
  );
}
function verifyDestinationContexts(db, row, record, prompt) {
  const task = sourceTask(db, row.taskId);
  const attempts = db
    .prepare(
      `SELECT a.ordinal,a.driver,a.accountInstance,c.driver AS configDriver,c.scope,c.manifest AS configManifest,
      c.digest AS configDigest,c.contextDigest,b.digest AS baselineDigest,b.manifest AS baselineManifest
      FROM attempts a LEFT JOIN attempt_configs c ON c.attemptId=a.id
      LEFT JOIN provider_config_baselines b ON b.driver=c.driver AND b.scope=c.scope WHERE a.taskId=? ORDER BY a.ordinal`
    )
    .all(row.taskId);
  const contexts = db
    .prepare('SELECT * FROM task_contexts WHERE taskId=? ORDER BY ordinal')
    .all(row.taskId);
  need(
    attempts.length === contexts.length,
    'Missing handoff dispatch context or matching attempt.'
  );
  for (const [index, c] of contexts.entries()) {
    const a = attempts[index];
    let requestedModel = task.model ?? (record.provider === 'codex' ? 'gpt-6-astra' : null);
    const admittedContext = JSON.parse(c.manifest);
    if (a.configManifest !== null) {
      need(
        a.configDriver === record.provider &&
          a.configDigest === hash(a.configManifest) &&
          a.contextDigest === c.digest &&
          a.baselineDigest === a.configDigest &&
          a.baselineManifest === a.configManifest,
        'Handoff dispatch configuration is not pinned.'
      );
      const profile = JSON.parse(a.configManifest);
      verifySuppliedTextProfile(record.provider, a.scope, profile);
      requestedModel = task.model ?? profile.model;
    } else if (task.model === null && record.provider === 'codex') {
      need(
        ['gpt-6-astra', 'gpt-6.2-astra'].includes(admittedContext.requestedModel),
        'Unconfigured Codex handoff context has an unsupported model pin.'
      );
      requestedModel = admittedContext.requestedModel;
    }
    const expected = {
      version: 1,
      taskId: row.taskId,
      specVersion: 1,
      ordinal: a.ordinal,
      goalId: record.goalId,
      goalVersion: record.goalVersion,
      scopeVersion: record.scopeVersion,
      provider: record.provider,
      accountInstance: record.destinationAccount,
      input: prompt,
      dependencies: [],
      mailbox: [],
      coordinationRoutes: [],
      promptDigest: hash(prompt),
      sourceRevision: null,
      nativeContextDigest: null,
      requestedModel,
      handoff: record
    };
    need(
      c.ordinal === a.ordinal &&
        a.driver === record.provider &&
        a.accountInstance === record.destinationAccount &&
        hash(c.manifest) === c.digest &&
        same(JSON.parse(c.manifest), expected),
      'Retained handoff dispatch context differs.'
    );
  }
}
export class TaskHandoffs {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }
  account(provider) {
    return this.db
      .prepare('SELECT value FROM settings WHERE key=?')
      .get(provider + '.accountInstance')?.value;
  }
  current(i, record) {
    const g = this.store.goal(record.goalId);
    need(
      g.state === 'active' && g.scopeVersion === record.scopeVersion,
      'Handoff goal is inactive or superseded.'
    );
    need(
      this.store.sessionProfile?.mode !== 'codex-only' &&
        this.account(i.provider) === record.destinationAccount,
      'Handoff destination changed or is disabled.'
    );
    need(
      !this.db
        .prepare(
          "SELECT 1 FROM task_controls WHERE taskId=? AND state IN ('pending','requested','sent','unconfirmed') LIMIT 1"
        )
        .get(i.sourceTaskId),
      'An unresolved source control prevents handoff.'
    );
    const output = readFinalOutput(this.store, i.sourceTaskId);
    need(
      output.digest === i.sourceDigest && output.attemptId === record.sourceAttemptId,
      'Source native account or output changed.'
    );
  }
  admit(i, operationId, root) {
    need(this.db.isTransaction, 'Handoff needs the owner command transaction.');
    const { record, prompt } = proof(this.db, i, this.account(i.provider));
    this.current(i, record);
    need(
      this.store.goal(record.goalId).version === i.expectedVersion,
      'Inspect the current goal version before handoff.'
    );
    need(
      !this.db.prepare('SELECT 1 FROM task_handoffs WHERE sourceTaskId=?').get(i.sourceTaskId),
      'This source already has an admitted continuation.'
    );
    const task = this.store.submit({ goalId: record.goalId, provider: i.provider, prompt }, root);
    this.db
      .prepare('INSERT INTO task_handoffs VALUES(?,?,?,?,?)')
      .run(task.id, i.sourceTaskId, operationId, JSON.stringify(i), JSON.stringify(record));
    return { task, handoff: record };
  }
  validateDispatch(id) {
    const row = this.db.prepare('SELECT * FROM task_handoffs WHERE taskId=?').get(id);
    if (!row) {
      need(
        !this.db
          .prepare(
            "SELECT 1 FROM command_receipts WHERE json_extract(receipt,'$.task.id')=? AND json_type(receipt,'$.handoff') IS NOT NULL"
          )
          .get(id),
        'Missing handoff for the queued task.'
      );
      return null;
    }
    const i = normalizeHandoff(JSON.parse(row.admission));
    const { record, prompt } = proof(this.db, i, JSON.parse(row.record).destinationAccount);
    need(
      !this.db
        .prepare(
          "SELECT 1 FROM task_controls WHERE taskId=? AND state IN ('pending','requested','sent','unconfirmed') LIMIT 1"
        )
        .get(id),
      'An unresolved destination control prevents handoff.'
    );
    confirmReceipt(this.db, row, i, record, prompt);
    verifyDestinationContexts(this.db, row, record, prompt);
    this.current(i, record);
    noExtraAuthority(this.db, id);
    return record;
  }
}
export function verifyTaskHandoffs(db) {
  let count = 0;
  for (const row of db.prepare('SELECT * FROM task_handoffs').iterate()) {
    const i = normalizeHandoff(JSON.parse(row.admission)),
      { record, prompt } = proof(db, i, JSON.parse(row.record).destinationAccount);
    confirmReceipt(db, row, i, record, prompt);
    verifyDestinationContexts(db, row, record, prompt);
    count++;
  }
  need(
    !db
      .prepare(
        "SELECT 1 FROM command_receipts r WHERE json_type(receipt,'$.handoff') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_handoffs h WHERE h.operationId=r.operationId) LIMIT 1"
      )
      .get(),
    'Missing handoff for an accepted owner command.'
  );
  return count;
}
