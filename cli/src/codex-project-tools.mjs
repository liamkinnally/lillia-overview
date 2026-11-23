import { createHash } from 'node:crypto';
import { constants, openSync, readFileSync, fstatSync, closeSync } from 'node:fs';
import { isDeepStrictEqual as same } from 'node:util';
import {
  workspaceProjectTools,
  workspaceProjectToolNames,
  workspaceProjectEnvelope,
  workspaceProjectInstructions
} from './project-workspace-tools.mjs';
import { projectTools, projectMcpArguments, projectSystemPrompt } from './project-mcp.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const need = (ok, message) => {
  if (!ok) throw Object.assign(new Error(message), { status: 409 });
};
const id = (value) => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value);
export const codexDisabledFeatures = [
  'apps',
  'plugins',
  'hooks',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'multi_agent_v2_dynamic_tools',
  'shell_tool',
  'unified_exec',
  'plugin_discovery_prefetch',
  'remote_plugin',
  'browser_use',
  'computer_use',
  'image_generation',
  'in_app_browser',
  'view_image',
  'workspace_dependencies',
  'skill_search',
  'skill_mcp_dependency_install',
  'code_mode_host',
  'goals',
  'shell_snapshot'
];
export { projectSystemPrompt as codexProjectInstructions };
export function codexProjectTools(role, version = 3) {
  if (version === 5) return workspaceProjectTools(role);
  const path = { type: 'string', minLength: 1, maxLength: 512 };
  const definitions = {
    list_files: ['List the files enrolled for this task.', {}],
    read_file: ['Read one enrolled immutable text file.', { path }],
    replace_text: [
      'Replace one enrolled text file if its current identity matches.',
      {
        path,
        expectedFileId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        text: { type: 'string', maxLength: 65536 }
      }
    ],
    run_check: ['Run the enrolled project check.', {}]
  };
  return projectTools(role).map((name) => {
    const [description, properties] = definitions[name];
    return {
      type: 'function',
      name,
      description,
      inputSchema: {
        type: 'object',
        properties,
        required: Object.keys(properties),
        additionalProperties: false
      }
    };
  });
}
export function codexProjectThreadConfig() {
  return { 'features.code_mode_host': true };
}
export function codexProjectManifest(role, version = 3) {
  need([1, 2, 3, 4, 5].includes(version), 'Unsupported project configuration version.');
  const tools = codexProjectTools(role, version);
  return {
    tools: version === 5 ? workspaceProjectToolNames(role) : projectTools(role),
    disabledFeatures: codexDisabledFeatures.filter(
      (key) => version < 3 || key !== 'code_mode_host'
    ),
    baseInstructionsDigest: digest(
      version === 5 ? workspaceProjectInstructions : projectSystemPrompt
    ),
    threadSandbox: 'readOnly',
    threadNetworkAccess: false,
    threadToolInventory: tools,
    ...(version === 2
      ? {
          submittedThreadConfig: codexProjectThreadConfig(),
          threadConfigEvidence: 'submitted-not-read-back'
        }
      : {}),
    ...(version >= 3
      ? { codeModeHost: true, threadConfigEvidence: 'verified-process-config' }
      : {}),
    projectDynamic: {
      version,
      protocol: version === 5 ? 'codex-dynamic-workspace-v1' : 'codex-dynamic-project-v1',
      role,
      toolDefinitionsDigest: hash(tools)
    }
  };
}

function credential(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    need(
      stat.isFile() &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0 &&
        stat.size === 44,
      'Project credential is not a private capability file.'
    );
    const value = readFileSync(fd, 'utf8');
    need(/^[a-zA-Z0-9_-]{43}\n$/.test(value), 'Invalid project capability.');
    return value.trim();
  } finally {
    closeSync(fd);
  }
}

// Native output is evidence only after the completed item echoes the exact response.
export class CodexProjectSession {
  constructor({ store, descriptor, threadId }) {
    const workspace = descriptor?.workflow === 'workspace';
    need(
      (workspace
        ? descriptor.version === 2 &&
          same(descriptor.executionSelection, {
            provider: 'codex',
            model: 'gpt-6.2-astra',
            reasoning: 'high'
          })
        : descriptor?.version === 1 && descriptor.workflow === undefined) &&
        id(descriptor.taskId) &&
        id(descriptor.attemptId) &&
        id(threadId) &&
        same(
          descriptor.tools,
          workspace ? workspaceProjectToolNames(descriptor.role) : projectTools(descriptor.role)
        ),
      'Invalid project session descriptor.'
    );
    this.queue = workspace ? Promise.resolve() : null;
    this.callLimit = workspace ? 128 : 48;
    this.arguments = workspace ? workspaceProjectEnvelope : projectMcpArguments;
    this.responseLimit = workspace ? 2 * 1024 * 1024 : 100000;
    this.store = store;
    this.descriptor = structuredClone(descriptor);
    this.threadId = threadId;
    this.calls = new Map();
    this.failed = false;
  }
  binding(turnId) {
    need(!this.failed, 'Project native session was quarantined.');
    const { task, attempts } = this.store.taskView(this.descriptor.taskId);
    const attempt = attempts.at(-1);
    need(
      attempt?.id === this.descriptor.attemptId &&
        attempt.driver === 'codex' &&
        ['starting', 'running'].includes(task.status) &&
        attempt.status === task.status &&
        task.threadId === this.threadId &&
        attempt.threadId === this.threadId &&
        attempt.turnId === turnId &&
        task.turnId === turnId &&
        id(turnId) &&
        attempt.accountInstance ===
          this.store.db
            .prepare("SELECT value FROM settings WHERE key='codex.accountInstance'")
            .get()?.value,
      'Project dynamic call is outside its reserved native turn.'
    );
    need(
      this.store.projectDevelopment.validateDispatch(task.id)?.role === this.descriptor.role,
      'Project native role changed.'
    );
    return attempt;
  }
  async request(params) {
    need(
      params &&
        params.threadId === this.threadId &&
        id(params.callId) &&
        (params.namespace === undefined || params.namespace === null) &&
        !this.calls.has(params.callId) &&
        this.calls.size < this.callLimit,
      'Invalid or replayed project dynamic call.'
    );
    this.binding(params.turnId);
    this.arguments(this.descriptor.role, params.tool, params.arguments);
    const call = { params: structuredClone(params), response: null, confirmed: false };
    this.calls.set(params.callId, call);
    if (this.queue === null) return this.#dispatch(call);
    // Reserve IDs before waiting; recheck authority only when this call reaches the broker.
    const result = this.queue.then(() => this.#dispatch(call));
    this.queue = result.catch(() => {
      this.failed = true;
    });
    return result;
  }
  async #dispatch(call) {
    const params = call.params;
    this.binding(params.turnId);
    this.arguments(this.descriptor.role, params.tool, params.arguments);
    const packet = {
      version: 1,
      operationId: 'codex-tool-' + hash([this.descriptor.attemptId, params.turnId, params.callId]),
      taskId: this.descriptor.taskId,
      attemptId: this.descriptor.attemptId,
      credential: credential(this.descriptor.credentialFile),
      tool: params.tool,
      arguments: structuredClone(params.arguments)
    };
    const response = await this.store.projectDevelopment.request(packet);
    this.binding(params.turnId);
    need(
      [200, 403].includes(response?.status) &&
        response.body?.version === 1 &&
        response.body.operationId === packet.operationId &&
        id(response.body.observationId) &&
        /^[a-f0-9]{64}$/.test(response.body.digest) &&
        typeof response.body.text === 'string' &&
        digest(response.body.text) === response.body.digest &&
        Buffer.byteLength(JSON.stringify(response.body)) <= this.responseLimit,
      'Invalid project broker response.'
    );
    call.receipt = response.body;
    call.response = {
      success: response.status === 200,
      contentItems: [{ type: 'inputText', text: JSON.stringify(response.body) }]
    };
    return structuredClone(call.response);
  }
  observe(method, params) {
    const item = params.item;
    need(
      params.threadId === this.threadId &&
        item?.type === 'dynamicToolCall' &&
        id(item.id) &&
        (item.namespace === undefined || item.namespace === null),
      'Invalid native project tool item.'
    );
    this.binding(params.turnId);
    this.arguments(this.descriptor.role, item.tool, item.arguments);
    if (method === 'item/started') return;
    const call = this.calls.get(item.id);
    need(
      method === 'item/completed' &&
        call?.response &&
        !call.confirmed &&
        call.params.turnId === params.turnId &&
        call.params.tool === item.tool &&
        same(call.params.arguments, item.arguments) &&
        item.status === (call.response.success ? 'completed' : 'failed') &&
        item.success === call.response.success &&
        same(item.contentItems, call.response.contentItems),
      'Native project completion does not confirm its exact broker response.'
    );
    this.store.projectDevelopment.confirmToolUse({
      taskId: this.descriptor.taskId,
      attemptId: this.descriptor.attemptId,
      tool: item.tool,
      arguments: item.arguments,
      toolUseId: item.id,
      runId: params.turnId,
      sessionId: this.threadId,
      response: call.receipt,
      denied: !call.response.success
    });
    call.confirmed = true;
  }
  terminal(turnId) {
    this.binding(turnId);
    need(
      [...this.calls.values()].every((call) => call.params.turnId === turnId && call.confirmed),
      'Project turn ended without confirmed native tool responses.'
    );
  }
}
