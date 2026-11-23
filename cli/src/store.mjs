import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const columns = new Set([
  'title',
  'prompt',
  'cwd',
  'model',
  'sandbox',
  'status',
  'threadId',
  'turnId',
  'dependsOn',
  'error',
  'output',
  'recoveryCleared'
]);
const decode = (row) =>
  row
    ? {
        ...row,
        dependsOn: JSON.parse(row.dependsOn),
        recoveryCleared: Boolean(row.recoveryCleared)
      }
    : null;

export class TaskStore {
  constructor(filename) {
    if (filename !== ':memory:')
      mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
        model TEXT, sandbox TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL, threadId TEXT, turnId TEXT, dependsOn TEXT NOT NULL,
        error TEXT, output TEXT NOT NULL DEFAULT '', recoveryCleared INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, type TEXT NOT NULL,
        payload TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_task ON events(taskId,id);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (
      !this.db
        .prepare('PRAGMA table_info(tasks)')
        .all()
        .some((column) => column.name === 'recoveryCleared')
    )
      this.db.exec('ALTER TABLE tasks ADD COLUMN recoveryCleared INTEGER NOT NULL DEFAULT 0');
  }
  createTask(input) {
    const now = new Date().toISOString();
    const task = {
      id: randomUUID(),
      title: input.title,
      prompt: input.prompt,
      cwd: input.cwd,
      model: input.model || null,
      sandbox: input.sandbox || 'read-only',
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      threadId: input.threadId || null,
      turnId: null,
      dependsOn: input.dependsOn || [],
      error: null,
      output: '',
      recoveryCleared: false
    };
    this.db
      .prepare(
        'INSERT INTO tasks (id,title,prompt,cwd,model,sandbox,status,createdAt,updatedAt,threadId,turnId,dependsOn,error,output,recoveryCleared) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        task.id,
        task.title,
        task.prompt,
        task.cwd,
        task.model,
        task.sandbox,
        task.status,
        now,
        now,
        task.threadId,
        null,
        JSON.stringify(task.dependsOn),
        null,
        '',
        0
      );
    return task;
  }
  getTask(id) {
    return decode(this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id));
  }
  listTasks() {
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY createdAt DESC, rowid DESC')
      .all()
      .map(decode);
  }
  queuedTasks() {
    return this.db
      .prepare("SELECT * FROM tasks WHERE status='queued' ORDER BY createdAt, rowid")
      .all()
      .map(decode);
  }
  reserveDispatch(task) {
    this.updateTask(task.id, { status: 'starting', error: null });
    return task;
  }
  updateTask(id, patch) {
    const entries = Object.entries(patch).filter(([key]) => columns.has(key));
    if (!entries.length) return this.getTask(id);
    const values = entries.map(([key, value]) =>
      key === 'dependsOn'
        ? JSON.stringify(value)
        : key === 'recoveryCleared'
          ? Number(Boolean(value))
          : value
    );
    this.db
      .prepare(
        `UPDATE tasks SET ${entries.map(([key]) => `${key}=?`).join(',')},updatedAt=? WHERE id=?`
      )
      .run(...values, new Date().toISOString(), id);
    return this.getTask(id);
  }
  addEvent(taskId, type, payload) {
    let json = JSON.stringify(payload ?? {});
    if (json.length > 65536)
      json = JSON.stringify({ truncated: true, preview: json.slice(0, 64000) });
    this.db
      .prepare('INSERT INTO events(taskId,type,payload,createdAt) VALUES(?,?,?,?)')
      .run(taskId, type, json, new Date().toISOString());
    this.db
      .prepare(
        'DELETE FROM events WHERE taskId=? AND id NOT IN (SELECT id FROM events WHERE taskId=? ORDER BY id DESC LIMIT 1000)'
      )
      .run(taskId, taskId);
  }
  events(taskId) {
    return this.db
      .prepare(
        'SELECT id,type,payload,createdAt FROM events WHERE taskId=? ORDER BY id DESC LIMIT 200'
      )
      .all(taskId)
      .reverse()
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  getPaused() {
    return this.db.prepare("SELECT value FROM settings WHERE key='paused'").get()?.value === 'true';
  }
  setPaused(paused) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES('paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(String(paused));
  }
  recoverActive() {
    this.db
      .prepare(
        `UPDATE tasks SET status=CASE WHEN threadId IS NULL THEN 'interrupted' ELSE 'recovery_needed' END,
      recoveryCleared=0,error=?,updatedAt=?
      WHERE status IN ('starting','running','waiting_for_input','interrupting')`
      )
      .run(
        'The controller stopped during this run. Inspect its effects before explicitly continuing.',
        new Date().toISOString()
      );
  }
  close() {
    this.db.close();
  }
}
