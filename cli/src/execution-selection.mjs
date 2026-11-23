import { claudeModels } from './claude-models.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });

export function normalizeExecutionPin(selection) {
  if (
    !selection ||
    typeof selection !== 'object' ||
    Array.isArray(selection) ||
    Object.keys(selection).some((key) => !['provider', 'model', 'reasoning'].includes(key))
  )
    throw fail(400, 'Supply an explicit provider, model and reasoning.');
  const { provider, model, reasoning } = selection;
  if (
    !(
      provider === 'codex' &&
      ['gpt-6-astra', 'gpt-6.2-astra'].includes(model) &&
      (reasoning === 'ultra' || (model === 'gpt-6.2-astra' && reasoning === 'high'))
    ) &&
    !(provider === 'claude' && claudeModels.includes(model) && reasoning === null)
  )
    throw fail(400, 'Select a supported exact provider, model and reasoning.');
  return { provider, model, reasoning };
}

// All inputs except selection must come from the authoritative server transaction.
export function resolveExecutionSelection({
  selection,
  goal,
  sessionProfile,
  adapters,
  roleProvider,
  projectExecution = false
}) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection))
    throw fail(400, 'Supply an explicit model selection.');
  const allowed = ['provider', 'model', 'reasoning', 'goalId', 'expectedVersion'];
  if (Object.keys(selection).some((key) => !allowed.includes(key)))
    throw fail(400, 'Unsupported selection field.');
  const { provider, model, reasoning } = normalizeExecutionPin({
    provider: selection.provider,
    model: selection.model,
    reasoning: selection.reasoning
  });
  const codex = provider === 'codex',
    claude = provider === 'claude';

  const hasGoal = Object.hasOwn(selection, 'goalId');
  const hasVersion = Object.hasOwn(selection, 'expectedVersion');
  if (
    hasGoal !== hasVersion ||
    (goal && !hasGoal) ||
    (hasGoal &&
      (typeof selection.goalId !== 'string' ||
        !selection.goalId.trim() ||
        selection.goalId.length > 128 ||
        !Number.isSafeInteger(selection.expectedVersion) ||
        selection.expectedVersion < 1))
  )
    throw fail(400, 'Task selection requires a goal ID and expected version.');
  if (!['mixed', 'codex-only'].includes(sessionProfile?.mode))
    throw fail(409, 'The session profile cannot be verified.');
  if (claude && sessionProfile.mode === 'codex-only')
    throw fail(409, 'The session profile does not authorize Claude.');

  const adapter = adapters?.[provider];
  const permitted = codex
    ? adapter?.driver === 'codex-app-server' &&
      adapter.route === 'chatgpt' &&
      adapter.model === model &&
      (reasoning === 'high'
        ? projectExecution === true && adapter.projectReasoningEfforts?.includes('high')
        : adapter.reasoningEffort === reasoning)
    : adapter?.driver === 'claude-code' &&
      adapter.route === 'claude.ai' &&
      Array.isArray(adapter.models) &&
      adapter.models.includes(model);
  if (!permitted) throw fail(409, 'The selected adapter route cannot be verified.');

  if (hasGoal) {
    if (
      !goal ||
      goal.id !== selection.goalId ||
      !Number.isSafeInteger(goal.version) ||
      goal.version !== selection.expectedVersion
    )
      throw fail(409, 'Goal changed or cannot be verified.');
    if (!['codex', 'claude'].includes(goal.workerProvider))
      throw fail(409, 'The goal destination cannot be verified.');
    // A role-selected route has precedence in GoalStore.submit. Never replace
    // an explicit selection when that authoritative role selects another route.
    if (roleProvider != null && roleProvider !== provider)
      throw fail(409, 'The selected provider conflicts with the authorized role.');
    if (claude && (goal.workerProvider !== 'claude' || goal.claudeModel?.model !== model))
      throw fail(409, 'The goal does not authorize the selected Claude model.');
  } else if (roleProvider != null) {
    throw fail(409, 'A role route requires an authoritative goal.');
  }

  return {
    provider,
    model,
    reasoning,
    ...(hasGoal ? { goalId: selection.goalId, expectedVersion: selection.expectedVersion } : {}),
    entitlement: 'unconfirmed'
  };
}
