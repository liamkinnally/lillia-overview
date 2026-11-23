const conflict = (message) => Object.assign(new Error(message), { status: 409 });
const live = new Set(['starting', 'running', 'waiting_for_input']);
const identity = [
  'controlId',
  'taskId',
  'attemptId',
  'driver',
  'accountInstance',
  'threadId',
  'turnId',
  'nativeSessionId',
  'executionId'
];

// Owner authority is synchronous: no observer or await may separate this check
// from the actual native effect. An async callback cannot authorize a send.
export function assertInterruptAuthority(beforeInterrupt) {
  if (beforeInterrupt === undefined) return;
  if (typeof beforeInterrupt !== 'function')
    throw conflict('Invalid interruption authority guard.');
  const result = beforeInterrupt();
  if (result !== undefined) {
    if (typeof result?.then === 'function') Promise.resolve(result).catch(() => {});
    throw conflict('Interruption authority guard must finish synchronously.');
  }
}

// Resolve only the exact live reservation. Native IDs are persisted provider facts,
// never renderer fields or a replacement task selected by the sender.
export function reservedStopBinding(
  store,
  controlId,
  taskId,
  attemptId,
  { interrupting = false } = {}
) {
  const row = store.db
    .prepare(
      `SELECT c.id AS controlId,c.taskId,c.kind,c.state,
    g.provider,a.id AS attemptId,a.driver,a.accountInstance,a.threadId,a.turnId,
    a.nativeSessionId,a.executionId,a.status AS attemptStatus,
    t.status,t.threadId AS taskThread,t.turnId AS taskTurn
    FROM task_controls c JOIN goal_tasks g ON g.taskId=c.taskId JOIN tasks t ON t.id=c.taskId
    JOIN attempts a ON a.taskId=t.id AND a.id=?
    WHERE c.id=? AND c.taskId=? AND a.ordinal=(SELECT max(ordinal) FROM attempts WHERE taskId=t.id)`
    )
    .get(attemptId, controlId, taskId);
  if (
    !row ||
    row.kind !== 'task.cancel' ||
    row.state !== 'pending' ||
    !(live.has(row.status) || (interrupting && row.status === 'interrupting')) ||
    row.attemptStatus !== row.status ||
    row.provider !== row.driver ||
    row.threadId !== row.taskThread ||
    row.turnId !== row.taskTurn
  )
    throw conflict('The reserved interruption attempt binding changed.');
  return Object.fromEntries(identity.map((key) => [key, row[key]]));
}

// Called synchronously in the actual adapter, immediately before cancelling its
// captured active binding. Legacy task-ID callers keep their existing behavior.
export function assertReservedStop(store, expected, binding, driver, options = {}) {
  const current = reservedStopBinding(
    store,
    expected.controlId,
    expected.taskId,
    expected.attemptId,
    options
  );
  if (
    identity.some((key) => expected[key] !== current[key]) ||
    expected.driver !== driver ||
    !binding ||
    binding.taskId !== current.taskId ||
    binding.attemptId !== current.attemptId ||
    binding.accountInstance !== current.accountInstance ||
    binding.uncertain ||
    binding.terminal ||
    (binding.cancelRequested && !options.interrupting) ||
    binding.controller?.signal.aborted ||
    (driver === 'codex' &&
      (binding.threadId !== current.threadId || binding.turnId !== current.turnId)) ||
    (driver === 'claude' &&
      (binding.nativeSessionId !== current.nativeSessionId ||
        binding.executionId !== current.executionId))
  )
    throw conflict('The active native interruption binding changed.');
}

// Shared post-commit delivery preserves the existing owner-control outcomes.
export async function deliverControl(
  store,
  adapter,
  action,
  task,
  { isClosed = () => false, expected, beforeInterrupt } = {}
) {
  if (store.db.isTransaction) throw conflict('Control delivery requires committed owner intent.');
  if (
    expected &&
    (action.kind !== 'task.cancel' ||
      action.id !== expected.controlId ||
      action.taskId !== expected.taskId ||
      task.id !== expected.taskId)
  )
    throw conflict('The interruption settlement binding differs.');
  try {
    if (action.kind === 'task.cancel') {
      if (expected && isClosed()) throw conflict('The service is stopping.');
      if (expected)
        assertReservedStop(store, expected, adapter.active?.get(task.id), expected.driver);
      const delivery = await adapter.interruptTask(task.id, expected, beforeInterrupt);
      if (expected && !['requested', 'sent', 'unconfirmed'].includes(delivery))
        throw conflict('A bound interruption requires a recorded request, not terminal evidence.');
      store.transaction(() => store.settleControl(action, delivery ?? 'unconfirmed'));
    } else {
      const result = await adapter.inspectTerminalAttempt(task);
      const current = store.getTask(task.id);
      if (
        isClosed() ||
        adapter.active?.has(task.id) ||
        current.status !== 'recovery_needed' ||
        current.threadId !== task.threadId ||
        current.turnId !== task.turnId ||
        !result ||
        result.threadId !== task.threadId ||
        result.turnId !== task.turnId ||
        !['completed', 'interrupted', 'failed'].includes(result.status)
      )
        throw conflict('A matching idle native thread and terminal turn could not be confirmed.');
      store.transaction(() => {
        store.updateTask(task.id, {
          status: result.status,
          recoveryCleared: true,
          error: result.status === 'failed' ? 'Native turn failed.' : null
        });
        store.settleControl(action, 'confirmed');
      });
      adapter.kick();
    }
  } catch (error) {
    store.transaction(() =>
      store.settleControl(
        action,
        'unconfirmed',
        error.status === 409
          ? error.message
          : 'No confirmed native outcome. Inspect the task before continuing.'
      )
    );
  }
}

// Internal bridge only. Scope/current-action authority is still supplied by the
// journal owner; this function does not expose an owner route or create a gate.
export async function deliverSubtreeStop(journal, adapter, input) {
  const { projectId, scopeId, operationId, memberId, controlId, expectedVersion } = input;
  const store = journal.store;
  if (store.db.isTransaction) throw conflict('Subtree delivery requires committed owner intent.');
  if (
    [projectId, scopeId, operationId, memberId, controlId].some(
      (v) => typeof v !== 'string' || !v.trim()
    ) ||
    projectId !== journal.projectId ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  )
    throw conflict('Invalid interruption reservation binding.');
  const grant = journal.transaction(() => {
    const saved = journal.load(operationId);
    if (!saved || saved.snapshot.projectId !== projectId || saved.snapshot.scopeId !== scopeId)
      throw conflict('Interruption scope binding differs.');
    const member = saved.receipt.members.find((m) => m.id === memberId);
    const reservation = store.db
      .prepare(
        'SELECT * FROM subtree_reservations WHERE operationId=? AND taskId=? AND controlId=?'
      )
      .get(operationId, memberId, controlId);
    if (
      !member ||
      member.effect !== 'stop' ||
      !member.attemptId ||
      !reservation ||
      reservation.attemptId !== member.attemptId
    )
      throw conflict('Exact provider interruption reservation is unavailable.');
    // A consumed claim is a read/reconciliation result, never another send grant.
    if (reservation.claimed) return { receipt: saved.receipt, replayed: true };
    const expected = reservedStopBinding(store, controlId, memberId, member.attemptId);
    const claimed = journal.claim(operationId, expectedVersion, memberId);
    if (claimed.controlId !== controlId || claimed.attemptId !== member.attemptId)
      throw conflict('Claimed interruption binding differs.');
    return { expected, receipt: claimed.receipt, replayed: false };
  });
  if (!grant.replayed) {
    const action = store.db.prepare('SELECT * FROM task_controls WHERE id=?').get(controlId);
    await deliverControl(store, adapter, action, store.getTask(memberId), {
      expected: grant.expected
    });
  }
  return {
    receipt: grant.receipt,
    replayed: grant.replayed,
    action: store.db.prepare('SELECT * FROM task_controls WHERE id=?').get(controlId)
  };
}
