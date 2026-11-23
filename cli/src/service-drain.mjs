const liveTasks = "status IN ('starting','running','waiting_for_input','interrupting')";
const uncertainTasks = "status='recovery_needed' AND recoveryCleared=0";
const unresolvedWorkspaces = "state IN ('allocating','projecting','capture_pending','uncertain')";
const controls = new Set([
  'task.cancel',
  'task.reconcile',
  'goal.cancel',
  'goal.pause',
  'research.revoke',
  'job.revoke',
  'project.review.retry',
  'bridge.abandon'
]);
const lifecycle = new Set(['daemon.drain', 'daemon.resume']);
const safeId = (s) => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(s);
function need(x, message, status = 409) {
  if (!x) throw Object.assign(new Error(message), { status });
}
function knownFields(value, fields) {
  need(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === fields.length &&
      fields.every((k) => Object.hasOwn(value, k)),
    'Invalid drain control input',
    400
  );
}
export function installServiceDrain(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS service_drain(
    slot INTEGER PRIMARY KEY CHECK(slot=1),mode TEXT NOT NULL CHECK(mode IN ('open','draining')),generation INTEGER NOT NULL,
    cutoff TEXT,cutoffAt TEXT,attemptCursor INTEGER NOT NULL,eventCursor INTEGER NOT NULL,lastOperation TEXT);
    INSERT OR IGNORE INTO service_drain VALUES(1,'open',0,NULL,NULL,0,0,NULL);
    CREATE TRIGGER IF NOT EXISTS service_drain_dispatch BEFORE UPDATE OF status ON tasks
    WHEN OLD.status IN ('queued','blocked') AND NEW.status IN ('starting','running','waiting_for_input','interrupting')
      AND (SELECT mode FROM service_drain WHERE slot=1)='draining'
    BEGIN SELECT RAISE(ABORT,'Daemon drain has closed dispatch admission.');END;`);
}
export class ServiceDrain {
  #inFlight = new Set();
  constructor(store, { live = () => ({ workers: 0, callbacks: 0, controls: 0 }) } = {}) {
    this.db = store.db;
    this.live = live;
  }
  #state() {
    const s = this.db
      .prepare(
        'SELECT mode,generation,cutoff,cutoffAt,attemptCursor,eventCursor,lastOperation FROM service_drain WHERE slot=1'
      )
      .get();
    need(s && ['open', 'draining'].includes(s.mode), 'Service drain state unavailable');
    return { ...s };
  }
  admissionsOpen() {
    return this.#state().mode === 'open';
  }
  #track(name, id) {
    const ticket = { name, id };
    this.#inFlight.add(ticket);
    return () => {
      this.#inFlight.delete(ticket);
    };
  }
  enterBackground(label) {
    need(
      typeof label === 'string' && label.length > 0 && label.length <= 64,
      'Invalid background activity',
      400
    );
    return this.admissionsOpen() ? this.#track(label, null) : null;
  }
  enter(name, operationId, intentDigest) {
    need(
      typeof name === 'string' && typeof operationId === 'string' && safeId(operationId),
      'Invalid service admission identity',
      400
    );
    if (lifecycle.has(name)) return () => {};
    if (name === 'authority.migrate') {
      need(
        this.view().phase === 'quiescent',
        'Protected-source migration requires a quiescent named drain.'
      );
      return this.#track(name, operationId);
    }
    if (!this.admissionsOpen() && !controls.has(name)) {
      let allowed = false;
      if (name === 'backup.create') {
        const pending = this.db
          .prepare('SELECT kind,digest FROM pending_effects WHERE operationId=?')
          .get(operationId);
        if (pending)
          need(
            pending.kind === name && pending.digest === intentDigest,
            'Pending backup intent changed'
          );
        allowed = !!pending || this.view().phase === 'quiescent';
        need(allowed, 'Daemon must reach quiescence before starting a new backup');
      }
      need(allowed, 'Daemon admission is drained. Inspect the named cutoff before resuming.');
    }
    return this.#track(name, operationId);
  }
  begin(input, operationId) {
    knownFields(input, ['expectedGeneration']);
    need(
      this.db.isTransaction && safeId(operationId),
      'Drain requires an owner receipt transaction and stable operation ID'
    );
    need(
      Number.isSafeInteger(input.expectedGeneration) && input.expectedGeneration >= 0,
      'Invalid drain generation',
      400
    );
    const state = this.#state();
    need(
      state.mode === 'open' && state.generation === input.expectedGeneration,
      'Daemon drain generation changed'
    );
    this.db
      .prepare(
        `UPDATE service_drain SET mode='draining',generation=generation+1,cutoff=?,cutoffAt=?,
      attemptCursor=(SELECT coalesce(max(rowid),0) FROM attempts),eventCursor=(SELECT coalesce(max(id),0) FROM activity),lastOperation=? WHERE slot=1`
      )
      .run(operationId, new Date().toISOString(), operationId);
    return this.view();
  }
  resume(input, operationId) {
    knownFields(input, ['expectedGeneration', 'cutoff']);
    need(
      this.db.isTransaction && safeId(operationId),
      'Resume requires an owner receipt transaction and stable operation ID'
    );
    need(
      Number.isSafeInteger(input.expectedGeneration) &&
        input.expectedGeneration >= 1 &&
        safeId(input.cutoff),
      'Invalid drain cutoff or generation',
      400
    );
    const state = this.#state();
    need(
      state.mode === 'draining' &&
        state.generation === input.expectedGeneration &&
        state.cutoff === input.cutoff,
      'Named drain cutoff or generation changed'
    );
    this.db
      .prepare(
        "UPDATE service_drain SET mode='open',generation=generation+1,lastOperation=? WHERE slot=1"
      )
      .run(operationId);
    return this.view();
  }
  view() {
    const s = this.#state(),
      q = (sql) => this.db.prepare(sql).get().n;
    let runtime = null;
    try {
      const live = this.live();
      if (
        live &&
        ['workers', 'callbacks', 'controls'].every(
          (k) => Number.isSafeInteger(live[k]) && live[k] >= 0
        )
      )
        runtime = live;
    } catch {}
    const tasks = this.db
      .prepare(
        `SELECT count(*) FILTER(WHERE status='queued') AS queuedTasks,
      count(*) FILTER(WHERE ${liveTasks}) AS activeTasks,count(*) FILTER(WHERE ${uncertainTasks}) AS uncertainTasks FROM tasks`
      )
      .get();
    const counts = {
      ...tasks,
      inFlight: this.#inFlight.size,
      workers: runtime?.workers ?? null,
      callbacks: runtime?.callbacks ?? null,
      liveControls: runtime?.controls ?? null,
      pendingEffects: q('SELECT count(*) AS n FROM pending_effects'),
      pendingControls: q(
        "SELECT count(*) AS n FROM task_controls WHERE state IN ('pending','requested','sent')"
      ),
      unconfirmedControls: q(
        "SELECT count(*) AS n FROM task_controls c JOIN tasks t ON t.id=c.taskId WHERE c.state='unconfirmed' AND (t.status IN ('starting','running','waiting_for_input','interrupting') OR (t.status='recovery_needed' AND t.recoveryCleared=0))"
      ),
      uncertainWorkspaces: q(
        'SELECT count(*) AS n FROM agent_workspaces WHERE ' + unresolvedWorkspaces
      )
    };
    const active =
      counts.inFlight +
      counts.activeTasks +
      (counts.workers ?? 0) +
      (counts.callbacks ?? 0) +
      (counts.liveControls ?? 0) +
      counts.pendingControls;
    const unknown =
      !runtime ||
      counts.pendingEffects +
        counts.unconfirmedControls +
        counts.uncertainTasks +
        counts.uncertainWorkspaces >
        0;
    const phase =
      s.mode === 'open' ? 'open' : active ? 'draining' : unknown ? 'uncertain' : 'quiescent';
    const sample = {
      inFlight: [...this.#sampleInFlight()],
      tasks: this.db
        .prepare(
          `SELECT id,status FROM tasks WHERE ${liveTasks} OR (${uncertainTasks}) ORDER BY rowid LIMIT 20`
        )
        .all()
        .map((r) => ({ ...r })),
      effects: this.db
        .prepare('SELECT operationId,kind FROM pending_effects ORDER BY rowid LIMIT 20')
        .all()
        .map((r) => ({ ...r })),
      controls: this.db
        .prepare(
          "SELECT id,taskId,kind,state FROM task_controls WHERE state IN ('pending','requested','sent','unconfirmed') ORDER BY rowid DESC LIMIT 20"
        )
        .all()
        .map((r) => ({ ...r })),
      workspaces: this.db
        .prepare(
          'SELECT taskId,workspaceId,state FROM agent_workspaces WHERE ' +
            unresolvedWorkspaces +
            ' ORDER BY rowid LIMIT 20'
        )
        .all()
        .map((r) => ({ ...r }))
    };
    return { ...s, phase, counts, sample };
  }
  *#sampleInFlight() {
    let n = 0;
    for (const t of this.#inFlight) {
      if (n++ === 20) break;
      yield { ...t };
    }
  }
}
