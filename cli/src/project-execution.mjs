// Project admissions retain their provider selection independently of current defaults.
export function validCodexProjectSelection(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    value.provider === 'codex' &&
    value.model === 'gpt-6.2-astra' &&
    ['ultra', 'high'].includes(value.reasoning)
  );
}

export function projectExecution(input) {
  return [2, 3].includes(input.version)
    ? input.executionSelection
    : { provider: 'claude', model: input.claudeModel, reasoning: null };
}

export function projectNativeIdentity(attempt) {
  return attempt.driver === 'codex'
    ? { runId: attempt.turnId, sessionId: attempt.threadId }
    : { runId: attempt.executionId, sessionId: attempt.nativeSessionId };
}
