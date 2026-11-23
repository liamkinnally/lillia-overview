import { createHash } from 'node:crypto';

const conflict = (message) => Object.assign(new Error(message), { status: 409 });

export function installProviderRecords(db) {
  db.exec(`
    CREATE TABLE goal_destinations (
      goalId TEXT PRIMARY KEY REFERENCES goals(id), workerProvider TEXT NOT NULL CHECK(workerProvider IN ('codex','claude'))
    );
    INSERT INTO goal_destinations SELECT id,'codex' FROM goals;
    CREATE TRIGGER goal_default_destination AFTER INSERT ON goals BEGIN
      INSERT INTO goal_destinations VALUES(NEW.id,'codex');
    END;
    ALTER TABLE goal_tasks ADD COLUMN provider TEXT NOT NULL DEFAULT 'codex' CHECK(provider IN ('codex','claude'));
    ALTER TABLE attempts ADD COLUMN nativeSessionId TEXT;
    ALTER TABLE attempts ADD COLUMN nativeMessageId TEXT;
    ALTER TABLE attempts ADD COLUMN nativeResultId TEXT;
    ALTER TABLE attempts ADD COLUMN executionId TEXT;
    CREATE TABLE claude_results (
      attemptId TEXT PRIMARY KEY REFERENCES attempts(id), accountInstance TEXT NOT NULL,
      digest TEXT NOT NULL, text TEXT NOT NULL
    );
    DROP TRIGGER bind_attempt_account;
    CREATE TRIGGER bind_attempt_account AFTER INSERT ON attempts BEGIN
      UPDATE attempts SET
        driver=(SELECT provider FROM goal_tasks WHERE taskId=NEW.taskId),
        accountRoute=CASE (SELECT provider FROM goal_tasks WHERE taskId=NEW.taskId) WHEN 'claude' THEN 'installed-claude' ELSE 'installed-chatgpt' END,
        accountInstance=(SELECT s.value FROM settings s JOIN goal_tasks g ON s.key=g.provider||'.accountInstance' WHERE g.taskId=NEW.taskId)
      WHERE id=NEW.id;
    END;
  `);
}

export function observeClaude(store, taskId, event) {
  const attempt = store.db
    .prepare(
      "SELECT * FROM attempts WHERE taskId=? AND driver='claude' ORDER BY ordinal DESC LIMIT 1"
    )
    .get(taskId);
  const binding = store.db
    .prepare("SELECT value FROM settings WHERE key='claude.accountInstance'")
    .get()?.value;
  if (
    !attempt ||
    !['starting', 'running', 'waiting_for_input', 'interrupting'].includes(attempt.status) ||
    !binding ||
    event.accountInstance !== binding ||
    attempt.accountInstance !== binding
  ) {
    throw conflict('Claude result has no matching live attempt and account.');
  }
  for (const [column, key] of [
    ['nativeSessionId', 'sessionId'],
    ['executionId', 'runId'],
    ['nativeMessageId', 'messageId']
  ]) {
    const value = event[key];
    if (value == null && key === 'messageId') continue;
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 256 ||
      (attempt[column] && value !== attempt[column])
    ) {
      throw conflict('The native Claude execution identity changed or is incomplete.');
    }
  }
  const model = typeof event.model === 'string' && event.model.length <= 160 ? event.model : null;
  const requested = event.expectedModel ?? attempt.requestedModel;
  if (
    requested != null &&
    (typeof requested !== 'string' ||
      !requested.length ||
      requested.length > 160 ||
      (attempt.requestedModel && attempt.requestedModel !== requested))
  )
    throw conflict('The requested Claude model identity changed.');
  store.db
    .prepare(
      `UPDATE attempts SET nativeSessionId=?,executionId=?,nativeMessageId=coalesce(?,nativeMessageId),
    requestedModel=?,observedModel=coalesce(?,observedModel),modelRerouted=max(modelRerouted,?) WHERE id=?`
    )
    .run(
      event.sessionId,
      event.runId,
      event.messageId ?? null,
      requested,
      model,
      requested && model && requested !== model ? 1 : 0,
      attempt.id
    );
  store.coordination.delivered(taskId, attempt.id);
  return attempt;
}

export function finishClaude(store, taskId, event) {
  const attempt = observeClaude(store, taskId, event);
  const success = event.status === 'completed';
  if (
    (!success && event.status !== 'failed') ||
    (success && (typeof event.output !== 'string' || event.output.length > 200000))
  ) {
    throw conflict('No complete bounded Claude result is available.');
  }
  if (
    event.resultId != null &&
    (typeof event.resultId !== 'string' || !event.resultId || event.resultId.length > 256)
  ) {
    throw conflict('Invalid native result identity.');
  }
  let digest = null;
  if (success) {
    digest = createHash('sha256').update(event.output).digest('hex');
    store.db
      .prepare('INSERT INTO claude_results VALUES(?,?,?,?)')
      .run(attempt.id, event.accountInstance, digest, event.output);
  }
  store.db
    .prepare('UPDATE attempts SET nativeResultId=?,usage=? WHERE id=?')
    .run(
      event.resultId ?? null,
      event.usage == null ? null : JSON.stringify(event.usage),
      attempt.id
    );
  store.updateTask(taskId, {
    status: event.status,
    output: success ? event.output : '',
    error: success ? null : 'Claude reported a failed native result.',
    recoveryCleared: true
  });
  store.addEvent(taskId, 'task/' + event.status, { driver: 'claude', digest });
}
