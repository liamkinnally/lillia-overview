import { createHash, randomUUID } from 'node:crypto';
import {
  pinOperation,
  advanceOperation,
  replayOperation,
  checkReceiptProgress,
  normalizeScope
} from './subtree-control.mjs';

// Backend migration owner installs these tables; no global schema version is assigned here.
export function installSubtreeJournal(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subtree_operations (
      operationId TEXT PRIMARY KEY, projectId TEXT NOT NULL, scopeId TEXT NOT NULL,
      snapshot TEXT NOT NULL, envelopeDigest TEXT NOT NULL,
      receipt TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1)
    );
    CREATE TABLE IF NOT EXISTS subtree_reservations (
      operationId TEXT NOT NULL REFERENCES subtree_operations(operationId),
      taskId TEXT NOT NULL REFERENCES goal_tasks(taskId), attemptId TEXT,
      controlId TEXT NOT NULL UNIQUE REFERENCES task_controls(id),
      claimed INTEGER NOT NULL DEFAULT 0 CHECK(claimed IN (0,1)),
      PRIMARY KEY(operationId,taskId)
    );
  `);
}

const bytes = (value) => JSON.stringify(value);
const digest = (projectId, snapshot, operation) =>
  createHash('sha256')
    .update(bytes([projectId, snapshot, operation.digest]))
    .digest('hex');

// Called only behind project owner authorization. scopeSnapshot must read this store
// synchronously inside the transaction; missing B/C authority never admits new effects.
export class SubtreeJournal {
  constructor(store, { projectId, scopeSnapshot } = {}) {
    if (typeof projectId !== 'string' || !projectId.trim()) throw Error('Project is required.');
    this.store = store;
    this.projectId = projectId;
    this.scopeSnapshot = scopeSnapshot;
  }

  // A caught inner failure must not leave partial controls in the owner's receipt transaction.
  transaction(work) {
    if (!this.store.db.isTransaction) return this.store.transaction(work);
    const name = 'subtree_' + randomUUID().replaceAll('-', '');
    this.store.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = work();
      this.store.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.store.db.exec(`ROLLBACK TO ${name}`);
      this.store.db.exec(`RELEASE ${name}`);
      throw error;
    }
  }

  load(operationId) {
    const row = this.store.db
      .prepare('SELECT * FROM subtree_operations WHERE operationId=? AND projectId=?')
      .get(operationId, this.projectId);
    if (!row) return null;
    try {
      const snapshot = normalizeScope(JSON.parse(row.snapshot));
      const receipt = JSON.parse(row.receipt);
      const initial = pinOperation({ ...receipt, members: snapshot.tasks });
      if (
        snapshot.projectId !== row.projectId ||
        snapshot.scopeId !== row.scopeId ||
        receipt.operationId !== row.operationId ||
        receipt.scopeId !== row.scopeId ||
        row.version !== receipt.version ||
        row.envelopeDigest !== digest(row.projectId, snapshot, initial) ||
        !checkReceiptProgress(initial, receipt)
      )
        throw Error();
      // Rebuild immutable scope fields from the pinned snapshot, not mutable receipt data.
      replayOperation(
        receipt,
        pinOperation({
          ...snapshot,
          operationId,
          action: receipt.action,
          members: snapshot.tasks
        })
      );
      const reservations = this.store.db
        .prepare(
          `SELECT r.*,c.taskId AS controlTask,
        c.kind FROM subtree_reservations r LEFT JOIN task_controls c ON c.id=r.controlId
        WHERE r.operationId=?`
        )
        .all(operationId);
      for (const member of receipt.members) {
        const row = reservations.find((item) => item.taskId === member.id);
        if (member.delivery === 'pending') {
          if (row) throw Error();
        } else if (
          !row ||
          row.controlTask !== member.id ||
          row.kind !== 'task.cancel' ||
          row.attemptId !== member.attemptId ||
          row.claimed !== (member.delivery === 'reserved' ? 0 : 1)
        )
          throw Error();
      }
      if (reservations.some((row) => !receipt.members.some((member) => member.id === row.taskId)))
        throw Error();
      return { snapshot, receipt };
    } catch {
      throw Error('Stored control operation is invalid; needs attention.');
    }
  }

  current(snapshot) {
    if (typeof this.scopeSnapshot !== 'function') throw Error('Scope authority unavailable.');
    const current = normalizeScope(
      this.scopeSnapshot(this.store, {
        projectId: this.projectId,
        scopeId: snapshot.scopeId
      })
    );
    if (current.projectId !== this.projectId || bytes(current) !== bytes(snapshot))
      throw Error('Scope authority changed.');
  }

  create({ operationId, action, snapshot: input }) {
    const snapshot = normalizeScope(input);
    if (snapshot.projectId !== this.projectId) throw Error('Wrong project.');
    const proposed = pinOperation({ ...snapshot, operationId, action, members: snapshot.tasks });
    return this.transaction(() => {
      const prior = this.load(operationId);
      if (prior) {
        if (bytes(prior.snapshot) !== bytes(snapshot)) throw Error('Pinned scope conflicts.');
        return replayOperation(prior.receipt, proposed);
      }
      this.current(snapshot);
      this.store.db
        .prepare('INSERT INTO subtree_operations VALUES(?,?,?,?,?,?,?)')
        .run(
          operationId,
          this.projectId,
          snapshot.scopeId,
          bytes(snapshot),
          digest(this.projectId, snapshot, proposed),
          bytes(proposed),
          proposed.version
        );
      return proposed;
    });
  }

  readOperation({ projectId, scopeId, operationId }) {
    if (projectId !== this.projectId) return null;
    return this.transaction(() => {
      const saved = this.load(operationId);
      if (!saved || saved.snapshot.scopeId !== scopeId) return null;
      return { projectId, scopeId, operationId, receipt: saved.receipt };
    });
  }

  save(previous, next) {
    if (!this.store.db.isTransaction) throw Error('Journal save requires an owner transaction.');
    if (!checkReceiptProgress(previous, next)) throw Error('Invalid receipt progression.');
    // Validate the complete stored invariant before releasing even a caught owner write.
    return this.transaction(() => {
      const result = this.store.db
        .prepare(
          `UPDATE subtree_operations SET receipt=?,version=?
      WHERE operationId=? AND projectId=? AND version=? AND receipt=?`
        )
        .run(
          bytes(next),
          next.version,
          previous.operationId,
          this.projectId,
          previous.version,
          bytes(previous)
        );
      if (result.changes !== 1) throw Error('Stale control operation.');
      this.load(previous.operationId);
      return next;
    });
  }

  task(member) {
    const task = this.store.taskView(member.id).task;
    const latest = this.store.db
      .prepare('SELECT id FROM attempts WHERE taskId=? ORDER BY ordinal DESC LIMIT 1')
      .get(member.id);
    if (task.status !== member.status || (latest?.id ?? null) !== member.attemptId)
      throw Error('Task or attempt changed.');
    return task;
  }

  reserve(operationId, expectedVersion, memberId) {
    return this.transaction(() => {
      const saved = this.load(operationId);
      if (!saved) throw Error('Unknown operation.');
      this.current(saved.snapshot);
      const member = saved.receipt.members.find((item) => item.id === memberId);
      if (!member) throw Error('Member was not pinned.');
      const next = advanceOperation(saved.receipt, {
        expectedVersion,
        memberId,
        event: 'reserve',
        scopeVersion: saved.snapshot.scopeVersion,
        membershipVersion: saved.snapshot.membershipVersion,
        memberVersion: member.version
      });
      const task = this.task(member);
      if (
        this.store.db
          .prepare(
            `SELECT 1 FROM task_controls WHERE taskId=?
        AND state IN ('pending','requested','sent','unconfirmed')`
          )
          .get(memberId)
      )
        throw Error('Prior task control needs attention.');
      const controlId = randomUUID();
      this.store.reserveControl(controlId, 'task.cancel', task);
      this.store.db
        .prepare('INSERT INTO subtree_reservations VALUES(?,?,?,?,0)')
        .run(operationId, memberId, member.attemptId, controlId);
      return this.save(saved.receipt, next);
    });
  }

  // Persist uncertainty BEFORE granting one delivery claim. A crash can lose that
  // delivery, so recovery must inspect authority; it must never grant another claim.
  claim(operationId, expectedVersion, memberId) {
    return this.transaction(() => {
      const saved = this.load(operationId);
      if (!saved || saved.receipt.version !== expectedVersion) throw Error('Stale operation.');
      this.current(saved.snapshot);
      if (saved.receipt.scopeGate) throw Error('C admission gate integration is unavailable.');
      const member = saved.receipt.members.find((item) => item.id === memberId);
      if (!member?.attemptId) throw Error('Local cancellation has no provider delivery.');
      this.task(member);
      const reservation = this.store.db
        .prepare(
          `SELECT r.*,c.state FROM subtree_reservations r
        JOIN task_controls c ON c.id=r.controlId AND c.taskId=r.taskId
        WHERE r.operationId=? AND r.taskId=?`
        )
        .get(operationId, memberId);
      if (
        !reservation ||
        reservation.claimed ||
        reservation.attemptId !== member.attemptId ||
        reservation.state !== 'pending'
      )
        throw Error('Delivery is quarantined or already claimed.');
      const next = advanceOperation(saved.receipt, {
        expectedVersion,
        memberId,
        event: 'uncertain'
      });
      this.store.db
        .prepare(
          `UPDATE subtree_reservations SET claimed=1
        WHERE operationId=? AND taskId=? AND claimed=0`
        )
        .run(operationId, memberId);
      return {
        controlId: reservation.controlId,
        attemptId: member.attemptId,
        receipt: this.save(saved.receipt, next)
      };
    });
  }

  reconcileAttempt(operationId, expectedVersion, memberId) {
    return this.transaction(() => {
      const saved = this.load(operationId);
      if (!saved) throw Error('Unknown operation.');
      const member = saved.receipt.members.find((item) => item.id === memberId);
      const proof = this.store.db
        .prepare(
          `SELECT a.id,a.status,t.recoveryCleared,c.state
        FROM subtree_reservations r JOIN task_controls c ON c.id=r.controlId AND c.taskId=r.taskId
        JOIN attempts a ON a.id=r.attemptId AND a.taskId=r.taskId
        JOIN tasks t ON t.id=r.taskId
        WHERE r.operationId=? AND r.taskId=? AND a.ordinal=
          (SELECT max(ordinal) FROM attempts WHERE taskId=r.taskId)`
        )
        .get(operationId, memberId);
      if (
        !member ||
        !proof ||
        proof.id !== member.attemptId ||
        proof.status !== 'interrupted' ||
        proof.state !== 'confirmed' ||
        !proof.recoveryCleared
      )
        throw Error('Matching authoritative interruption evidence is unavailable.');
      return this.save(
        saved.receipt,
        advanceOperation(saved.receipt, {
          expectedVersion,
          memberId,
          event: 'confirm',
          observation: { memberId, attemptId: proof.id, status: proof.status }
        })
      );
    });
  }
}
