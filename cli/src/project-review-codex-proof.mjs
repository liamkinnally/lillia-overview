import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { requireProject as need } from './project-source.mjs';

// This mirrors the model-independent Codex branch of readFinalOutput while
// allowing recovery to verify historical records from the retained database.
export function verifyCodexProjectFinal(db, task, attempt, evidence) {
  const setting = (key) => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  const binding = setting('codex.accountBinding');
  need(
    task?.status === 'completed' &&
      attempt?.status === 'completed' &&
      attempt.taskId === task.id &&
      attempt.driver === 'codex' &&
      attempt.accountRoute === 'installed-chatgpt' &&
      !attempt.modelRerouted &&
      attempt.accountInstance &&
      attempt.accountInstance === setting('codex.accountInstance') &&
      attempt.threadId &&
      attempt.turnId &&
      task.threadId === attempt.threadId &&
      task.turnId === attempt.turnId &&
      (!binding || setting('codex.threadAccount.' + attempt.threadId) === binding),
    'Missing terminal installed-account project attempt.'
  );
  const rows = db
    .prepare(
      `SELECT itemId,digest,text FROM task_final_outputs
    WHERE attemptId=? AND threadId=? AND turnId=? LIMIT 2`
    )
    .all(attempt.id, attempt.threadId, attempt.turnId);
  const row = rows[0];
  need(
    rows.length === 1 &&
      typeof row.text === 'string' &&
      row.text.trim() &&
      createHash('sha256').update(row.text).digest('hex') === row.digest,
    'Project final output is missing, ambiguous or changed.'
  );
  const expected = {
    taskId: task.id,
    specVersion: task.specVersion,
    goalVersion: task.goalVersion,
    attemptId: attempt.id,
    accountInstance: attempt.accountInstance,
    threadId: attempt.threadId,
    turnId: attempt.turnId,
    itemId: row.itemId,
    digest: row.digest,
    runId: attempt.turnId,
    contextDigest: attempt.contextDigest,
    configDigest: attempt.configDigest
  };
  need(
    isDeepStrictEqual(evidence, expected),
    'Project verdict differs from its native final output.'
  );
  return row.text;
}
