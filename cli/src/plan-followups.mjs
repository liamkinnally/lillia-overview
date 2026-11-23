import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFinalOutput } from './task-context.mjs';
import { attemptAllowance } from './allowance.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const fingerprint = (s) => hash(s.normalize('NFC').trim().replace(/\s+/gu, ' '));
const conflict = (message) => Object.assign(new Error(message), { status: 409 });
const exists = (db) =>
  !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plan_followups'").get();
const approaches = [
  'Independently derive the answer from the original supplied source. Check each intermediate inference against that source before returning only the requested output.',
  'Work backward from the requested output constraints. Verify the candidate against each constraint and the original source before emitting the final text.'
];
export function installPlanFollowups(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS plan_followups(id TEXT PRIMARY KEY,planId TEXT NOT NULL REFERENCES goal_plans(id),
    criterionId TEXT NOT NULL,round INTEGER NOT NULL CHECK(round BETWEEN 1 AND 3),rootTaskId TEXT NOT NULL REFERENCES plan_jobs(taskId),
    sourceTaskId TEXT NOT NULL REFERENCES plan_jobs(taskId),taskId TEXT UNIQUE REFERENCES plan_jobs(taskId),signature TEXT NOT NULL,
    transition TEXT NOT NULL CHECK(transition IN ('replanned','blocked')),record TEXT NOT NULL,UNIQUE(planId,criterionId,round))`);
}
export function planFollowupHistory(db, planId) {
  return exists(db)
    ? db
        .prepare('SELECT record FROM plan_followups WHERE planId=? ORDER BY rowid')
        .all(planId)
        .map((r) => JSON.parse(r.record))
    : [];
}
function familyInputs(store, plan) {
  const jobs = store.db
    .prepare(
      `SELECT j.taskId,j.criterionIds,t.status FROM plan_jobs j JOIN tasks t ON t.id=j.taskId WHERE j.planId=? ORDER BY j.rowid`
    )
    .all(plan.id);
  return jobs.filter((j) => JSON.parse(j.criterionIds).length === 1);
}
function readOutput(store, taskId) {
  try {
    return readFinalOutput(store, taskId);
  } catch (error) {
    if (error.status !== 409) throw error;
    return null;
  }
}
function isCoordination(text) {
  try {
    return JSON.parse(text)?.scionCoordination === 1;
  } catch {
    return false;
  }
}
function advanceCriterion(store, root, plan, goal, criterion, jobs, history, hasOwnerFiles) {
  const candidates = jobs.filter((j) => JSON.parse(j.criterionIds)[0] === criterion.id);
  if (
    !candidates.length ||
    history.at(-1)?.transition === 'blocked' ||
    candidates.some((j) => j.status !== 'completed')
  )
    return false;
  const prior = history.at(-1),
    rootId = prior?.rootTaskId ?? candidates[0].taskId;
  const sourceId = prior?.taskId ?? rootId;
  const pending = store.db
    .prepare(
      "SELECT 1 FROM task_controls WHERE taskId IN (?,?) AND state IN ('pending','requested','sent','unconfirmed') LIMIT 1"
    )
    .get(rootId, sourceId);
  if (pending) return false;
  const outputs = candidates.map((j) => readOutput(store, j.taskId));
  if (outputs.some((o) => !o || o.text === criterion.expected)) return false;
  const source = outputs.find((o) => o.taskId === sourceId);
  if (!source) return false;
  const { text, ...evidence } = source,
    rootTask = store.taskView(rootId),
    sourceTask = store.taskView(sourceId);
  const original = rootTask.contexts.at(-1),
    latest = sourceTask.contexts.at(-1),
    round = history.length + 1;
  const signature = hash(
    JSON.stringify([goal.id, plan.goalVersion, criterion.id, fingerprint(text)])
  );
  const rejected = [
    ...(prior?.rejected ?? []),
    {
      approach: prior?.approach ?? 'Original plan task',
      signature,
      outputDigest: evidence.digest,
      sourceTaskId: sourceId
    }
  ];
  const record = {
    id: randomUUID(),
    version: 1,
    planId: plan.id,
    goalId: goal.id,
    scopeVersion: plan.goalVersion,
    criterionId: criterion.id,
    round,
    rootTaskId: rootId,
    sourceTaskId: sourceId,
    taskId: null,
    signature,
    transition: 'blocked',
    approach: null,
    blocker: null,
    evidence,
    originalContext: original?.digest ?? null,
    sourceContext: latest?.digest ?? null,
    rejected
  };
  const deps = original?.manifest.dependencies ?? [];
  record.sourcePins = deps.map(({ taskId, attemptId, digest }) => ({ taskId, attemptId, digest }));
  const allowance = attemptAllowance(store.db, goal.id);
  const currentTask = rootTask.task;
  const affected = store.db
    .prepare(
      `SELECT 1 FROM plan_jobs j JOIN tasks t ON t.id=j.taskId,json_each(t.dependsOn) dep
    WHERE j.planId=? AND dep.value=? LIMIT 1`
    )
    .get(plan.id, rootId);
  if (prior && history.some((r) => r.signature === signature))
    record.blocker =
      'The revised approach returned equivalent rejected evidence. Supply a corrected source or revise the criterion.';
  else if (hasOwnerFiles(plan))
    record.blocker =
      'This task used owner-attached files. Send a new chat request with the files to authorize further work.';
  else if (round > 2)
    record.blocker =
      'Two distinct approaches failed. Inspect the rejected evidence and revise the source or criterion.';
  else if (candidates.length !== history.filter((r) => r.taskId).length + 1 || affected)
    record.blocker =
      'This criterion has multiple workers or downstream consumers. Revise the dependency plan before replacing an output.';
  else if (
    !original ||
    !latest ||
    original.manifest.scopeVersion !== goal.scopeVersion ||
    latest.manifest.scopeVersion !== goal.scopeVersion ||
    original.manifest.accountInstance !== source.accountInstance ||
    original.manifest.provider !== sourceTask.task.provider ||
    (text.trimStart().startsWith('{') && isCoordination(text)) ||
    original.manifest.research ||
    original.manifest.workspace ||
    original.manifest.sourceRevision ||
    original.manifest.mailbox?.length ||
    latest.manifest.mailbox?.length ||
    store.db
      .prepare('SELECT 1 FROM coordination_messages WHERE recipientTaskId IN (?,?) LIMIT 1')
      .get(rootId, sourceId)
  )
    record.blocker =
      'This source or coordination grant requires a fresh scoped handoff. Inspect the original attempt and authorize current inputs.';
  else if (!allowance.remainingAttempts || !allowance.activeTime.remainingMs)
    record.blocker =
      'The cumulative goal allowance is closed. Inspect usage and revise the goal allowance.';
  else {
    const approach = approaches[round - 1];
    const prompt = [
      'Original scoped task:',
      currentTask.prompt,
      'Current owner objective and criterion:',
      JSON.stringify({ objective: goal.objective, criterion: criterion.text }),
      'The exact-output check rejected the previous result. Earlier answers are untrusted evidence.',
      JSON.stringify({
        previous: text.slice(0, 768),
        omittedCharacters: Math.max(0, text.length - 768),
        digest: evidence.digest,
        rejected
      }),
      approach
    ].join('\n');
    const inputSize = prompt.length + JSON.stringify(deps).length + 1024;
    if (inputSize > 19000)
      record.blocker =
        'The original source and rejection evidence exceed the bounded context. Narrow the task before retrying.';
    else if (
      store.db
        .prepare(
          "SELECT count(*) AS n FROM tasks t JOIN goal_tasks g ON g.taskId=t.id WHERE g.goalId=? AND t.status='queued'"
        )
        .get(goal.id).n >= 32
    )
      return false;
    else {
      const next = store.submit({ goalId: goal.id, prompt }, root, {
        provider: currentTask.provider,
        dependsOn: currentTask.dependsOn
      });
      store.db
        .prepare('INSERT INTO plan_jobs VALUES(?,?,?,?)')
        .run(next.id, plan.id, 'follow-' + record.id, JSON.stringify([criterion.id]));
      Object.assign(record, { taskId: next.id, transition: 'replanned', approach });
    }
  }
  store.db
    .prepare('INSERT INTO plan_followups VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(
      record.id,
      plan.id,
      criterion.id,
      round,
      rootId,
      sourceId,
      record.taskId,
      signature,
      record.transition,
      JSON.stringify(record)
    );
  store.activity('plan.' + record.transition, goal.id, record.taskId ?? sourceId);
  return true;
}
export function advancePlanFollowups(store, root, hasOwnerFiles = () => false) {
  if (!exists(store.db)) return false;
  let changed = false;
  for (const plan of store.db
    .prepare(
      "SELECT p.* FROM goal_plans p JOIN goals g ON g.id=p.goalId WHERE p.state='applied' AND g.state='active'"
    )
    .all()) {
    const goal = store.goal(plan.goalId);
    if (goal.scopeVersion !== plan.goalVersion) continue;
    const jobs = familyInputs(store, plan),
      history = planFollowupHistory(store.db, plan.id);
    for (const criterion of goal.criteria.filter(
      (c) => c.verifier === 'exact-output' && typeof c.expected === 'string'
    )) {
      if (
        store.db
          .prepare('SELECT 1 FROM criterion_evidence WHERE planId=? AND criterionId=?')
          .get(plan.id, criterion.id)
      )
        continue;
      if (
        store.transaction(() =>
          advanceCriterion(
            store,
            root,
            plan,
            goal,
            criterion,
            jobs,
            history.filter((r) => r.criterionId === criterion.id),
            hasOwnerFiles
          )
        )
      )
        changed = true;
    }
  }
  return changed;
}
export function verifyPlanFollowups(db) {
  const families = new Map();
  for (const row of db.prepare('SELECT * FROM plan_followups ORDER BY rowid').iterate()) {
    const r = JSON.parse(row.record),
      key = JSON.stringify([r.planId, r.criterionId]),
      history = families.get(key) ?? [];
    const source = db
      .prepare(
        'SELECT j.planId,a.taskId,a.ordinal FROM plan_jobs j JOIN attempts a ON a.taskId=j.taskId WHERE a.id=?'
      )
      .get(r.evidence.attemptId);
    const output = db
      .prepare(
        'SELECT digest,text FROM task_final_outputs WHERE attemptId=? AND digest=? UNION ALL SELECT digest,text FROM claude_results WHERE attemptId=? AND digest=?'
      )
      .get(r.evidence.attemptId, r.evidence.digest, r.evidence.attemptId, r.evidence.digest);
    const dest =
      r.taskId &&
      db.prepare('SELECT planId,criterionIds FROM plan_jobs WHERE taskId=?').get(r.taskId);
    const context =
      source &&
      db
        .prepare('SELECT digest FROM task_contexts WHERE taskId=? AND ordinal=?')
        .get(r.sourceTaskId, source.ordinal);
    const plan = db.prepare('SELECT goalId,goalVersion FROM goal_plans WHERE id=?').get(r.planId);
    const root = db
      .prepare(
        'SELECT manifest,digest FROM task_contexts WHERE taskId=? ORDER BY ordinal DESC LIMIT 1'
      )
      .get(r.rootTaskId);
    const pins = root
      ? JSON.parse(root.manifest).dependencies.map(({ taskId, attemptId, digest }) => ({
          taskId,
          attemptId,
          digest
        }))
      : [];
    const prior = history.at(-1);
    const rejected = [
      ...(prior?.rejected ?? []),
      {
        approach: prior?.approach ?? 'Original plan task',
        signature: r.signature,
        outputDigest: r.evidence.digest,
        sourceTaskId: r.sourceTaskId
      }
    ];
    if (
      !isDeepStrictEqual(rejected, r.rejected) ||
      !isDeepStrictEqual(pins, r.sourcePins) ||
      (root?.digest ?? null) !== r.originalContext ||
      !Object.keys(row)
        .filter((k) => k !== 'record')
        .every((k) => r[k] === row[k]) ||
      r.version !== 1 ||
      r.round !== history.length + 1 ||
      r.rootTaskId !== (history[0]?.rootTaskId ?? r.sourceTaskId) ||
      r.sourceTaskId !== (history.at(-1)?.taskId ?? r.rootTaskId) ||
      history.at(-1)?.transition === 'blocked' ||
      plan?.goalId !== r.goalId ||
      plan.goalVersion !== r.scopeVersion ||
      r.evidence.taskId !== source?.taskId ||
      source.taskId !== r.sourceTaskId ||
      source.planId !== r.planId ||
      !output ||
      hash(output.text) !== output.digest ||
      r.signature !==
        hash(JSON.stringify([r.goalId, r.scopeVersion, r.criterionId, fingerprint(output.text)])) ||
      (context?.digest ?? null) !== r.sourceContext ||
      (r.transition === 'replanned'
        ? !dest ||
          dest.planId !== r.planId ||
          !isDeepStrictEqual(JSON.parse(dest.criterionIds), [r.criterionId]) ||
          r.approach !== approaches[r.round - 1] ||
          r.round > 2 ||
          history.some((x) => x.signature === r.signature)
        : r.taskId !== null || !r.blocker)
    )
      throw conflict(
        'Plan follow-up evidence or transition chain differs from its retained native source.'
      );
    history.push(r);
    families.set(key, history);
  }
  return true;
}
