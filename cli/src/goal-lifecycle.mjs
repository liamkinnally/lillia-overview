import { randomUUID } from 'node:crypto';

export const steeringCommands = new Set(['goal.pause', 'goal.resume', 'goal.cancel', 'goal.amend']);
const conflict = (message) => Object.assign(new Error(message), { status: 409 });

export function goalRevisionPage(db, id, { afterVersion = 0, historyLimit = 8 } = {}) {
  if (
    !Number.isSafeInteger(afterVersion) ||
    afterVersion < 0 ||
    !Number.isInteger(historyLimit) ||
    historyLimit < 1 ||
    historyLimit > 16
  )
    throw Object.assign(
      new Error('Select a nonnegative version cursor and a history limit of 1 to 16.'),
      { status: 400 }
    );
  const rows = db
    .prepare('SELECT * FROM goal_revisions WHERE id=? AND version>? ORDER BY version LIMIT ?')
    .all(id, afterVersion, historyLimit + 1);
  const revisions = rows
    .slice(0, historyLimit)
    .map((row) => ({ ...row, criteria: JSON.parse(row.criteria) }));
  return {
    revisions,
    revisionCursor: rows.length > historyLimit ? revisions.at(-1).version : null
  };
}

export function makeCriteria(criteria) {
  return criteria.map((value) =>
    typeof value === 'string'
      ? { id: randomUUID(), text: value, verifier: 'local-owner', evidence: [] }
      : {
          id: randomUUID(),
          text: 'Return the exact text ' + JSON.stringify(value.expected),
          verifier: 'exact-output',
          expected: value.expected,
          evidence: []
        }
  );
}

export function installGoalHistory(db) {
  db.exec(`
    CREATE TABLE goal_revisions (
      id TEXT NOT NULL, version INTEGER NOT NULL, objective TEXT NOT NULL, criteria TEXT NOT NULL,
      state TEXT NOT NULL, changeKind TEXT NOT NULL, createdAt TEXT NOT NULL, PRIMARY KEY(id,version)
    );
    INSERT INTO goal_revisions SELECT id,version,objective,criteria,state,'created',createdAt FROM goals;
    CREATE TRIGGER goal_created AFTER INSERT ON goals BEGIN
      INSERT INTO goal_revisions VALUES(NEW.id,NEW.version,NEW.objective,NEW.criteria,NEW.state,'created',NEW.createdAt);
    END;
    ALTER TABLE attempts ADD COLUMN accountInstance TEXT;
    CREATE TRIGGER bind_attempt_account AFTER INSERT ON attempts BEGIN
      UPDATE attempts SET accountInstance=(SELECT value FROM settings WHERE key='codex.accountInstance') WHERE id=NEW.id;
    END;
  `);
}

const workflowTables = {
  project_changes: ['authorTaskId', 'reviewerTaskId'],
  change_flows: ['authorTaskId', 'reviewerTaskId'],
  native_goals: ['authorTaskId', 'reviewerTaskId'],
  harness_git_inspections: ['requestTaskId', 'consumerTaskId']
};
const soleCriterion = {
  project_changes: 'reviewed-project-change',
  change_flows: 'reviewed-git-change',
  native_goals: 'reviewed-native-change',
  harness_git_inspections: 'mediated-git-read'
};
const exists = (db, table) =>
  !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table);

function soleBlockedWorkflow(store, id, table) {
  const db = store.db,
    goal = store.goal(id);
  const row = db.prepare('SELECT * FROM ' + table + ' WHERE goalId=?').get(id);
  if (
    row?.stage !== 'blocked' ||
    goal.scopeVersion !== (row.scopeVersion ?? 1) ||
    goal.criteria.length !== 1 ||
    goal.criteria[0].verifier !== soleCriterion[table]
  )
    return false;
  for (const other of Object.keys(workflowTables)) {
    if (
      other !== table &&
      exists(db, other) &&
      db.prepare('SELECT 1 FROM ' + other + ' WHERE goalId=?').get(id)
    )
      return false;
  }
  if (
    db
      .prepare('SELECT 1 FROM goal_plans WHERE goalId=? AND goalVersion=?')
      .get(id, goal.scopeVersion)
  )
    return false;
  const owned = workflowTables[table].map((key) => row[key]).filter(Boolean);
  if (table === 'native_goals' && exists(db, 'native_objective_plans')) {
    const plan = db.prepare('SELECT taskId FROM native_objective_plans WHERE goalId=?').get(id);
    if (plan) owned.push(plan.taskId);
  }
  return !db
    .prepare(
      `SELECT 1 FROM goal_tasks g JOIN tasks t ON t.id=g.taskId WHERE g.goalId=? AND (
    t.status IN ('starting','running','waiting_for_input','interrupting') OR (t.status='recovery_needed' AND t.recoveryCleared=0)
    OR (t.status IN ('queued','blocked') AND t.id NOT IN (SELECT value FROM json_each(?)))
    OR EXISTS(SELECT 1 FROM task_controls c WHERE c.taskId=t.id AND c.state IN ('pending','requested','sent','unconfirmed'))
    OR EXISTS(SELECT 1 FROM coordination_messages m WHERE m.recipientTaskId=t.id AND m.resolutionRequired=1 AND m.resolution IS NULL)
    OR EXISTS(SELECT 1 FROM agent_workspaces w WHERE w.taskId=t.id AND w.state='uncertain')) LIMIT 1`
    )
    .get(id, JSON.stringify(owned));
}

function recordWorkflowState(store, goal, state, kind) {
  if (!store.db.isTransaction)
    throw new Error('Goal workflow transition requires a writer transaction.');
  store.db.prepare('UPDATE goals SET state=?,version=version+1 WHERE id=?').run(state, goal.id);
  store.db
    .prepare(
      'INSERT INTO goal_revisions SELECT id,version,objective,criteria,state,?,? FROM goals WHERE id=?'
    )
    .run(kind, new Date().toISOString(), goal.id);
  store.activity(kind, goal.id);
}

export function blockWorkflowGoal(store, table, id) {
  if (!Object.hasOwn(workflowTables, table)) throw new Error('Unknown goal workflow.');
  const goal = store.goal(id);
  if (goal.state !== 'active' || !soleBlockedWorkflow(store, id, table)) return false;
  recordWorkflowState(store, goal, 'blocked', 'goal.blocked');
  return true;
}

// Earlier live stores and delayed terminal ownership can leave a phase ahead of its goal.
export function reconcileBlockedWorkflows(store, table) {
  if (!Object.hasOwn(workflowTables, table)) throw new Error('Unknown goal workflow.');
  const rows = store.db
    .prepare(
      'SELECT w.goalId FROM ' +
        table +
        " w JOIN goals g ON g.id=w.goalId WHERE w.stage='blocked' AND g.state='active'"
    )
    .all();
  if (!rows.length) return false;
  return store.transaction(() => {
    let changed = false;
    for (const { goalId } of rows) if (blockWorkflowGoal(store, table, goalId)) changed = true;
    return changed;
  });
}

export function reactivateForNativeRepair(store, id) {
  const goal = store.goal(id);
  if (goal.state === 'blocked' && soleBlockedWorkflow(store, id, 'native_goals')) {
    // The owner receipt transaction rolls this back unless the exact review and original allowance permit repair.
    recordWorkflowState(store, goal, 'active', 'goal.reactivated');
  }
}

// The caller holds the same transaction used for the owner command receipt.
export function steerGoal(store, adapter, name, input) {
  const goal = store.goal(input.id);
  if (goal.version !== input.expectedVersion)
    throw conflict('Goal changed. Inspect the current version before steering.');
  if (goal.state === 'cancelled' || goal.state === 'completed')
    throw conflict('This goal is already terminal.');
  if (name === 'goal.resume' && goal.state !== 'paused')
    throw conflict('Only a paused goal can be resumed.');
  if (name === 'goal.pause' && goal.state === 'paused')
    throw conflict('This goal is already paused.');
  const states = { 'goal.pause': 'paused', 'goal.resume': 'active', 'goal.cancel': 'cancelled' };
  let state = states[name] ?? goal.state;
  if (name === 'goal.resume') {
    const previous = store.db
      .prepare(
        "SELECT state FROM goal_revisions WHERE id=? AND state!='paused' ORDER BY version DESC LIMIT 1"
      )
      .get(goal.id);
    if (
      previous?.state === 'blocked' ||
      Object.keys(workflowTables).some(
        (table) => exists(store.db, table) && soleBlockedWorkflow(store, goal.id, table)
      )
    )
      state = 'blocked';
  }
  const objective = input.objective ?? goal.objective;
  const criteria = input.criteria ? makeCriteria(input.criteria) : goal.criteria;
  const version = goal.version + 1;
  const serialized = JSON.stringify(criteria);
  store.db
    .prepare('UPDATE goals SET version=?,objective=?,criteria=?,state=? WHERE id=?')
    .run(version, objective, serialized, state, goal.id);
  store.db
    .prepare('INSERT INTO goal_revisions VALUES(?,?,?,?,?,?,?)')
    .run(goal.id, version, objective, serialized, state, name, new Date().toISOString());
  const controls = [];
  if (name !== 'goal.resume') {
    const tasks = store.db
      .prepare(
        `SELECT t.id,t.status FROM tasks t JOIN goal_tasks g ON g.taskId=t.id
      WHERE g.goalId=? AND t.status IN ('queued','blocked','starting','running','waiting_for_input')`
      )
      .all(goal.id);
    for (const row of tasks) {
      const active = adapter.active?.has(row.id);
      const retireQueued = name !== 'goal.pause' && ['queued', 'blocked'].includes(row.status);
      if (!active && !retireQueued) continue;
      const task = { ...row, goalId: goal.id };
      const action = store.reserveControl(randomUUID(), 'task.cancel', task);
      controls.push({ action, task });
    }
  }
  store.activity(name, goal.id);
  return { goal: store.goal(goal.id), controls };
}
