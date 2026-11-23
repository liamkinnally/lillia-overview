import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createCodexAdapter } from './adapters/codex.mjs';
import { installEffectiveConfigs } from './effective-config.mjs';
import { CodexRuntime } from './runtime.mjs';
import { TaskStore } from './store.mjs';

const bundled =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const loginHelp =
  'Run codex login in a terminal, complete ChatGPT sign-in in your browser, then try again.';
export const sessionError = (code, message) => Object.assign(new Error(message), { code });

function nativeRuntime(options) {
  if (process.platform !== 'darwin') return new CodexRuntime(options);
  // The native account stays in its normal credential store. Keep the user's global
  // AGENTS files out of the model context even when a native extension discovers them.
  return new CodexRuntime({
    ...options,
    command: '/usr/bin/sandbox-exec',
    args: [
      '-D',
      'guide=' + path.join(homedir(), '.codex', 'AGENTS.md'),
      '-D',
      'override=' + path.join(homedir(), '.codex', 'AGENTS.override.md'),
      '-p',
      '(version 1) (allow default) (deny file-read* (literal (param "guide")) (literal (param "override")) (with no-report))',
      options.command,
      ...options.args
    ]
  });
}

export async function nativeLogin(signal) {
  const file = existsSync(bundled) ? bundled : 'codex';
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = spawn(file, ['-c', 'forced_login_method="chatgpt"', 'login'], {
      stdio: 'ignore',
      signal,
      cwd: tmpdir(),
      env: {
        HOME: homedir(),
        TMPDIR: tmpdir(),
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin'
      }
    });
    const failed = () =>
      reject(signal.aborted ? signal.reason : sessionError('CODEX_SIGN_IN_REQUIRED', loginHelp));
    child.once('error', failed);
    child.once('exit', (code) => (code === 0 ? resolve() : failed()));
  });
}

export async function withSessionRuntime({ runtimeFactory = nativeRuntime, signal }, operation) {
  signal.throwIfAborted();
  // Account/profile verification uses the established adapter. No tasks are enrolled
  // and the private in-memory store is discarded when this request ends.
  const store = new TaskStore(':memory:');
  installEffectiveConfigs(store.db);
  const adapter = createCodexAdapter({ store, workspaceRoot: tmpdir(), runtimeFactory });
  const stopped = () => {
    setImmediate(() => {
      void adapter.close().catch(() => {});
    });
  };
  signal.addEventListener('abort', stopped, { once: true });
  try {
    try {
      await adapter.runtime.start();
    } catch (error) {
      signal.throwIfAborted();
      if (/existing paid ChatGPT login|identify the signed-in ChatGPT account/i.test(error.message))
        throw sessionError('CODEX_SIGN_IN_REQUIRED', loginHelp);
      throw sessionError('CODEX_SESSION_UNAVAILABLE', error.message);
    }
    signal.throwIfAborted();
    return await operation(adapter.runtime, adapter.runtimeInfo, signal);
  } finally {
    signal.removeEventListener('abort', stopped);
    await adapter.close();
    store.close();
  }
}

export async function verifiedAccount(runtime, info) {
  const worker = runtime.worker;
  await runtime.guard(worker);
  const limits = await runtime.verifyInstance(false, worker);
  const accountBinding = createHash('sha256')
    .update(JSON.stringify([runtime.identity, limits.accountId]))
    .digest('hex');
  return {
    summary: {
      provider: 'Codex',
      model: info.model,
      account: 'Signed in with ChatGPT',
      accountBinding
    },
    limits
  };
}

function included(limits, model) {
  const applicable = [
    limits.rateLimits,
    ...Object.values(limits.rateLimitsByLimitId ?? {}).filter((l) => l?.normalModelSlug === model)
  ];
  return (
    limits.ordinaryUsageAllowed === true &&
    applicable.every((limit) => {
      const windows = [limit?.primary, limit?.secondary].filter(Boolean);
      return (
        windows.length &&
        !limit.spendControlReached &&
        !limit.rateLimitReachedType &&
        windows.every(
          (w) => Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent < 100
        )
      );
    })
  );
}

export async function openConversation(runtime, info, instructions) {
  const worker = runtime.worker;
  const start = await runtime.nativeRequest(worker, 'thread/start', {
    model: info.model,
    modelProvider: 'openai',
    allowProviderModelFallback: false,
    cwd: runtime.cwd,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
    environments: [],
    dynamicTools: [],
    selectedCapabilityRoots: [],
    baseInstructions: instructions,
    config: {
      include_environment_context: false,
      include_permissions_instructions: false,
      include_apps_instructions: false,
      'skills.include_instructions': false
    }
  });
  if (
    !start.thread?.id ||
    start.thread.status?.type !== 'idle' ||
    start.thread.ephemeral !== true ||
    start.thread.path !== null ||
    !Array.isArray(start.thread.environments) ||
    start.thread.environments.length ||
    !Array.isArray(start.runtimeWorkspaceRoots) ||
    start.runtimeWorkspaceRoots.length ||
    !Array.isArray(start.instructionSources) ||
    start.instructionSources.length ||
    start.cwd !== runtime.cwd ||
    start.model !== info.model ||
    start.modelProvider !== 'openai' ||
    start.reasoningEffort !== info.reasoningEffort ||
    start.sandbox?.type !== 'readOnly' ||
    start.sandbox.networkAccess !== false ||
    start.approvalPolicy !== 'never'
  )
    throw Error('Codex could not confirm session isolation, instructions, model or permissions.');
  await runtime.checkThread(start.thread.id, worker);
  return start.thread.id;
}

export async function askNative(
  runtime,
  info,
  { input, instructions, outputSchema, accountBinding },
  signal
) {
  const checkAccount = async () => {
    const { summary, limits } = await verifiedAccount(runtime, info);
    if (accountBinding !== undefined && summary.accountBinding !== accountBinding)
      throw sessionError(
        'CODEX_ACCOUNT_CHANGED',
        'The signed-in ChatGPT account changed. Reopen the session with the current account.'
      );
    if (!included(limits, info.model))
      throw Error('The included Codex subscription quota is exhausted or unavailable.');
  };
  await checkAccount();
  signal.throwIfAborted();
  const worker = runtime.worker;
  const threadId = await openConversation(runtime, info, instructions);
  await checkAccount();
  signal.throwIfAborted();
  return waitForAnswer(runtime, worker, { threadId, input, outputSchema }, signal);
}

async function waitForAnswer(runtime, worker, turn, signal) {
  let turnId, final, failure;
  const early = [];
  const done = Promise.withResolvers();
  // Notifications may precede the native turn/start reply. Accept only final
  // output for the acknowledged thread AND turn before returning a proposal.
  function observe(event) {
    if (event.params.threadId !== turn.threadId) return;
    if (
      event.method === 'item/completed' &&
      (event.params.item?.type !== 'agentMessage' || event.params.item?.phase !== 'final_answer')
    )
      return;
    if (!['item/completed', 'turn/completed', 'model/rerouted'].includes(event.method)) return;
    if (!turnId) {
      if (early.length >= 32) fail(Error('Codex returned too many unbound conversation events.'));
      else early.push(event);
      return;
    }
    const id = event.method === 'turn/completed' ? event.params.turn?.id : event.params.turnId;
    if (id !== turnId) return;
    if (event.method === 'model/rerouted')
      fail(Error('Codex rerouted the conversation to a different model.'));
    else if (event.method === 'item/completed') {
      if (
        final !== undefined ||
        typeof event.params.item.text !== 'string' ||
        event.params.item.text.length > 24000
      )
        fail(Error('Codex returned an invalid final reply.'));
      else final = event.params.item.text;
    } else if (event.params.turn.status === 'completed' && typeof final === 'string')
      done.resolve();
    else fail(Error('Codex did not complete the conversation reply.'));
  }
  function fail(error) {
    failure = error;
    done.resolve();
  }
  function abort() {
    if (turnId && worker.status === 'ready')
      void runtime
        .nativeRequest(worker, 'turn/interrupt', { threadId: turn.threadId, turnId })
        .catch(() => {});
    fail(signal.reason);
  }
  const status = ({ status }) => {
    if (status === 'error') fail(Error('Codex disconnected during this reply.'));
  };
  const route = (params) => observe({ method: 'model/rerouted', params });
  runtime.on('notification', observe);
  runtime.on('modelRoute', route);
  runtime.on('status', status);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const result = await runtime.nativeRequest(
      worker,
      'turn/start',
      {
        ...turn,
        input: [{ type: 'text', text: turn.input }],
        environments: []
      },
      () => signal.throwIfAborted()
    );
    turnId = result.turn?.id;
    signal.throwIfAborted();
    if (!turnId || result.turn.error || ['failed', 'interrupted'].includes(result.turn.status))
      throw Error('Codex did not accept the conversation turn.');
    for (const event of early) observe(event);
    await done.promise;
    if (failure) throw failure;
    return final;
  } finally {
    signal.removeEventListener('abort', abort);
    runtime.off('notification', observe);
    runtime.off('modelRoute', route);
    runtime.off('status', status);
  }
}
