import { createHash, randomUUID } from 'node:crypto';
import { readFinalOutput } from './task-context.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const now = () => new Date().toISOString();
function fail(message, status = 409) {
  throw Object.assign(new Error(message), { status });
}
function fields(value, names) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !names.includes(k))
  )
    fail('Unexpected mailbox input field.', 400);
}
function string(value, limit = 1600) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    fail('Invalid mailbox text or identifier.', 400);
  return value;
}
function envelope(row) {
  if (hash(row.payload) !== row.digest) fail('Mailbox content digest mismatch.');
  return { ...JSON.parse(row.payload), digest: row.digest, resolution: JSON.parse(row.resolution) };
}
export function installCoordination(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS coordination_messages(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,goalId TEXT NOT NULL REFERENCES goals(id),
    scopeVersion INTEGER NOT NULL,recipientTaskId TEXT NOT NULL REFERENCES goal_tasks(taskId),kind TEXT NOT NULL,
    resolutionRequired INTEGER NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,resolution TEXT,acceptedAt TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS coordination_recipient ON coordination_messages(recipientTaskId,seq);
    CREATE INDEX IF NOT EXISTS coordination_goal ON coordination_messages(goalId,seq);
    CREATE TABLE IF NOT EXISTS coordination_deliveries(messageId TEXT NOT NULL REFERENCES coordination_messages(id),
      attemptId TEXT NOT NULL REFERENCES attempts(id),includedAt TEXT NOT NULL,deliveredAt TEXT,acknowledgedAt TEXT,
      PRIMARY KEY(messageId,attemptId));
    CREATE TABLE IF NOT EXISTS coordination_processed(attemptId TEXT PRIMARY KEY REFERENCES attempts(id),outcome TEXT NOT NULL);`);
}
export class Coordination {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }
  atomic(fn) {
    return this.db.isTransaction ? fn() : this.store.transaction(fn);
  }
  current(goalId, expectedVersion) {
    const goal = this.store.goal(string(goalId));
    if (goal.state !== 'active' || goal.version !== expectedVersion)
      fail('Expected active goal version.');
    return goal;
  }
  recipient(goal, id) {
    const { task } = this.store.taskView(string(id));
    if (
      task.goalId !== goal.id ||
      task.goalVersion < goal.scopeVersion ||
      task.goalVersion > goal.version ||
      task.status !== 'queued'
    )
      fail('Expected a queued continuation in this goal scope.');
    return task;
  }
  insert(goal, recipient, input, sender) {
    const { kind, acceptance, dependencyTaskId, expectedOutput } = input;
    if (!['question', 'dependency-request', 'info', 'supersession', 'cancellation'].includes(kind))
      fail('Unknown coordination kind.', 400);
    if (kind === 'dependency-request') {
      if (!recipient.dependsOn.includes(dependencyTaskId))
        fail('Dependency was not declared for this recipient.');
      string(acceptance);
      if (expectedOutput !== undefined) string(expectedOutput, 1024);
    } else if ([acceptance, dependencyTaskId, expectedOutput].some((x) => x !== undefined))
      fail('Dependency fields require a dependency request.', 400);
    const count = this.db
      .prepare('SELECT COUNT(*) AS n FROM coordination_messages WHERE recipientTaskId=?')
      .get(recipient.id).n;
    if (count >= 12) fail('Mailbox capacity reached for this continuation.');
    const plan = this.db
      .prepare(
        'SELECT p.id,p.goalVersion FROM goal_plans p JOIN plan_jobs j ON j.planId=p.id WHERE j.taskId=?'
      )
      .get(recipient.id);
    const id = randomUUID(),
      acceptedAt = now();
    const payload = JSON.stringify({
      id,
      correlationId: id,
      goalId: goal.id,
      goalVersion: goal.version,
      scopeVersion: goal.scopeVersion,
      planId: plan?.id ?? null,
      planVersion: plan?.goalVersion ?? null,
      sourceRevision: null,
      attachments: [],
      recipientTaskId: recipient.id,
      specVersion: recipient.specVersion,
      sender,
      kind,
      text: string(input.text),
      acceptance,
      dependencyTaskId,
      expectedOutput,
      acceptedAt
    });
    this.db
      .prepare(
        `INSERT INTO coordination_messages(id,goalId,scopeVersion,recipientTaskId,kind,resolutionRequired,payload,digest,acceptedAt)
      VALUES(?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        goal.id,
        goal.scopeVersion,
        recipient.id,
        kind,
        Number(['question', 'dependency-request'].includes(kind)),
        payload,
        hash(payload),
        acceptedAt
      );
    this.store.activity('coordination.accepted', goal.id, recipient.id);
    return envelope(this.db.prepare('SELECT * FROM coordination_messages WHERE id=?').get(id));
  }
  post(input) {
    fields(input, [
      'goalId',
      'expectedVersion',
      'recipientTaskId',
      'kind',
      'text',
      'dependencyTaskId',
      'acceptance',
      'expectedOutput'
    ]);
    return this.atomic(() => {
      const goal = this.current(input.goalId, input.expectedVersion);
      return this.insert(goal, this.recipient(goal, input.recipientTaskId), input, {
        principal: 'local-owner'
      });
    });
  }
  resolve(input) {
    fields(input, ['goalId', 'expectedVersion', 'messageId', 'text', 'expectedDigest']);
    return this.atomic(() => {
      const goal = this.current(input.goalId, input.expectedVersion);
      const row = this.db
        .prepare('SELECT * FROM coordination_messages WHERE id=? AND goalId=? AND scopeVersion=?')
        .get(string(input.messageId), goal.id, goal.scopeVersion);
      if (!row?.resolutionRequired) fail('No applicable coordination request.');
      const msg = envelope(row);
      this.recipient(goal, row.recipientTaskId);
      const resolution = { principal: 'local-owner', text: string(input.text) };
      if (row.kind === 'dependency-request') {
        const { text, ...proof } = readFinalOutput(this.store, msg.dependencyTaskId);
        if (
          proof.digest !== input.expectedDigest ||
          (msg.expectedOutput !== undefined && text !== msg.expectedOutput)
        )
          fail('Dependency verification mismatch.');
        resolution.evidence = proof;
      } else if (input.expectedDigest !== undefined)
        fail('Question resolution cannot bind dependency evidence.', 400);
      if (row.resolution && row.resolution !== JSON.stringify(resolution))
        fail('Request has already been resolved.');
      this.saveResolution(row, resolution);
      return { ...msg, resolution };
    });
  }
  saveResolution(row, resolution) {
    const result = this.db
      .prepare('UPDATE coordination_messages SET resolution=? WHERE id=? AND resolution IS NULL')
      .run(JSON.stringify(resolution), row.id);
    if (result.changes)
      this.store.activity('coordination.resolved', row.goalId, row.recipientTaskId);
    return !!result.changes;
  }
  view({ goalId, taskId, after = 0, limit = 20 }) {
    this.store.goal(goalId);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      fail('Invalid mailbox page.', 400);
    const rows = this.db
      .prepare(
        'SELECT * FROM coordination_messages WHERE goalId=? AND seq>? AND (? IS NULL OR recipientTaskId=?) ORDER BY seq LIMIT ?'
      )
      .all(goalId, after, taskId ?? null, taskId ?? null, limit + 1);
    const messages = rows.slice(0, limit).map((row) => ({
      ...envelope(row),
      seq: row.seq,
      deliveries: this.db
        .prepare(
          'SELECT * FROM coordination_deliveries WHERE messageId=? ORDER BY includedAt,attemptId'
        )
        .all(row.id)
    }));
    return { messages, cursor: rows.length > limit ? messages.at(-1).seq : null };
  }
  routes(taskId) {
    return this.db
      .prepare(
        `SELECT dest.jobKey FROM plan_jobs src JOIN goal_plans p ON p.id=src.planId
      JOIN plan_jobs dest ON dest.planId=p.id JOIN tasks t ON t.id=dest.taskId
      WHERE p.state='applied' AND src.taskId=? AND t.status='queued'
      AND EXISTS (SELECT 1 FROM json_each(t.dependsOn) d WHERE d.value=src.taskId) ORDER BY dest.jobKey`
      )
      .all(taskId)
      .map((row) => row.jobKey);
  }
  dispatch(taskId) {
    const { task } = this.store.taskView(taskId),
      goal = this.store.goal(task.goalId);
    const rows = this.db
      .prepare(
        'SELECT * FROM coordination_messages WHERE recipientTaskId=? AND scopeVersion=? ORDER BY seq'
      )
      .all(taskId, goal.scopeVersion);
    const messages = rows.map(envelope);
    for (const msg of messages) {
      if (msg.specVersion !== task.specVersion)
        fail('Recipient specification changed after message acceptance.');
      if (
        msg.planId &&
        !this.db
          .prepare(
            "SELECT 1 FROM goal_plans p JOIN plan_jobs j ON j.planId=p.id WHERE p.id=? AND p.goalId=? AND p.state='applied' AND j.taskId=?"
          )
          .get(msg.planId, goal.id, taskId)
      )
        fail('Mailbox recipient plan is no longer applicable.');
      const sources = [msg.resolution?.evidence];
      if (msg.sender.principal === 'verified-worker') sources.push(msg.sender);
      for (const source of sources.filter(Boolean)) {
        const { text, ...current } = readFinalOutput(this.store, source.taskId);
        if (Object.keys(current).some((key) => source[key] !== current[key]))
          fail('Mailbox evidence no longer matches its authoritative result.');
      }
    }
    return { blocked: rows.some((row) => row.resolutionRequired && !row.resolution), messages };
  }
  included(taskId, attemptId, messages) {
    if (!this.db.isTransaction) fail('Mailbox inclusion requires the reservation transaction.');
    const attempt = this.db
      .prepare(
        "SELECT id FROM attempts WHERE taskId=? AND id=? AND status IN ('starting','running')"
      )
      .get(taskId, attemptId);
    const inbox = this.dispatch(taskId);
    if (!attempt || inbox.blocked || JSON.stringify(inbox.messages) !== JSON.stringify(messages))
      fail('Mailbox reservation scope changed.');
    for (const msg of messages)
      this.db
        .prepare(
          'INSERT OR IGNORE INTO coordination_deliveries(messageId,attemptId,includedAt) VALUES(?,?,?)'
        )
        .run(msg.id, attemptId, now());
  }
  delivered(taskId, attemptId) {
    this.db
      .prepare(
        `UPDATE coordination_deliveries SET deliveredAt=COALESCE(deliveredAt,?) WHERE attemptId=?
      AND EXISTS(SELECT 1 FROM attempts a WHERE a.id=? AND a.taskId=?)`
      )
      .run(now(), attemptId, attemptId, taskId);
  }
  consume(row, proof, packet) {
    fields(packet, ['scionCoordination', 'messages', 'acknowledge']);
    const { messages = [], acknowledge = [] } = packet;
    if (
      !Array.isArray(messages) ||
      messages.length > 8 ||
      !Array.isArray(acknowledge) ||
      acknowledge.length > 12
    )
      fail('Invalid worker mailbox packet.', 400);
    const goal = this.store.goal(row.goalId);
    const findJob = (key) =>
      this.db
        .prepare('SELECT taskId FROM plan_jobs WHERE planId=? AND jobKey=?')
        .get(row.planId, string(key, 128))?.taskId;
    for (const msg of messages) {
      fields(msg, [
        'kind',
        'recipientKey',
        'text',
        'dependencyKey',
        'acceptance',
        'expectedOutput'
      ]);
      const target = findJob(msg.recipientKey);
      if (!target) fail('Unknown downstream recipient.');
      const recipient = this.recipient(goal, target);
      if (!recipient.dependsOn.includes(row.taskId))
        fail('Recipient is outside the declared downstream edge.');
      const dependencyTaskId =
        msg.dependencyKey === undefined ? undefined : findJob(msg.dependencyKey);
      this.insert(
        goal,
        recipient,
        { ...msg, dependencyTaskId },
        { principal: 'verified-worker', driver: row.driver, ...proof }
      );
    }
    this.delivered(row.taskId, row.attemptId);
    for (const id of acknowledge) {
      const result = this.db
        .prepare(
          `UPDATE coordination_deliveries SET acknowledgedAt=COALESCE(acknowledgedAt,?)
        WHERE attemptId=? AND messageId=? AND deliveredAt IS NOT NULL`
        )
        .run(now(), row.attemptId, string(id, 128));
      if (!result.changes) fail('Acknowledgment is outside the worker delivery.');
    }
  }
  advance() {
    return this.atomic(() => {
      let changed = false;
      const workers = this.db
        .prepare(
          `SELECT a.id AS attemptId,a.taskId,a.driver,p.goalId,p.id AS planId FROM attempts a
        JOIN tasks t ON t.id=a.taskId JOIN plan_jobs j ON j.taskId=a.taskId JOIN goal_plans p ON p.id=j.planId
        JOIN goals g ON g.id=p.goalId JOIN goal_tasks gt ON gt.taskId=t.id AND gt.goalId=g.id
        WHERE t.status='completed' AND a.status='completed' AND g.state='active' AND p.state='applied'
        AND p.goalVersion >= (SELECT MAX(version) FROM goal_revisions WHERE id=g.id AND changeKind IN ('created','goal.amend'))
        AND NOT EXISTS(SELECT 1 FROM coordination_processed h WHERE h.attemptId=a.id)`
        )
        .all();
      for (const row of workers) {
        let output;
        try {
          output = readFinalOutput(this.store, row.taskId);
        } catch (e) {
          if (e.status === 409) continue;
          throw e;
        }
        if (output.attemptId !== row.attemptId) continue;
        const { text, ...proof } = output;
        let packet,
          outcome = 'ignored';
        if (text.length <= 20000) {
          try {
            packet = JSON.parse(text);
          } catch {
            /* Ordinary output. */
          }
        }
        if (packet?.scionCoordination === 1) {
          this.db.exec('SAVEPOINT coordination_packet');
          try {
            this.consume(row, proof, packet);
            outcome = 'accepted';
            changed = true;
          } catch (e) {
            this.db.exec('ROLLBACK TO coordination_packet');
            if (![400, 404, 409].includes(e.status)) throw e;
            outcome = 'rejected';
          } finally {
            this.db.exec('RELEASE coordination_packet');
          }
        }
        this.db
          .prepare('INSERT INTO coordination_processed VALUES(?,?)')
          .run(row.attemptId, outcome);
        if (outcome === 'rejected')
          this.store.activity('coordination.rejected', row.goalId, row.taskId);
      }
      const pending = this.db
        .prepare(
          `SELECT m.* FROM coordination_messages m JOIN goals g ON g.id=m.goalId JOIN tasks t ON t.id=m.recipientTaskId
        WHERE g.state='active' AND t.status='queued' AND m.kind='dependency-request' AND m.resolution IS NULL
        AND json_type(m.payload,'$.expectedOutput')='text' AND m.scopeVersion=(SELECT MAX(version) FROM goal_revisions
          WHERE id=g.id AND changeKind IN ('created','goal.amend'))`
        )
        .all();
      for (const row of pending) {
        const msg = envelope(row);
        let output;
        try {
          output = readFinalOutput(this.store, msg.dependencyTaskId);
        } catch (e) {
          if (e.status === 409) continue;
          throw e;
        }
        const { text, ...proof } = output;
        if (text === msg.expectedOutput)
          changed =
            this.saveResolution(row, { principal: 'core:exact-output', evidence: proof }) ||
            changed;
      }
      return changed;
    });
  }
}
