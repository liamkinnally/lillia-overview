const wall = "CAST(round(unixepoch('subsec')*1000) AS INTEGER)";
const terminal = "('completed','failed','interrupted','blocked')";
export const defaultActiveSeconds = 86400;
export function validateActiveSeconds(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 604800)
    throw Object.assign(new Error('Select an active-time limit from 1 to 604,800 seconds.'), {
      status: 400
    });
  return value;
}
export function installTimeBudget(db) {
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='time_clock'").get())
    return;
  db.exec(`CREATE TABLE time_clock(slot INTEGER PRIMARY KEY CHECK(slot=1),highWaterMs INTEGER NOT NULL);
    INSERT INTO time_clock VALUES(1,${wall});
    CREATE TABLE time_budgets(goalId TEXT PRIMARY KEY REFERENCES goals(id),maxActiveSeconds INTEGER NOT NULL DEFAULT 86400 CHECK(maxActiveSeconds BETWEEN 1 AND 604800),
      elapsedUncertain INTEGER NOT NULL DEFAULT 0,warningRecorded INTEGER NOT NULL DEFAULT 0,exhaustionRecorded INTEGER NOT NULL DEFAULT 0);
    INSERT INTO time_budgets(goalId) SELECT id FROM goals;
    CREATE TRIGGER make_time_budget AFTER INSERT ON goals BEGIN INSERT INTO time_budgets(goalId) VALUES(NEW.id); END;
    CREATE TABLE timed_attempts(attemptId TEXT PRIMARY KEY REFERENCES attempts(id),goalId TEXT NOT NULL REFERENCES goals(id),
      startedMs INTEGER NOT NULL,closedMs INTEGER,interruptControl TEXT REFERENCES task_controls(id),CHECK(closedMs IS NULL OR closedMs>=startedMs));
    CREATE INDEX timed_by_goal ON timed_attempts(goalId);
    INSERT INTO timed_attempts(attemptId,goalId,startedMs,closedMs)
      SELECT a.id,g.goalId,round(unixepoch(a.startedAt,'subsec')*1000),
        CASE WHEN a.status IN ${terminal} OR (a.status='recovery_needed' AND t.recoveryCleared=1)
        THEN max(round(unixepoch(a.updatedAt,'subsec')*1000),round(unixepoch(a.startedAt,'subsec')*1000)) END
        FROM attempts a JOIN goal_tasks g ON g.taskId=a.taskId JOIN tasks t ON t.id=a.taskId;
    UPDATE time_clock SET highWaterMs=max(highWaterMs,coalesce((SELECT max(max(startedMs,coalesce(closedMs,0))) FROM timed_attempts),0));
    CREATE VIEW goal_time_usage AS
      SELECT b.goalId,b.maxActiveSeconds,b.elapsedUncertain,k.highWaterMs,
        (${wall}<k.highWaterMs) AS clockRollback,
        coalesce(sum(CASE WHEN a.attemptId IS NOT NULL THEN max(0,coalesce(a.closedMs,max(${wall},k.highWaterMs))-a.startedMs) END),0) AS activeMs,
        count(CASE WHEN a.attemptId IS NOT NULL AND a.closedMs IS NULL THEN 1 END) AS openAttempts
      FROM time_budgets b CROSS JOIN time_clock k LEFT JOIN timed_attempts a ON a.goalId=b.goalId GROUP BY b.goalId;
    CREATE TRIGGER enforce_time_budget BEFORE INSERT ON attempts
      WHEN NOT EXISTS(SELECT 1 FROM goal_tasks g JOIN goal_time_usage u ON u.goalId=g.goalId WHERE g.taskId=NEW.taskId
        AND u.clockRollback=0 AND u.elapsedUncertain=0 AND u.activeMs<u.maxActiveSeconds*1000)
      BEGIN SELECT RAISE(ABORT,'Goal active-time admission is closed.'); END;
    CREATE TRIGGER start_attempt_clock AFTER INSERT ON attempts BEGIN
      UPDATE time_clock SET highWaterMs=max(highWaterMs,${wall});
      INSERT INTO timed_attempts(attemptId,goalId,startedMs) SELECT NEW.id,goalId,${wall} FROM goal_tasks WHERE taskId=NEW.taskId;
    END;
    CREATE TRIGGER close_attempt_clock AFTER UPDATE OF status,recoveryCleared ON tasks
    WHEN NEW.status IN ${terminal} OR (NEW.status='recovery_needed' AND NEW.recoveryCleared=1)
    BEGIN
      UPDATE time_budgets SET elapsedUncertain=1 WHERE ${wall}<(SELECT highWaterMs FROM time_clock)
        AND goalId IN (SELECT r.goalId FROM timed_attempts r JOIN attempts a ON a.id=r.attemptId WHERE a.taskId=NEW.id AND r.closedMs IS NULL);
      UPDATE time_clock SET highWaterMs=max(highWaterMs,${wall});
      UPDATE timed_attempts SET closedMs=max(startedMs,(SELECT highWaterMs FROM time_clock))
        WHERE closedMs IS NULL AND attemptId IN (SELECT id FROM attempts WHERE taskId=NEW.id);
    END;`);
}
export function timeBudget(db, goalId) {
  const row = db.prepare('SELECT * FROM goal_time_usage WHERE goalId=?').get(goalId);
  if (!row)
    throw Object.assign(new Error('Goal active-time allowance is unavailable.'), { status: 409 });
  const uncertainAttempts = db
    .prepare(
      `SELECT count(*) AS n FROM timed_attempts r JOIN attempts a ON a.id=r.attemptId
    WHERE r.goalId=? AND r.closedMs IS NULL AND a.status='recovery_needed'`
    )
    .get(goalId).n;
  const limitMs = row.maxActiveSeconds * 1000;
  return {
    ...row,
    clockRollback: Boolean(row.clockRollback),
    elapsedUncertain: Boolean(row.elapsedUncertain),
    uncertainAttempts,
    warning: Boolean(row.elapsedUncertain || row.activeMs * 5 >= limitMs * 4),
    remainingMs: row.clockRollback || row.elapsedUncertain ? 0 : Math.max(0, limitMs - row.activeMs)
  };
}
export function observeTimeClock(db) {
  db.exec(`UPDATE time_budgets SET elapsedUncertain=1 WHERE elapsedUncertain=0 AND ${wall}<(SELECT highWaterMs FROM time_clock)
      AND goalId IN (SELECT goalId FROM timed_attempts WHERE closedMs IS NULL);
      UPDATE time_clock SET highWaterMs=${wall} WHERE highWaterMs<${wall} AND EXISTS(SELECT 1 FROM timed_attempts WHERE closedMs IS NULL);`);
}
export function reserveTimeInterruptions(store) {
  return store.transaction(() => {
    const db = store.db,
      actions = [];
    // A backwards wall clock leaves elapsed running time unmeasurable. Preserve that
    // fact across restarts and stop the affected authorizations conservatively.
    observeTimeClock(db);
    const rows = db
      .prepare(
        `SELECT u.*,b.warningRecorded,b.exhaustionRecorded FROM goal_time_usage u JOIN time_budgets b ON u.goalId=b.goalId
      WHERE (b.warningRecorded=0 AND (u.activeMs*5>=u.maxActiveSeconds*4000 OR u.elapsedUncertain=1)) OR
      ((u.activeMs>=u.maxActiveSeconds*1000 OR u.elapsedUncertain=1) AND (u.openAttempts>0 OR b.exhaustionRecorded=0))`
      )
      .all();
    for (const row of rows) {
      if (!row.warningRecorded) {
        db.prepare('UPDATE time_budgets SET warningRecorded=1 WHERE goalId=?').run(row.goalId);
        store.activity('time.warning', row.goalId);
      }
      if (!row.elapsedUncertain && row.activeMs < row.maxActiveSeconds * 1000) continue;
      if (!row.exhaustionRecorded) {
        db.prepare('UPDATE time_budgets SET exhaustionRecorded=1 WHERE goalId=?').run(row.goalId);
        store.activity('time.exhausted', row.goalId);
      }
      const open = db
        .prepare(
          `SELECT r.attemptId,a.taskId FROM timed_attempts r JOIN attempts a ON a.id=r.attemptId
        WHERE r.goalId=? AND r.closedMs IS NULL AND r.interruptControl IS NULL`
        )
        .all(row.goalId);
      for (const item of open) {
        const prior = db
          .prepare(
            "SELECT id FROM task_controls WHERE taskId=? AND kind='task.cancel' AND state IN ('pending','requested','sent','unconfirmed') ORDER BY rowid DESC LIMIT 1"
          )
          .get(item.taskId);
        const task = { ...store.getTask(item.taskId), goalId: row.goalId };
        // A durable reservation is accepted before the platform attempts delivery.
        // Existing requests are never sent again, including after an uncertain exit.
        const action =
          prior ?? store.reserveControl('active-time/' + item.attemptId, 'task.cancel', task);
        db.prepare('UPDATE timed_attempts SET interruptControl=? WHERE attemptId=?').run(
          action.id,
          item.attemptId
        );
        if (!prior) actions.push({ action, task });
      }
    }
    return actions;
  });
}
