import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertReservedStop, assertInterruptAuthority } from './task-control-delivery.mjs';

const activeStatuses = new Set(['starting', 'running', 'waiting_for_input', 'interrupting']);
const terminalStatuses = new Set([
  'completed',
  'failed',
  'interrupted',
  'recovery_needed',
  'blocked'
]);
const approvalMethods = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval'
]);
const errorWithStatus = (message, status = 400) => Object.assign(new Error(message), { status });
const inside = (root, cwd) => cwd === root || cwd.startsWith(root + path.sep);
const overlapping = (a, b) => inside(a, b) || inside(b, a);

export class Controller extends EventEmitter {
  constructor({ store, runtime, workspaceRoot, maxParallel = 2 }) {
    super();
    this.store = store;
    this.runtime = runtime;
    this.workspaceRoot = workspaceRoot;
    this.maxParallel = maxParallel;
    this.active = new Map();
    this.approvals = new Map();
    this.runtimeInfo = { status: runtime.status, error: null, models: [] };
    this.shuttingDown = false;
    runtime.on('notification', (message) => this.onNotification(message));
    runtime.on('serverRequest', (message) => this.onServerRequest(message));
    runtime.on('status', (state) => {
      this.runtimeInfo = { ...this.runtimeInfo, ...state, error: state.error || null };
      if (state.status === 'error' || state.status === 'stopped') {
        for (const binding of [...this.active.values()])
          this.finish(
            binding.taskId,
            binding.threadId ? 'recovery_needed' : 'interrupted',
            state.error || 'The runtime disconnected. Inspect the saved thread before continuing.'
          );
        this.approvals.clear();
      }
      this.changed();
      if (state.status === 'ready') this.kick();
    });
  }
  async start() {
    this.workspaceRoot = await realpath(this.workspaceRoot);
    if (this.shuttingDown) return;
    const workspace = await stat(this.workspaceRoot);
    if (this.shuttingDown) return;
    if (!workspace.isDirectory()) throw Error('Workspace must be a directory.');
    if (this.recoverOnStart !== false) this.store.recoverActive();
    await this.connect();
  }
  async connect() {
    if (this.shuttingDown) return;
    if (this.active.size)
      throw errorWithStatus('Finish or interrupt active tasks before reconnecting.', 409);
    try {
      await this.runtime.start();
      if (this.shuttingDown) return;
      try {
        const models = await this.runtime.request('model/list', { limit: 100 });
        if (this.shuttingDown) return;
        this.runtimeInfo.models = models.data || [];
      } catch {
        if (this.shuttingDown) return;
        this.runtimeInfo.models = [];
      }
      this.kick();
    } catch (error) {
      if (this.shuttingDown) return;
      this.runtimeInfo = { ...this.runtimeInfo, status: 'error', error: error.message };
    }
    this.changed();
  }
  async reconnect() {
    if ([...this.active.values()].some((binding) => !binding.uncertain))
      throw errorWithStatus('Active tasks must finish first.', 409);
    await this.runtime.stop();
    if (this.shuttingDown) return;
    await this.connect();
  }
  snapshot() {
    return {
      config: { workspaceRoot: this.workspaceRoot, maxParallel: this.maxParallel },
      runtime: this.runtimeInfo,
      paused: this.store.getPaused(),
      tasks: this.store.listTasks().map((task) => this.withActions(task)),
      approvals: [...this.approvals.values()].map(({ rawId, ...rest }) => rest)
    };
  }
  withActions(task) {
    const binding = this.active.get(task.id);
    const threadBusy =
      task.threadId &&
      [...this.active.values()].some((active) => active.threadId === task.threadId);
    return {
      ...task,
      canInterrupt:
        !this.shuttingDown &&
        (task.status === 'queued' ||
          task.status === 'blocked' ||
          Boolean(binding && (!binding.uncertain || binding.turnId))),
      canContinue:
        !this.shuttingDown &&
        Boolean(task.threadId && terminalStatuses.has(task.status) && !binding && !threadBusy)
    };
  }
  task(id) {
    const task = this.store.getTask(id);
    if (!task) throw errorWithStatus('Task not found.', 404);
    return this.withActions(task);
  }
  details(id) {
    return { task: this.task(id), events: this.store.events(id) };
  }
  changed() {
    this.emit('change');
  }
  async validateDirectory(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value))
      throw errorWithStatus(
        'Choose an absolute working directory inside the configured workspace.'
      );
    let resolved;
    try {
      resolved = await realpath(value);
      if (!(await stat(resolved)).isDirectory()) throw Error();
    } catch {
      throw errorWithStatus('The working directory does not exist.');
    }
    if (!inside(this.workspaceRoot, resolved))
      throw errorWithStatus('The working directory must be inside the configured workspace.');
    return resolved;
  }
  async createTask(input, { threadId = null } = {}) {
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20000)
      throw errorWithStatus('Enter a prompt between 1 and 20,000 characters.');
    if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 160))
      throw errorWithStatus('The title must be at most 160 characters.');
    if (input.model !== undefined && (typeof input.model !== 'string' || input.model.length > 160))
      throw errorWithStatus('Invalid model.');
    const sandbox = input.sandbox || 'read-only';
    if (!['read-only', 'workspace-write'].includes(sandbox))
      throw errorWithStatus('Choose read-only or workspace-write permissions.');
    const dependsOn = input.dependsOn || [];
    if (
      !Array.isArray(dependsOn) ||
      dependsOn.length > 20 ||
      dependsOn.some((id) => typeof id !== 'string' || !this.store.getTask(id))
    )
      throw errorWithStatus('Select valid prerequisite tasks (up to 20).');
    const cwd = await this.validateDirectory(input.cwd || this.workspaceRoot);
    if (this.shuttingDown) throw errorWithStatus('The controller is shutting down.', 409);
    const task = this.store.createTask({
      title: input.title?.trim() || input.prompt.trim().slice(0, 80),
      prompt: input.prompt.trim(),
      cwd,
      model: input.model,
      sandbox,
      dependsOn: [...new Set(dependsOn)],
      threadId
    });
    this.store.addEvent(task.id, 'task/queued', {});
    this.changed();
    this.kick();
    return task;
  }
  async continueTask(id, input) {
    const original = this.task(id);
    if (!original.canContinue)
      throw errorWithStatus(
        'Only a finished task with an inactive saved thread can be continued.',
        409
      );
    return this.createTask(
      {
        title: input.title || `Continue: ${original.title}`.slice(0, 160),
        prompt: input.prompt,
        cwd: original.cwd,
        model: original.model || undefined,
        sandbox: original.sandbox
      },
      { threadId: original.threadId }
    );
  }
  setPaused(paused) {
    if (typeof paused !== 'boolean') throw errorWithStatus('paused must be a boolean.');
    this.store.setPaused(paused);
    this.changed();
    if (!paused) this.kick();
  }
  kick() {
    if (this.tickScheduled || this.shuttingDown) return;
    this.tickScheduled = true;
    queueMicrotask(() => {
      this.tickScheduled = false;
      this.dispatch();
    });
  }
  dispatch() {
    if (this.shuttingDown || this.store.getPaused() || this.runtime.status !== 'ready') return;
    for (const task of this.store.queuedTasks(this.provider)) {
      const deps = task.dependsOn.map((id) => this.store.getTask(id));
      if (deps.some((d) => !d || (terminalStatuses.has(d.status) && d.status !== 'completed'))) {
        this.store.updateTask(task.id, {
          status: 'blocked',
          error:
            'A prerequisite did not complete. Create a revised task when the dependency is resolved.'
        });
        this.changed();
        continue;
      }
      if (deps.some((d) => d.status !== 'completed')) continue;
      const busy = [...this.active.values()];
      const ownerChat = Boolean(this.store.isProjectChatTask?.(task.id));
      if (
        busy.filter((binding) => binding.ownerChat === ownerChat).length >=
        (ownerChat ? 1 : this.maxParallel)
      )
        continue;
      const isolated = this.runtime.isolationFor?.(task);
      const separate = (other) =>
        isolated?.privateChat ||
        other?.privateChat ||
        (isolated &&
          other &&
          isolated.taskId !== other.taskId &&
          (!isolated.mutablePath ||
            !other.mutablePath ||
            isolated.mutablePath !== other.mutablePath));
      if (
        busy.some(
          (x) =>
            (task.threadId && x.threadId === task.threadId) ||
            (overlapping(x.cwd, task.cwd) && !separate(x.isolation))
        )
      )
        continue;
      const quarantined = this.store
        .listTasks()
        .filter((row) => row.status === 'recovery_needed' && !row.recoveryCleared);
      if (
        quarantined.some(
          (row) =>
            row.id !== task.id &&
            !(task.threadId && row.threadId === task.threadId) &&
            overlapping(row.cwd, task.cwd) &&
            !separate(this.runtime.isolationFor?.(row, true))
        )
      )
        continue;
      const admitted = this.store.reserveDispatch(task);
      if (admitted) void this.launch(admitted);
      else this.changed();
    }
  }
  async launch(task) {
    const binding = {
      taskId: task.id,
      attemptId: null,
      accountInstance: null,
      cwd: task.cwd,
      ownerChat: Boolean(this.store.isProjectChatTask?.(task.id)),
      isolation: this.runtime.isolationFor?.(task),
      threadId: task.threadId,
      turnId: null,
      cancelRequested: false,
      acceptingTurn: false,
      uncertain: false,
      messages: new Map()
    };
    this.active.set(task.id, binding);
    this.changed();
    let turnSubmitted = false;
    try {
      const attempt = this.store.taskView
        ? this.store.db
            .prepare(
              'SELECT id,accountInstance FROM attempts WHERE taskId=? ORDER BY ordinal DESC LIMIT 1'
            )
            .get(task.id)
        : null;
      binding.attemptId = attempt?.id ?? null;
      binding.accountInstance = attempt?.accountInstance ?? null;
      await this.validateDirectory(task.cwd);
      if (!this.owns(binding)) return;
      const params = { cwd: task.cwd, sandbox: task.sandbox, approvalPolicy: 'on-request' };
      if (task.model) params.model = task.model;
      const result = task.threadId
        ? await this.runtime.request('thread/resume', {
            ...params,
            threadId: task.threadId,
            excludeTurns: true
          })
        : await this.runtime.request('thread/start', { ...params, ephemeral: false }, task.id);
      if (!this.owns(binding)) return;
      const threadId = result.thread?.id;
      if (!threadId) throw Error('Codex did not return a thread identifier.');
      if (task.threadId && threadId !== task.threadId)
        throw Error('Codex resumed a different thread.');
      if (
        [...this.active.values()].some((other) => other !== binding && other.threadId === threadId)
      )
        throw Error('This thread already belongs to an active task.');
      binding.threadId = threadId;
      this.store.updateTask(task.id, { threadId });
      this.store.addEvent(task.id, task.threadId ? 'thread/resumed' : 'thread/created', {
        threadId,
        ...(result.neutralWorkspaceId ? { neutralWorkspaceId: result.neutralWorkspaceId } : {})
      });
      this.changed();
      if (!this.owns(binding)) return;
      if (
        result.thread?.status?.type === 'active' ||
        (task.threadId && result.thread?.status?.type !== 'idle')
      ) {
        binding.acceptingTurn = true;
        this.markUncertain(
          binding,
          'This thread is not confirmed idle. Inspect it in Codex before continuing.'
        );
        return;
      }
      if (task.threadId)
        for (const prior of this.store.listTasks())
          if (
            prior.threadId === threadId &&
            prior.status === 'recovery_needed' &&
            !prior.recoveryCleared
          )
            this.store.updateTask(prior.id, { recoveryCleared: true });
      if (binding.cancelRequested) {
        this.finish(task.id, 'interrupted');
        return;
      }
      if (!this.owns(binding)) return;
      binding.acceptingTurn = true;
      turnSubmitted = true;
      const turnParams = { threadId, input: [{ type: 'text', text: task.prompt }] };
      if (task.outputSchema) turnParams.outputSchema = task.outputSchema;
      const turnResult = await this.runtime.request('turn/start', turnParams);
      if (!this.owns(binding)) return;
      if (!turnResult.turn?.id) throw Error('Codex did not return a turn identifier.');
      binding.turnId = turnResult.turn.id;
      this.store.updateTask(task.id, { turnId: binding.turnId });
      if (['completed', 'failed', 'interrupted'].includes(turnResult.turn.status)) {
        this.finish(task.id, turnResult.turn.status, turnResult.turn.error?.message || null);
        return;
      }
      if (binding.cancelRequested) await this.sendInterrupt(binding);
      else if (this.task(task.id).status === 'starting')
        this.store.updateTask(task.id, { status: 'running' });
      if (!this.owns(binding)) return;
      this.changed();
    } catch (error) {
      if (!this.owns(binding)) return;
      if (binding.turnId || (turnSubmitted && !Number.isInteger(error.code)))
        this.markUncertain(binding, error.message);
      else this.finish(task.id, 'failed', error.message);
    }
  }
  owns(binding) {
    return !this.shuttingDown && this.active.get(binding.taskId) === binding;
  }
  markUncertain(binding, error) {
    if (!this.owns(binding)) return;
    binding.uncertain = true;
    this.store.updateTask(binding.taskId, {
      status: 'recovery_needed',
      error,
      recoveryCleared: false
    });
    this.store.addEvent(binding.taskId, 'task/recovery_needed', { error });
    this.changed();
  }
  findBinding(params) {
    const threadId = params.threadId || params.thread?.id;
    const turnId = params.turnId || params.turn?.id;
    return [...this.active.values()].find(
      (binding) =>
        binding.threadId === threadId &&
        binding.acceptingTurn &&
        (!turnId || !binding.turnId || binding.turnId === turnId)
    );
  }
  onNotification(message) {
    if (this.shuttingDown) return;
    const p = message.params || {};
    if (message.method === 'serverRequest/resolved') {
      for (const [id, request] of this.approvals)
        if (request.rawId === p.requestId) this.approvals.delete(id);
      const binding = this.findBinding(p);
      if (binding) this.restoreRunning(binding.taskId);
      this.changed();
      return;
    }
    const binding = this.findBinding(p);
    if (!binding) return;
    const id = binding.taskId;
    this.store.addEvent(id, message.method, p);
    if (message.method === 'turn/started') {
      binding.turnId = p.turn.id;
      this.store.updateTask(id, {
        turnId: p.turn.id,
        status: binding.cancelRequested ? 'interrupting' : 'running'
      });
    }
    if (message.method === 'item/agentMessage/delta') {
      const key = p.itemId || 'message';
      binding.messages.set(key, (binding.messages.get(key) || '') + (p.delta || ''));
      this.store.updateTask(id, {
        output: [...binding.messages.values()].join('\n\n').slice(-200000)
      });
    }
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
      binding.messages.set(p.item.id, p.item.text || '');
      this.store.updateTask(id, {
        output: [...binding.messages.values()].join('\n\n').slice(-200000)
      });
    }
    if (message.method === 'turn/completed') {
      const status = p.turn?.status;
      if (['completed', 'failed', 'interrupted'].includes(status))
        this.finish(id, status, p.turn?.error?.message || null);
      else
        this.markUncertain(
          binding,
          p.turn?.error?.message || 'The runtime did not confirm a terminal turn status.'
        );
      return;
    }
    this.changed();
  }
  onServerRequest(message) {
    if (this.shuttingDown) return;
    const binding = this.findBinding(message.params || {});
    if (!binding) {
      this.runtime.respondError(
        message.id,
        -32601,
        'No active task is associated with this request.'
      );
      return;
    }
    if (binding.ownerChat && message.method === 'item/tool/requestUserInput') {
      try {
        this.runtime.respondError(
          message.id,
          -32601,
          'Ask the owner in your structured reply with action set to null.'
        );
      } catch {
        this.markUncertain(
          binding,
          'Could not deliver the project chat clarification response. Inspect the saved turn.'
        );
      }
      return;
    }
    const id = randomUUID();
    this.approvals.set(id, {
      id,
      rawId: message.id,
      method: message.method,
      params: message.params || {},
      taskId: binding.taskId
    });
    this.store.addEvent(binding.taskId, message.method, message.params);
    this.store.updateTask(binding.taskId, { status: 'waiting_for_input' });
    this.changed();
  }
  restoreRunning(taskId) {
    const binding = this.active.get(taskId);
    if (!binding) return;
    if (![...this.approvals.values()].some((x) => x.taskId === taskId))
      this.store.updateTask(taskId, {
        status: binding.cancelRequested ? 'interrupting' : 'running'
      });
  }
  async respondToRequest(id, input) {
    const request = this.approvals.get(id);
    if (!request) throw errorWithStatus('That request is no longer pending.', 409);
    if (approvalMethods.has(request.method)) {
      if (!['accept', 'decline', 'cancel'].includes(input.decision))
        throw errorWithStatus('Choose accept, decline, or cancel.');
      const available = request.params.availableDecisions;
      if (input.decision === 'accept' && Array.isArray(available) && !available.includes('accept'))
        throw errorWithStatus('Accept is not an available decision for this request.');
      this.runtime.respond(request.rawId, { decision: input.decision });
    } else if (request.method === 'item/tool/requestUserInput') {
      const answers = input.answers;
      if (!answers || typeof answers !== 'object')
        throw errorWithStatus('Answer the requested questions.');
      const result = {};
      for (const q of request.params.questions || []) {
        const values = answers[q.id]?.answers;
        if (
          !Array.isArray(values) ||
          !values.length ||
          values.length > 10 ||
          values.some((x) => typeof x !== 'string' || !x.trim() || x.length > 4000)
        )
          throw errorWithStatus(`Provide an answer for ${q.header || q.id}.`);
        result[q.id] = { answers: values };
      }
      this.runtime.respond(request.rawId, { answers: result });
    } else if (request.method === 'item/permissions/requestApproval') {
      if (input.decision === 'accept')
        throw errorWithStatus('Broader permissions are not granted by this client.');
      this.runtime.respond(request.rawId, { permissions: {}, scope: 'turn' });
    } else {
      if (input.decision === 'accept') throw errorWithStatus('This request type is not supported.');
      this.runtime.respondError(
        request.rawId,
        -32601,
        'This request type is not supported by Lillia.'
      );
    }
    this.approvals.delete(id);
    this.store.addEvent(request.taskId, 'request/responded', {
      method: request.method,
      decision: input.decision || 'answered'
    });
    this.restoreRunning(request.taskId);
    this.changed();
  }
  async interruptTask(id, expected, beforeInterrupt) {
    if (this.shuttingDown) throw errorWithStatus('The controller is shutting down.', 409);
    if (expected) assertReservedStop(this.store, expected, this.active.get(id), 'codex');
    const task = this.task(id);
    if (task.status === 'queued' || task.status === 'blocked') {
      this.store.updateTask(id, { status: 'interrupted', error: null });
      this.changed();
      this.kick();
      return 'confirmed';
    }
    const binding = this.active.get(id);
    if (!binding) throw errorWithStatus('This task is not active.', 409);
    if (expected) binding.interruptExpected = Object.freeze({ ...expected });
    if (beforeInterrupt !== undefined) binding.interruptAuthority = beforeInterrupt;
    binding.cancelRequested = true;
    this.store.updateTask(id, { status: 'interrupting' });
    this.changed();
    return binding.turnId ? this.sendInterrupt(binding) : 'requested';
  }
  async sendInterrupt(binding) {
    if (!this.owns(binding) || !binding.turnId) return 'unconfirmed';
    binding.interruptDelivery ??= this.deliverInterrupt(binding);
    return binding.interruptDelivery;
  }
  async deliverInterrupt(binding) {
    try {
      const {
        threadId,
        turnId,
        interruptExpected: expected,
        interruptAuthority: authority
      } = binding;
      const beforeWrite = () => {
        if (
          !this.owns(binding) ||
          binding.uncertain ||
          binding.threadId !== threadId ||
          binding.turnId !== turnId
        )
          throw errorWithStatus('The captured interruption binding changed.', 409);
        if (expected)
          assertReservedStop(this.store, expected, binding, 'codex', { interrupting: true });
        assertInterruptAuthority(authority);
      };
      beforeWrite();
      await this.runtime.request(
        'turn/interrupt',
        {
          threadId,
          turnId
        },
        undefined,
        beforeWrite
      );
      return 'sent';
    } catch (error) {
      if (this.owns(binding))
        this.markUncertain(binding, `Interruption could not be confirmed: ${error.message}`);
      return 'unconfirmed';
    }
  }
  finish(id, status, error = null) {
    const binding = this.active.get(id);
    if (status !== 'recovery_needed' && binding?.threadId)
      this.runtime.retireThread?.(binding.threadId);
    this.active.delete(id);
    for (const [key, request] of this.approvals)
      if (request.taskId === id) this.approvals.delete(key);
    this.store.updateTask(id, { status, error, recoveryCleared: status !== 'recovery_needed' });
    this.store.addEvent(id, 'task/' + status, { error });
    this.changed();
    this.kick();
  }
  async close() {
    this.shuttingDown = true;
    await this.runtime.stop();
  }
}
