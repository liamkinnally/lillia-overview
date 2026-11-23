import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { safePath } from './project-workspace-scope.mjs';

const fileActions = new Map([
  ['read_file', 'Read'],
  ['write_file', 'Edited'],
  ['replace_text', 'Edited'],
  ['delete_file', 'Deleted']
]);
const otherActions = new Map([
  ['list_files', 'Listed files'],
  ['search', 'Searched project files'],
  ['changed_files', 'Inspected changed files']
]);
const checkActions = new Map([
  ['passed', 'Checks passed'],
  ['failed', 'Checks failed'],
  ['unavailable', 'Checks unavailable']
]);
function action(row) {
  if (row.denied) return 'Tool request denied';
  if (row.tool === 'run_check') return checkActions.get(row.outcome) ?? 'Ran checks';
  if (fileActions.has(row.tool)) {
    let path = 'a file';
    if (typeof row.path === 'string' && row.path.length <= 512 && !/\p{C}/u.test(row.path)) {
      try {
        path = safePath(row.path);
      } catch {
        // A receipt with an unsafe display path still advances the session cursor.
      }
    }
    return fileActions.get(row.tool) + ' ' + path;
  }
  return otherActions.get(row.tool) ?? 'Used a project tool';
}

export function readSessionActivity({ stateDir }, { goal, projectChange }, after = 0) {
  if (
    !goal?.id ||
    projectChange?.goalId !== goal.id ||
    !projectChange.operationId ||
    !projectChange.authorTaskId ||
    !Number.isSafeInteger(after) ||
    after < 0
  )
    return [];
  const db = new DatabaseSync(join(stateDir, 'data', 'platform.sqlite'), { readOnly: true });
  try {
    db.exec('BEGIN');
    const bound = db
      .prepare('SELECT 1 FROM project_changes WHERE goalId=? AND operationId=? AND authorTaskId=?')
      .get(goal.id, projectChange.operationId, projectChange.authorTaskId);
    if (!bound) return [];
    const page = db.prepare(`SELECT p.rowid AS cursor,p.role,p.tool,p.denied,
        CASE WHEN p.denied=0 AND p.tool IN ('read_file','write_file','replace_text','delete_file')
          THEN json_extract(p.args,'$.path') END AS path,
        CASE WHEN p.denied=0 AND p.tool='run_check' THEN json_extract(p.text,'$.outcome') END AS outcome
      FROM project_tool_operations p WHERE p.rowid>? AND p.goalId=? AND (
        (p.role='author' AND p.taskId=?) OR
        (p.role='reviewer' AND p.taskId=? AND p.taskId=(SELECT reviewerTaskId FROM project_changes WHERE goalId=?)))
      ORDER BY p.rowid LIMIT 64`);
    const events = [];
    let cursor = after;
    for (;;) {
      const rows = page.all(
        cursor,
        goal.id,
        projectChange.authorTaskId,
        projectChange.reviewerTaskId ?? null,
        goal.id
      );
      for (const row of rows) {
        const role = row.role === 'author' ? 'Author' : 'Reviewer';
        events.push({ cursor: row.cursor, label: role + ' · ' + action(row) });
      }
      if (rows.length < 64) return events;
      cursor = rows.at(-1).cursor;
    }
  } finally {
    db.close();
  }
}
