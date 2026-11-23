import path from 'node:path';
import { normalizeExecutionPin } from './execution-selection.mjs';
import { problem } from './goal-store.mjs';
import { steeringCommands } from './goal-lifecycle.mjs';
import { normalizeChatSend, normalizeThreadCreate } from './project-chat.mjs';
import { normalizeChatOrigin } from './project-chat-origins.mjs';
import { normalizeChatContext, normalizeChatSelection } from './project-chat-contexts.mjs';
import { normalizeAttachmentPin } from './project-chat-attachment-pins.mjs';
import {
  normalizeChatBranch,
  normalizeParentGrant,
  normalizeParentRevocation
} from './project-chat-branches.mjs';
import { normalizeBranchThread } from './project-chat-branch-threads.mjs';
import { normalizeBranchAttempt } from './project-chat-branch-runtime.mjs';
import { requireClaudeModel } from './claude-models.mjs';
import { normalizeJobGrant } from './job-capabilities.mjs';
import { normalizeNativeCommand } from './native-operations.mjs';
import { normalizeHarnessGit } from './harness-git.mjs';
import { normalizeCompatibility } from './git-compatibility.mjs';
import { normalizeBridge } from './git-bridge.mjs';
import { normalizeActivation } from './native-authority.mjs';
import { normalizeGitCutover } from './git-cutover.mjs';
import { normalizeJsEnrollment } from './native-javascript.mjs';
import { normalizeReviewAction } from './native-series.mjs';
import { normalizeLibraryCommand } from './research-library.mjs';
import { normalizeRegression } from './native-regression.mjs';
import { normalizeRelease } from './native-release.mjs';
import { normalizeDevelopment } from './change-flow.mjs';
import { validateActiveSeconds } from './time-budget.mjs';
import { normalizeProjectGoal } from './project-source.mjs';
import { normalizeProjectRepair } from './project-repair.mjs';
import { normalizeProjectReviewRetry } from './project-review-recovery.mjs';
import { normalizeProjectValidation } from './project-validation.mjs';
import { normalizeHandoff } from './task-handoff.mjs';

export const reviewCommands = new Set([
  'review.init',
  'review.submit',
  'review.decide',
  'review.attest',
  'review.check',
  'review.land'
]);
const ordered = (value) =>
  Array.isArray(value)
    ? value.map(ordered)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, ordered(value[key])])
        )
      : value;

export function objectWith(input, fields) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !fields.includes(key))
  )
    throw problem(400, 'Unexpected input fields.');
}
export function requiredText(value, name, limit = 20000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw problem(400, name + ' must contain between 1 and ' + limit + ' characters.');
  }
  return value.trim();
}
export function page(input, fallback, max) {
  objectWith(input, ['after', 'limit']);
  const { after = 0, limit = fallback } = input;
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > max
  ) {
    throw problem(400, 'Invalid cursor or page size.');
  }
  return [after, limit];
}

function validateGoalRepair(input) {
  objectWith(input, ['id', 'revisionId', 'decisionId', 'expectedVersion']);
  const result = Object.fromEntries(
    ['id', 'revisionId', 'decisionId'].map((k) => [k, requiredText(input[k], k, 128)])
  );
  if (input.expectedVersion !== undefined) {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
      throw problem(400, 'Select a positive goal version.');
    result.expectedVersion = input.expectedVersion;
  }
  return result;
}

function validateRegression(input, name) {
  return normalizeRegression(name, input);
}

function validateCompat(input, name) {
  return normalizeCompatibility(name, input);
}

function validateBridge(input, name) {
  return normalizeBridge(name, input);
}

function validateNative(input, name) {
  return normalizeNativeCommand(name, input);
}

function validateJobRevoke(input) {
  objectWith(input, ['id']);
  return { id: requiredText(input.id, 'Capability ID', 128) };
}

function validateGoalDevelop(input) {
  return normalizeDevelopment(input, {
    native: typeof input?.base === 'string' && input.base.length === 64
  });
}

function validateLibraryCommand(input, name) {
  return normalizeLibraryCommand(name, input);
}

function validateReviewAction(input, name) {
  return normalizeReviewAction(name, input);
}

function validateResearchGrant(input) {
  objectWith(input, ['investigationId', 'digest', 'forOperation', 'destinations']);
  return ordered(input);
}

function validateResearchRevoke(input) {
  objectWith(input, ['id']);
  return { id: requiredText(input.id, 'Research grant ID', 128) };
}

function validateBackupCreate(input) {
  objectWith(input, ['destination']);
  const destination = requiredText(input.destination, 'Destination', 4096);
  if (!path.isAbsolute(destination) || destination.split('/').includes('..'))
    throw problem(400, 'Supply an absolute backup destination without traversal.');
  return { destination: path.normalize(destination) };
}

function validateProjectRegister(input) {
  objectWith(input, ['expectedRevision']);
  if (input.expectedRevision !== undefined && !/^[a-f0-9]{40}$/.test(input.expectedRevision))
    throw problem(400, 'Expected revision must be a full SHA-1 commit ID.');
  return { expectedRevision: input.expectedRevision };
}

function validateGoalAccept(input) {
  objectWith(input, ['id', 'expectedVersion', 'criterionId', 'taskId', 'note']);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw problem(400, 'A positive expected goal version is required.');
  return {
    id: requiredText(input.id, 'Goal ID', 128),
    expectedVersion: input.expectedVersion,
    criterionId: requiredText(input.criterionId, 'Criterion ID', 128),
    taskId: requiredText(input.taskId, 'Task ID', 128),
    note: requiredText(input.note, 'Review note', 2000)
  };
}

function validateResearchImport(input) {
  objectWith(input, ['directory', 'expectedVersion']);
  const directory = requiredText(input.directory, 'Catalog directory', 4096);
  if (!path.isAbsolute(directory)) throw problem(400, 'Catalog directory must be absolute.');
  if (input.expectedVersion !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedVersion))
    throw problem(400, 'Invalid catalog version.');
  return { directory, expectedVersion: input.expectedVersion };
}

function validateGoalVersion(input, name) {
  const amend = name === 'goal.amend';
  objectWith(
    input,
    amend ? ['id', 'expectedVersion', 'objective', 'criteria'] : ['id', 'expectedVersion']
  );
  const id = requiredText(input.id, 'Goal ID', 128);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw problem(400, 'A positive expected goal version is required.');
  return {
    id,
    expectedVersion: input.expectedVersion,
    ...(amend
      ? commandInput('goal.create', { objective: input.objective, criteria: input.criteria })
      : {})
  };
}

function validateTaskControl(input) {
  objectWith(input, ['id']);
  return { id: requiredText(input.id, 'Task ID', 128) };
}

function validateTaskSubmit(input) {
  objectWith(input, ['goalId', 'prompt', 'provider', 'expectedVersion', 'executionSelection']);
  const executionSelection =
    input.executionSelection === undefined
      ? undefined
      : normalizeExecutionPin(input.executionSelection);
  if (
    (executionSelection &&
      (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) ||
    (!executionSelection && input.expectedVersion !== undefined)
  )
    throw problem(
      400,
      'An explicit execution selection requires a positive expected goal version.'
    );
  if (
    executionSelection &&
    input.provider !== undefined &&
    input.provider !== executionSelection.provider
  )
    throw problem(400, 'Provider and execution selection disagree.');
  if (input.provider !== undefined && !['codex', 'claude'].includes(input.provider))
    throw problem(400, 'Unknown task provider.');
  return {
    goalId: requiredText(input.goalId, 'Goal ID', 128),
    prompt: requiredText(input.prompt, 'Prompt'),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(executionSelection ? { expectedVersion: input.expectedVersion, executionSelection } : {})
  };
}

function validateGoalCreate(input) {
  objectWith(input, [
    'objective',
    'criteria',
    'maxAttempts',
    'maxActiveSeconds',
    'workerProvider',
    'claudeModel',
    'executionSelection'
  ]);
  if (input.claudeModel !== undefined) requireClaudeModel(input.claudeModel);
  const executionSelection =
    input.executionSelection === undefined
      ? undefined
      : normalizeExecutionPin(input.executionSelection);
  if (
    executionSelection &&
    ((input.workerProvider !== undefined && input.workerProvider !== executionSelection.provider) ||
      (input.claudeModel !== undefined &&
        (executionSelection.provider !== 'claude' ||
          input.claudeModel !== executionSelection.model)))
  )
    throw problem(400, 'Goal destination and execution selection disagree.');
  if (input.workerProvider !== undefined && !['codex', 'claude'].includes(input.workerProvider))
    throw problem(400, 'Unknown worker provider.');
  const objective = requiredText(input.objective, 'Objective');
  if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > 32) {
    throw problem(400, 'Supply between 1 and 32 acceptance criteria.');
  }
  const criteria = input.criteria.map((value) => {
    if (typeof value === 'string') return requiredText(value, 'Criterion', 2000);
    objectWith(value, ['type', 'expected']);
    if (
      value.type !== 'exact-output' ||
      typeof value.expected !== 'string' ||
      !value.expected.trim() ||
      value.expected.length > 2000
    )
      throw problem(400, 'Invalid exact-output criterion.');
    return { type: 'exact-output', expected: value.expected };
  });
  if (new Set(criteria.map((c) => JSON.stringify(c))).size !== criteria.length)
    throw problem(400, 'Acceptance criteria must be distinct.');
  const { maxAttempts } = input;
  if (
    maxAttempts !== undefined &&
    (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 256)
  ) {
    throw problem(400, 'Select an initial allowance of 1 to 256 attempts.');
  }
  return {
    objective,
    criteria,
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(input.maxActiveSeconds !== undefined
      ? { maxActiveSeconds: validateActiveSeconds(input.maxActiveSeconds) }
      : {}),
    ...(input.workerProvider !== undefined ? { workerProvider: input.workerProvider } : {}),
    ...(input.claudeModel !== undefined ? { claudeModel: input.claudeModel } : {}),
    ...(executionSelection ? { executionSelection } : {})
  };
}

import { normalizeOwnerMailSend, normalizeOwnerMailAction } from './thread-mail-owner-input.mjs';
import { normalizeMailSetting } from './thread-mail-settings.mjs';
import { normalizeMailPreview } from './thread-mail-preview.mjs';

function normalizeScopeAction(input) {
  objectWith(input, [
    'projectId',
    'threadId',
    'action',
    'authority',
    'expectedGateVersion',
    'membershipDigest'
  ]);
  if (!Array.isArray(input.authority)) throw problem(400, 'Supply exact thread authority.');
  for (const row of input.authority) objectWith(row, ['threadId', 'version']);
  return {
    projectId: input.projectId,
    threadId: input.threadId,
    action: input.action,
    authority: input.authority.map((row) => ({ threadId: row.threadId, version: row.version })),
    expectedGateVersion: input.expectedGateVersion,
    membershipDigest: input.membershipDigest
  };
}

const commandInputs = new Map([
  ['chat.scope.control', normalizeScopeAction],
  ['chat.mail.preview', normalizeMailPreview],
  ['chat.mail.configure', normalizeMailSetting],
  ['chat.mail.send', normalizeOwnerMailSend],
  ['chat.mail.acknowledge', (input) => normalizeOwnerMailAction(input, 'chat.mail.acknowledge')],
  ['chat.mail.resolve', (input) => normalizeOwnerMailAction(input, 'chat.mail.resolve')],
  ...Array.from(reviewCommands, (name) => [name, ordered]),
  ...Array.from(steeringCommands, (name) => [name, validateGoalVersion]),
  ['authority.activate', normalizeActivation],
  ['authority.migrate', normalizeGitCutover],
  ['authority.policy', validateReviewAction],
  ['backup.create', validateBackupCreate],
  ['chat.send', normalizeChatSend],
  ['chat.thread.create', normalizeThreadCreate],
  ['chat.origin.create', normalizeChatOrigin],
  ['chat.context.pin', normalizeChatContext],
  ['chat.attachment.pin', normalizeAttachmentPin],
  ['chat.branch.prepare', normalizeChatBranch],
  ['chat.branch.create', normalizeBranchThread],
  ['chat.branch.start', normalizeBranchAttempt],
  ['chat.parent.grant', normalizeParentGrant],
  ['chat.parent.revoke', normalizeParentRevocation],
  ['chat.selection.create', normalizeChatSelection],
  ['compat.inspect', normalizeHarnessGit],
  ['daemon.drain', ordered],
  ['daemon.resume', ordered],
  ['goal.repair', validateGoalRepair],
  ['goal.develop', validateGoalDevelop],
  ['goal.accept', validateGoalAccept],
  ['goal.run', validateGoalVersion],
  ['goal.create', validateGoalCreate],
  ['job.grant', normalizeJobGrant],
  ['job.revoke', validateJobRevoke],
  ['js.enroll', normalizeJsEnrollment],
  ['mail.post', ordered],
  ['mail.resolve', ordered],
  ['project.validation.enroll', normalizeProjectValidation],
  ['project.develop', normalizeProjectGoal],
  ['project.repair', normalizeProjectRepair],
  ['project.review.retry', normalizeProjectReviewRetry],
  ['project.register', validateProjectRegister],
  ['release.bisect', validateRegression],
  ['release.revert', validateRegression],
  ['release.prepare', normalizeRelease],
  ['research.fetch', validateLibraryCommand],
  ['research.note', validateLibraryCommand],
  ['research.run', ordered],
  ['research.grant', validateResearchGrant],
  ['research.revoke', validateResearchRevoke],
  ['research.import', validateResearchImport],
  ['review.comment', validateReviewAction],
  ['review.resolve', validateReviewAction],
  ['review.owner', validateReviewAction],
  ['task.handoff', normalizeHandoff],
  ['task.cancel', validateTaskControl],
  ['task.reconcile', validateTaskControl],
  ['task.submit', validateTaskSubmit],
  ['worktree.capture', ordered]
]);

export function commandInput(name, input) {
  const normalize = commandInputs.get(name);
  if (normalize) return normalize(input, name);
  if (name.startsWith('compat.')) return validateCompat(input, name);
  if (name.startsWith('bridge.')) return validateBridge(input, name);
  if (name.startsWith('native.')) return validateNative(input, name);
  throw problem(404, 'Unknown command.');
}
