import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { readFinalOutput } from './task-context.mjs';
import { NativeStore } from './native-store.mjs';
import { nativePolicyAt, requireReview as need } from './native-policy.mjs';
import { jsGrant } from './native-javascript.mjs';

const sha = (x) => createHash('sha256').update(x).digest('hex');
const strings = { type: 'array', items: { type: 'string' } };
export const nativeObjectiveOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['steps', 'validation', 'limitations'],
  properties: { steps: strings, validation: strings, limitations: strings }
};
export const nativeObjectiveTables = ['native_objective_plans'];
export function installNativeObjectivePlanning(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS native_objective_plans(goalId TEXT PRIMARY KEY REFERENCES native_goals(goalId),
    taskId TEXT UNIQUE NOT NULL REFERENCES goal_tasks(taskId),packet TEXT NOT NULL,record TEXT);`);
}
export function normalizeObjectivePlan(raw) {
  need(
    raw &&
      typeof raw === 'object' &&
      Object.keys(raw).sort().join(',') === 'limitations,steps,validation',
    'Planner must return exactly steps, validation and limitations'
  );
  const out = {};
  for (const [key, min, max] of [
    ['steps', 1, 6],
    ['validation', 1, 4],
    ['limitations', 0, 4]
  ]) {
    const list = raw[key];
    need(
      Array.isArray(list) &&
        list.length >= min &&
        list.length <= max &&
        list.every(
          (x) =>
            typeof x === 'string' &&
            x.isWellFormed() &&
            x.trim() &&
            Buffer.byteLength(x) <= 400 &&
            !/[\x00-\x1f\x7f]/.test(x)
        ),
      'Invalid bounded planner ' + key
    );
    out[key] = [...list];
  }
  return out;
}
export function plannerPacket({
  goalId,
  scopeVersion,
  repository,
  base,
  path,
  objective,
  checks,
  javascript
}) {
  return JSON.stringify({
    kind: 'native-objective-plan-v1',
    goalId,
    scopeVersion,
    repository,
    base,
    path,
    objective,
    checks: checks.map((c) => c.kind),
    ...(javascript
      ? { javascript: { exportName: javascript.exportName, caseCount: javascript.cases.length } }
      : {}),
    instruction:
      'Propose work for the authorized path only. Source bytes and research are unavailable to this role. Return only JSON with steps (1 to 6 strings), validation (1 to 4 strings), and limitations (0 to 4 strings), each up to 400 UTF-8 bytes. Describe proposed work, not results. Do not use tools or grant authority.'
  });
}
export function authorizedPlannerPacket(db, f, a) {
  return plannerPacket({
    ...f.admission,
    goalId: f.goalId,
    scopeVersion: f.scopeVersion,
    repository: f.repository,
    checks: a.checks,
    javascript: jsGrant(db, f.admission, a)
  });
}
export function createObjectivePlan(store, f, a, root) {
  need(
    store.db.isTransaction && f.admission.plannerProvider === 'codex',
    'Expected explicit native Codex planner admission'
  );
  const packet = authorizedPlannerPacket(store.db, f, a),
    task = store.submit({ goalId: f.goalId, prompt: packet, provider: 'codex' }, root);
  store.db
    .prepare('INSERT INTO native_objective_plans VALUES(?,?,?,NULL)')
    .run(f.goalId, task.id, packet);
}
function plannerContext(db, taskId, ordinal, packet) {
  const ctx = db
      .prepare('SELECT * FROM task_contexts WHERE taskId=? AND ordinal=?')
      .get(taskId, ordinal),
    m = ctx && JSON.parse(ctx.manifest);
  need(
    m &&
      sha(ctx.manifest) === ctx.digest &&
      m.taskId === taskId &&
      m.provider === 'codex' &&
      m.input === packet &&
      m.promptDigest === sha(packet) &&
      !m.research &&
      !m.workspace &&
      !m.rollover &&
      !m.sourceRevision &&
      !m.sourcePath &&
      [m.dependencies, m.mailbox, m.coordinationRoutes].every((v) => Array.isArray(v) && !v.length),
    'Planner dispatch differs from its supplied scope'
  );
  return { m, contextDigest: ctx.digest };
}
function bind(row, evidence, text, scope) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    need(false, 'Planner final result must be a JSON object');
  }
  const guidance = normalizeObjectivePlan(raw);
  const body = {
    taskId: row.taskId,
    goalId: row.goalId,
    scopeVersion: scope,
    packetDigest: sha(row.packet),
    evidence,
    guidance
  };
  return { id: sha(JSON.stringify(['native-objective-plan-v1', body])), ...body };
}
export function authenticatedGuidance(store, f) {
  if (!f.admission.plannerProvider) return null;
  const row = store.db.prepare('SELECT * FROM native_objective_plans WHERE goalId=?').get(f.goalId);
  need(row?.record, 'An authenticated native plan is required');
  const { text, ...proof } = readFinalOutput(store, row.taskId);
  const { ordinal } = store.db
    .prepare('SELECT ordinal FROM attempts WHERE id=? AND taskId=?')
    .get(proof.attemptId, row.taskId);
  const { contextDigest } = plannerContext(store.db, row.taskId, ordinal, row.packet);
  const expected = bind(row, { ...proof, contextDigest }, text, f.scopeVersion);
  need(
    same(JSON.parse(row.record), expected),
    'The accepted native plan differs from the planner result'
  );
  return planGuidance(expected);
}
export function requireSeparatePlanner(db, goalId, evidence) {
  const row = db.prepare('SELECT record FROM native_objective_plans WHERE goalId=?').get(goalId);
  const planner = row?.record && JSON.parse(row.record).evidence;
  need(
    planner &&
      planner.taskId !== evidence.taskId &&
      planner.attemptId !== evidence.attemptId &&
      (!evidence.threadId || evidence.threadId !== planner.threadId),
    'Native planner requires a separate provider task, attempt and thread'
  );
}
export function planGuidance(row) {
  return row
    ? {
        id: row.id,
        steps: row.guidance.steps,
        validation: row.guidance.validation,
        limitations: row.guidance.limitations
      }
    : null;
}
export function planView(db, goalId) {
  const row = db
    .prepare('SELECT taskId,record FROM native_objective_plans WHERE goalId=?')
    .get(goalId);
  if (!row) return null;
  const { status } = db.prepare('SELECT status FROM tasks WHERE id=?').get(row.taskId);
  return { taskId: row.taskId, status, accepted: row.record ? JSON.parse(row.record) : null };
}
export function acceptObjectivePlan(store, f, a) {
  const db = store.db,
    row = db.prepare('SELECT * FROM native_objective_plans WHERE goalId=?').get(f.goalId);
  need(
    db.isTransaction &&
      f.stage === 'planner' &&
      row &&
      !row.record &&
      row.packet === authorizedPlannerPacket(db, f, a),
    'Planner no longer owns this goal scope'
  );
  const head = new NativeStore(store).ref({ repository: f.repository, name: 'mainline' });
  need(
    head.revisionId === f.admission.base,
    'Native mainline changed before planned author admission'
  );
  const { text, ...proof } = readFinalOutput(store, row.taskId);
  const attempt = db
    .prepare('SELECT ordinal FROM attempts WHERE id=? AND taskId=?')
    .get(proof.attemptId, row.taskId);
  const { m, contextDigest } = plannerContext(db, row.taskId, attempt.ordinal, row.packet);
  need(
    m.goalId === f.goalId &&
      m.scopeVersion === f.scopeVersion &&
      m.accountInstance === proof.accountInstance,
    'Planner goal scope or account changed'
  );
  const record = bind(row, { ...proof, contextDigest }, text, f.scopeVersion);
  db.prepare('UPDATE native_objective_plans SET record=? WHERE goalId=? AND record IS NULL').run(
    JSON.stringify(record),
    f.goalId
  );
  return record;
}
export function verifyNativeObjectivePlanning(db, checkEvidence) {
  let planners = 0,
    accepted = 0;
  for (const row of db.prepare('SELECT * FROM native_objective_plans').iterate()) {
    const f = db.prepare('SELECT * FROM native_goals WHERE goalId=?').get(row.goalId),
      input = JSON.parse(f.admission);
    const init = db.prepare('SELECT record FROM native_authority WHERE slot=1').get(),
      pin = db
        .prepare('SELECT digest FROM native_policy_enrollments WHERE goalId=?')
        .get(row.goalId);
    const a = nativePolicyAt(db, JSON.parse(init.record), pin.digest);
    const receipt = db
      .prepare('SELECT receipt FROM command_receipts WHERE operationId=?')
      .get(f.operationId);
    const admitted = JSON.parse(receipt.receipt).flow;
    const t = db
      .prepare(
        'SELECT t.prompt,t.status,g.* FROM tasks t JOIN goal_tasks g ON g.taskId=t.id WHERE t.id=?'
      )
      .get(row.taskId);
    need(
      input.plannerProvider === 'codex' &&
        a.repository === f.repository &&
        a.epoch === f.epoch &&
        admitted.planner?.taskId === row.taskId &&
        !admitted.planner.accepted &&
        admitted.stage === 'planner' &&
        !admitted.authorTaskId &&
        t.goalId === f.goalId &&
        t.provider === 'codex' &&
        t.specVersion === 1 &&
        t.goalVersion === f.scopeVersion &&
        row.packet === t.prompt &&
        row.packet === authorizedPlannerPacket(db, { ...f, admission: input }, a),
      'Native planner lost its owner admission or exact authorized packet'
    );
    for (const ctx of db
      .prepare('SELECT ordinal FROM task_contexts WHERE taskId=?')
      .iterate(row.taskId)) {
      const { m } = plannerContext(db, row.taskId, ctx.ordinal, row.packet);
      need(
        m.goalId === f.goalId && m.scopeVersion === f.scopeVersion,
        'Planner archived context scope changed'
      );
    }
    if (row.record) {
      const v = JSON.parse(row.record),
        p = v.evidence;
      checkEvidence(db, p);
      const finals = db
        .prepare(
          'SELECT itemId,digest,text FROM task_final_outputs WHERE attemptId=? AND threadId=? AND turnId=? LIMIT 2'
        )
        .all(p.attemptId, p.threadId, p.turnId);
      need(
        finals.length === 1 && finals[0].itemId === p.itemId && finals[0].digest === p.digest,
        'Archived native planner final is missing or ambiguous'
      );
      const [out] = finals;
      const attempt = db
        .prepare('SELECT * FROM attempts WHERE taskId=? ORDER BY ordinal DESC LIMIT 1')
        .get(row.taskId);
      need(attempt?.id === p.attemptId, 'The recorded planner is not the latest native attempt');
      const { m, contextDigest } = plannerContext(db, row.taskId, attempt.ordinal, row.packet);
      need(
        p.taskId === row.taskId &&
          p.goalVersion === t.goalVersion &&
          p.specVersion === t.specVersion &&
          p.digest === sha(out.text) &&
          t.status === 'completed' &&
          attempt.status === 'completed' &&
          p.threadId === attempt.threadId &&
          p.turnId === attempt.turnId &&
          m.accountInstance === p.accountInstance &&
          p.contextDigest === contextDigest &&
          same(v, bind(row, p, out.text, f.scopeVersion)) &&
          f.authorTaskId &&
          f.stage !== 'planner',
        'Accepted native plan differs from its final provider result'
      );
      const guide = planGuidance(v);
      for (const sub of db
        .prepare("SELECT record FROM native_submissions WHERE json_extract(record,'$.goalId')=?")
        .iterate(f.goalId)) {
        const revision = JSON.parse(sub.record);
        need(same(revision.objectivePlan, guide), 'Native submission lost its plan');
        requireSeparatePlanner(db, f.goalId, revision.author);
        for (const decision of db
          .prepare('SELECT record FROM native_reviews WHERE revisionId=?')
          .iterate(revision.id))
          requireSeparatePlanner(db, f.goalId, JSON.parse(decision.record).evidence);
      }
      for (const role of db
        .prepare(
          'SELECT r.role,t.prompt FROM native_roles r JOIN tasks t ON t.id=r.taskId WHERE r.goalId=?'
        )
        .iterate(row.goalId)) {
        const packet = JSON.parse(role.prompt);
        need(
          same((role.role === 'author' ? packet : packet.packet).objectivePlan, guide),
          'A native role lost its accepted plan'
        );
      }
      if (f.stage === 'completed')
        need(
          JSON.parse(f.evidence)?.objectivePlanId === v.id,
          'Completed native goal lost its accepted planner evidence'
        );
      accepted++;
    } else
      need(
        !f.authorTaskId &&
          !f.reviewerTaskId &&
          !f.revisionId &&
          ['planner', 'blocked', 'superseded'].includes(f.stage),
        'Unplanned native author or review was issued'
      );
    planners++;
  }
  need(
    !db
      .prepare(
        "SELECT 1 FROM native_goals n LEFT JOIN native_objective_plans p ON p.goalId=n.goalId WHERE json_extract(n.admission,'$.plannerProvider') IS NOT NULL AND p.goalId IS NULL LIMIT 1"
      )
      .get(),
    'An admitted native planner goal has no planner'
  );
  need(
    !db
      .prepare(
        `SELECT 1 FROM native_submissions s LEFT JOIN native_objective_plans p ON p.goalId=json_extract(s.record,'$.goalId')
    WHERE p.record IS NULL AND json_type(s.record,'$.objectivePlan') IS NOT NULL LIMIT 1`
      )
      .get(),
    'Native submission cites an unadmitted planner'
  );
  return { planners, accepted };
}
