import { createHash, randomUUID } from 'node:crypto';
import { readSubtreeControlFacts } from './subtree-control-authority.mjs';
import { readThreadMailAuthority } from './thread-mail-authority.mjs';
import { assertMailOwner } from './thread-mail-owner-input.mjs';
import { readBranchThread } from './project-chat-branch-threads.mjs';
import { readChatBranch, verifyParentGrant } from './project-chat-branches.mjs';
import { verifySubtreeScope } from './subtree-scope-schema.mjs';

const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function transaction(store, run) {
  if (!store.db.isTransaction) return store.transaction(run);
  const name = 'scope_' + randomUUID().replaceAll('-', '');
  store.db.exec(`SAVEPOINT ${name}`);
  try {
    const result = run();
    store.db.exec(`RELEASE ${name}`);
    return result;
  } catch (e) {
    store.db.exec(`ROLLBACK TO ${name}`);
    store.db.exec(`RELEASE ${name}`);
    throw e;
  }
}
function facts(store, input, actor) {
  // Reuse only the private process-local owner identity, never a mail content grant.
  // Backend must route an explicit scope action from its supported owner ingress.
  assertMailOwner(actor);
  verifySubtreeScope(store.db);
  const value = readSubtreeControlFacts(store, input);
  const authority = value.threads.map((thread) => {
    const current = readThreadMailAuthority(store.db, thread.id);
    const denied = store.db
      .prepare('SELECT enabled FROM thread_mail_permissions WHERE threadId=?')
      .get(thread.id);
    if (denied?.enabled === 0) throw Error('Current thread permission denies control.');
    if (thread.parentThreadId !== null) {
      const relation = readBranchThread(store.db, thread.id).branchThread;
      const { branch } = readChatBranch(store.db, {
        projectId: input.projectId,
        id: relation.preparationId
      });
      verifyParentGrant(store.db, {
        projectId: input.projectId,
        id: relation.parentGrantId,
        selectionId: branch.selectionId,
        accountInstance: branch.recipient.accountInstance
      });
    }
    return { threadId: thread.id, version: current.version };
  });
  const bound = store.db
    .prepare("SELECT value FROM settings WHERE key='codex.accountBinding'")
    .get();
  if (!bound?.value) throw Error('Current owner account binding is unavailable.');
  const tasks = [
    ...new Map(
      value.threads
        .flatMap((t) => [
          ...t.workGoals.flatMap((g) => g.tasks),
          ...t.carrierTurns.map((turn) => turn.task)
        ])
        .map((task) => [task.id, task])
    ).values()
  ];
  const details = tasks.map((task) => ({
    task,
    attempt: task.latestAttempt
      ? store.db
          .prepare('SELECT * FROM attempts WHERE id=? AND taskId=?')
          .get(task.latestAttempt.id, task.id)
      : null,
    controls: store.db
      .prepare('SELECT * FROM task_controls WHERE taskId=? ORDER BY id')
      .all(task.id)
  }));
  return { value, authority, details, membershipDigest: hash({ value, details }) };
}
export function previewSubtreeScope(store, input, actor) {
  return transaction(store, () => {
    const current = facts(store, input, actor);
    const gate = store.db
      .prepare('SELECT * FROM subtree_scope_gates WHERE threadId=?')
      .get(input.threadId);
    return {
      projectId: input.projectId,
      threadId: input.threadId,
      gate,
      authority: current.authority,
      membershipDigest: current.membershipDigest
    };
  });
}
export function controlSubtreeScope(store, input, operationId, actor) {
  if (
    !input ||
    Object.keys(input).sort().join(',') !==
      'action,authority,expectedGateVersion,membershipDigest,projectId,threadId' ||
    !['pause', 'stop', 'resume'].includes(input.action) ||
    !Number.isSafeInteger(input.expectedGateVersion) ||
    input.expectedGateVersion < 1 ||
    !/^[a-f0-9]{64}$/.test(input.membershipDigest) ||
    typeof operationId !== 'string' ||
    !operationId.trim()
  )
    throw Error('Invalid scope action.');
  if (
    !Array.isArray(input.authority) ||
    !input.authority.every(
      (a) =>
        a &&
        Object.keys(a).sort().join(',') === 'threadId,version' &&
        typeof a.threadId === 'string' &&
        Number.isSafeInteger(a.version) &&
        a.version >= 1
    )
  )
    throw Error('Invalid thread authority.');
  input = {
    projectId: input.projectId,
    threadId: input.threadId,
    action: input.action,
    authority: input.authority.map((a) => ({ threadId: a.threadId, version: a.version })),
    expectedGateVersion: input.expectedGateVersion,
    membershipDigest: input.membershipDigest
  };
  return transaction(store, () => {
    const current = facts(store, input, actor);
    const digest = hash(['chat.scope.control', input]);
    const prior = store.db
      .prepare('SELECT * FROM command_receipts WHERE operationId=?')
      .get(operationId);
    if (prior) {
      const receipt = JSON.parse(prior.receipt);
      const seal = store.db
        .prepare('SELECT * FROM subtree_scope_operations WHERE operationId=?')
        .get(operationId);
      if (
        prior.digest !== digest ||
        receipt.operationId !== operationId ||
        !seal ||
        seal.projectId !== input.projectId ||
        seal.threadId !== input.threadId ||
        seal.receiptDigest !== hash(receipt) ||
        JSON.stringify(receipt.scopeIntent) !== JSON.stringify(input)
      )
        throw Error('Scope operation identity conflicts.');
      return receipt;
    }
    if (
      JSON.stringify(current.authority) !== JSON.stringify(input.authority) ||
      current.membershipDigest !== input.membershipDigest
    )
      throw Error('Scope authority or complete membership changed.');
    const receipt = store.acceptWithinTransaction(operationId, digest, () => {
      const gate = store.db
        .prepare('SELECT * FROM subtree_scope_gates WHERE threadId=?')
        .get(input.threadId);
      if (
        !gate ||
        gate.version !== input.expectedGateVersion ||
        (input.action === 'resume' && gate.state !== 'paused') ||
        (input.action === 'pause' && gate.state !== 'active')
      )
        throw Error('Scope gate changed.');
      if (
        input.action === 'resume' &&
        current.details.some(
          ({ task, controls }) =>
            ['interrupting', 'recovery_needed'].includes(task.status) ||
            controls.some((c) => ['pending', 'requested', 'sent', 'unconfirmed'].includes(c.state))
        )
      )
        throw Error('Unresolved work prevents scope resume.');
      const state = input.action === 'resume' ? 'active' : 'paused';
      const changed = store.db
        .prepare(
          'UPDATE subtree_scope_gates SET state=?,version=version+1 WHERE threadId=? AND version=?'
        )
        .run(state, input.threadId, input.expectedGateVersion);
      if (changed.changes !== 1) throw Error('Scope gate changed.');
      const reservations = [];
      if (input.action !== 'resume')
        for (const detail of current.details) {
          const { task, attempt, controls } = detail;
          const live = ['starting', 'running', 'waiting_for_input'].includes(task.status);
          if (!live && !(input.action === 'stop' && ['queued', 'blocked'].includes(task.status)))
            continue;
          if (
            live &&
            (!attempt ||
              attempt.status !== task.status ||
              attempt.driver !== task.provider ||
              attempt.threadId !== task.nativeThreadId ||
              attempt.turnId !== task.nativeTurnId)
          )
            throw Error('Current task attempt binding differs.');
          if (
            controls.some((c) => ['pending', 'requested', 'sent', 'unconfirmed'].includes(c.state))
          )
            throw Error('Prior control is unresolved.');
          const control = store.reserveControl(
            randomUUID(),
            'task.cancel',
            store.taskView(task.id).task
          );
          reservations.push({ control, taskId: task.id, pinnedTask: task, pinnedAttempt: attempt });
        }
      const result = {
        scopeIntent: input,
        membership: current.value,
        gate: { threadId: input.threadId, state, version: gate.version + 1 },
        reservations
      };
      store.db
        .prepare('INSERT INTO subtree_scope_operations VALUES(?,?,?,?)')
        .run(operationId, input.projectId, input.threadId, hash({ operationId, ...result }));
      return result;
    });
    return JSON.parse(JSON.stringify(receipt));
  });
}

// Exact admission hook staged for ProjectChat.send, work-goal submit and dispatch.
// It must be called in the same admission transaction; never gate the shared carrier.
export function assertSubtreeAdmission(store, { threadId, goalId, taskId }) {
  if (!store.db.isTransaction) throw Error('Scope admission requires a transaction.');
  verifySubtreeScope(store.db);
  if (!threadId)
    threadId = store.db
      .prepare(
        `SELECT m.threadId FROM project_chat_turns u
    JOIN project_chat_turn_threads m ON m.turnId=u.id
    WHERE u.workGoalId=? OR u.taskId=?`
      )
      .get(goalId ?? null, taskId ?? null)?.threadId;
  if (!threadId) return;
  const ids = [threadId];
  if (
    store.db.prepare('SELECT 1 FROM project_chat_branch_threads WHERE threadId=?').get(threadId)
  ) {
    const relation = readBranchThread(store.db, threadId).branchThread;
    ids.push(
      readChatBranch(store.db, { projectId: relation.projectId, id: relation.preparationId }).branch
        .parentThreadId
    );
  }
  for (const id of ids)
    if (
      store.db.prepare('SELECT state FROM subtree_scope_gates WHERE threadId=?').get(id)?.state !==
      'active'
    )
      throw Object.assign(Error('Scope admission is paused.'), {
        status: 409,
        code: 'scope_admission_paused'
      });
}
