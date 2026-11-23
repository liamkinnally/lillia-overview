import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

// A single JSONL message can contain a sizeable tool result, but must not grow
// without bound when a child emits broken output without a newline.
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const owns = (object, key) => Object.hasOwn(object, key);
const validId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id));

export class CodexRuntime extends EventEmitter {
  constructor({
    command = 'codex',
    args = ['app-server', '--listen', 'stdio://'],
    cwd,
    env,
    experimentalApi = false,
    requestTimeoutMs = 30000
  } = {}) {
    super();
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0)
      throw new TypeError('requestTimeoutMs must be positive');
    if (typeof experimentalApi !== 'boolean')
      throw new TypeError('experimentalApi must be boolean');
    this.experimentalApi = experimentalApi;
    this.command = command;
    this.args = [...args];
    this.cwd = cwd;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.status = 'stopped';
    this._session = null;
    this._startPromise = null;
    this._stopPromise = null;
    this._nextId = 1;
    this._epoch = 0;
  }

  start() {
    if (this._stopPromise) return this._stopPromise.then(() => this.start());
    if (this.status === 'ready') return Promise.resolve();
    if (this._startPromise) return this._startPromise;
    const promise = this._start(this._epoch);
    this._startPromise = promise;
    // Both branches clear the shared handshake without creating an unobserved
    // rejecting promise. All concurrent callers receive the same handshake.
    promise.then(
      () => {
        if (this._startPromise === promise) this._startPromise = null;
      },
      () => {
        if (this._startPromise === promise) this._startPromise = null;
      }
    );
    return promise;
  }

  async _start(epoch) {
    if (this._session && !this._session.closed) await this._session.whenClosed;
    if (epoch !== this._epoch) throw new Error('Codex runtime stopped');
    this._setStatus('starting');
    if (epoch !== this._epoch) throw new Error('Codex runtime stopped');
    const session = {
      pending: new Map(),
      parts: [],
      bytes: 0,
      failed: null,
      stopping: false,
      closed: false
    };
    session.whenClosed = new Promise((resolve) => {
      session.resolveClosed = resolve;
    });
    this._session = session;
    try {
      const child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      session.child = child;
      child.on('error', (error) => this._fail(session, error));
      child.on('close', (code, signal) => {
        session.closed = true;
        clearTimeout(session.killTimer);
        session.resolveClosed();
        if (!session.stopping)
          this._fail(
            session,
            new Error(`Codex process exited (code ${code}, signal ${signal ?? 'none'})`)
          );
      });
      child.stdin.on('error', (error) => this._fail(session, error));
      child.stdout.on('error', (error) => this._fail(session, error));
      child.stderr.on('error', (error) => this._fail(session, error));
      child.stdout.on('data', (chunk) => this._read(session, chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        if (this._session === session) this.emit('stderr', chunk);
      });

      // Initialization bypasses request(), which itself waits for start().
      const handshake = await this._request(session, 'initialize', {
        clientInfo: { name: 'codex_control', version: '0.1.0' },
        ...(this.experimentalApi ? { capabilities: { experimentalApi: true } } : {})
      });
      this.nativeVersion =
        handshake?.userAgent?.match(/\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?\b/)?.[0] ?? null;
      this._write(session, { method: 'initialized' });
      this._setStatus('ready');
    } catch (error) {
      if (!session.child) {
        session.closed = true;
        session.resolveClosed();
      }
      this._fail(session, error);
      throw error;
    }
  }

  async request(method, params, _startingTaskId, beforeWrite) {
    // Guarded sends belong to this ready session, never a replacement created
    // while startup yields. The third argument stays compatible with AccountRuntime.
    const session = this._session,
      epoch = this._epoch;
    await this.start();
    if (
      beforeWrite !== undefined &&
      (!session || session !== this._session || epoch !== this._epoch)
    )
      throw new Error('The captured Codex session changed before writing.');
    return this._request(this._session, method, params, beforeWrite);
  }

  _request(session, method, params, beforeWrite) {
    if (!session || session.failed || session.stopping || session.closed)
      return Promise.reject(session?.failed ?? new Error('Codex runtime is stopped'));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`Codex request ${method} timed out after ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
      session.pending.set(id, { resolve, reject, timer });
      try {
        this._write(session, { id, method, params }, beforeWrite);
      } catch (error) {
        clearTimeout(timer);
        session.pending.delete(id);
        reject(error);
      }
    });
  }

  respond(id, result) {
    if (!validId(id)) throw new TypeError('Invalid JSON-RPC request id');
    this._write(this._session, { id, result: result === undefined ? null : result });
  }

  respondError(id, code, message) {
    if (!validId(id)) throw new TypeError('Invalid JSON-RPC request id');
    this._write(this._session, { id, error: { code, message } });
  }

  _write(session, message, beforeWrite) {
    if (
      !session ||
      session.failed ||
      session.stopping ||
      session.closed ||
      !session.child?.stdin.writable
    )
      throw session?.failed ?? new Error('Codex runtime is stopped');
    const data = `${JSON.stringify(message)}\n`;
    // Serialization/startup may yield or run caller code. Check synchronously
    // here, with no await or observer callback before the actual transport write.
    if (beforeWrite !== undefined) {
      if (session !== this._session) throw new Error('The captured Codex session changed.');
      if (typeof beforeWrite !== 'function') throw new TypeError('Invalid native write guard.');
      const result = beforeWrite();
      if (result !== undefined) {
        if (typeof result?.then === 'function') Promise.resolve(result).catch(() => {});
        throw new TypeError('Native write guard must finish synchronously.');
      }
    }
    session.child.stdin.write(data, (error) => {
      if (error) this._fail(session, error);
    });
  }

  _read(session, chunk) {
    if (session.failed || session.stopping || this._session !== session) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const piece = chunk.subarray(offset, end);
      session.bytes += piece.length;
      if (session.bytes > MAX_LINE_BYTES) {
        this._fail(session, new Error('Codex protocol line exceeds the 16 MiB limit'));
        return;
      }
      session.parts.push(piece);
      if (newline === -1) return;
      const line = Buffer.concat(session.parts, session.bytes).toString('utf8');
      session.parts = [];
      session.bytes = 0;
      offset = newline + 1;
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
        this._validateMessage(message);
      } catch (error) {
        this._fail(session, new Error(`Codex protocol error: ${error.message}`));
        return;
      }
      this._route(session, message);
      if (session.failed || session.stopping) return;
    }
  }

  _validateMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message))
      throw new Error('Expected a JSON-RPC message object');
    const hasId = owns(message, 'id');
    if (hasId && !validId(message.id)) throw new Error('Invalid JSON-RPC message id');
    if (owns(message, 'method')) {
      if (typeof message.method !== 'string') throw new Error('Invalid JSON-RPC method');
      return;
    }
    if (!hasId || owns(message, 'result') === owns(message, 'error'))
      throw new Error('Invalid JSON-RPC response');
    if (
      owns(message, 'error') &&
      (!message.error ||
        typeof message.error !== 'object' ||
        !Number.isInteger(message.error.code) ||
        typeof message.error.message !== 'string')
    )
      throw new Error('Invalid JSON-RPC error');
  }

  _route(session, message) {
    if (owns(message, 'method')) {
      this.emit(owns(message, 'id') ? 'serverRequest' : 'notification', message);
      return;
    }
    const pending = session.pending.get(message.id);
    // A timeout can leave a legitimate late response with no remaining caller.
    if (!pending) return;
    session.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (owns(message, 'error')) {
      const error = new Error(message.error.message);
      error.code = message.error.code;
      error.data = message.error.data;
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  _fail(session, error) {
    if (session.failed) return;
    session.failed = error instanceof Error ? error : new Error(String(error));
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(session.failed);
    }
    session.pending.clear();
    session.parts = [];
    session.bytes = 0;
    if (this._session === session && !session.stopping)
      this._setStatus('error', session.failed.message);
    this._terminate(session);
  }

  _terminate(session) {
    if (!session.child || session.closed || session.killTimer) return;
    session.child.kill('SIGTERM');
    session.killTimer = setTimeout(() => {
      if (!session.closed) session.child.kill('SIGKILL');
    }, 500);
    session.killTimer.unref();
  }

  stop() {
    if (this._stopPromise) return this._stopPromise;
    this._epoch++;
    const session = this._session;
    if (!session) {
      this._setStatus('stopped');
      return Promise.resolve();
    }
    session.stopping = true;
    this._fail(session, new Error('Codex runtime stopped'));
    this._terminate(session);
    const promise = session.whenClosed.then(() => {
      if (this._session === session) this._setStatus('stopped');
    });
    this._stopPromise = promise;
    promise.then(() => {
      if (this._stopPromise === promise) this._stopPromise = null;
    });
    return promise;
  }

  _setStatus(status, error) {
    if (this.status === status && !error) return;
    this.status = status;
    this.emit('status', error ? { status, error } : { status });
  }
}
