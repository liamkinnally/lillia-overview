import { isDeepStrictEqual as same } from 'node:util';
import { hashRecord } from './native-policy.mjs';

const need = (ok, message, status = 409) => {
  if (!ok) throw Object.assign(new Error(message), { status });
};
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value, max) =>
  typeof value === 'string' &&
  value.isWellFormed() &&
  value.trim() &&
  !value.includes('\0') &&
  Buffer.byteLength(value) <= max;
export function normalizeProjectRepair(input) {
  const keys = [
    'rejectedGoalId',
    'expectedCandidate',
    'expectedReviewDigest',
    'repairInstructions',
    'maxAttempts',
    'maxActiveSeconds'
  ];
  need(
    input &&
      !Array.isArray(input) &&
      Object.keys(input).length === keys.length &&
      keys.every((key) => Object.hasOwn(input, key)) &&
      id(input.rejectedGoalId) &&
      hex(input.expectedCandidate) &&
      hex(input.expectedReviewDigest) &&
      text(input.repairInstructions, 4000) &&
      Number.isSafeInteger(input.maxAttempts) &&
      input.maxAttempts >= 2 &&
      input.maxAttempts <= 8 &&
      Number.isSafeInteger(input.maxActiveSeconds) &&
      input.maxActiveSeconds >= 1 &&
      input.maxActiveSeconds <= 1800,
    'Supply the exact rejected goal, candidate, review digest, repair instructions and bounded budget.',
    400
  );
  return Object.fromEntries(keys.map((key) => [key, input[key]]));
}
export function normalizeRetainedRepair(record, input) {
  const keys = [
    'version',
    'rejectedGoalId',
    'expectedCandidate',
    'expectedReviewDigest',
    'repairInstructions',
    'feedback'
  ];
  need(
    input.version === 3 &&
      record &&
      !Array.isArray(record) &&
      record.version === 1 &&
      Object.keys(record).length === keys.length &&
      keys.every((key) => Object.hasOwn(record, key)) &&
      text(record.feedback, 8192),
    'Invalid retained workspace repair record.',
    400
  );
  normalizeProjectRepair({
    ...Object.fromEntries(keys.slice(1, 5).map((key) => [key, record[key]])),
    maxAttempts: input.maxAttempts,
    maxActiveSeconds: input.maxActiveSeconds
  });
  return Object.fromEntries(keys.map((key) => [key, record[key]]));
}
export const projectSeed = (input) => input.repair?.expectedCandidate ?? input.base;
export function projectRepairCommand(input) {
  const r = normalizeRetainedRepair(input.repair, input);
  return normalizeProjectRepair({
    rejectedGoalId: r.rejectedGoalId,
    expectedCandidate: r.expectedCandidate,
    expectedReviewDigest: r.expectedReviewDigest,
    repairInstructions: r.repairInstructions,
    maxAttempts: input.maxAttempts,
    maxActiveSeconds: input.maxActiveSeconds
  });
}
export function projectAdmissionDigest(input) {
  return hashRecord(
    input.repair ? ['project.repair', projectRepairCommand(input)] : ['project.develop', input]
  );
}
export function rejectedProject(db, request) {
  const row = db
    .prepare('SELECT * FROM project_changes WHERE goalId=?')
    .get(request.rejectedGoalId);
  const input = row && JSON.parse(row.input),
    author = row?.authorFinal && JSON.parse(row.authorFinal),
    reviewer = row?.reviewerFinal && JSON.parse(row.reviewerFinal);
  need(
    row &&
      input.version === 3 &&
      row.stage === 'blocked' &&
      db
        .prepare(
          "SELECT 1 FROM goal_revisions WHERE id=? AND state='blocked' AND changeKind='goal.blocked' LIMIT 1"
        )
        .get(row.goalId) &&
      author?.decision === 'submit' &&
      reviewer?.decision === 'reject' &&
      row.candidate === request.expectedCandidate &&
      author.revisionId === row.candidate &&
      reviewer.revisionId === row.candidate &&
      hashRecord(reviewer) === request.expectedReviewDigest &&
      !db.prepare('SELECT 1 FROM project_landings WHERE goalId=?').get(row.goalId),
    'Repair requires the exact settled rejected workspace candidate and feedback.'
  );
  for (const taskId of [row.authorTaskId, row.reviewerTaskId]) {
    const task = db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId);
    const attempt = db
      .prepare('SELECT status FROM attempts WHERE taskId=? ORDER BY ordinal DESC LIMIT 1')
      .get(taskId);
    need(
      task?.status === 'completed' && attempt?.status === 'completed',
      'Rejected project roles must be completed before repair.'
    );
  }
  return { ...row, input, authorFinal: author, reviewerFinal: reviewer };
}
export function deriveProjectRepairInput(db, raw) {
  const request = normalizeProjectRepair(raw),
    parent = rejectedProject(db, request);
  let cursor = parent;
  const seen = new Set();
  while (cursor) {
    need(
      !seen.has(cursor.goalId) && seen.size < 15,
      'Project repair ancestry is cyclic or exceeds its bound.'
    );
    seen.add(cursor.goalId);
    cursor = cursor.input.repair ? rejectedProject(db, projectRepairCommand(cursor.input)) : null;
  }
  return {
    ...parent.input,
    maxAttempts: request.maxAttempts,
    maxActiveSeconds: request.maxActiveSeconds,
    repair: {
      version: 1,
      rejectedGoalId: parent.goalId,
      expectedCandidate: request.expectedCandidate,
      expectedReviewDigest: request.expectedReviewDigest,
      repairInstructions: request.repairInstructions,
      feedback: parent.reviewerFinal.note
    }
  };
}
export function verifyProjectRepairInput(db, input) {
  need(
    same(input, deriveProjectRepairInput(db, projectRepairCommand(input))),
    'Repair admission differs from the rejected project authority or feedback.'
  );
  return input.repair.rejectedGoalId;
}
export function requireSettledRepair(db, goalId) {
  const goal = db
    .prepare(
      "SELECT g.*,(SELECT MAX(version) FROM goal_revisions r WHERE r.id=g.id AND r.changeKind IN ('created','goal.amend')) AS scopeVersion FROM goals g WHERE g.id=?"
    )
    .get(goalId);
  const parent = db.prepare('SELECT input FROM project_changes WHERE goalId=?').get(goalId);
  need(
    goal?.state === 'blocked' &&
      goal.scopeVersion === 1 &&
      parent &&
      goal.objective === JSON.parse(parent.input).objective,
    'Repair requires the currently blocked original project objective.'
  );
  need(
    !db.prepare('SELECT 1 FROM pending_effects LIMIT 1').get() &&
      !db.prepare('SELECT 1 FROM time_budgets WHERE goalId=? AND elapsedUncertain=1').get(goalId) &&
      !db
        .prepare(
          "SELECT 1 FROM tasks t JOIN goal_tasks g ON g.taskId=t.id WHERE g.goalId=? AND (t.status IN ('queued','blocked','starting','running','waiting_for_input','interrupting') OR (t.status='recovery_needed' AND t.recoveryCleared=0)) LIMIT 1"
        )
        .get(goalId) &&
      !db
        .prepare('SELECT 1 FROM timed_attempts WHERE goalId=? AND closedMs IS NULL LIMIT 1')
        .get(goalId) &&
      !db
        .prepare(
          "SELECT 1 FROM task_controls c JOIN goal_tasks g ON g.taskId=c.taskId WHERE g.goalId=? AND c.state IN ('pending','requested','sent','unconfirmed') LIMIT 1"
        )
        .get(goalId),
    'Repair requires settled execution, controls and effects.'
  );
}
