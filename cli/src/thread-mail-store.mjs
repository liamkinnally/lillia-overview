import { createHash } from 'node:crypto';
import { createEnvelope } from './thread-mail.mjs';

export const THREAD_MAIL_SQL = `CREATE TABLE thread_mail_operations (
  operationId TEXT PRIMARY KEY NOT NULL,
  envelope TEXT NOT NULL,
  digest TEXT NOT NULL CHECK(length(digest)=64),
  state TEXT NOT NULL CHECK(state IN ('pending','uncertain','delivered','acknowledged','resolved')),
  attemptId TEXT UNIQUE,
  receipt TEXT UNIQUE,
  resolution TEXT,
  CHECK((state='pending' AND attemptId IS NULL AND receipt IS NULL AND resolution IS NULL)
    OR (state='uncertain' AND attemptId IS NOT NULL AND length(attemptId)>0 AND receipt IS NULL AND resolution IS NULL)
    OR (state IN ('delivered','acknowledged') AND attemptId IS NOT NULL AND length(attemptId)>0 AND receipt IS NOT NULL AND length(receipt)>0 AND resolution IS NULL)
    OR (state='resolved' AND attemptId IS NOT NULL AND length(attemptId)>0 AND receipt IS NOT NULL AND length(receipt)>0 AND resolution IS NOT NULL AND length(resolution)>0))
)`;

// Explicit installer only. The shared migration owns serial schema registration;
// this module never changes the global schema version.
export function installThreadMailStore(db) {
  db.exec(THREAD_MAIL_SQL);
}
function fail(message) {
  throw Object.assign(new Error(message), { status: 409 });
}
function canonical(id, row) {
  let envelope;
  try {
    envelope = createEnvelope(row.envelope);
  } catch {
    fail('Mail storage integrity mismatch.');
  }
  const bytes = JSON.stringify(envelope);
  if (
    id !== envelope.operationId ||
    createHash('sha256').update(bytes).digest('hex') !== row.digest
  )
    fail('Mail storage integrity mismatch.');
  return { ...row, envelope };
}

// Persistence only. Owner authorization, source reads and native submission proof
// are checked by the owner and delivery adapters in the same transaction.
export class ThreadMailSqliteStore {
  constructor(db) {
    this.db = db;
  }
  transaction(fn) {
    const nested = this.db.isTransaction;
    this.db.exec(nested ? 'SAVEPOINT thread_mail_write' : 'BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (result && typeof result.then === 'function')
        fail('Mail transactions must be synchronous.');
      this.db.exec(nested ? 'RELEASE thread_mail_write' : 'COMMIT');
      return result;
    } catch (error) {
      if (nested) this.db.exec('ROLLBACK TO thread_mail_write; RELEASE thread_mail_write');
      else this.db.exec('ROLLBACK');
      throw error;
    }
  }
  get(id) {
    const stored = this.db
      .prepare('SELECT * FROM thread_mail_operations WHERE operationId=?')
      .get(id);
    if (!stored) return undefined;
    let envelope;
    try {
      envelope = JSON.parse(stored.envelope);
    } catch {
      fail('Mail storage integrity mismatch.');
    }
    const { operationId, ...row } = stored;
    return canonical(operationId, { ...row, envelope });
  }
  insert(id, row) {
    if (!this.db.isTransaction) fail('Mail insert requires a transaction.');
    const value = canonical(id, row);
    if (value.state !== 'pending') fail('Mail insert requires pending state.');
    this.db
      .prepare(
        `INSERT INTO thread_mail_operations
      (operationId,envelope,digest,state,attemptId,receipt,resolution) VALUES(?,?,?,?,?,?,?)`
      )
      .run(
        id,
        JSON.stringify(value.envelope),
        value.digest,
        value.state,
        value.attemptId,
        value.receipt,
        value.resolution
      );
  }
  replace(id, row) {
    if (!this.db.isTransaction) fail('Mail update requires a transaction.');
    const value = canonical(id, row),
      previous = this.get(id);
    if (
      !previous ||
      previous.digest !== value.digest ||
      JSON.stringify(previous.envelope) !== JSON.stringify(value.envelope)
    )
      fail('Immutable mail operation changed.');
    const next = {
      pending: 'uncertain',
      uncertain: 'delivered',
      delivered: 'acknowledged',
      acknowledged: 'resolved'
    };
    if (value.state === previous.state) {
      for (const key of ['attemptId', 'receipt', 'resolution'])
        if (value[key] !== previous[key]) fail('Invalid mail transition.');
      return;
    }
    if (
      next[previous.state] !== value.state ||
      (previous.attemptId !== null && previous.attemptId !== value.attemptId) ||
      (previous.receipt !== null && previous.receipt !== value.receipt) ||
      (previous.resolution !== null && previous.resolution !== value.resolution)
    )
      fail('Invalid mail transition.');
    this.db
      .prepare(
        `UPDATE thread_mail_operations SET state=?,attemptId=?,receipt=?,resolution=?
      WHERE operationId=?`
      )
      .run(value.state, value.attemptId, value.receipt, value.resolution, id);
  }
}
