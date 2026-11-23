import { createCodexAdapter } from './adapters/codex.mjs';
import { createClaudeAdapter, claudeModels } from './adapters/claude.mjs';
import { assertReservedStop, assertInterruptAuthority } from './task-control-delivery.mjs';

const conflict = (message) => Object.assign(new Error(message), { status: 409 });
const unsuccessful = new Set(['failed', 'interrupted', 'blocked']);

export async function createProviderPool({
  store,
  workspaceRoot,
  codexFactory = createCodexAdapter,
  claudeFactory = createClaudeAdapter
}) {
  const codex = await codexFactory({ store, workspaceRoot });
  codex.provider = 'codex';
  codex.recoverOnStart = false;
  const codexOnly = store.sessionProfile?.mode === 'codex-only';
  let claude;
  try {
    claude = codexOnly
      ? { runtimeInfo: { status: 'disabled', reason: 'Codex-only session profile' }, close() {} }
      : await claudeFactory({ store, workspaceRoot });
  } catch (error) {
    await codex.close();
    throw error;
  }

  const activeClaude = new Map();
  let started = false,
    closed = false,
    scheduled = false;
  let working, closing, startup, preflightError, codexError;
  let verifiedModel = null;
  const refreshes = new Map(),
    lastRefresh = new Map();
  const quotaWork = store.db
    .prepare(`SELECT 1 FROM tasks t JOIN goal_tasks s ON s.taskId=t.id JOIN goals g ON g.id=s.goalId
    WHERE s.provider=? AND ((t.status='queued' AND g.state='active' AND ?=0) OR
    t.status IN ('starting','running','waiting_for_input','interrupting') OR (t.status='recovery_needed' AND t.recoveryCleared=0)) LIMIT 1`);

  async function refreshUsage(provider) {
    if (!['codex', 'claude'].includes(provider))
      throw conflict('Choose Codex or Claude for a usage observation.');
    const adapter = provider === 'claude' ? claude : codex;
    const result = (state, detail) => ({
      provider,
      state,
      usage: adapter.runtimeInfo.usage ?? { observedAt: null, windows: [] },
      ...(detail ? { detail } : {})
    });
    const drain = store.serviceDrain;
    if (closed || !started || !adapter.refreshUsage || (drain && !drain.admissionsOpen()))
      return result('unavailable', 'Usage refresh is unavailable in the current service state.');
    if (refreshes.has(provider)) return refreshes.get(provider).promise;
    if (quotaWork.get(provider, Number(store.getPaused())))
      return result('busy', 'This provider has pending or unresolved work.');
    const now = Date.now(),
      observed = Date.parse(adapter.runtimeInfo.usage?.observedAt);
    if (now >= observed && now - observed < 30000) return result('recent');
    const previous = lastRefresh.get(provider);
    if (previous && now >= previous.at && now - previous.at < 30000)
      return result(previous.state, previous.detail);
    const release = drain?.enterBackground('provider usage');
    if (drain && !release) return result('unavailable', 'The service is draining.');
    const abort = new AbortController();
    const promise = Promise.resolve().then(async () => {
      try {
        await adapter.refreshUsage({ signal: abort.signal });
        lastRefresh.set(provider, { at: Date.now(), state: 'recent' });
        return result('updated');
      } catch (error) {
        if (error.code === 'PROVIDER_BUSY')
          return result('busy', 'This provider has pending or unresolved work.');
        const detail = 'The native account did not confirm a new usage observation.';
        lastRefresh.set(provider, { at: Date.now(), state: 'unavailable', detail });
        return result('unavailable', detail);
      } finally {
        refreshes.delete(provider);
        release?.();
      }
    });
    refreshes.set(provider, { abort, promise });
    return promise;
  }

  function nextClaudeTask() {
    if (store.getPaused()) return null;
    for (const task of store.queuedTasks('claude')) {
      if (task.provider !== 'claude') continue;
      if (!claudeModels.includes(task.model)) {
        store.updateTask(task.id, {
          status: 'blocked',
          error:
            'This task has no authorized exact Claude model. Admit fresh work with a verified model pin.'
        });
        continue;
      }
      const dependencies = task.dependsOn.map((id) => store.getTask(id));
      if (dependencies.some((dep) => !dep || unsuccessful.has(dep.status))) {
        store.updateTask(task.id, { status: 'blocked', error: 'A prerequisite did not complete.' });
        continue;
      }
      if (dependencies.every((dep) => dep.status === 'completed')) return task;
    }
    return null;
  }

  function wakeClaude() {
    if (codexOnly || !started || closed || scheduled || working || preflightError) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (closed || working || preflightError) return;
      working = dispatchClaude().then(
        (handled) => {
          working = null;
          if (handled && !closed) {
            codex.kick();
            wakeClaude();
          }
        },
        () => {
          working = null;
          preflightError =
            'The Claude worker could not be scheduled. Inspect its task and restart the service.';
        }
      );
    });
  }

  async function dispatchClaude() {
    const selected = nextClaudeTask();
    if (!selected) return false;
    if (verifiedModel !== selected.model) {
      const drain = store.serviceDrain;
      const finish = drain?.enterBackground('Claude account preflight');
      if (drain && !finish) return false;
      try {
        await claude.start({ model: selected.model });
        if (claude.runtimeInfo.status !== 'ready' || !claude.runtimeInfo.accountInstance)
          throw conflict('The native Claude account is unavailable.');
        verifiedModel = selected.model;
      } catch (error) {
        if (error.code === 'CLAUDE_MODEL_UNAVAILABLE' && error.uncertain === false) {
          verifiedModel = null;
          if (!closed && nextClaudeTask()?.id === selected.id)
            store.updateTask(selected.id, { status: 'blocked', error: error.message });
          return true;
        }
        preflightError =
          claude.runtimeInfo.error ||
          'The native Claude account could not be verified. Check the login and restart the service.';
        return false;
      } finally {
        finish?.();
      }
    }
    if (closed) return false;
    // Preflight may have yielded to an owner pause, cancellation or another
    // provider. Re-read the queue; the store enforces global admission at reserve.
    const candidate = nextClaudeTask();
    if (!candidate) return false;
    if (candidate.model !== verifiedModel) return true;
    const task = store.reserveDispatch(candidate);
    if (!task) return store.getTask(candidate.id)?.status !== 'queued';
    const binding = {
      taskId: task.id,
      attemptId: null,
      nativeSessionId: null,
      executionId: null,
      controller: new AbortController(),
      accountInstance: claude.runtimeInfo.accountInstance
    };
    activeClaude.set(task.id, binding);
    try {
      binding.attemptId =
        store.db
          .prepare('SELECT id FROM attempts WHERE taskId=? ORDER BY ordinal DESC LIMIT 1')
          .get(task.id)?.id ?? null;
      store.updateTask(task.id, { status: 'running' });
      function settle(result) {
        if (binding.terminal) return;
        if (!['completed', 'failed'].includes(result.status))
          throw conflict('Claude returned no confirmed terminal outcome.');
        if (result.status === 'completed' && result.model !== task.model)
          throw conflict('Claude reported a model outside the reserved attempt.');
        store.completeClaudeAttempt(task.id, {
          ...result,
          expectedModel: task.model,
          accountInstance: binding.accountInstance
        });
        binding.terminal = true;
      }
      const result = await claude.run({
        taskId: task.id,
        model: task.model,
        prompt: task.prompt,
        signal: binding.controller.signal,
        onEvent(event) {
          if (event.type === 'completed' || event.type === 'failed') {
            settle(event);
          } else if (!binding.terminal && event.type === 'modelMismatch') {
            store.addEvent(task.id, 'provider/modelMismatch', {
              expectedModel: event.expectedModel,
              observedModel: event.model
            });
          } else if (!binding.terminal && (event.type === 'started' || event.type === 'message')) {
            store.observeClaudeIdentity(task.id, {
              sessionId: event.sessionId,
              messageId: event.messageId ?? null,
              runId: event.runId,
              accountInstance: binding.accountInstance,
              expectedModel: event.expectedModel,
              model: event.model ?? null
            });
            binding.nativeSessionId = event.sessionId;
            binding.executionId = event.runId;
          }
        }
      });
      settle(result);
    } catch (error) {
      if (binding.terminal) return true;
      // The adapter alone knows if its input write was attempted. Unknown
      // outcomes (including result-persistence failure) never re-enter the queue.
      const safe = error.uncertain === false;
      const status = safe
        ? binding.controller.signal.aborted
          ? 'interrupted'
          : 'failed'
        : 'recovery_needed';
      const modelUnavailable = safe && error.code === 'CLAUDE_MODEL_UNAVAILABLE';
      store.updateTask(task.id, {
        status,
        recoveryCleared: safe,
        error: modelUnavailable
          ? error.message
          : safe
            ? 'Claude stopped before submitting the task.'
            : 'No confirmed Claude outcome was recorded. Inspect this attempt before retrying.'
      });
      if (claude.runtimeInfo.status === 'error') {
        verifiedModel = null;
        if (!modelUnavailable)
          preflightError =
            claude.runtimeInfo.error ||
            'Claude is unavailable. Inspect the native route before restarting the service.';
      }
    } finally {
      activeClaude.delete(task.id);
    }
    return true;
  }

  // The legacy controller emits a change on final settlement, including error
  // and disconnect paths. Wake the other queue when a shared slot may be free.
  let codexSlots = codex.active.size;
  function onCodexChange() {
    const current = codex.active.size;
    if (current < codexSlots) wakeClaude();
    codexSlots = current;
  }
  codex.on?.('change', onCodexChange);

  return {
    get active() {
      return new Map([...codex.active, ...activeClaude]);
    },
    refreshUsage,
    get approvals() {
      return codex.approvals;
    },
    get runtimeInfo() {
      const codexInfo = codexError
        ? { ...codex.runtimeInfo, status: 'error', error: codexError }
        : { ...codex.runtimeInfo };
      const claudeInfo = preflightError
        ? { ...claude.runtimeInfo, status: 'error', error: preflightError }
        : { ...claude.runtimeInfo };
      return { ...codexInfo, providers: { codex: codexInfo, claude: claudeInfo } };
    },
    start() {
      if (closed) return Promise.reject(conflict('The provider pool is closed.'));
      started = true;
      wakeClaude();
      return (startup ??= Promise.resolve()
        .then(() => codex.start())
        .catch(() => {
          codexError = 'Codex startup failed. Inspect the installed provider.';
        }));
    },
    kick() {
      if (!closed && started) {
        codex.kick();
        wakeClaude();
      }
    },
    async interruptTask(id, expected, beforeInterrupt) {
      const { task } = store.taskView(id);
      if (task.provider === 'codex') return codex.interruptTask(id, expected, beforeInterrupt);
      if (task.provider !== 'claude') throw conflict('Unknown task provider.');
      const binding = activeClaude.get(id);
      if (expected) assertReservedStop(store, expected, binding, 'claude');
      if (binding?.terminal)
        throw conflict('The Claude task has already reached a native terminal outcome.');
      if (binding) {
        store.updateTask(id, { status: 'interrupting' });
        if (expected)
          assertReservedStop(store, expected, binding, 'claude', { interrupting: true });
        assertInterruptAuthority(beforeInterrupt);
        binding.controller.abort();
        return 'requested';
      }
      if (task.status === 'queued' || task.status === 'blocked') {
        store.updateTask(id, { status: 'interrupted', recoveryCleared: true, error: null });
        wakeClaude();
        return 'confirmed';
      }
      throw conflict('The Claude task is not active.');
    },
    inspectTerminalAttempt(task) {
      const { provider } = store.taskView(task.id).task;
      if (provider === 'codex') return codex.inspectTerminalAttempt(task);
      throw conflict('Ephemeral Claude sessions have no authoritative terminal inspection route.');
    },
    close() {
      if (closing) return closing;
      closed = true;
      codex.off?.('change', onCodexChange);
      for (const check of refreshes.values()) check.abort.abort();
      for (const binding of activeClaude.values()) binding.controller.abort();
      closing = Promise.allSettled([
        codex.close(),
        claude.close(),
        startup,
        working,
        ...[...refreshes.values()].map((check) => check.promise)
      ]).then((results) => {
        const failed = results.find((result) => result.status === 'rejected');
        if (failed) throw failed.reason;
      });
      return closing;
    }
  };
}
