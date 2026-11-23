import {
  CodexProjectSession,
  codexProjectTools,
  codexProjectManifest,
  codexProjectInstructions,
  codexDisabledFeatures
} from '../codex-project-tools.mjs';
import { workspaceProjectInstructions } from '../project-workspace-tools.mjs';
import { validCodexProjectSelection } from '../project-execution.mjs';
import { versionMismatch } from './provider-version.mjs';
import { EventEmitter } from 'node:events';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { assertBranchDispatch, requiresBranchDispatch } from '../project-chat-branch-dispatch.mjs';
import {
  beginMailNativeRequest,
  recordMailNativeConfirmation,
  reconcileMailDeliveries
} from '../thread-mail-native.mjs';
import {
  constants as F,
  existsSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  lstatSync
} from 'node:fs';
import {
  bindAttemptConfig,
  configDigest,
  pinVerifiedProfile,
  codexProjectProfileScope
} from '../effective-config.mjs';
import { mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Controller } from '../controller.mjs';
import { CodexRuntime } from '../runtime.mjs';
import { nativeObjectiveOutputSchema } from '../native-objective-planning.mjs';
import { planOutputSchema } from '../planning.mjs';
import { mainChatOutputSchema } from '../project-chat.mjs';
import { codexUsage } from '../provider-usage.mjs';

const model = 'gpt-6.2-astra';
const effort = 'ultra';
const nativeVersion = '0.171.0-alpha.13';
const baseInstructions =
  'Answer the supplied task using its provided context. Do not use tools or delegate.';
const disabled = codexDisabledFeatures;
const settings = [
  'model_provider="openai"',
  'forced_login_method="chatgpt"',
  `model="${model}"`,
  `model_reasoning_effort="${effort}"`,
  'notify=[]',
  'project_doc_max_bytes=0',
  'web_search="disabled"',
  'developer_instructions=""',
  'instructions=""',
  'approval_policy="never"'
];
const refuse = (message) => Object.assign(new Error(message), { status: 409, code: -32001 });
const bundled =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const envForNative = () => ({
  HOME: homedir(),
  TMPDIR: tmpdir(),
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin',
  LANG: 'en_US.UTF-8'
});

function account({ account: info }) {
  if (
    info?.type !== 'chatgpt' ||
    !['pro', 'plus', 'business', 'team', 'enterprise', 'edu'].includes(info.planType)
  )
    throw refuse('An existing paid ChatGPT login is required. Check Codex login status.');
  // Compare identity in memory. No auth response enters the user-facing store.
  if (typeof info.email !== 'string' || !info.email)
    throw refuse('Unable to identify the signed-in ChatGPT account.');
  return info.email;
}

function checkConfig(config, servers, projectHost = false, reasoning = effort) {
  const mcp = config?.mcp_servers;
  if (
    !mcp ||
    typeof mcp !== 'object' ||
    Object.entries(mcp).some(([id, v]) => !servers.has(id) || v?.enabled !== false)
  )
    throw refuse('The native connector configuration changed or could not be disabled.');
  const route = config.chatgpt_base_url;
  if (
    config.forced_login_method !== 'chatgpt' ||
    config.model_provider !== 'openai' ||
    config.openai_base_url ||
    !['https://chatgpt.com/backend-api/', 'https://chatgpt.com/backend-api'].includes(route) ||
    Object.keys(config.model_providers || {}).length
  )
    throw refuse('The native provider configuration does not verify the ChatGPT destination.');
  if (
    config.model !== model ||
    config.model_reasoning_effort !== reasoning ||
    config.web_search !== 'disabled' ||
    config.project_doc_max_bytes !== 0 ||
    config.notify?.length ||
    config.model_instructions_file ||
    config.experimental_compact_prompt_file ||
    config.developer_instructions ||
    config.instructions ||
    disabled.some(
      (flag) => config.features?.[flag] !== (projectHost && flag === 'code_mode_host')
    ) ||
    config.features?.skip_host_skill_discovery !== true
  )
    throw refuse('The required read-only native configuration could not be verified.');
}

function codexOrigins(response, servers, version, projectHost = false, reasoning = effort) {
  const types = ['sessionFlags', 'user', 'system'];
  if (version !== nativeVersion) throw refuse(versionMismatch('Codex', nativeVersion, version));
  if (response.layers?.length !== types.length)
    throw refuse('Unsupported Codex configuration layer set.');
  const layers = response.layers.map((layer, i) => {
    const { name, version, disabledReason } = layer;
    const file =
      types[i] === 'user'
        ? path.join(homedir(), '.codex', 'config.toml')
        : types[i] === 'system'
          ? '/etc/codex/config.toml'
          : undefined;
    if (
      name?.type !== types[i] ||
      name.file !== file ||
      name.profile ||
      disabledReason ||
      !/^sha256:[a-f0-9]{64}$/.test(version)
    )
      throw refuse('Unexpected Codex configuration source or revision.');
    return { source: name.type, revisionDigest: configDigest(version) };
  });
  const controls = [
    'model',
    'model_reasoning_effort',
    'model_provider',
    'forced_login_method',
    'web_search',
    'project_doc_max_bytes',
    'approval_policy',
    'notify',
    'developer_instructions',
    'instructions',
    ...disabled.map((key) => 'features.' + key),
    'features.skip_host_skill_discovery'
  ];
  const unattributed = [];
  for (const key of [
    ...controls,
    ...Array.from(servers, (id) => 'mcp_servers.' + id + '.enabled')
  ]) {
    const source = response.origins?.[key];
    if (!source && ['features.multi_agent_v2', 'notify'].includes(key)) {
      unattributed.push(key);
      continue;
    }
    if (source?.name?.type !== 'sessionFlags' || source.version !== response.layers[0].version)
      throw refuse(
        'Native configuration controls do not originate in the supplied worker options.'
      );
  }
  return {
    profileVersion: 1,
    nativeVersion: version,
    model,
    reasoningEffort: reasoning,
    route: 'chatgpt',
    layers,
    sourceOfControls: 'sessionFlags except unattributed effective values',
    unattributed,
    controls,
    disabledFeatures: disabled.filter((key) => !projectHost || key !== 'code_mode_host'),
    ...(projectHost ? { codeModeHost: true } : {}),
    disabledConnectorCount: servers.size,
    connectorSetDigest: configDigest(JSON.stringify([...servers].sort())),
    workDirectory: 'private-empty',
    projectInstructions: 'disabled',
    tools: 'supplied-text-only',
    workspaceWrite: false,
    outboundTools: false,
    approvalPolicy: 'never',
    baseInstructionsDigest: configDigest(baseInstructions)
  };
}
function instructionFiles() {
  const root = path.join(homedir(), '.codex');
  if (!lstatSync(root).isDirectory())
    throw refuse('Native instruction directory cannot be verified.');
  return ['AGENTS.md', 'AGENTS.override.md'].map((name) => {
    let fd;
    try {
      try {
        fd = openSync(path.join(root, name), F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
      } catch (error) {
        if (error.code === 'ENOENT') return { source: name, present: false };
        throw error;
      }
      const before = fstatSync(fd, { bigint: true });
      if (
        !before.isFile() ||
        before.uid !== BigInt(process.getuid()) ||
        before.nlink !== 1n ||
        before.size > 131072n
      )
        throw Error();
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let n = 0,
        count;
      while (n < bytes.length && (count = readSync(fd, bytes, n, bytes.length - n, null)) > 0)
        n += count;
      const after = fstatSync(fd, { bigint: true });
      if (
        BigInt(n) !== before.size ||
        after.ctimeNs !== before.ctimeNs ||
        after.mtimeNs !== before.mtimeNs
      )
        throw Error();
      return { source: name, present: true, bytes: n, digest: configDigest(bytes.subarray(0, n)) };
    } catch {
      throw refuse(
        'A native instruction file is unreadable, changed or exceeds the bounded profile.'
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  });
}

class AccountRuntime extends EventEmitter {
  constructor(factory, store, { projectHost = false, reasoning = effort, projectVersion } = {}) {
    super();
    this.factory = factory;
    this.projectHost = projectHost;
    this.reasoning = reasoning;
    this.projectVersion = projectVersion ?? (reasoning === 'high' ? 4 : 3);
    this.projectRuntimes = new Map();
    this.workerScope = projectHost
      ? `project-worker/${model}@${nativeVersion}/v${this.projectVersion}`
      : `worker/${model}@${nativeVersion}`;
    this.store = store;
    this.threadEvidence = new Map();
    this.projectSessions = new Map();
    this.saveSetting = store.db.prepare(
      'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING'
    );
    this.readSetting = store.db.prepare('SELECT value FROM settings WHERE key=?');
    this.saveSetting.run('codex.accountSalt', randomBytes(32).toString('hex'));
    this.accountSalt = this.readSetting.get('codex.accountSalt').value;
    this.saveSetting.run('codex.accountInstance', randomUUID());
    this.instance = this.readSetting.get('codex.accountInstance').value;
    this.status = 'stopped';
    this.threads = new Set();
    this.threadWorkspaces = new Map();
    this.verifyingThreads = new Set();
    this.isolated = store.sessionProfile?.mode === 'codex-only';
    this.epoch = 0;
  }

  setStatus(status, error) {
    this.status = status;
    this.emit('status', { status, error });
  }

  makeRuntime(servers = []) {
    const args = [
      ...disabled.flatMap((key) => [
        this.projectHost && key === 'code_mode_host' ? '--enable' : '--disable',
        key
      ]),
      '--enable',
      'skip_host_skill_discovery',
      ...settings.flatMap((value) => [
        '-c',
        value.startsWith('model_reasoning_effort=')
          ? `model_reasoning_effort="${this.reasoning}"`
          : value
      ]),
      ...servers.flatMap((key) => ['-c', `mcp_servers.${key}.enabled=false`]),
      'app-server',
      '--stdio'
    ];
    return this.factory({
      command: existsSync(bundled) ? bundled : 'codex',
      args,
      experimentalApi: true,
      env: envForNative(),
      cwd: this.cwd
    });
  }

  async start() {
    if (this.stopping) await this.stopping;
    if (this.status === 'ready') return;
    if (!this.starting)
      this.starting = this.open(this.epoch).finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  async open(epoch) {
    const checkEpoch = () => {
      if (epoch !== this.epoch) throw refuse('Codex startup was cancelled.');
    };
    this.setStatus('starting');
    await this.dispose();
    try {
      this.cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'scion-native-')));
      checkEpoch();
      const probe = this.makeRuntime();
      this.probe = probe;
      try {
        await probe.start();
        checkEpoch();
        this.identity = account(await probe.request('account/read', { refreshToken: false }));
        checkEpoch();

        const { config } = await probe.request('config/read', {
          cwd: this.cwd,
          includeLayers: false
        });
        if (!config?.mcp_servers || typeof config.mcp_servers !== 'object')
          throw refuse('The native connector configuration is unavailable.');
        const ids = Object.keys(config.mcp_servers);
        if (ids.some((id) => !/^[-a-zA-Z0-9_]+$/.test(id)))
          throw refuse('An unsupported native connector identifier prevents safe startup.');
        this.servers = new Set(ids);
      } finally {
        await probe.stop();
        this.probe = null;
      }
      checkEpoch();
      const worker = this.makeRuntime([...this.servers]);
      this.worker = worker;
      worker.on('notification', (event) => this.receiveNotification(worker, event));
      worker.on('serverRequest', (event) => {
        if (event.method === 'item/tool/call') {
          void this.projectRequest(worker, event);
          return;
        }
        if (this.projectHost || event.method !== 'item/tool/requestUserInput') {
          worker.respondError(
            event.id,
            -32601,
            'Native tools and expanded permissions are unavailable in this profile.'
          );
          return;
        }
        const { threadId, turnId, itemId, questions } = event.params || {};
        if (
          !Array.isArray(questions) ||
          questions.some((q) => !q || q.isSecret || !Array.isArray(q.options ?? []))
        ) {
          worker.respondError(event.id, -32602, 'Malformed or secret input is unavailable.');
          return;
        }
        const safeQuestions = questions.map(({ id, header, question, options, isOther }) => ({
          id,
          header,
          question,
          isOther,
          options: options
            ?.filter(Boolean)
            .map(({ label, description }) => ({ label, description }))
        }));
        this.emit('serverRequest', {
          id: event.id,
          method: event.method,
          params: { threadId, turnId, itemId, questions: safeQuestions }
        });
      });
      worker.on('status', (state) => {
        if (state.status === 'error' && this.worker === worker)
          this.setStatus('error', 'Codex disconnected. Inspect the saved attempt.');
      });
      await worker.start();
      checkEpoch();
      const manifest = await this.guard();
      checkEpoch();
      await this.verifyInstance(true);
      this.workerConfig = pinVerifiedProfile(this.store, 'codex', this.workerScope, manifest);
      this.emit('effectiveConfig', this.workerConfig);
      checkEpoch();
      this.setStatus('ready');
    } catch (error) {
      await this.dispose();
      const detail =
        error.status === 409
          ? error.message
          : 'Codex app-server could not start or verify its installed account. Check native login and host permissions.';
      if (epoch === this.epoch) this.setStatus('error', detail);
      throw refuse(detail);
    }
  }

  async projectRequest(worker, event) {
    const session = this.projectSessions.get(event.params?.threadId);
    try {
      if (!session || worker !== this.worker || this.status !== 'ready')
        throw refuse('No scoped project tools are available for this thread.');
      await this.guard(worker, this.threadWorkspaces.get(session.threadId)?.cwd);
      await this.verifyInstance(false, worker);
      if (worker !== this.worker || this.status !== 'ready')
        throw refuse('Project worker disconnected.');
      this.checkWorkspace(this.threadWorkspaces.get(session.threadId));
      const response = await session.request(event.params);
      if (worker !== this.worker || this.status !== 'ready')
        throw refuse('Project worker disconnected.');
      worker.respond(event.id, response);
    } catch {
      if (session) session.failed = true;
      try {
        worker.respondError(event.id, -32601, 'Project tool request could not be verified.');
      } catch {}
      this.setStatus(
        'error',
        'Project tool request could not be verified. Inspect the saved attempt.'
      );
      void worker.stop().catch(() => {});
    }
  }

  receiveNotification(worker, { method, params = {} }) {
    if (this.worker !== worker) return;
    const project = this.projectSessions.get(params.threadId);
    try {
      if (project && method === 'turn/completed') project.terminal(params.turn?.id);
      if (params.item?.type === 'dynamicToolCall') {
        if (!project) throw refuse('Unexpected native project tool.');
        project.observe(method, params);
        this.emit('notification', {
          method,
          params: {
            threadId: params.threadId,
            turnId: params.turnId,
            item: { id: params.item.id, type: 'dynamicToolCall' }
          }
        });
        return;
      }
    } catch {
      if (project) project.failed = true;
      this.setStatus(
        'error',
        'Project native evidence could not be verified. Inspect the saved attempt.'
      );
      void worker.stop().catch(() => {});
      return;
    }
    if (method === 'model/rerouted') {
      if (
        typeof params.threadId !== 'string' ||
        !params.threadId ||
        typeof params.turnId !== 'string' ||
        !params.turnId
      )
        return;
      const name = params.toModel;
      this.emit('modelRoute', {
        threadId: params.threadId,
        turnId: params.turnId,
        requestedModel: model,
        observedModel:
          typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name) ? name : null,
        exactModelVerified: false
      });
      if (project) {
        project.failed = true;
        this.setStatus('error', 'Project model was rerouted. Inspect the saved attempt.');
        void worker.stop().catch(() => {});
      }
      return;
    }
    const compact = { threadId: params.threadId };
    if (params.turnId) compact.turnId = params.turnId;
    if (method === 'turn/started' || method === 'turn/completed') {
      const turn = params.turn;
      if (!turn?.id) return;
      compact.turn = { id: turn.id, status: turn.status };
      if (turn.error) compact.turn.error = { message: 'Codex reported a failed turn.' };
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = params.item;
      if (!['userMessage', 'reasoning', 'agentMessage', 'plan'].includes(item?.type)) {
        this.setStatus(
          'error',
          'An unexpected native tool or item was observed. Inspect the saved attempt.'
        );
        void worker.stop().catch(() => {});
        return;
      }
      compact.item = { id: item.id, type: item.type };
      if (item.type === 'agentMessage') {
        if (typeof item.text === 'string') compact.item.text = item.text;
        compact.item.phase = ['final_answer', 'partial_answer', 'commentary'].includes(item.phase)
          ? item.phase
          : null;
      }
    } else if (method === 'item/agentMessage/delta') {
      if (typeof params.delta !== 'string') return;
      compact.itemId = params.itemId;
      compact.delta = params.delta;
    } else if (method === 'serverRequest/resolved') {
      compact.requestId = params.requestId;
    } else if (method === 'thread/tokenUsage/updated') {
      compact.tokenUsage = {};
      for (const window of ['last', 'total']) {
        const counters = {};
        for (const key of [
          'inputTokens',
          'cachedInputTokens',
          'cacheWriteInputTokens',
          'outputTokens',
          'reasoningOutputTokens',
          'totalTokens'
        ]) {
          const value = params.tokenUsage?.[window]?.[key];
          if (Number.isSafeInteger(value) && value >= 0) counters[key] = value;
        }
        compact.tokenUsage[window] = counters;
      }
    } else return;
    this.emit('notification', { method, params: compact });
  }

  nativeRequest(worker, method, params, beforeWrite) {
    const epoch = this.epoch;
    const checkWorker = () => {
      if (
        !worker ||
        worker !== this.worker ||
        worker.status !== 'ready' ||
        this.stopping ||
        epoch !== this.epoch ||
        !['ready', 'starting'].includes(this.status)
      )
        throw refuse('The verified ChatGPT worker is unavailable.');
    };
    checkWorker();
    return worker.request(
      method,
      params,
      undefined,
      beforeWrite === undefined
        ? undefined
        : () => {
            checkWorker();
            return beforeWrite();
          }
    );
  }

  async guard(worker = this.worker, cwd = this.cwd) {
    const info = await this.nativeRequest(worker, 'account/read', { refreshToken: false });
    if (account(info) !== this.identity) throw refuse('The signed-in ChatGPT account changed.');
    const response = await this.nativeRequest(worker, 'config/read', { cwd, includeLayers: true });
    checkConfig(response.config, this.servers, this.projectHost, this.reasoning);
    const manifest = codexOrigins(
      response,
      this.servers,
      worker.nativeVersion,
      this.projectHost,
      this.reasoning
    );
    if (this.workerConfig) pinVerifiedProfile(this.store, 'codex', this.workerScope, manifest);
    return manifest;
  }

  async verifyInstance(enroll = false, worker = this.worker) {
    const limits = await this.nativeRequest(worker, 'account/rateLimits/read', {});
    if (worker !== this.worker || this.stopping)
      throw refuse('The native worker closed during account verification.');
    if (typeof limits.accountId !== 'string' || !limits.accountId)
      throw refuse('Codex could not verify the native account instance.');
    const digest = createHmac('sha256', this.accountSalt)
      .update(JSON.stringify([this.identity, limits.accountId]))
      .digest('hex');
    if (enroll) this.saveSetting.run('codex.accountBinding', digest);
    if (this.readSetting.get('codex.accountBinding')?.value !== digest)
      throw refuse(
        'The signed-in ChatGPT account differs from this installation’s pinned account.'
      );
    this.accountDigest = digest;
    this.emit('usage', codexUsage(limits, model));
    return limits;
  }

  async checkThread(id, worker = this.worker) {
    const inventory = await this.nativeRequest(worker, 'mcpServerStatus/list', {
      threadId: id,
      limit: 100
    });
    if (
      !Array.isArray(inventory.data) ||
      inventory.nextCursor ||
      inventory.data.length !== this.servers.size ||
      new Set(inventory.data.map((server) => server.name)).size !== this.servers.size ||
      inventory.data.some(
        (server) =>
          !this.servers.has(server.name) ||
          server.runtimeStatus !== 'disabled' ||
          Object.keys(server.tools || {}).length ||
          server.resources?.length ||
          server.resourceTemplates?.length
      )
    )
      throw refuse('The worker thread has an active or unverified connector.');
  }

  isolationFor(task, uncertain = false) {
    const ownerChat = this.store.isProjectChatTask?.(task.id);
    if (
      (!this.isolated && !ownerChat) ||
      task.sandbox !== 'read-only' ||
      (!uncertain && task.threadId)
    )
      return null;
    if (
      uncertain &&
      (!task.threadId || !this.readSetting.get('codex.neutralWorkspace.' + task.threadId))
    )
      return null;
    if (ownerChat) return { taskId: task.id, privateChat: true, mutablePath: null };
    const lease = this.store.db
      .prepare('SELECT role,grant FROM agent_workspaces WHERE taskId=?')
      .get(task.id);
    const grant = lease && JSON.parse(lease.grant);
    return {
      taskId: task.id,
      mutablePath: lease?.role === 'author' ? JSON.stringify([grant.projectId, grant.path]) : null
    };
  }
  allocateWorkspace() {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'scion-session-'))),
      stat = lstatSync(cwd, { bigint: true });
    return { cwd, id: randomUUID(), dev: stat.dev, ino: stat.ino };
  }
  checkWorkspace(space) {
    try {
      const stat = lstatSync(space.cwd, { bigint: true });
      if (
        stat.isDirectory() &&
        stat.dev === space.dev &&
        stat.ino === space.ino &&
        stat.uid === BigInt(process.getuid()) &&
        (stat.mode & 0o077n) === 0n &&
        !readdirSync(space.cwd).length
      )
        return;
    } catch {}
    throw refuse('The native session workspace is no longer empty and private.');
  }
  discardWorkspace(space) {
    if (!space) return;
    try {
      this.checkWorkspace(space);
      rmdirSync(space.cwd);
    } catch {}
  }
  retireThread(id) {
    const owner = [...this.projectRuntimes.values()].find((child) => child.threads.has(id));
    if (owner) {
      owner.retireThread(id);
      this.threadEvidence.delete(id);
      return;
    }
    const space = this.threadWorkspaces.get(id);
    if (!space) return;
    this.threadWorkspaces.delete(id);
    this.threads.delete(id);
    this.threadEvidence.delete(id);
    this.projectSessions.delete(id);
    this.discardWorkspace(space);
  }

  async projectWorker(reasoning, projectVersion) {
    const key = projectVersion + ':' + reasoning;
    if (!this.projectRuntimes.has(key)) {
      const child = new AccountRuntime(this.factory, this.store, {
        projectHost: true,
        reasoning,
        projectVersion
      });
      child.activeTaskForThread = (id) => this.activeTaskForThread?.(id);
      child.verifyingThreads = this.verifyingThreads;
      for (const event of ['notification', 'modelRoute', 'usage'])
        child.on(event, (value) => this.emit(event, value));
      child.on('status', (state) => {
        if (state.status === 'error' && !this.stopping)
          this.setStatus('error', state.error || 'The project worker disconnected.');
      });
      this.projectRuntimes.set(key, child);
    }
    const child = this.projectRuntimes.get(key);
    await child.start();
    if (this.status !== 'ready' || this.stopping || this.projectRuntimes.get(key) !== child)
      throw refuse('Project worker startup was cancelled.');
    return child;
  }

  async request(method, params, startingTaskId, beforeWrite, projectDescriptor) {
    if (this.status !== 'ready') throw refuse('The verified ChatGPT worker is unavailable.');
    const owner = [...this.projectRuntimes.values()].find((child) =>
      child.threads.has(params.threadId)
    );
    if (!this.projectHost && owner)
      return owner.request(method, params, startingTaskId, beforeWrite);
    if (method === 'thread/start' && !this.projectHost) {
      if (this.status !== 'ready') throw refuse('The verified ChatGPT worker is unavailable.');
      const descriptor = startingTaskId
        ? await this.store.projectDevelopment?.toolSession(startingTaskId)
        : null;
      if (descriptor) {
        const selection = descriptor.executionSelection ?? {
          provider: 'codex',
          model,
          reasoning: effort
        };
        if (!validCodexProjectSelection(selection))
          throw refuse('Unqualified project execution selection.');
        const workspace = descriptor.workflow === 'workspace';
        if (
          (workspace && (descriptor.version !== 2 || selection.reasoning !== 'high')) ||
          (!workspace && (descriptor.version !== 1 || descriptor.workflow !== undefined))
        )
          throw refuse('Invalid project workflow descriptor.');
        const version = workspace ? 5 : selection.reasoning === 'high' ? 4 : 3;
        const child = await this.projectWorker(selection.reasoning, version);
        const result = await child.request(method, params, startingTaskId, beforeWrite, descriptor);
        this.threadEvidence.set(result.thread.id, child.threadEvidence.get(result.thread.id));
        return result;
      }
    }
    const worker = this.worker;
    if (this.status !== 'ready') throw refuse('The verified ChatGPT worker is unavailable.');
    if (method === 'thread/start') {
      const ownerChat = this.store.isProjectChatTask?.(startingTaskId);
      const descriptor = projectDescriptor;
      if (this.projectHost && !descriptor) throw refuse('Project worker requires scoped tools.');
      const space = this.isolated || ownerChat || descriptor ? this.allocateWorkspace() : null,
        cwd = space?.cwd ?? this.cwd;
      let retained = false,
        verifyingId;
      try {
        await this.guard(worker, cwd);
        await this.verifyInstance(false, worker);
        if (params.sandbox !== 'read-only' || (params.model && params.model !== model))
          throw refuse('This profile accepts read-only Astra tasks.');
        const before = instructionFiles();
        const result = await this.nativeRequest(worker, method, {
          cwd,
          model,
          modelProvider: 'openai',
          sandbox: 'read-only',
          approvalPolicy: 'never',
          ephemeral: false,
          baseInstructions: descriptor
            ? this.projectVersion === 5
              ? workspaceProjectInstructions
              : codexProjectInstructions
            : baseInstructions,
          ...(descriptor
            ? { dynamicTools: codexProjectTools(descriptor.role, this.projectVersion) }
            : {})
        });
        const expected = path.join(homedir(), '.codex');
        if (
          typeof result.thread?.id !== 'string' ||
          !result.thread.id ||
          result.cwd !== cwd ||
          result.modelProvider !== 'openai' ||
          result.model !== model ||
          result.reasoningEffort !== this.reasoning ||
          result.sandbox?.type !== 'readOnly' ||
          result.sandbox.networkAccess !== false ||
          result.approvalPolicy !== 'never' ||
          !Array.isArray(result.instructionSources) ||
          result.instructionSources.some(
            (source) =>
              ![
                path.join(expected, 'AGENTS.md'),
                path.join(expected, 'AGENTS.override.md')
              ].includes(source)
          )
        )
          throw refuse(
            'Codex started a thread with unexpected instructions, model, or permissions.'
          );
        const id = result.thread.id;
        const bindingKey = 'codex.threadAccount.' + id,
          workspaceKey = 'codex.neutralWorkspace.' + id;
        if (
          this.verifyingThreads.has(id) ||
          this.readSetting.get(bindingKey) ||
          this.readSetting.get(workspaceKey)
        )
          throw refuse('Codex returned a previously observed thread for a fresh session.');
        if (space && result.thread.status?.type !== 'idle')
          throw refuse('Codex did not confirm that the new isolated thread is idle.');
        this.verifyingThreads.add(id);
        verifyingId = id;
        if (space) this.saveSetting.run(workspaceKey, space.id);
        await this.checkThread(result.thread.id, worker);
        if (worker !== this.worker || this.stopping || this.status !== 'ready')
          throw refuse('The native worker closed during thread verification.');
        const after = instructionFiles(),
          sources = result.instructionSources.map((file) => path.basename(file));
        if (
          JSON.stringify(before) !== JSON.stringify(after) ||
          sources.some((name) => !after.find((f) => f.source === name)?.present)
        )
          throw refuse('Native instructions changed while creating the verified thread.');
        const profile = pinVerifiedProfile(
          this.store,
          'codex',
          descriptor
            ? codexProjectProfileScope(model, descriptor.role, nativeVersion, this.projectVersion)
            : `thread/${model}@${nativeVersion}`,
          {
            ...this.workerConfig.manifest,
            nativeInstructionSources: sources,
            instructionFiles: after,
            threadSandbox: 'readOnly',
            threadNetworkAccess: false,
            threadToolInventory: 'all-connectors-disabled',
            ...(descriptor ? codexProjectManifest(descriptor.role, this.projectVersion) : {})
          }
        );
        if (descriptor)
          this.projectSessions.set(
            id,
            new CodexProjectSession({ store: this.store, descriptor, threadId: id })
          );
        this.threadEvidence.set(result.thread.id, profile);
        this.emit('effectiveConfig', profile);
        this.saveSetting.run(bindingKey, this.accountDigest);
        if (this.readSetting.get(bindingKey)?.value !== this.accountDigest)
          throw refuse('This thread belongs to a different account.');
        this.threads.add(result.thread.id);
        if (space) {
          this.threadWorkspaces.set(result.thread.id, space);
          retained = true;
          return { ...result, neutralWorkspaceId: space.id };
        }
        return result;
      } finally {
        if (verifyingId) this.verifyingThreads.delete(verifyingId);
        if (!retained) this.discardWorkspace(space);
      }
    }
    if (method === 'turn/start') {
      if (!this.threads.has(params.threadId))
        throw refuse('The target thread has no verified profile.');
      const taskId = this.activeTaskForThread?.(params.threadId);
      const ownerChat = this.store.isProjectChatTask?.(taskId);
      const space = this.threadWorkspaces.get(params.threadId);
      if ((this.isolated || ownerChat) && !space)
        throw refuse('The neutral workspace for this thread is unavailable.');
      if (space) this.checkWorkspace(space);
      await this.guard(worker, space?.cwd ?? this.cwd);
      await this.checkThread(params.threadId, worker);
      const limits = await this.verifyInstance(false, worker);
      const main = limits.rateLimits;
      const applicable = [
        main,
        ...Object.values(limits.rateLimitsByLimitId || {}).filter(
          (limit) => limit?.normalModelSlug === model
        )
      ];
      if (
        limits.ordinaryUsageAllowed !== true ||
        applicable.some((limit) => {
          const windows = [limit?.primary, limit?.secondary].filter(Boolean);
          return (
            !windows.length ||
            limit?.spendControlReached ||
            limit?.rateLimitReachedType ||
            windows.some(
              (w) => !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent >= 100
            )
          );
        })
      )
        throw refuse('Included subscription quota is exhausted or unavailable.');
      let result;
      const turn = { threadId: params.threadId, input: params.input };
      if (ownerChat) {
        if (params.outputSchema !== mainChatOutputSchema)
          throw refuse('The owner chat reply schema was not confirmed.');
        turn.outputSchema = mainChatOutputSchema;
      } else if (
        params.outputSchema === planOutputSchema ||
        params.outputSchema === nativeObjectiveOutputSchema
      ) {
        turn.outputSchema = params.outputSchema;
      }
      const profile = this.threadEvidence.get(params.threadId);
      if (
        !profile ||
        JSON.stringify(profile.manifest.instructionFiles) !== JSON.stringify(instructionFiles())
      )
        throw refuse('Native instruction configuration drift since thread creation.');
      try {
        if (space) this.checkWorkspace(space);
        bindAttemptConfig(this.store, {
          taskId,
          driver: 'codex',
          accountInstance: this.instance,
          profile
        });
      } catch (error) {
        // No native turn has been submitted. Preserve uncertainty at the transport boundary below.
        throw refuse(
          [400, 404, 409].includes(error.status)
            ? error.message
            : 'The local attempt configuration could not be recorded.'
        );
      }
      if (ownerChat && requiresBranchDispatch(this.store.db, taskId)) {
        try {
          assertBranchDispatch(this.store.db, {
            taskId,
            accountInstance: this.instance,
            accountDigest: this.accountDigest,
            input: turn.input
          });
        } catch (error) {
          throw refuse(error.message);
        }
      }
      try {
        const mailScope = {
          taskId,
          nativeThreadId: params.threadId,
          accountInstance: this.instance,
          accountBinding: this.accountDigest,
          input: turn.input
        };
        beginMailNativeRequest(this.store, mailScope);
        result = await this.nativeRequest(worker, method, turn);
        recordMailNativeConfirmation(this.store, mailScope, result?.turn?.id);
        reconcileMailDeliveries(this.store);
      } catch (error) {
        const failure = new Error('Codex did not accept or confirm the requested turn.');
        if (Number.isInteger(error.code)) failure.code = error.code;
        throw failure;
      }
      return {
        turn: {
          id: result?.turn?.id,
          status: result?.turn?.status,
          error: result?.turn?.error ? { message: 'Codex reported a failed turn.' } : null
        }
      };
    }
    if (method === 'thread/resume')
      throw refuse('Resume requires a verified saved configuration manifest.');
    if (method === 'turn/interrupt' && this.threads.has(params.threadId))
      return this.nativeRequest(worker, method, params, beforeWrite);
    if (method === 'model/list') {
      const catalog = await this.nativeRequest(worker, method, params);
      return {
        data: (catalog.data || []).filter((entry) => entry.model === model || entry.id === model)
      };
    }
    if (method === 'thread/read') {
      if (
        this.readSetting.get('codex.threadAccount.' + params.threadId)?.value !== this.accountDigest
      )
        throw refuse('This saved thread has no matching account binding.');
      await this.guard(worker);
      await this.verifyInstance(false, worker);
      return this.nativeRequest(worker, method, params);
    }
    throw refuse('This native operation is unavailable in the read-only profile.');
  }

  respond(id, result) {
    this.worker.respond(id, result);
  }
  respondError(id, code, message) {
    this.worker.respondError(id, code, message);
  }

  async dispose() {
    const children = [...this.projectRuntimes.values()];
    this.projectRuntimes.clear();
    await Promise.all(children.map((child) => child.stop()));
    const worker = this.worker;
    this.worker = null;
    try {
      if (worker) await worker.stop();
    } finally {
      for (const id of this.threadWorkspaces.keys()) this.retireThread(id);
      this.threads.clear();
      this.threadEvidence.clear();
      this.projectSessions.clear();
      if (this.cwd) await rmdir(this.cwd).catch(() => {});
      this.cwd = null;
    }
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.epoch++;
    this.setStatus('stopped');
    const handshake = this.starting;
    const shutdown = async () => {
      await Promise.all([
        this.probe?.stop(),
        this.worker?.stop(),
        ...Array.from(this.projectRuntimes.values(), (child) => child.stop())
      ]);
      if (handshake) await handshake.catch(() => {});
      await this.dispose();
    };
    this.stopping = shutdown().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }
}

export function createCodexAdapter({
  store,
  workspaceRoot,
  runtimeFactory = (options) => new CodexRuntime(options)
}) {
  const slots = store.sessionProfile?.mode === 'codex-only' ? store.sessionProfile.codexSlots : 1;
  if (!Number.isInteger(slots) || slots < 1 || slots > 4)
    throw refuse('Invalid number of native Codex session slots.');
  const runtime = new AccountRuntime(runtimeFactory, store);
  const controller = new Controller({ store, runtime, workspaceRoot, maxParallel: slots });
  runtime.activeTaskForThread = (id) => {
    const matches = [...controller.active.values()].filter(
      (b) => b.threadId === id && b.acceptingTurn && !b.turnId && !b.cancelRequested
    );
    return matches.length === 1 ? matches[0].taskId : null;
  };
  runtime.on('effectiveConfig', (profile) => {
    controller.runtimeInfo.effectiveConfig = profile;
  });
  runtime.on('usage', (usage) => {
    controller.runtimeInfo.usage = usage;
  });
  // A native reroute may precede the start reply or arrive after a terminal event.
  // Keep only pending work for the active binding. Persist only an exact thread/turn match.
  const currentMatch = store.db.prepare(
    'SELECT id FROM tasks WHERE threadId=? AND turnId=? LIMIT 2'
  );
  const pendingRoutes = new Map();
  function recordRoute(route) {
    const rows = currentMatch.all(route.threadId, route.turnId);
    const taskId = store.taskIdForNativeTurn
      ? store.taskIdForNativeTurn(route.threadId, route.turnId)
      : rows.length === 1
        ? rows[0].id
        : null;
    if (!taskId) return false;
    store.addEvent(taskId, 'provider/modelChanged', route);
    return true;
  }
  runtime.on('modelRoute', (route) => {
    if (recordRoute(route)) {
      controller.changed();
      return;
    }
    const binding = [...controller.active.values()].find(
      (item) => item.threadId === route.threadId && item.acceptingTurn && !item.turnId
    );
    if (binding) pendingRoutes.set(binding.taskId, route);
  });
  controller.on('change', () => {
    for (const [taskId, route] of pendingRoutes) {
      if (
        recordRoute(route) ||
        !controller.active.has(taskId) ||
        controller.active.get(taskId).turnId
      )
        pendingRoutes.delete(taskId);
    }
  });
  Object.assign(controller.runtimeInfo, {
    usage: { observedAt: null, windows: [] },
    driver: 'codex-app-server',
    route: 'chatgpt',
    accountInstance: runtime.instance,
    profile: 'read-only supplied text',
    model,
    reasoningEffort: effort,
    projectReasoningEfforts: ['ultra', 'high'],
    instructions:
      'Native user instructions may apply. Project settings and workspace files are excluded.',
    capabilities: {
      workspaceWrite: false,
      nativeResume: false,
      interrupt: true,
      sessionSlots: slots,
      independentWorkspaces: runtime.isolated
    }
  });
  controller.refreshUsage = async () => {
    if (controller.active.size)
      throw Object.assign(refuse('A Codex worker is active.'), { code: 'PROVIDER_BUSY' });
    if (runtime.status !== 'ready') throw refuse('The verified Codex worker is unavailable.');
    const worker = runtime.worker;
    const info = await runtime.nativeRequest(worker, 'account/read', { refreshToken: false });
    if (account(info) !== runtime.identity) throw refuse('The signed-in ChatGPT account changed.');
    await runtime.verifyInstance(false, worker);
    return controller.runtimeInfo.usage;
  };
  controller.inspectTerminalAttempt = async (task) => {
    if (!task?.threadId || !task.turnId)
      throw refuse('Inspection requires the saved native thread and turn identifiers.');
    let result;
    try {
      result = await runtime.request('thread/read', {
        threadId: task.threadId,
        includeTurns: true
      });
    } catch {
      throw refuse('The native thread could not be inspected on the verified account.');
    }
    const thread = result?.thread;
    const turn = thread?.turns?.find((item) => item.id === task.turnId);
    if (
      thread?.id !== task.threadId ||
      thread.status?.type !== 'idle' ||
      !['completed', 'failed', 'interrupted'].includes(turn?.status)
    )
      throw refuse('Codex has not confirmed this exact turn terminal on an idle thread.');
    return { threadId: thread.id, turnId: turn.id, status: turn.status };
  };
  return controller;
}
