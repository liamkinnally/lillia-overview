// The receipt retires local read authority only. Native session history stays unknown.
import { isDeepStrictEqual as same } from 'node:util';
import { configDigest, matchProjectProfile } from './effective-config.mjs';

export const disposition = 'locally-retired-remote-unknown';
export const id = (v) => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(v);
export const hash = (v) => configDigest(JSON.stringify(v));
export function requireValue(ok, message, status = 409) {
  if (!ok) throw Object.assign(new Error(message), { status });
}
export function normalizeProjectReviewRetry(raw) {
  requireValue(
    raw && typeof raw === 'object' && !Array.isArray(raw),
    'Select a project reviewer.',
    400
  );
  const {
    goalId,
    taskId,
    attemptId,
    candidate,
    expectedLimit,
    additionalAttempts,
    additionalActiveSeconds,
    reason
  } = raw;
  const input = {
    goalId,
    taskId,
    attemptId,
    candidate,
    expectedLimit,
    additionalAttempts,
    additionalActiveSeconds,
    reason
  };
  requireValue(
    Object.keys(raw).every((k) => Object.hasOwn(input, k)) &&
      [goalId, taskId, attemptId].every(id) &&
      typeof candidate === 'string' &&
      /^[a-f0-9]{64}$/.test(candidate) &&
      expectedLimit === 2 &&
      additionalAttempts === 1 &&
      additionalActiveSeconds === 300 &&
      typeof reason === 'string' &&
      reason.trim().length > 0 &&
      reason.length <= 1000,
    'Select the original two-attempt admission, its exact candidate, one reviewer attempt and 300 active seconds.',
    400
  );
  input.reason = reason.trim();
  return input;
}
export function fenceValid(f) {
  return (
    f &&
    id(f.predecessorId) &&
    id(f.successorId) &&
    f.predecessorId !== f.successorId &&
    f.priorProcessStopped === true &&
    f.exclusiveWriter === true &&
    f.brokerUnissued === true &&
    f.operationsIdle === true
  );
}
export function historicalBinding(db, i) {
  const f = db.prepare('SELECT * FROM project_changes WHERE goalId=?').get(i.goalId);
  requireValue(
    f?.reviewerTaskId === i.taskId && f.candidate === i.candidate && f.authorTaskId !== i.taskId,
    'Project reviewer or submitted candidate changed.'
  );
  const admission = JSON.parse(f.input),
    authorFinal = JSON.parse(f.authorFinal);
  const author = db
    .prepare(
      'SELECT a.*,d.closedMs,d.startedMs FROM attempts a JOIN timed_attempts d ON d.attemptId=a.id WHERE a.taskId=?'
    )
    .all(f.authorTaskId);
  const a = db.prepare('SELECT * FROM attempts WHERE id=? AND taskId=?').get(i.attemptId, i.taskId);
  const t = db
    .prepare('SELECT t.model,g.* FROM tasks t JOIN goal_tasks g ON g.taskId=t.id WHERE t.id=?')
    .get(i.taskId);
  requireValue(
    t?.goalId === i.goalId &&
      t.provider === 'claude' &&
      t.specVersion === 1 &&
      t.model === admission.claudeModel &&
      admission.maxAttempts === 2 &&
      author.length === 1 &&
      author[0].ordinal === 1 &&
      author[0].status === 'completed' &&
      author[0].driver === 'claude' &&
      author[0].closedMs !== null &&
      author[0].id === authorFinal?.evidence?.attemptId &&
      authorFinal.revisionId === i.candidate &&
      a?.ordinal === 1 &&
      a.status === 'recovery_needed' &&
      a.driver === 'claude' &&
      a.accountRoute === 'installed-claude' &&
      id(a.accountInstance) &&
      a.accountInstance === author[0].accountInstance &&
      a.accountInstance ===
        db.prepare("SELECT value FROM settings WHERE key='claude.accountInstance'").get()?.value &&
      id(a.executionId) &&
      id(a.nativeSessionId) &&
      a.nativeSessionId !== author[0].nativeSessionId &&
      a.executionId !== author[0].executionId &&
      a.requestedModel === t.model &&
      !a.modelRerouted &&
      (!a.observedModel || a.observedModel === t.model) &&
      !a.nativeResultId &&
      !db
        .prepare(
          'SELECT 1 FROM claude_results WHERE attemptId=? UNION ALL SELECT 1 FROM task_final_outputs WHERE attemptId=?'
        )
        .get(a.id, a.id),
    'The original author or uncertain reviewer lacks its exact nonterminal native identity.'
  );
  const c = db
    .prepare(
      `SELECT c.*,t.manifest AS context,t.digest AS retainedContext,b.digest AS pin,b.manifest AS baseline
    FROM attempt_configs c JOIN task_contexts t ON t.taskId=? AND t.ordinal=?
    JOIN provider_config_baselines b ON b.driver=c.driver AND b.scope=c.scope WHERE c.attemptId=?`
    )
    .get(i.taskId, a.ordinal, a.id);
  requireValue(
    c?.driver === 'claude' &&
      c.digest === c.pin &&
      c.manifest === c.baseline &&
      configDigest(c.manifest) === c.digest &&
      configDigest(c.context) === c.contextDigest &&
      c.contextDigest === c.retainedContext &&
      matchProjectProfile(c.driver, c.scope, JSON.parse(c.manifest)) === 'reviewer',
    'Retired reviewer configuration or context is unavailable.'
  );
  const context = JSON.parse(c.context),
    subject = context.projectChange;
  requireValue(
    subject?.role === 'reviewer' &&
      subject.revisionId === i.candidate &&
      subject.operationId === f.operationId &&
      subject.goalId === i.goalId &&
      context.taskId === i.taskId &&
      context.goalId === i.goalId &&
      context.ordinal === a.ordinal &&
      context.provider === 'claude' &&
      context.requestedModel === t.model &&
      context.accountInstance === a.accountInstance &&
      context.scopeVersion === 1 &&
      context.specVersion === t.specVersion,
    'Reviewer dispatch context lost its exact role.'
  );
  const operations = db
    .prepare('SELECT * FROM project_tool_operations WHERE attemptId=? ORDER BY rowid')
    .all(a.id);
  requireValue(
    operations.every(
      (o) =>
        o.taskId === i.taskId &&
        o.goalId === i.goalId &&
        o.role === 'reviewer' &&
        ['list_files', 'read_file', 'run_check'].includes(o.tool) &&
        o.revisionBefore === i.candidate &&
        o.revisionAfter === i.candidate
    ),
    'Prior reviewer operation exceeds the read-only candidate.'
  );
  return {
    f,
    a,
    admission,
    subject,
    author: author[0],
    identity: {
      ordinal: a.ordinal,
      nextOrdinal: a.ordinal + 1,
      executionId: a.executionId,
      sessionId: a.nativeSessionId,
      accountInstance: a.accountInstance,
      authorAttemptId: author[0].id,
      contextDigest: c.contextDigest,
      configDigest: c.digest,
      toolOperationsDigest: hash(operations),
      toolOperationCount: operations.length
    }
  };
}
export function clockAndControl(db, i, { historical = false } = {}) {
  const clock = db
    .prepare('SELECT * FROM timed_attempts WHERE attemptId=? AND goalId=?')
    .get(i.attemptId, i.goalId);
  requireValue(clock, 'Missing reviewer clock.');
  // A later reviewer can acquire a separate control; only the old attempt's linked control belongs to this retirement.
  const controls = historical
    ? db
        .prepare('SELECT * FROM task_controls WHERE taskId=? AND id=?')
        .all(i.taskId, clock.interruptControl)
    : db.prepare('SELECT * FROM task_controls WHERE taskId=? ORDER BY id').all(i.taskId);
  requireValue(
    controls.length === 1 &&
      controls[0].id === clock.interruptControl &&
      clock.interruptControl === 'active-time/' + i.attemptId &&
      controls[0].kind === 'task.cancel',
    'A separate reviewer control or missing budget interrupt requires inspection.'
  );
  return { clock, control: controls[0] };
}
export function verifyProjectReviewRecovery(db, goalId) {
  const receipts = db
    .prepare("SELECT * FROM command_receipts WHERE json_extract(receipt,'$.recovery.goalId')=?")
    .all(goalId);
  const anchors = db
    .prepare(
      "SELECT type,taskId FROM activity WHERE goalId=? AND type GLOB 'project.review.retired/*'"
    )
    .all(goalId);
  if (!receipts.length) {
    const budget = db
      .prepare(
        `SELECT p.input,u.attemptLimit,u.attemptsUsed,t.maxActiveSeconds FROM project_changes p
      JOIN goal_allowance_usage u ON u.goalId=p.goalId JOIN time_budgets t ON t.goalId=p.goalId WHERE p.goalId=?`
      )
      .get(goalId);
    const prior = budget && JSON.parse(budget.input);
    const retired = db
      .prepare(
        `SELECT 1 FROM task_controls c JOIN goal_tasks g ON g.taskId=c.taskId WHERE g.goalId=? AND c.state='retired-unknown'`
      )
      .get(goalId);
    requireValue(
      !anchors.length &&
        !retired &&
        (!budget ||
          (budget.attemptLimit === prior.maxAttempts &&
            budget.maxActiveSeconds === prior.maxActiveSeconds &&
            budget.attemptsUsed <= prior.maxAttempts)),
      'Missing reviewer retirement record.'
    );
    return null;
  }
  const r = JSON.parse(receipts[0].receipt).recovery,
    {
      goalId: g,
      taskId,
      attemptId,
      candidate,
      expectedLimit,
      additionalAttempts,
      additionalActiveSeconds,
      reason
    } = r;
  const i = normalizeProjectReviewRetry({
    goalId: g,
    taskId,
    attemptId,
    candidate,
    expectedLimit,
    additionalAttempts,
    additionalActiveSeconds,
    reason
  });
  const { identity, author, admission } = historicalBinding(db, i),
    { clock, control } = clockAndControl(db, i, { historical: true });
  const newControl = { ...r.previousControl, state: 'retired-unknown' };
  const max = db.prepare('SELECT maxActiveSeconds FROM time_budgets WHERE goalId=?').get(goalId);
  const allowance = db.prepare('SELECT * FROM goal_allowance_usage WHERE goalId=?').get(goalId);
  requireValue(
    r.goalId === goalId &&
      anchors.length === 1 &&
      anchors[0].type === 'project.review.retired/' + hash(r) &&
      anchors[0].taskId === r.taskId &&
      receipts.length === 1 &&
      receipts[0].operationId === r.operationId &&
      receipts[0].digest === hash(['project.review.retry', i]) &&
      same(JSON.parse(receipts[0].receipt), { operationId: r.operationId, recovery: r }) &&
      r.disposition === disposition &&
      fenceValid(r.fence) &&
      Object.entries(identity).every(([k, v]) => r[k] === v) &&
      r.originalMaxActiveSeconds === admission.maxActiveSeconds &&
      r.previousControl.state === 'unconfirmed' &&
      same(newControl, { ...control }) &&
      Number.isSafeInteger(clock.closedMs) &&
      clock.closedMs === r.closedMs &&
      r.accruedMs === author.closedMs - author.startedMs + clock.closedMs - clock.startedMs &&
      max.maxActiveSeconds === r.maxActiveSeconds &&
      r.maxActiveSeconds === Math.floor(r.accruedMs / 1000) + 300 &&
      r.attemptLimit === 3 &&
      allowance.attemptLimit === 3 &&
      [2, 3].includes(allowance.attemptsUsed),
    'Retained reviewer retirement, time or scope evidence differs.'
  );
  return r;
}
export function verifyProjectReviewRecoveries(db) {
  const rows = db
    .prepare(
      `SELECT goalId FROM project_changes UNION SELECT goalId FROM activity WHERE type GLOB 'project.review.retired/*'
     UNION SELECT g.goalId FROM task_controls c JOIN goal_tasks g ON g.taskId=c.taskId WHERE c.state='retired-unknown'  UNION SELECT json_extract(receipt,'$.recovery.goalId')
    FROM command_receipts WHERE json_type(receipt,'$.recovery.goalId') IS NOT NULL`
    )
    .all();
  for (const { goalId } of rows) verifyProjectReviewRecovery(db, goalId);
}
