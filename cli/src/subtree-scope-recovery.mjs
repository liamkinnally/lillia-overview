import { createHash } from 'node:crypto';
import { verifySubtreeScope } from './subtree-scope-schema.mjs';
import { verifyScopeDeliveryClaims } from './subtree-scope-claim-schema.mjs';

export const scopeRecoveryTables = [
  'subtree_scope_gates',
  'subtree_scope_operations',
  'subtree_scope_delivery_claims'
];
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function need(ok) {
  if (!ok) throw Error('Scope retained receipt or claim proof differs.');
}
// Recovery validates historical intent and immutable native identity. Current
// permissions and task status may have advanced after an accepted owner action.
export function verifyScopeRecovery(db) {
  verifySubtreeScope(db);
  verifyScopeDeliveryClaims(db);
  const receipts = new Map();
  for (const row of db.prepare('SELECT * FROM subtree_scope_operations').all()) {
    const command = db
      .prepare('SELECT * FROM command_receipts WHERE operationId=?')
      .get(row.operationId);
    need(command);
    const receipt = JSON.parse(command.receipt),
      input = receipt.scopeIntent;
    need(
      input &&
        receipt.operationId === row.operationId &&
        row.projectId === input.projectId &&
        row.threadId === input.threadId &&
        Object.keys(input).sort().join(',') ===
          'action,authority,expectedGateVersion,membershipDigest,projectId,threadId' &&
        ['pause', 'stop', 'resume'].includes(input.action) &&
        Number.isSafeInteger(input.expectedGateVersion) &&
        input.expectedGateVersion >= 1 &&
        /^[a-f0-9]{64}$/.test(input.membershipDigest) &&
        Array.isArray(input.authority) &&
        input.authority.every(
          (a) =>
            Object.keys(a).sort().join(',') === 'threadId,version' &&
            typeof a.threadId === 'string' &&
            Number.isSafeInteger(a.version) &&
            a.version >= 1
        )
    );
    // Rebuild frozen62 normalization; don't accept another command's receipt.
    const normalized = {
      projectId: input.projectId,
      threadId: input.threadId,
      action: input.action,
      authority: input.authority.map((a) => ({ threadId: a.threadId, version: a.version })),
      expectedGateVersion: input.expectedGateVersion,
      membershipDigest: input.membershipDigest
    };
    need(
      command.digest === hash(['chat.scope.control', normalized]) &&
        row.receiptDigest === hash(receipt)
    );
    need(
      receipt.membership?.projectId === row.projectId &&
        receipt.membership.threadId === row.threadId &&
        receipt.gate?.threadId === row.threadId &&
        receipt.gate.version === input.expectedGateVersion + 1 &&
        receipt.gate.state === (input.action === 'resume' ? 'active' : 'paused') &&
        Array.isArray(receipt.reservations)
    );
    const owned = new Map(
      receipt.membership.threads
        .flatMap((t) => [
          ...t.workGoals.flatMap((g) => g.tasks),
          ...t.carrierTurns.map((x) => x.task)
        ])
        .map((t) => [t.id, t])
    );
    const ids = new Set();
    for (const r of receipt.reservations) {
      const control = db.prepare('SELECT * FROM task_controls WHERE id=?').get(r.control?.id);
      const task = owned.get(r.taskId);
      need(
        task &&
          !ids.has(r.control.id) &&
          control?.kind === 'task.cancel' &&
          control.taskId === r.taskId &&
          r.control.kind === 'task.cancel' &&
          r.control.taskId === r.taskId &&
          JSON.stringify(task) === JSON.stringify(r.pinnedTask)
      );
      ids.add(r.control.id);
      if (r.pinnedAttempt) {
        const attempt = db.prepare('SELECT * FROM attempts WHERE id=?').get(r.pinnedAttempt.id);
        need(attempt?.taskId === r.taskId && r.pinnedAttempt.taskId === r.taskId);
      } else {
        need(['queued', 'blocked'].includes(task.status) && r.control.state === 'confirmed');
      }
    }
    receipts.set(row.operationId, receipt);
  }
  // Cold recovery scan only; never part of scheduling or an owner hot read.
  for (const row of db
    .prepare(
      `SELECT operationId FROM command_receipts
    WHERE CASE WHEN json_valid(receipt) THEN json_type(receipt,'$.scopeIntent') END IS NOT NULL`
    )
    .all())
    need(receipts.has(row.operationId));
  let claims = 0;
  for (const row of db.prepare('SELECT * FROM subtree_scope_delivery_claims').all()) {
    const record = JSON.parse(row.record),
      receipt = receipts.get(row.operationId);
    const reservation = receipt?.reservations.find(
      (r) => r.control.id === row.controlId && r.taskId === record.taskId
    );
    need(reservation?.pinnedAttempt && row.digest === hash(record));
    const a = reservation.pinnedAttempt;
    const expected = {
      controlId: row.controlId,
      taskId: reservation.taskId,
      attemptId: a.id,
      driver: a.driver,
      accountInstance: a.accountInstance,
      threadId: a.threadId,
      turnId: a.turnId,
      nativeSessionId: a.nativeSessionId,
      executionId: a.executionId
    };
    const sealed = {
      projectId: receipt.scopeIntent.projectId,
      threadId: receipt.scopeIntent.threadId,
      operationId: row.operationId,
      taskId: reservation.taskId,
      controlId: row.controlId,
      receiptDigest: hash(receipt),
      expected
    };
    need(row.digest === hash(sealed));
    const attempt = db.prepare('SELECT * FROM attempts WHERE id=?').get(expected.attemptId);
    need(
      attempt?.taskId === expected.taskId &&
        attempt.driver === expected.driver &&
        attempt.accountInstance === expected.accountInstance
    );
    // A starting attempt may gain previously unknown native IDs. Identities
    // already known at the claim cannot become another native execution.
    for (const key of ['threadId', 'turnId', 'nativeSessionId', 'executionId'])
      if (expected[key] !== null) need(attempt[key] === expected[key]);
    claims++;
  }
  return { operations: receipts.size, claims };
}
