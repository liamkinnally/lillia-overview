import { createHash } from 'node:crypto';
import { controlSubtreeScope } from './subtree-scope-owner.mjs';
import { readSubtreeControlFacts } from './subtree-control-authority.mjs';
import { reservedStopBinding, deliverControl } from './task-control-delivery.mjs';
import { verifyScopeDeliveryClaims } from './subtree-scope-claim-schema.mjs';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function normalizeIdentity(input) {
  if (
    !input ||
    Object.keys(input).sort().join(',') !== 'controlId,operationId,projectId,taskId,threadId' ||
    Object.values(input).some((v) => typeof v !== 'string' || !v.trim())
  )
    throw Error('Invalid scope delivery identity.');
  return Object.freeze({
    projectId: input.projectId,
    threadId: input.threadId,
    operationId: input.operationId,
    taskId: input.taskId,
    controlId: input.controlId
  });
}
function readScopeStop(store, input, actor) {
  verifyScopeDeliveryClaims(store.db);
  const row = store.db
    .prepare('SELECT receipt FROM command_receipts WHERE operationId=?')
    .get(input.operationId);
  if (!row) throw Error('Accepted scope receipt is unavailable.');
  const saved = JSON.parse(row.receipt);
  if (
    saved.scopeIntent?.projectId !== input.projectId ||
    saved.scopeIntent?.threadId !== input.threadId
  )
    throw Error('Scope delivery identity differs.');
  // Frozen owner replay checks current actor, permission/grant history and the
  // independently sealed original outcome before returning any reservation.
  const receipt = controlSubtreeScope(store, saved.scopeIntent, input.operationId, actor);
  const reservation = receipt.reservations.find(
    (r) => r.control.id === input.controlId && r.taskId === input.taskId
  );
  if (
    !reservation ||
    !['starting', 'running', 'waiting_for_input'].includes(reservation.pinnedTask.status) ||
    !reservation.pinnedAttempt
  )
    throw Error('Local/no-attempt proof is separate from native delivery.');
  const a = reservation.pinnedAttempt;
  const expected = {
    controlId: input.controlId,
    taskId: input.taskId,
    attemptId: a.id,
    driver: a.driver,
    accountInstance: a.accountInstance,
    threadId: a.threadId,
    turnId: a.turnId,
    nativeSessionId: a.nativeSessionId,
    executionId: a.executionId
  };
  const seal = store.db
    .prepare('SELECT receiptDigest FROM subtree_scope_operations WHERE operationId=?')
    .get(input.operationId);
  const record = { ...input, receiptDigest: seal.receiptDigest, expected };
  const prior = store.db
    .prepare('SELECT * FROM subtree_scope_delivery_claims WHERE controlId=?')
    .get(input.controlId);
  if (prior) {
    if (
      prior.operationId !== input.operationId ||
      prior.digest !== hash(JSON.parse(prior.record)) ||
      hash(record) !== prior.digest
    )
      throw Error('Persisted scope claim identity differs.');
  }
  return { receipt, reservation, expected, record, prior };
}
function assertCurrentScope(store, input, { receipt, reservation, expected }) {
  const gate = store.db
    .prepare('SELECT * FROM subtree_scope_gates WHERE threadId=?')
    .get(input.threadId);
  if (gate?.state !== 'paused' || gate.version !== receipt.gate.version)
    throw Error('Accepted scope gate changed.');
  const current = readSubtreeControlFacts(store, input);
  const members = current.threads.flatMap((t) => [
    ...t.workGoals.flatMap((g) => g.tasks),
    ...t.carrierTurns.map((x) => x.task)
  ]);
  const member = members.find((t) => t.id === input.taskId);
  if (
    !member ||
    member.goalId !== reservation.pinnedTask.goalId ||
    member.specVersion !== reservation.pinnedTask.specVersion ||
    member.provider !== expected.driver
  )
    throw Error('Current exact task membership differs.');
}
// Rechecked after observer callbacks and after a delayed native turn becomes available.
// No claim is created here: missing or consumed intent never grants another send.
function assertScopeStopAuthority(store, input, actor, expected) {
  if (store.db.isTransaction) throw Error('Scope effect requires committed owner intent.');
  store.transaction(() => {
    const saved = readScopeStop(store, input, actor);
    if (!saved.prior || hash(saved.expected) !== hash(expected))
      throw Error('Committed scope claim is unavailable or changed.');
    assertCurrentScope(store, input, saved);
  });
}

// The only send grant is the first durable insertion. A crash after commit leaves
// uncertainty, never permission to resend. Receipt/claim replay performs no effect.
export function claimScopeStop(store, input, actor) {
  if (store.db.isTransaction) throw Error('Scope claim requires committed owner intent.');
  input = normalizeIdentity(input);
  return store.transaction(() => {
    const saved = readScopeStop(store, input, actor);
    const { receipt, expected, record, prior } = saved;
    if (prior) return { receipt, replayed: true };
    assertCurrentScope(store, input, saved);
    const actual = reservedStopBinding(store, input.controlId, input.taskId, expected.attemptId);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw Error('Pinned native attempt binding differs.');
    store.db
      .prepare('INSERT INTO subtree_scope_delivery_claims VALUES(?,?,?,?)')
      .run(input.controlId, input.operationId, JSON.stringify(record), hash(record));
    return { receipt, expected, replayed: false };
  });
}

export async function deliverScopeStop(store, adapter, input, actor) {
  if (store.db.isTransaction) throw Error('Scope delivery requires committed owner intent.');
  input = normalizeIdentity(input);
  const grant = claimScopeStop(store, input, actor);
  if (!grant.replayed) {
    const action = store.db.prepare('SELECT * FROM task_controls WHERE id=?').get(input.controlId);
    await deliverControl(store, adapter, action, store.getTask(input.taskId), {
      expected: grant.expected,
      beforeInterrupt: () => assertScopeStopAuthority(store, input, actor, grant.expected)
    });
  }
  return {
    receipt: grant.receipt,
    replayed: grant.replayed,
    claimConsumed: true,
    action: store.db.prepare('SELECT * FROM task_controls WHERE id=?').get(input.controlId)
  };
}
