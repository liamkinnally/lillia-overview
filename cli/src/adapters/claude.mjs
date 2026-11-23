import { versionMismatch } from './provider-version.mjs';
import { isDeepStrictEqual } from 'node:util';
import {
  projectServer,
  projectSystemPrompt,
  projectTransport,
  verifyProjectInventory,
  ProjectMcpTranscript
} from '../project-mcp.mjs';
import { execFile, spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import {
  bindAttemptConfig,
  claudeProfileScope,
  claudeVersion,
  configDigest,
  pinVerifiedProfile
} from '../effective-config.mjs';
import { mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const version = claudeVersion;
import { claudeModels } from '../claude-models.mjs';
import { timeBudget } from '../time-budget.mjs';
import { claudeUsage } from '../provider-usage.mjs';
export { claudeModels };
const systemPrompt =
  'Answer the supplied task using its provided text. Use no tools or other agents.';
// This execution policy is already part of saved CLI profile digests. Runtime
// observations belong in task events so existing verified profiles remain usable.
const cliPolicy = {
  preferred: 'claude-desktop-code',
  preferredStatus: 'unverified',
  selected: 'installed-claude-cli',
  reason:
    'An observable Desktop Code session interface and its model entitlement have not been verified.'
};
function selectClaudeRoute(directories) {
  const installed = directories.some((dir) =>
    existsSync(path.join(dir, 'Claude.app', 'Contents', 'MacOS', 'Claude'))
  );
  return {
    preferred: 'claude-desktop-code',
    preferredStatus: installed ? 'interactive-only' : 'not-detected',
    selected: 'installed-claude-cli',
    reason: installed
      ? 'Desktop Code is interactive. Its handoff cannot report a verified model and terminal result to Lillia.'
      : 'Claude Desktop was not detected in standard application directories. Lillia can verify the local CLI before sending work.',
    checkedAt: new Date().toISOString()
  };
}
const settings = { disableAllHooks: true, forceLoginMethod: 'claudeai' };
const unavailable = (message) => Object.assign(new Error(message), { status: 409 });
const identifier = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
const nativeOptions = [
  '--safe-mode',
  '--restricted',
  '--setting-sources',
  '',
  '--settings',
  JSON.stringify(settings),
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--no-chrome',
  '--disable-slash-commands'
];

async function* frames(stream) {
  let pending = '';
  let total = 0;
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    total += Buffer.byteLength(chunk);
    if (total > 4 * 1024 * 1024) throw unavailable('Claude exceeded the bounded response size.');
    pending += chunk;
    let boundary;
    while ((boundary = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, boundary);
      pending = pending.slice(boundary + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  if (pending.trim()) yield JSON.parse(pending);
}

async function openNative({ signal, model, project }) {
  const managed = '/Library/Application Support/ClaudeCode';
  const command = await realpath(path.join(homedir(), '.local/bin/claude'));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'scion-claude-')));
  function verifyInstructionSources() {
    const locations = [
      ...['CLAUDE.md', 'rules'].map((name) => path.join(homedir(), '.claude', name)),
      ...['managed-settings.json', 'managed-settings.d', 'CLAUDE.md'].map((name) =>
        path.join(managed, name)
      )
    ];
    for (let folder = cwd; ; folder = path.dirname(folder)) {
      locations.push(
        ...['.claude', '.mcp.json', 'CLAUDE.md', 'CLAUDE.local.md'].map((name) =>
          path.join(folder, name)
        )
      );
      if (folder === path.dirname(folder)) break;
    }
    for (const file of locations) {
      try {
        lstatSync(file);
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        throw unavailable('Claude instruction sources cannot be verified.');
      }
      throw unavailable(
        'Claude instruction or managed configuration was discovered outside the supplied profile.'
      );
    }
    return true;
  }
  const env = {
    HOME: homedir(),
    USER: userInfo().username,
    TMPDIR: tmpdir(),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
    CLAUDE_CODE_MAX_RETRIES: '0'
  };
  let child;
  try {
    verifyInstructionSources();
    const options = { cwd, env, signal, timeout: 8000, maxBuffer: 64 * 1024 };
    const installed = await execute(command, ['--version'], options);
    if (installed.stdout.trim() !== version + ' (Claude Code)')
      throw unavailable(versionMismatch('Claude Code', version, installed.stdout));
    let auth;
    try {
      auth = JSON.parse(
        (await execute(command, [...nativeOptions, 'auth', 'status', '--json'], options)).stdout
      );
    } catch {
      throw unavailable(
        'The native Claude Pro login is unavailable. Check Claude Code auth status.'
      );
    }
    signal.throwIfAborted();
    const args = [
      ...nativeOptions,
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--permission-mode',
      'dontAsk',
      '--tools',
      '',
      '--model',
      model,
      '--system-prompt-snapshot',
      'off',
      '--system-prompt',
      project ? projectSystemPrompt : systemPrompt,
      ...(project ? ['--allowedTools', ...project.tools] : [])
    ];
    child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    let closed = false;
    const exited = new Promise((resolve) =>
      child.once('close', () => {
        closed = true;
        resolve();
      })
    );
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    const iterator = frames(child.stdout);
    let closing;
    function close() {
      if (!closing)
        closing = (async () => {
          if (!closed) child.kill('SIGTERM');
          const force = setTimeout(() => {
            if (!closed) child.kill('SIGKILL');
          }, 500);
          force.unref();
          try {
            await exited;
          } finally {
            clearTimeout(force);
            signal.removeEventListener('abort', abort);
            await rmdir(cwd).catch(() => {});
          }
        })();
      return closing;
    }
    const abort = () => {
      void close();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      await close();
      signal.throwIfAborted();
    }
    async function next() {
      const event = await iterator.next();
      if (event.done) throw unavailable('The native Claude process exited before its result.');
      return event.value;
    }
    function send(packet) {
      signal.throwIfAborted();
      if (closed || !child.stdin.writable)
        throw unavailable('The native Claude process disconnected.');
      child.stdin.write(JSON.stringify(packet) + '\n');
    }
    return {
      auth,
      close,
      next,
      verifyInstructionSources,
      async control(subtype, extra = {}) {
        const id = randomUUID();
        send({ type: 'control_request', request_id: id, request: { subtype, ...extra } });
        for (;;) {
          const event = await next();
          if (event.type === 'control_request')
            throw unavailable('Unexpected native Claude control request.');
          if (event.type !== 'control_response') continue;
          if (event.response?.request_id !== id || event.response.subtype !== 'success')
            throw unavailable('Claude could not confirm the requested profile setting.');
          return event.response.response;
        }
      },
      sendPrompt(prompt) {
        send({
          type: 'user',
          session_id: '',
          parent_tool_use_id: null,
          message: { role: 'user', content: prompt }
        });
      }
    };
  } catch (err) {
    if (child) child.kill('SIGKILL');
    await rmdir(cwd).catch(() => {});
    throw err.status === 409
      ? err
      : unavailable('The installed Claude CLI could not be started safely.');
  }
}

function quota(usage, model) {
  const limits = usage?.rate_limits;
  if (
    usage?.subscription_type !== 'pro' ||
    usage.rate_limits_available !== true ||
    limits?.spend?.enabled !== false ||
    (limits.extra_usage && limits.extra_usage.is_enabled !== false)
  )
    throw unavailable('Paid Claude usage is enabled or its exclusion could not be verified.');
  for (const window of [
    limits.five_hour,
    limits.seven_day,
    model === 'claude-fable-5-2' ? limits.seven_day_fable : limits.seven_day_opus
  ]) {
    if (typeof window?.utilization === 'number' && window.utilization >= 100)
      throw unavailable('A reported Claude subscription allowance is exhausted.');
  }
}

async function verify(worker, model, project) {
  const route = worker.auth;
  const initialized = await worker.control('initialize');
  const info = initialized?.account;
  if (
    route?.loggedIn !== true ||
    route.authMethod !== 'claude.ai' ||
    route.apiProvider !== 'firstParty' ||
    route.subscriptionType !== 'pro' ||
    !info ||
    !['pro', 'claude pro'].includes(String(info.subscriptionType).toLowerCase()) ||
    info.apiProvider !== 'firstParty' ||
    info.apiKeySource ||
    info.tokenSource ||
    !route.email ||
    !route.orgId ||
    !route.orgName ||
    route.email !== info.email ||
    route.orgName !== info.organization
  )
    throw unavailable('The native Claude Pro account and first-party login could not be verified.');
  const config = await worker.control('get_settings');
  if (
    config?.sources?.length !== 1 ||
    config.sources[0].source !== 'flagSettings' ||
    Object.keys(config.effective || {}).length !== 2 ||
    config.effective.forceLoginMethod !== 'claudeai' ||
    config.effective.disableAllHooks !== true ||
    config.applied?.model !== model
  )
    throw unavailable('Unexpected Claude settings, model, or instruction sources.');
  const inventory = await worker.control('mcp_status');
  if (!Array.isArray(inventory?.mcpServers) || inventory.mcpServers.length)
    throw unavailable('An unexpected Claude connector is present.');
  if (project) {
    const result = await worker.control('mcp_set_servers', {
      servers: { [projectServer]: project.server }
    });
    if (
      !isDeepStrictEqual(result?.added, [projectServer]) ||
      result.removed?.length ||
      Object.keys(result.errors ?? {}).length
    )
      throw unavailable('The scoped project MCP server was not the sole new server.');
    let registered;
    for (let n = 0; n < 12; n++) {
      registered = await worker.control('mcp_status');
      if (
        registered?.mcpServers?.length !== 1 ||
        registered.mcpServers[0].name !== projectServer ||
        registered.mcpServers[0].status !== 'pending'
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    verifyProjectInventory(registered, project.role);
  }
  return { identity: [route.email, route.orgId], models: initialized.models };
}

function verifyModel(models, model) {
  if (model !== 'claude-opus-4-6') return;
  const catalog =
    Array.isArray(models) &&
    models.length > 0 &&
    models.every((entry) => typeof entry?.value === 'string' && entry.value);
  if (catalog && models.some((entry) => entry.value === model)) return;
  const error = unavailable(
    'The native account did not separately advertise the exact Opus model entitlement.'
  );
  if (catalog) error.code = 'CLAUDE_MODEL_UNAVAILABLE';
  throw error;
}

function tokenCounts(usage) {
  const result = {};
  for (const [key, native] of [
    ['inputTokens', 'input_tokens'],
    ['outputTokens', 'output_tokens'],
    ['cacheReadInputTokens', 'cache_read_input_tokens'],
    ['cacheCreationInputTokens', 'cache_creation_input_tokens']
  ]) {
    if (Number.isSafeInteger(usage?.[native]) && usage[native] >= 0) result[key] = usage[native];
  }
  return Object.keys(result).length ? result : null;
}

export function createClaudeAdapter({
  store,
  createWorker = openNative,
  applicationDirectories = ['/Applications', path.join(homedir(), 'Applications')]
}) {
  const save = store.db.prepare(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING'
  );
  const get = store.db.prepare('SELECT value FROM settings WHERE key=?');
  save.run('claude.accountSalt', randomBytes(32).toString('hex'));
  save.run('claude.accountInstance', randomUUID());
  const runtimeInfo = {
    status: 'stopped',
    driver: 'claude-code',
    route: 'claude.ai',
    accountInstance: get.get('claude.accountInstance').value,
    profile: 'read-only supplied text',
    model: null,
    models: claudeModels,
    version,
    routeSelection: selectClaudeRoute(applicationDirectories),
    usage: { observedAt: null, windows: [] },
    modelEntitlement: 'unconfirmed until an exact native result',
    capabilities: {
      nativeResume: false,
      inspectTerminal: false,
      tools: false,
      workspaceWrite: false
    }
  };
  const owned = new Map();
  let closed = false;
  let running = false;
  let observation = null;

  function operate(prompt, onEvent, outerSignal, taskId, model, usageOnly = false) {
    if (!claudeModels.includes(model))
      return Promise.reject(unavailable('A supported exact Claude model pin is required.'));
    if (closed) return Promise.reject(unavailable('The Claude adapter is closed.'));
    if (observation) {
      const pending = owned.get(observation);
      if (usageOnly) return pending;
      observation.abort(
        Object.assign(unavailable('An authorized Claude job needs the worker.'), {
          code: 'PROVIDER_BUSY'
        })
      );
      return pending
        .catch(() => {})
        .then(() => operate(prompt, onEvent, outerSignal, taskId, model));
    }
    if (running)
      return Promise.reject(
        Object.assign(unavailable('A Claude worker is already active.'), { code: 'PROVIDER_BUSY' })
      );
    running = !usageOnly;
    const controller = new AbortController();
    if (usageOnly) observation = controller;
    const signals = [controller.signal];
    if (outerSignal) signals.push(outerSignal);
    let signal = AbortSignal.any([...signals, AbortSignal.timeout(usageOnly ? 15000 : 60000)]);
    const runId = randomUUID();
    async function operation() {
      let worker, descriptor, project, transcript;
      let submitted = false;
      let sessionId = null;
      let observedModel = null,
        assistantModelConfirmed = false;
      let messageId = null,
        projectFinal = null;
      try {
        signal.throwIfAborted();
        if (!usageOnly) runtimeInfo.routeSelection = selectClaudeRoute(applicationDirectories);
        if (taskId) {
          const attempts = store.db
            .prepare(
              `SELECT a.id FROM attempts a JOIN tasks t ON t.id=a.taskId WHERE a.taskId=? AND a.driver='claude'
            AND a.accountInstance=? AND t.model=? AND a.status IN ('starting','running') AND t.status=a.status LIMIT 2`
            )
            .all(taskId, runtimeInfo.accountInstance, model);
          if (attempts.length === 1)
            store.addEvent(taskId, 'provider/routeSelected', {
              ...runtimeInfo.routeSelection,
              attemptId: attempts[0].id
            });
          descriptor = await store.projectDevelopment?.toolSession(taskId);
          if (descriptor) {
            if (
              attempts.length !== 1 ||
              typeof store.projectDevelopment.confirmToolUse !== 'function'
            )
              throw unavailable('Missing reserved project attempt.');
            project = await projectTransport(descriptor, taskId, attempts[0].id);
            signal.throwIfAborted();
            const { goalId } = store.taskView(taskId).task;
            const { remainingMs } = timeBudget(store.db, goalId);
            if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0)
              throw unavailable('Project active-time allowance is exhausted.');
            signal = AbortSignal.any([
              ...signals,
              AbortSignal.timeout(Math.min(1800000, remainingMs))
            ]);
            transcript = new ProjectMcpTranscript(descriptor, runId, (receipt) =>
              store.projectDevelopment.confirmToolUse(receipt)
            );
          }
        }
        worker = await createWorker({ signal, model, project });
        const { identity, models } = await verify(worker, model, project);
        const digest = createHmac('sha256', get.get('claude.accountSalt').value)
          .update(JSON.stringify(identity))
          .digest('hex');
        const bound = get.get('claude.accountBinding')?.value;
        const hasClaudeBaseline = store.db
          .prepare("SELECT 1 FROM provider_config_baselines WHERE driver='claude' LIMIT 1")
          .get();
        if ((bound || prompt !== null || hasClaudeBaseline) && bound !== digest)
          throw unavailable('The installed Claude account differs from the pinned instance.');
        const usage = await worker.control('get_usage', { skip_behaviors: true });
        if (usageOnly) {
          signal.throwIfAborted();
          if (
            usage?.subscription_type !== 'pro' ||
            usage.rate_limits_available !== true ||
            !usage.rate_limits
          )
            throw unavailable('The subscription did not provide a quota observation.');
          runtimeInfo.usage = claudeUsage(usage);
          return runtimeInfo.usage;
        }
        if (bound) runtimeInfo.usage = claudeUsage(usage);
        quota(usage, model);
        signal.throwIfAborted();
        if (worker.verifyInstructionSources() !== true)
          throw unavailable('Claude instruction origins changed.');
        verifyModel(models, model);
        if (prompt === null) save.run('claude.accountBinding', digest);
        if (get.get('claude.accountBinding')?.value !== digest)
          throw unavailable('The installed Claude account differs from the pinned instance.');
        if (!bound) runtimeInfo.usage = claudeUsage(usage);
        const profile = pinVerifiedProfile(
          store,
          'claude',
          claudeProfileScope(model, project?.role ?? null, version),
          {
            profileVersion: 1,
            nativeVersion: version,
            model,
            route: 'claude.ai',
            routeSelection: cliPolicy,
            layers: [
              { source: 'flagSettings', revisionDigest: configDigest(JSON.stringify(settings)) }
            ],
            instructionSources: {
              suppliedSystemPromptDigest: configDigest(
                project ? projectSystemPrompt : systemPrompt
              ),
              nativeUser: 'absent',
              managed: 'absent',
              projectAndAncestor: 'absent'
            },
            disabledConnectorCount: 0,
            connectorSetDigest: configDigest(JSON.stringify(project ? [projectServer] : [])),
            tools: project?.tools ?? [],
            permissionMode: 'dontAsk',
            workspaceWrite: false,
            CLIFlags: [
              'safe-mode',
              'restricted',
              'strict-mcp-config',
              'no-chrome',
              'disable-slash-commands',
              'no-session-persistence'
            ],
            accountRoute: 'first-party-existing-pro',
            paidSpend: 'verified-disabled',
            ...(project ? { projectMcp: project.attestation } : {})
          }
        );
        runtimeInfo.model = model;
        runtimeInfo.effectiveConfig = profile;
        runtimeInfo.status = 'ready';
        runtimeInfo.error = null;
        if (prompt === null) return;
        // The write may have reached the provider even if a subsequent acknowledgement is lost.
        if (project) {
          if (!Array.isArray(models) || !models.some((m) => m.value === model))
            throw unavailable('The scoped project model is not advertised on this account.');
          if (!isDeepStrictEqual(descriptor, await store.projectDevelopment.toolSession(taskId)))
            throw unavailable('Project authority changed before native dispatch.');
          verifyProjectInventory(await worker.control('mcp_status'), project.role);
        }
        bindAttemptConfig(store, {
          taskId,
          driver: 'claude',
          accountInstance: runtimeInfo.accountInstance,
          profile
        });
        submitted = true;
        worker.sendPrompt(prompt);
        for (;;) {
          const event = await worker.next();
          signal.throwIfAborted();
          const meter = event.rate_limit_info;
          if (
            event.type === 'rate_limit_event' &&
            (meter?.isUsingOverage || meter?.overageInUse || meter?.overageEnabled)
          )
            throw unavailable('Claude reported a change to paid usage during inference.');
          if (
            event.type === 'control_request' ||
            event.type === 'tool_use_summary' ||
            event.type === 'tool_progress' ||
            (event.type === 'system' &&
              ['task_started', 'task_progress', 'task_notification'].includes(event.subtype))
          )
            throw unavailable(
              'Unexpected Claude tool, child task or control request during inference.'
            );
          if (event.type === 'system' && event.subtype === 'init') {
            if (
              sessionId ||
              !Array.isArray(event.tools) ||
              !Array.isArray(event.mcp_servers) ||
              !isDeepStrictEqual([...event.tools].sort(), [...(project?.tools ?? [])].sort()) ||
              !isDeepStrictEqual(
                event.mcp_servers.map((s) => [s.name, s.status]),
                project ? [[projectServer, 'connected']] : []
              ) ||
              !identifier(event.session_id) ||
              !identifier(event.model)
            )
              throw unavailable(
                'Claude reported unexpected tools, connectors, or session metadata.'
              );
            sessionId = event.session_id;
            observedModel = event.model;
            onEvent({
              type: 'started',
              runId,
              sessionId,
              expectedModel: model,
              model: observedModel
            });
            if (observedModel !== model)
              throw unavailable('Claude reported a different native model.');
          } else if (event.type === 'assistant') {
            if (!sessionId || event.session_id !== sessionId)
              throw unavailable('Claude session identity changed.');
            if (
              !Array.isArray(event.message?.content) ||
              event.message.content.some(
                (part) =>
                  !['text', 'thinking', 'redacted_thinking'].includes(part?.type) &&
                  !(project && part?.type === 'tool_use')
              )
            )
              throw unavailable('Claude produced an unexpected tool or content item.');
            if (event.message.model !== model) {
              onEvent({
                type: 'modelMismatch',
                runId,
                sessionId,
                expectedModel: model,
                model: identifier(event.message.model) ? event.message.model : null
              });
              throw unavailable('Claude assistant output lacks the exact authorized native model.');
            }
            assistantModelConfirmed = true;
            if (project) {
              if (!identifier(event.message.id))
                throw unavailable('Project assistant message lacks native identity.');
              const parts = event.message.content;
              projectFinal = parts.some((p) => p.type === 'tool_use')
                ? null
                : {
                    id: event.message.id,
                    text: parts
                      .filter((p) => p.type === 'text')
                      .map((p) => p.text)
                      .join('')
                  };
            } else if (identifier(event.message.id)) messageId = event.message.id;
            for (const part of event.message.content) {
              if (part.type === 'tool_use') transcript.call(sessionId, part);
              if (!project && part.type === 'text' && typeof part.text === 'string')
                onEvent({
                  type: 'message',
                  runId,
                  sessionId,
                  model: observedModel,
                  messageId,
                  text: part.text
                });
            }
          } else if (project && event.type === 'user') {
            if (
              !sessionId ||
              event.session_id !== sessionId ||
              !Array.isArray(event.message?.content) ||
              !event.message.content.length ||
              !event.message.content.every((part) => part.type === 'tool_result')
            )
              throw unavailable('Unexpected project user event.');
            projectFinal = null;
            for (const part of event.message.content) await transcript.result(sessionId, part);
          } else if (event.type === 'result') {
            transcript?.complete();
            if (!sessionId || event.session_id !== sessionId)
              throw unavailable('Claude returned a result for an unconfirmed session.');
            const success =
              event.subtype === 'success' &&
              event.is_error === false &&
              typeof event.result === 'string';
            if (
              success &&
              (!assistantModelConfirmed ||
                (event.model !== undefined && event.model !== model) ||
                Object.keys(event.modelUsage ?? {}).length !== 1 ||
                Object.keys(event.modelUsage)[0] !== model)
            )
              throw unavailable('Claude terminal result lacks the exact authorized native model.');
            if (project && success) {
              if (
                !projectFinal ||
                !projectFinal.text ||
                projectFinal.text !== event.result ||
                !identifier(event.uuid)
              )
                throw unavailable(
                  'Project terminal result differs from the final native assistant message.'
                );
              messageId = projectFinal.id;
              onEvent({
                type: 'message',
                runId,
                sessionId,
                model: observedModel,
                messageId,
                text: event.result
              });
            }
            const result = {
              status: success ? 'completed' : 'failed',
              output: success ? event.result : '',
              sessionId,
              runId,
              nativeTurnId: null,
              model: observedModel,
              expectedModel: model,
              messageId,
              resultId: identifier(event.uuid) ? event.uuid : null,
              usage: tokenCounts(event.usage),
              error: success ? null : 'Claude reported a failed native turn.'
            };
            onEvent({ type: result.status, ...result });
            return result;
          }
        }
      } catch (err) {
        if (usageOnly && controller.signal.reason?.code === 'PROVIDER_BUSY')
          throw controller.signal.reason;
        const message =
          err?.status === 409
            ? err.message
            : signal.aborted
              ? 'Claude execution ended before a confirmed result.'
              : 'Claude did not confirm the native operation.';
        if (!closed && !usageOnly) {
          runtimeInfo.status = 'error';
          runtimeInfo.error = message;
        }
        const failure = Object.assign(unavailable(message), {
          uncertain: submitted,
          runId,
          sessionId
        });
        if (!submitted && err.code === 'CLAUDE_MODEL_UNAVAILABLE') failure.code = err.code;
        throw failure;
      } finally {
        try {
          if (worker) await worker.close();
        } finally {
          if (usageOnly) observation = null;
          else running = false;
          owned.delete(controller);
        }
      }
    }
    const task = Promise.resolve().then(operation);
    owned.set(controller, task);
    return task;
  }

  return {
    runtimeInfo,
    refreshUsage({ signal } = {}) {
      return operate(null, null, signal, null, runtimeInfo.model ?? 'claude-opus-4-6', true);
    },
    start({ model } = {}) {
      return operate(null, () => {}, null, null, model);
    },
    run({ prompt, onEvent = () => {}, signal, taskId, model }) {
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000)
        return Promise.reject(unavailable('Supply between 1 and 20,000 characters of text.'));
      return operate(prompt, onEvent, signal, taskId, model);
    },
    async inspectTerminalAttempt() {
      throw unavailable('Ephemeral Claude sessions do not support terminal inspection.');
    },
    async close() {
      closed = true;
      runtimeInfo.status = 'stopped';
      const tasks = [...owned.values()];
      for (const stop of owned.keys()) stop.abort();
      await Promise.allSettled(tasks);
    }
  };
}
