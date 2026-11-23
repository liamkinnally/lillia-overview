import { isDeepStrictEqual as same } from 'node:util';
import { timeBudget } from './time-budget.mjs';
import {
  disposition,
  id,
  hash,
  requireValue,
  fenceValid,
  historicalBinding,
  clockAndControl,
  normalizeProjectReviewRetry,
  verifyProjectReviewRecovery
} from './project-review-recovery-proof.mjs';
export {
  normalizeProjectReviewRetry,
  verifyProjectReviewRecovery,
  verifyProjectReviewRecoveries
} from './project-review-recovery-proof.mjs';
export function retryProjectReview(store, raw, operationId, { coldFence, verifyWorkflow } = {}) {
  const i = normalizeProjectReviewRetry(raw),
    db = store.db;
  requireValue(id(operationId), 'Invalid operation ID.', 400);
  return store.accept(operationId, hash(['project.review.retry', i]), () => {
    requireValue(!verifyProjectReviewRecovery(db, i.goalId), 'Reviewer extension already used.');
    const { f, admission, subject, identity } = historicalBinding(db, i);
    const goal = store.goal(i.goalId),
      task = store.getTask(i.taskId);
    const allowance = db.prepare('SELECT * FROM goal_allowance_usage WHERE goalId=?').get(i.goalId);
    requireValue(
      store.sessionProfile?.mode === 'mixed' &&
        goal.state === 'active' &&
        goal.scopeVersion === 1 &&
        f.stage === 'reviewer' &&
        !f.reviewerFinal &&
        !db.prepare('SELECT 1 FROM project_landings WHERE goalId=?').get(i.goalId) &&
        allowance?.attemptLimit === i.expectedLimit &&
        allowance.attemptsUsed === 2 &&
        task.status === 'recovery_needed' &&
        !task.recoveryCleared &&
        !db.prepare('SELECT 1 FROM pending_effects LIMIT 1').get(),
      'Original reviewer, allowance or pending effect is ineligible for recovery.'
    );
    requireValue(
      same(store.projectDevelopment?.validateDispatch(i.taskId), subject),
      'The broker no longer authorizes the original reviewer subject.'
    );
    requireValue(
      typeof verifyWorkflow === 'function' && verifyWorkflow(db, i.goalId) === true,
      'Historical author and project evidence must verify.'
    );
    const fence = coldFence?.({ goalId: i.goalId, taskId: i.taskId, attemptId: i.attemptId });
    requireValue(
      fenceValid(fence),
      'A fresh exclusive daemon must fence the stopped predecessor, credentials and outstanding work.'
    );
    const before = timeBudget(db, i.goalId),
      { clock, control } = clockAndControl(db, i);
    requireValue(
      before.maxActiveSeconds === admission.maxActiveSeconds &&
        !before.clockRollback &&
        !before.elapsedUncertain &&
        before.openAttempts === 1 &&
        clock.closedMs === null &&
        control.state === 'unconfirmed',
      'Active-time or control history cannot be fenced.'
    );
    // The existing clock trigger closes this one open local reservation at the high water mark.
    db.prepare("UPDATE tasks SET recoveryCleared=1 WHERE id=? AND status='recovery_needed'").run(
      i.taskId
    );
    const after = timeBudget(db, i.goalId),
      closedMs = db
        .prepare('SELECT closedMs FROM timed_attempts WHERE attemptId=?')
        .get(i.attemptId).closedMs;
    const maxActiveSeconds = Math.floor(after.activeMs / 1000) + i.additionalActiveSeconds;
    requireValue(
      !after.clockRollback &&
        !after.elapsedUncertain &&
        after.openAttempts === 0 &&
        Number.isSafeInteger(closedMs) &&
        maxActiveSeconds <= 604800,
      'The local clock could not establish the full elapsed reservation.'
    );
    db.prepare('UPDATE goal_allowances SET attemptLimit=? WHERE goalId=?').run(
      i.expectedLimit + 1,
      i.goalId
    );
    db.prepare('UPDATE time_budgets SET maxActiveSeconds=? WHERE goalId=?').run(
      maxActiveSeconds,
      i.goalId
    );
    db.prepare("UPDATE task_controls SET state='retired-unknown' WHERE id=?").run(control.id);
    const record = {
      ...i,
      ...identity,
      operationId,
      disposition,
      originalMaxActiveSeconds: before.maxActiveSeconds,
      accruedMs: after.activeMs,
      closedMs,
      maxActiveSeconds,
      attemptLimit: i.expectedLimit + 1,
      previousControl: { ...control },
      fence: {
        predecessorId: fence.predecessorId,
        successorId: fence.successorId,
        priorProcessStopped: true,
        exclusiveWriter: true,
        brokerUnissued: true,
        operationsIdle: true
      }
    };
    store.activity('project.review.retired/' + hash(record), i.goalId, i.taskId);
    store.updateTask(i.taskId, { status: 'queued', recoveryCleared: false, error: null });
    return { recovery: record };
  });
}

// A queued cancellation also runs the legacy task-to-latest-attempt trigger. Preserve just
// the retired attempt's mirrored fields, in the same transaction as the task transition.
export function preserveRetiredReview(store, taskId, patch, write) {
  if (!store.projectDevelopment) return write();
  if (!('status' in patch || 'threadId' in patch || 'turnId' in patch)) return write();
  const db = store.db;
  const select =
    db.prepare(`SELECT a.id,a.status,a.threadId,a.turnId,a.updatedAt FROM task_controls c
    JOIN timed_attempts d ON d.interruptControl=c.id JOIN attempts a ON a.id=d.attemptId
    WHERE c.taskId=? AND c.state='retired-unknown' AND a.taskId=c.taskId
    AND NOT EXISTS (SELECT 1 FROM attempts n WHERE n.taskId=a.taskId AND n.ordinal>a.ordinal)`);
  if (!select.get(taskId)) return write();
  function preserve() {
    const old = select.get(taskId);
    const value = write();
    if (old)
      db.prepare('UPDATE attempts SET status=?,threadId=?,turnId=?,updatedAt=? WHERE id=?').run(
        old.status,
        old.threadId,
        old.turnId,
        old.updatedAt,
        old.id
      );
    return value;
  }
  return db.isTransaction ? preserve() : store.transaction(preserve);
}
