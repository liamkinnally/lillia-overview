import { randomUUID } from 'node:crypto';
import { readFinalOutput } from './task-context.mjs';

const conflict = (message) => Object.assign(new Error(message), { status: 409 });
const supportedFields = new Set(['id', 'text', 'evidence', 'verifier', 'expected']);

export function installEvaluation(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS criterion_evidence (
      id TEXT PRIMARY KEY, goalId TEXT NOT NULL REFERENCES goals(id),
      planId TEXT NOT NULL REFERENCES goal_plans(id), criterionId TEXT NOT NULL,
      attemptId TEXT NOT NULL REFERENCES attempts(id), record TEXT NOT NULL,
      UNIQUE(planId,criterionId,attemptId)
    );
    CREATE INDEX IF NOT EXISTS evidence_by_goal ON criterion_evidence(goalId);
    CREATE TABLE IF NOT EXISTS goal_completions (
      goalId TEXT PRIMARY KEY REFERENCES goals(id), snapshot TEXT NOT NULL
    );
  `);
}

function verifier(criterion) {
  // An unfamiliar policy (including a model requirement) needs its own verifier.
  if (Object.keys(criterion).some((key) => !supportedFields.has(key))) return null;
  if (criterion.verifier === 'exact-output' && typeof criterion.expected === 'string')
    return 'exact-output';
  if (
    (criterion.verifier === undefined || criterion.verifier === 'local-owner') &&
    criterion.expected === undefined
  )
    return 'local-owner';
  return null;
}

export class GoalEvaluation {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }

  view(id, scopes = null) {
    const scopeList = scopes === null ? null : JSON.stringify(scopes);
    const scopeFilter =
      ' AND (? IS NULL OR e.planId IN (SELECT id FROM goal_plans WHERE goalVersion IN (SELECT value FROM json_each(?))))';
    const rows = this.db
      .prepare(
        'SELECT e.record FROM criterion_evidence e WHERE e.goalId=?' +
          scopeFilter +
          ' ORDER BY e.rowid'
      )
      .all(id, scopeList, scopeList);
    const row = this.db.prepare('SELECT snapshot FROM goal_completions WHERE goalId=?').get(id);
    // A provider may report an actual model after an immutable verification or
    // completion. Expose that observation separately from what was known then.
    const observations = this.db
      .prepare(
        `SELECT DISTINCT a.id AS attemptId,a.requestedModel,a.observedModel,a.modelRerouted
      FROM criterion_evidence e JOIN attempts a ON a.id=e.attemptId
      WHERE e.goalId=?` +
          scopeFilter +
          ' ORDER BY a.id'
      )
      .all(id, scopeList, scopeList);
    return {
      completion: row ? JSON.parse(row.snapshot) : null,
      evidence: rows.map(({ record }) => JSON.parse(record)),
      currentModelObservations: observations.map((entry) => ({
        ...entry,
        modelRerouted: Boolean(entry.modelRerouted)
      }))
    };
  }

  plan(goal) {
    return this.db
      .prepare("SELECT * FROM goal_plans WHERE goalId=? AND goalVersion=? AND state='applied'")
      .get(goal.id, goal.scopeVersion);
  }

  record(goal, plan, criterion, output, kind, note) {
    const prior = this.db
      .prepare(
        'SELECT record FROM criterion_evidence WHERE planId=? AND criterionId=? AND attemptId=?'
      )
      .get(plan.id, criterion.id, output.attemptId);
    if (prior) {
      const existing = JSON.parse(prior.record);
      if (existing.digest !== output.digest || existing.verifier !== kind || existing.note !== note)
        throw conflict(
          'An existing verification of this attempt has different evidence or review notes.'
        );
      return existing;
    }
    const { text, ...source } = output;
    const attempt = this.db
      .prepare(
        'SELECT driver,accountRoute,requestedModel,observedModel,modelRerouted FROM attempts WHERE id=?'
      )
      .get(output.attemptId);
    const record = {
      id: randomUUID(),
      goalId: goal.id,
      scopeVersion: goal.scopeVersion,
      planId: plan.id,
      criterionId: criterion.id,
      verifier: kind,
      note,
      ...source,
      driver: attempt.driver,
      accountRoute: attempt.accountRoute,
      observedModel: attempt.observedModel,
      requestedModel: attempt.requestedModel,
      modelRerouted: Boolean(attempt.modelRerouted),
      verifiedAt: new Date().toISOString()
    };
    this.db
      .prepare('INSERT INTO criterion_evidence VALUES(?,?,?,?,?,?)')
      .run(record.id, goal.id, plan.id, criterion.id, output.attemptId, JSON.stringify(record));
    this.store.activity('criterion.verified', goal.id, output.taskId);
    return record;
  }

  // The calling owner command holds its receipt transaction.
  accept(input) {
    const goal = this.store.goal(input.id);
    if (goal.state !== 'active' || goal.version !== input.expectedVersion)
      throw conflict('Inspect the current active goal version before verification.');
    const criterion = goal.criteria.find((c) => c.id === input.criterionId);
    if (!criterion || verifier(criterion) !== 'local-owner')
      throw conflict('This criterion cannot be verified by owner judgement.');
    if (typeof input.note !== 'string' || !input.note.trim())
      throw conflict('Record the basis for owner verification.');
    const plan = this.plan(goal);
    const job =
      plan &&
      this.db
        .prepare('SELECT criterionIds FROM plan_jobs WHERE planId=? AND taskId=?')
        .get(plan.id, input.taskId);
    if (
      !job ||
      input.taskId === plan.plannerTaskId ||
      !JSON.parse(job.criterionIds).includes(criterion.id)
    )
      throw conflict('Choose a worker assigned this criterion in the current applied plan.');
    const output = readFinalOutput(this.store, input.taskId);
    const evidence = this.record(goal, plan, criterion, output, 'local-owner', input.note);
    this.evaluate(goal, plan);
    return evidence;
  }

  advance() {
    const ids = this.db
      .prepare(
        `SELECT DISTINCT g.id FROM goals g JOIN goal_plans p ON p.goalId=g.id
      WHERE g.state='active' AND p.state='applied'`
      )
      .all();
    for (const { id } of ids)
      this.store.transaction(() => {
        const goal = this.store.goal(id);
        const plan = this.plan(goal);
        if (goal.state === 'active' && plan) this.evaluate(goal, plan);
      });
  }

  evaluate(goal, plan) {
    const jobs = this.db
      .prepare('SELECT taskId,criterionIds FROM plan_jobs WHERE planId=? ORDER BY rowid')
      .all(plan.id);
    if (!jobs.length || !goal.criteria.length) return;
    const sources = new Map();
    const assigned = new Map();
    for (const job of jobs) {
      if (job.taskId === plan.plannerTaskId) return;
      const ids = new Set(JSON.parse(job.criterionIds));
      assigned.set(job.taskId, ids);
      let output;
      try {
        output = readFinalOutput(this.store, job.taskId);
      } catch (error) {
        if (error.status === 409) continue;
        throw error;
      }
      sources.set(job.taskId, output);
      for (const criterion of goal.criteria) {
        if (
          ids.has(criterion.id) &&
          verifier(criterion) === 'exact-output' &&
          output.text === criterion.expected
        )
          this.record(goal, plan, criterion, output, 'exact-output', null);
      }
    }
    if (sources.size !== jobs.length) return;
    const stillOpen = this.db
      .prepare(
        `SELECT 1 FROM tasks t JOIN goal_tasks g ON g.taskId=t.id WHERE g.goalId=? AND (
      (g.goalVersion>=? AND t.status!='completed') OR t.status IN ('starting','running','waiting_for_input','interrupting','recovery_needed')
      OR EXISTS(SELECT 1 FROM task_controls c WHERE c.taskId=t.id AND (
        c.state IN ('pending','requested','sent') OR (c.kind='task.cancel' AND c.state='unconfirmed')
      ))
    ) LIMIT 1`
      )
      .get(goal.id, goal.scopeVersion);
    if (stillOpen) return;
    const rows = this.db
      .prepare('SELECT record FROM criterion_evidence WHERE goalId=? AND planId=? ORDER BY rowid')
      .all(goal.id, plan.id);
    const evidence = rows
      .map((row) => JSON.parse(row.record))
      .filter((record) => {
        const output = sources.get(record.taskId);
        const criterion = goal.criteria.find((c) => c.id === record.criterionId);
        return (
          criterion &&
          verifier(criterion) === record.verifier &&
          assigned.get(record.taskId)?.has(criterion.id) &&
          record.attemptId === output?.attemptId &&
          record.digest === output.digest &&
          record.itemId === output.itemId
        );
      });
    const criteria = goal.criteria.map((criterion) => ({
      ...criterion,
      evidence: evidence.filter((e) => e.criterionId === criterion.id).map((e) => e.id)
    }));
    if (criteria.some((c) => !c.evidence.length)) return;
    const version = goal.version + 1;
    const completedAt = new Date().toISOString();
    const snapshot = {
      goalId: goal.id,
      version,
      verifiedGoalVersion: goal.version,
      scopeVersion: goal.scopeVersion,
      planId: plan.id,
      objective: goal.objective,
      criteria,
      evidence,
      completedAt,
      policy: 'supplied-text-v1',
      requiredJobs: [...sources.values()].map(({ text, ...reference }) => reference)
    };
    this.db
      .prepare('INSERT INTO goal_completions VALUES(?,?)')
      .run(goal.id, JSON.stringify(snapshot));
    this.db
      .prepare("UPDATE goals SET state='completed',version=?,criteria=? WHERE id=?")
      .run(version, JSON.stringify(criteria), goal.id);
    this.db
      .prepare("INSERT INTO goal_revisions VALUES(?,?,?,?,'completed','goal.completed',?)")
      .run(goal.id, version, goal.objective, JSON.stringify(criteria), completedAt);
    this.store.activity('goal.completed', goal.id);
  }
}
