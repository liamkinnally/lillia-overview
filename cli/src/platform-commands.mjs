import { problem } from './goal-store.mjs';
import { applyMailSetting } from './thread-mail-settings.mjs';
import { applyMailPreview } from './thread-mail-preview.mjs';
import { executionReceipt } from './execution-pins.mjs';
import { steerGoal, steeringCommands } from './goal-lifecycle.mjs';
import { verifyGitCutoverHistory } from './recovery.mjs';
import { createChatOrigin } from './project-chat-origins.mjs';
import { pinChatContext, createChatSelection } from './project-chat-contexts.mjs';
import { createAttachmentPin } from './project-chat-attachment-pins.mjs';
import {
  createChatBranch,
  createParentGrant,
  revokeParentGrant
} from './project-chat-branches.mjs';
import { createBranchThread } from './project-chat-branch-threads.mjs';

export function createAcceptedCommandHandler({
  mail,
  chat,
  jobs,
  drain,
  series,
  harnessGit,
  projectDevelopment,
  nativeDevelopment,
  regressions,
  authority,
  admitDevelopment,
  disclosures,
  store,
  project,
  research,
  evaluation,
  root,
  planning,
  adapter,
  getPlanningError
}) {
  function acceptChatSend({ normalized, operationId }) {
    return chat.send(normalized, operationId);
  }

  function acceptJobGrant({ normalized }) {
    return { capability: jobs.grant(normalized) };
  }

  function acceptJobRevoke({ normalized }) {
    return { capability: jobs.revoke(normalized.id) };
  }

  function acceptDaemonDrain({ normalized, operationId }) {
    return { drain: drain.begin(normalized, operationId) };
  }

  function acceptDaemonResume({ normalized, operationId }) {
    return { drain: drain.resume(normalized, operationId) };
  }

  function acceptReviewAction({ name, normalized, operationId }) {
    return series.apply(name, normalized, operationId);
  }

  function acceptCompatInspect({ normalized, operationId }) {
    if (!harnessGit)
      throw problem(409, 'This installation does not support provider Git inspections.');
    return harnessGit.admit(normalized, operationId);
  }

  function acceptProjectDevelop({ normalized, operationId }) {
    if (!projectDevelopment) throw problem(409, 'Reviewed project changes require schema 46.');
    return projectDevelopment.admit(normalized, operationId);
  }

  function acceptProjectRepair({ normalized, operationId }) {
    if (!projectDevelopment) throw problem(409, 'Reviewed project changes require schema 46.');
    return projectDevelopment.repair(normalized, operationId);
  }

  function acceptGoalRepair({ normalized }) {
    return nativeDevelopment.retryRejected(normalized);
  }

  function acceptReleaseBisect({ normalized, operationId }) {
    return regressions.bisect(normalized, operationId);
  }

  function acceptReleaseRevert({ normalized, operationId }) {
    return regressions.revert(normalized, operationId);
  }

  function acceptAuthorityActivate({ normalized, operationId }) {
    return authority.activate(normalized, operationId);
  }

  function acceptAuthorityMigrate({ normalized, operationId }) {
    return authority.migrate(normalized, operationId, verifyGitCutoverHistory);
  }

  function acceptJsEnroll({ normalized, operationId }) {
    return nativeDevelopment.javascript.enroll(normalized, operationId);
  }

  function acceptGoalDevelop({ normalized, operationId }) {
    return admitDevelopment(normalized, operationId);
  }

  function acceptResearchGrant({ normalized }) {
    return { grant: disclosures.grant(normalized) };
  }

  function acceptResearchRevoke({ normalized }) {
    return { grant: disclosures.revoke(normalized.id) };
  }

  function acceptMailPost({ normalized }) {
    return { message: store.coordination.post(normalized) };
  }

  function acceptMailResolve({ normalized }) {
    return { message: store.coordination.resolve(normalized) };
  }

  function acceptProjectRegister({ capture }) {
    return { capture: project.register(capture) };
  }

  function acceptResearchImport({ bundle }) {
    return { catalog: research.importVerified(bundle) };
  }

  function acceptGoalAccept({ normalized }) {
    return { evidence: evaluation.accept(normalized) };
  }

  function acceptGoalCreate({ normalized, operationId }) {
    return executionReceipt(
      'goal.create',
      normalized,
      operationId,
      'goal',
      store.createGoal(normalized),
      store.db
    );
  }

  function acceptTaskHandoff({ normalized, operationId }) {
    if (!store.taskHandoffs) throw problem(409, 'Task handoffs require schema 45.');
    return store.taskHandoffs.admit(normalized, operationId, root);
  }

  function acceptTaskSubmit({ normalized, operationId }) {
    return executionReceipt(
      'task.submit',
      normalized,
      operationId,
      'task',
      store.submit(normalized, root),
      store.db
    );
  }

  function acceptGoalRun({ normalized }) {
    const planningError = getPlanningError();
    if (planningError) throw problem(503, planningError);
    if (store.goal(normalized.id).version !== normalized.expectedVersion)
      throw problem(409, 'Goal changed. Inspect the current version before planning.');
    return { plan: planning.start(normalized.id) };
  }

  function acceptGoalSteering({ name, normalized, deliveries }) {
    const result = steerGoal(store, adapter, name, normalized);
    if (name === 'goal.amend' || name === 'goal.cancel') planning.supersede(normalized.id);
    deliveries.push(...result.controls);
    return { goal: result.goal, actions: result.controls.map(({ action }) => action) };
  }

  function acceptTaskControl({ name, normalized, operationId, deliveries }) {
    const { task } = store.taskView(normalized.id);
    if (
      name === 'task.cancel' &&
      !['queued', 'blocked'].includes(task.status) &&
      (!adapter.active?.has(task.id) || task.status === 'interrupting')
    ) {
      throw problem(409, 'This task cannot be cancelled in its current state.');
    }
    if (
      name === 'task.reconcile' &&
      (adapter.active?.has(task.id) ||
        !task.threadId ||
        !task.turnId ||
        task.status !== 'recovery_needed' ||
        typeof adapter.inspectTerminalAttempt !== 'function')
    ) {
      throw problem(
        409,
        'Reconciliation requires an inactive attempt with saved native thread and turn IDs. Inspect the native session.'
      );
    }
    const action = store.reserveControl(operationId, name, task);
    deliveries.push({ action, task });
    return { action };
  }

  const routes = new Map([
    [
      'chat.mail.preview',
      ({ normalized, operationId, actor }) =>
        applyMailPreview(store, normalized, operationId, actor)
    ],
    [
      'chat.mail.configure',
      ({ normalized, actor }) => applyMailSetting(store.db, normalized, actor)
    ],
    ...['chat.mail.send', 'chat.mail.acknowledge', 'chat.mail.resolve'].map((name) => [
      name,
      ({ normalized, operationId, actor }) => mail.apply(name, normalized, operationId, actor)
    ]),
    ...Array.from(steeringCommands, (name) => [name, acceptGoalSteering]),
    ['authority.policy', acceptReviewAction],
    ['authority.activate', acceptAuthorityActivate],
    ['authority.migrate', acceptAuthorityMigrate],
    ['chat.send', acceptChatSend],
    [
      'chat.branch.create',
      ({ normalized, operationId }) => createBranchThread(store, normalized, operationId)
    ],
    [
      'chat.branch.prepare',
      ({ normalized, operationId }) => createChatBranch({ store, input: normalized, operationId })
    ],
    [
      'chat.parent.grant',
      ({ normalized, operationId }) => createParentGrant({ store, input: normalized, operationId })
    ],
    [
      'chat.parent.revoke',
      ({ normalized, operationId }) => revokeParentGrant({ store, input: normalized, operationId })
    ],
    [
      'chat.attachment.pin',
      ({ normalized, operationId }) => createAttachmentPin(store.db, normalized, operationId)
    ],
    [
      'chat.selection.create',
      ({ normalized, operationId }) => createChatSelection(store.db, normalized, operationId)
    ],
    [
      'chat.context.pin',
      ({ normalized, operationId }) => pinChatContext(store.db, normalized, operationId)
    ],
    [
      'chat.origin.create',
      ({ normalized, operationId }) => createChatOrigin(store.db, normalized, operationId)
    ],
    [
      'chat.thread.create',
      ({ normalized, operationId }) => chat.createThread(normalized, operationId)
    ],
    ['compat.inspect', acceptCompatInspect],
    ['daemon.drain', acceptDaemonDrain],
    ['daemon.resume', acceptDaemonResume],
    ['goal.repair', acceptGoalRepair],
    ['goal.develop', acceptGoalDevelop],
    ['goal.accept', acceptGoalAccept],
    ['goal.create', acceptGoalCreate],
    ['goal.run', acceptGoalRun],
    ['job.grant', acceptJobGrant],
    ['job.revoke', acceptJobRevoke],
    ['js.enroll', acceptJsEnroll],
    ['mail.post', acceptMailPost],
    ['mail.resolve', acceptMailResolve],
    ['project.develop', acceptProjectDevelop],
    ['project.repair', acceptProjectRepair],
    ['project.register', acceptProjectRegister],
    ['release.bisect', acceptReleaseBisect],
    ['release.revert', acceptReleaseRevert],
    ['research.grant', acceptResearchGrant],
    ['research.revoke', acceptResearchRevoke],
    ['research.import', acceptResearchImport],
    ['review.comment', acceptReviewAction],
    ['review.resolve', acceptReviewAction],
    ['review.owner', acceptReviewAction],
    ['task.handoff', acceptTaskHandoff],
    ['task.submit', acceptTaskSubmit],
    ['task.cancel', acceptTaskControl],
    ['task.reconcile', acceptTaskControl]
  ]);

  return function acceptCommand(context) {
    return routes.get(context.name)(context);
  };
}
