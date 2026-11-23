import { timeBudget } from './time-budget.mjs';

export function installAllowances(db) {
  db.exec(`
    CREATE TABLE goal_allowances (
      goalId TEXT PRIMARY KEY REFERENCES goals(id),
      attemptLimit INTEGER NOT NULL CHECK(attemptLimit > 0)
    );
    INSERT INTO goal_allowances SELECT id,256 FROM goals;
    CREATE TRIGGER default_allowance AFTER INSERT ON goals BEGIN
      INSERT INTO goal_allowances VALUES(NEW.id,256);
    END;
    CREATE VIEW goal_allowance_usage AS
      SELECT l.goalId,l.attemptLimit,count(a.id) AS attemptsUsed FROM goal_allowances l
      LEFT JOIN goal_tasks g ON g.goalId=l.goalId
      LEFT JOIN attempts a ON a.taskId=g.taskId GROUP BY l.goalId,l.attemptLimit;
    CREATE TRIGGER enforce_attempt_allowance BEFORE INSERT ON attempts
    WHEN EXISTS (
      SELECT 1 FROM goal_tasks g JOIN goal_allowance_usage u ON u.goalId=g.goalId
      JOIN goals ON goals.id=g.goalId
      WHERE g.taskId=NEW.taskId AND (u.attemptsUsed>=u.attemptLimit OR goals.state!='active')
    )
    BEGIN SELECT RAISE(ABORT,'Goal admission is closed'); END;
    CREATE TRIGGER report_attempt_allowance AFTER INSERT ON attempts BEGIN
      INSERT INTO activity(type,goalId,taskId,createdAt)
        SELECT CASE WHEN u.attemptsUsed=u.attemptLimit THEN 'allowance.exhausted' ELSE 'allowance.warning' END,
               u.goalId,NEW.taskId,NEW.startedAt
        FROM goal_tasks g JOIN goal_allowance_usage u ON u.goalId=g.goalId
        WHERE g.taskId=NEW.taskId AND (u.attemptsUsed=u.attemptLimit OR
          (u.attemptsUsed*5>=u.attemptLimit*4 AND (u.attemptsUsed-1)*5<u.attemptLimit*4));
    END;
    ALTER TABLE attempts ADD COLUMN observedModel TEXT;
    ALTER TABLE attempts ADD COLUMN modelRerouted INTEGER NOT NULL DEFAULT 0;
  `);
}

// Count the durable reservations, including uncertain and failed outcomes.
export function attemptAllowance(db, goalId) {
  const row = db
    .prepare('SELECT attemptLimit,attemptsUsed FROM goal_allowance_usage WHERE goalId=?')
    .get(goalId);
  const activeTime = timeBudget(db, goalId);
  return {
    ...row,
    activeTime,
    remainingAttempts: row.attemptLimit - row.attemptsUsed,
    warning: activeTime.warning || row.attemptsUsed * 5 >= row.attemptLimit * 4
  };
}
