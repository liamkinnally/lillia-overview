import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

function journal(stateDir) {
  const db = new DatabaseSync(join(stateDir, 'requests.sqlite'));
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS requests (
      seq INTEGER PRIMARY KEY, op TEXT NOT NULL UNIQUE, objective TEXT NOT NULL,
      repository TEXT NOT NULL, attempts INTEGER NOT NULL, seconds INTEGER NOT NULL,
      goal TEXT, declined INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS retries (op TEXT PRIMARY KEY)
  `);
  return db;
}

const latest = 'SELECT * FROM requests WHERE declined = 0 ORDER BY seq DESC LIMIT 1';
function reserve(db, config, objective) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare(latest).get();
    if (previous && !previous.goal && previous.objective !== objective)
      throw Error(
        'The last request is unconfirmed. Repeat its exact objective before starting another.'
      );
    let row = db
      .prepare('SELECT * FROM requests WHERE declined=0 AND objective=? ORDER BY seq DESC LIMIT 1')
      .get(objective);
    if (row && !row.goal) db.prepare('INSERT OR IGNORE INTO retries(op) VALUES (?)').run(row.op);
    if (!row) {
      row = db
        .prepare(
          `INSERT INTO requests(op,objective,repository,attempts,seconds)
        VALUES (?,?,?,?,?) RETURNING *`
        )
        .get(
          randomUUID(),
          objective,
          config.repository,
          config.maxAttempts,
          config.maxActiveSeconds
        );
    }
    db.exec('COMMIT');
    return row;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const stalePreparation =
  'The current source changed after preparation. Inspect it and use a new operation ID.';

async function requestAdmission(db, command, row) {
  try {
    return await command([
      'project',
      'start',
      row.repository,
      '--max-attempts',
      String(row.attempts),
      '--max-active-seconds',
      String(row.seconds),
      '--operation-id',
      row.op,
      '--',
      row.objective
    ]);
  } catch (error) {
    if (error.exitCode !== 3 || error.message !== stalePreparation) {
      if ([2, 3].includes(error.exitCode))
        db.prepare(
          'UPDATE requests SET declined=1 WHERE op=? AND goal IS NULL AND op NOT IN (SELECT op FROM retries)'
        ).run(row.op);
      throw error;
    }
  }

  // The old enrollment can no longer admit work against this generation. A concurrent
  // caller could already have admitted it, so check the public operation before releasing it.
  try {
    return (await command(['operation', 'show', row.op])).receipt;
  } catch (error) {
    // The owner CLI maps every 4xx except conflicts to exit 2. Only this specific 404 proves absence.
    if (error.exitCode !== 2 || error.message !== 'Operation not found.') throw error;
    const released = db
      .prepare('UPDATE requests SET declined=1 WHERE op=? AND goal IS NULL')
      .run(row.op);
    if (!released.changes)
      throw Error('The request changed during recovery. Repeat the same objective.');
    throw Error(
      'The project source changed before this request started. No goal was admitted. Run the issue again to use the current source, or enter another issue.'
    );
  }
}

export async function admitIssue({ stateDir, config, command }, objective) {
  if (!objective?.trim() || Buffer.byteLength(objective) > 4000)
    throw Error('Enter an issue of 1 to 4,000 UTF-8 bytes.');
  const db = journal(stateDir);
  try {
    // Persist the exact request before contacting the service; a crash can occur after admission.
    const row = reserve(db, config, objective);
    let goalId = row.goal;
    if (!goalId) {
      const receipt = await requestAdmission(db, command, row);
      if (
        receipt?.operationId !== row.op ||
        !receipt.goal?.id ||
        receipt.projectChange?.goalId !== receipt.goal.id ||
        receipt.projectChange.operationId !== row.op ||
        receipt.projectChange.input?.repository !== row.repository ||
        receipt.projectChange.input?.objective !== row.objective ||
        receipt.projectChange.input.maxAttempts !== row.attempts ||
        receipt.projectChange.input.maxActiveSeconds !== row.seconds
      )
        throw Error('Could not confirm this admission receipt. Repeat the same objective.');
      goalId = receipt.goal.id;
      db.prepare('UPDATE requests SET goal=?,declined=0 WHERE op=?').run(goalId, row.op);
    }
    return goalId;
  } finally {
    db.close();
  }
}

export async function runIssue(context, objective) {
  const goalId = await admitIssue(context, objective);
  return 'Goal ' + goalId + '\nCheck it with lillia progress ' + goalId + '.';
}

export async function inspectIssue({ stateDir, config, command }, goalId) {
  const db = journal(stateDir);
  let row;
  try {
    row = goalId
      ? db.prepare('SELECT * FROM requests WHERE declined=0 AND goal=?').get(goalId)
      : db.prepare(latest).get();
    if (!row)
      throw Error(
        goalId
          ? 'This goal is not a saved request in this project.'
          : 'No task yet. Use lillia run "your issue".'
      );
    if (!row.goal)
      throw Error(
        'The last request is unconfirmed. Repeat lillia run with the same objective: ' +
          row.objective
      );
    goalId = row.goal;
  } finally {
    db.close();
  }
  const result = await command(['goal', 'show', goalId]);
  if (
    result?.goal?.id !== goalId ||
    result.projectChange?.goalId !== goalId ||
    result.projectChange.input?.repository !== config.repository ||
    result.projectChange.operationId !== row.op ||
    result.projectChange.input?.objective !== row.objective
  )
    throw Error('That goal does not match the configured project.');
  return result;
}

export function progressText({ goal, projectChange, blocker }) {
  const lines = [
    goal.objective,
    'Goal ' + goal.id,
    'State: ' + goal.state + ' (' + projectChange.stage + ')'
  ];
  const detail = blocker?.reason || projectChange.reviewerFinal?.note || projectChange.detail;
  if (typeof detail === 'string' && detail) lines.push(detail);
  if (goal.state === 'completed')
    lines.push('Get the reviewed change with lillia result ' + goal.id + '.');
  return stripVTControlCharacters(lines.join('\n'));
}
