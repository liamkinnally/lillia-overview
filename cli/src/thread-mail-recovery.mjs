import { THREAD_MAIL_SQL, ThreadMailSqliteStore } from './thread-mail-store.mjs';
import { verifyMailReceipt } from './thread-mail-effects.mjs';

// Storage integrity plus exact retained native proof for post-effect states.
// A structurally valid receipt string alone is never delivery proof.
export function verifyThreadMailStore(db) {
  const sql = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='thread_mail_operations'")
    .get()?.sql;
  const fail = () => {
    throw Object.assign(new Error('Mail restore schema or integrity mismatch.'), { status: 409 });
  };
  if (sql !== THREAD_MAIL_SQL) fail();
  const extra = db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE tbl_name='thread_mail_operations' AND type IN ('trigger','index') AND sql IS NOT NULL LIMIT 1"
    )
    .get();
  if (extra) fail();
  const checks = db.prepare('PRAGMA integrity_check(thread_mail_operations)').all();
  if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok') fail();
  const store = new ThreadMailSqliteStore(db);
  let operations = 0,
    uncertain = 0;
  for (const row of db.prepare('SELECT operationId FROM thread_mail_operations').iterate()) {
    const record = store.get(row.operationId);
    // Pending/uncertain states retain uncertainty. Confirmed states also need
    // the exact native request, prompt, task context and turn response binding.
    if (
      !['pending', 'uncertain'].includes(record.state) &&
      !verifyMailReceipt(db, record.envelope, record.attemptId, record.receipt, record.digest)
    )
      fail();
    operations++;
    if (record.state === 'uncertain') uncertain++;
  }
  return { operations, uncertain };
}
