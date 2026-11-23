import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readSessionActivity } from '../src/session-activity.mjs';

test('activity pages stay bound to the saved operation, goal and role tasks', (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'session-activity-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  mkdirSync(join(stateDir, 'data'));
  const db = new DatabaseSync(join(stateDir, 'data', 'platform.sqlite'));
  db.exec(`CREATE TABLE project_changes(goalId TEXT PRIMARY KEY, operationId TEXT, authorTaskId TEXT, reviewerTaskId TEXT);
    INSERT INTO project_changes VALUES ('g','op','a','r');
    CREATE TABLE project_tool_operations(goalId TEXT, taskId TEXT, role TEXT, tool TEXT, args TEXT, text TEXT, denied INTEGER)`);
  const insert = db.prepare('INSERT INTO project_tool_operations VALUES(?,?,?,?,?,?,?)');
  const args = JSON.stringify({ path: 'range.mjs', text: 'secret', query: 'secret' });
  insert.run('g', 'a', 'author', 'write_file', args, '{}', 0);
  insert.run('other', 'a', 'author', 'write_file', args, '{}', 0);
  insert.run('g', 'a', 'reviewer', 'read_file', args, '{}', 0);
  insert.run('g', 'r', 'reviewer', 'read_file', '{"path":"hidden"}', '{}', 1);
  for (let i = 0; i < 135; i++) insert.run('g', 'r', 'reviewer', 'search', args, '{}', 0);
  insert.run('g', 'r', 'reviewer', 'run_check', '{}', '{"outcome":"passed","detail":"secret"}', 0);
  db.close();
  const project = { stateDir };
  const view = {
    goal: { id: 'g' },
    projectChange: { goalId: 'g', operationId: 'op', authorTaskId: 'a', reviewerTaskId: 'r' }
  };
  const events = readSessionActivity(project, view);
  assert.equal(events.length, 138);
  assert.deepEqual(events[0], { cursor: 1, label: 'Author · Edited range.mjs' });
  assert.deepEqual(events.at(-1), { cursor: 140, label: 'Reviewer · Checks passed' });
  assert.doesNotMatch(JSON.stringify(events), /secret|hidden/);
  assert.deepEqual(readSessionActivity(project, view, 137), events.slice(-3));
  view.projectChange.operationId = 'other';
  assert.deepEqual(readSessionActivity(project, view), []);
});
