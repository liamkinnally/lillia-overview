import { createHash } from 'node:crypto';

const actions = new Set(['pause', 'stop', 'resume']);
const statuses = new Set([
  'queued',
  'blocked',
  'starting',
  'running',
  'waiting_for_input',
  'interrupting',
  'recovery_needed',
  'completed',
  'failed',
  'interrupted',
  'cancelled'
]);
const terminal = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const live = new Set(['starting', 'running', 'waiting_for_input']);

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${name}.`);
}

// The caller reads scope, membership and member versions in one authoritative transaction.
export function pinOperation({
  operationId,
  action,
  scopeId,
  scopeState,
  scopeVersion,
  membershipVersion,
  members
}) {
  required(operationId, 'operation ID');
  required(scopeId, 'scope ID');
  if (
    !actions.has(action) ||
    !['active', 'paused'].includes(scopeState) ||
    (action === 'pause' && scopeState !== 'active') ||
    (action === 'resume' && scopeState !== 'paused') ||
    !Number.isSafeInteger(scopeVersion) ||
    scopeVersion < 0 ||
    !Number.isSafeInteger(membershipVersion) ||
    membershipVersion < 0 ||
    !Array.isArray(members)
  ) {
    throw new Error('Invalid operation.');
  }
  if (
    action === 'resume' &&
    members.some((member) => ['interrupting', 'recovery_needed'].includes(member.status))
  )
    throw new Error('Unresolved work prevents resume.');
  const seen = new Set();
  const pinned = members
    .map(({ id, version, status, attemptId = null }) => {
      required(id, 'member ID');
      if (
        seen.has(id) ||
        !Number.isSafeInteger(version) ||
        version < 0 ||
        !statuses.has(status) ||
        (live.has(status) && (typeof attemptId !== 'string' || !attemptId.trim()))
      ) {
        throw new Error('Invalid member.');
      }
      seen.add(id);
      const effect = terminal.has(status)
        ? 'none'
        : status === 'recovery_needed'
          ? 'uncertain'
          : status === 'interrupting'
            ? 'stopping'
            : action === 'resume'
              ? 'none'
              : action === 'pause' && !live.has(status)
                ? 'none'
                : 'stop';
      return { id, version, status, attemptId, effect, delivery: 'pending' };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const identity = {
    operationId,
    action,
    scopeId,
    scopeState,
    scopeVersion,
    membershipVersion,
    members: pinned,
    scopeGate:
      action === 'stop'
        ? null
        : { target: action === 'pause' ? 'paused' : 'active', state: 'pending' }
  };
  return {
    ...identity,
    digest: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    version: 1
  };
}

// Persist the returned record with compare-and-swap before any external delivery.
export function advanceOperation(
  record,
  { expectedVersion, memberId, event, scopeVersion, membershipVersion, memberVersion, observation }
) {
  if (record.version !== expectedVersion) throw new Error('Stale operation.');
  const member = record.members.find((item) => item.id === memberId);
  if (!member) throw new Error('Member was not pinned.');
  if (event === 'sent' && record.action === 'pause' && record.scopeGate?.state !== 'applied')
    throw new Error('Pause gate has not been applied.');
  if (event === 'reserve') {
    if (
      scopeVersion !== record.scopeVersion ||
      membershipVersion !== record.membershipVersion ||
      memberVersion !== member.version
    )
      throw new Error('Stale scope, membership or member.');
    if (member.delivery !== 'pending' || member.effect !== 'stop')
      throw new Error('Delivery cannot be reserved.');
  } else if (
    !(
      (event === 'confirm-local' &&
        ['reserved', 'requested', 'uncertain'].includes(member.delivery)) ||
      (event === 'sent' && member.delivery === 'reserved') ||
      (event === 'uncertain' && ['reserved', 'requested'].includes(member.delivery)) ||
      (event === 'confirm' && ['requested', 'uncertain'].includes(member.delivery))
    )
  ) {
    throw new Error('Invalid delivery transition.');
  }
  if (
    event === 'confirm-local' &&
    (!['queued', 'blocked'].includes(member.status) ||
      member.attemptId !== null ||
      observation?.kind !== 'task' ||
      observation.memberId !== memberId ||
      observation.pinnedVersion !== member.version ||
      !Number.isSafeInteger(observation.version) ||
      observation.version <= member.version ||
      observation.status !== 'interrupted' ||
      observation.attemptId !== null)
  )
    throw new Error('Local cancellation needs matching task evidence.');
  if (
    event === 'confirm' &&
    (member.attemptId === null ||
      observation?.memberId !== memberId ||
      observation.status !== 'interrupted' ||
      observation.attemptId !== member.attemptId)
  )
    throw new Error('Confirmation needs matching observed evidence.');
  const delivery =
    event === 'reserve'
      ? 'reserved'
      : event === 'sent'
        ? 'requested'
        : ['confirm', 'confirm-local'].includes(event)
          ? 'confirmed'
          : 'uncertain';
  return {
    ...record,
    version: record.version + 1,
    members: record.members.map((item) => (item.id === memberId ? { ...item, delivery } : item))
  };
}

function pinnedDigest(record) {
  const identity = {
    operationId: record.operationId,
    action: record.action,
    scopeId: record.scopeId,
    scopeState: record.scopeState,
    scopeVersion: record.scopeVersion,
    membershipVersion: record.membershipVersion,
    members: record.members.map(({ id, version, status, attemptId, effect }) => ({
      id,
      version,
      status,
      attemptId,
      effect,
      delivery: 'pending'
    })),
    scopeGate:
      record.scopeGate === null ? null : { target: record.scopeGate.target, state: 'pending' }
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function replayOperation(saved, proposed) {
  if (
    saved.operationId !== proposed.operationId ||
    saved.digest !== proposed.digest ||
    pinnedDigest(saved) !== saved.digest ||
    pinnedDigest(proposed) !== proposed.digest
  )
    throw new Error('Operation ID conflicts with saved input.');
  return saved;
}

// The owner must commit this record and its single scope gate change in the same transaction.
export function applyScopeGate(record, { expectedVersion, scopeVersion, membershipVersion }) {
  if (
    record.version !== expectedVersion ||
    record.scopeVersion !== scopeVersion ||
    record.membershipVersion !== membershipVersion ||
    record.scopeGate?.state !== 'pending' ||
    record.members.some((member) => member.effect === 'stop' && member.delivery === 'pending')
  )
    throw new Error('Scope gate cannot be applied.');
  return {
    ...record,
    version: record.version + 1,
    scopeGate: { ...record.scopeGate, state: 'applied' }
  };
}

// Validate a saved receipt without sending effects; the owner still authenticates its source.
export function checkReceiptProgress(previous, next) {
  try {
    replayOperation(next, previous);
    const valid = (record) =>
      Number.isSafeInteger(record.version) &&
      record.version >= 1 &&
      record.members.every(
        (member) =>
          ['pending', 'reserved', 'requested', 'uncertain', 'confirmed'].includes(
            member.delivery
          ) &&
          (member.effect === 'stop' || member.delivery === 'pending')
      ) &&
      (record.scopeGate === null ||
        (['pending', 'applied'].includes(record.scopeGate.state) &&
          !(
            record.scopeGate.state === 'applied' &&
            record.members.some(
              (member) => member.effect === 'stop' && member.delivery === 'pending'
            )
          ) &&
          !(
            record.action === 'pause' &&
            record.scopeGate.state === 'pending' &&
            record.members.some(
              (member) => member.effect === 'stop' && member.delivery === 'requested'
            )
          )));
    if (!valid(previous) || !valid(next) || next.version < previous.version) return false;
    let steps = 0;
    for (let i = 0; i < previous.members.length; i++) {
      const from = previous.members[i],
        to = next.members[i];
      const local = from.attemptId === null && ['queued', 'blocked'].includes(from.status);
      const paths = {
        pending: { pending: 0, reserved: 1, requested: 2, uncertain: 2, confirmed: local ? 2 : 3 },
        reserved: { reserved: 0, requested: 1, uncertain: 1, confirmed: local ? 1 : 2 },
        requested: { requested: 0, uncertain: 1, confirmed: 1 },
        uncertain: { uncertain: 0, confirmed: 1 },
        confirmed: { confirmed: 0 }
      };
      const distance = paths[from.delivery]?.[to.delivery];
      if (distance === undefined) return false;
      steps += distance;
    }
    if (previous.scopeGate?.state === 'applied' && next.scopeGate?.state !== 'applied')
      return false;
    if (previous.scopeGate?.state === 'pending' && next.scopeGate?.state === 'applied') steps++;
    return next.version - previous.version >= steps;
  } catch {
    return false;
  }
}

export function normalizeScope(value) {
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (
    !value ||
    typeof value.projectId !== 'string' ||
    !value.projectId ||
    typeof value.scopeId !== 'string' ||
    !value.scopeId ||
    !Array.isArray(value.descendants) ||
    !Array.isArray(value.tasks)
  )
    throw Error('Scope snapshot is unavailable.');
  const descendants = value.descendants.map(({ id, version }) => ({ id, version })).sort(byId);
  const ids = new Set([value.scopeId]);
  for (const item of descendants) {
    if (
      typeof item.id !== 'string' ||
      !item.id ||
      !Number.isSafeInteger(item.version) ||
      item.version < 0 ||
      ids.has(item.id)
    )
      throw Error('Invalid thread membership.');
    ids.add(item.id);
  }
  const taskIds = new Set();
  const tasks = value.tasks
    .map(({ id, threadId, version, status, attemptId = null, dependsOn = [] }) => {
      if (
        typeof id !== 'string' ||
        !id ||
        taskIds.has(id) ||
        !ids.has(threadId) ||
        !Array.isArray(dependsOn) ||
        dependsOn.some((entry) => typeof entry !== 'string')
      )
        throw Error('Invalid affected task.');
      taskIds.add(id);
      return { id, threadId, version, status, attemptId, dependsOn: [...dependsOn].sort() };
    })
    .sort(byId);
  return {
    projectId: value.projectId,
    scopeId: value.scopeId,
    scopeState: value.scopeState,
    scopeVersion: value.scopeVersion,
    membershipVersion: value.membershipVersion,
    descendants,
    tasks
  };
}
