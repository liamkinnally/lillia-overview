import { createHash } from 'node:crypto';
import { readBranchThread } from './project-chat-branch-threads.mjs';

const threadTable = `CREATE TABLE project_chat_threads (
  id TEXT NOT NULL PRIMARY KEY,
  title TEXT NOT NULL
)`;
const mappingTable = `CREATE TABLE project_chat_turn_threads (
  turnId INTEGER PRIMARY KEY REFERENCES project_chat_turns(id) ON DELETE CASCADE,
  threadId TEXT NOT NULL REFERENCES project_chat_threads(id)
)`;
const creationTable = `CREATE TABLE project_chat_thread_creations (
  threadId TEXT PRIMARY KEY REFERENCES project_chat_threads(id),
  operationId TEXT NOT NULL UNIQUE REFERENCES command_receipts(operationId) DEFERRABLE INITIALLY DEFERRED
)`;
const assignRoot = `CREATE TRIGGER project_chat_turn_assign_root
AFTER INSERT ON project_chat_turns
BEGIN
  INSERT INTO project_chat_turn_threads (turnId,threadId) VALUES (NEW.id,'root');
END`;
const protectRoot = `CREATE TRIGGER project_chat_root_no_delete
BEFORE DELETE ON project_chat_threads WHEN OLD.id='root'
BEGIN
  SELECT RAISE(ABORT,'cannot delete the root thread');
END`;

export function upgradeProjectChatThreads(db) {
  db.exec(`
    CREATE TEMP TABLE retained_chat_mappings AS SELECT turnId,threadId FROM project_chat_turn_threads;
    DROP TRIGGER project_chat_turn_assign_root;
    DROP TRIGGER project_chat_root_no_delete;
    DROP TABLE project_chat_turn_threads;
    DROP TABLE project_chat_threads;
    ${threadTable};
    INSERT INTO project_chat_threads(id,title) VALUES ('root','Orchestrator');
    ${mappingTable};
    INSERT INTO project_chat_turn_threads SELECT turnId,threadId FROM retained_chat_mappings;
    DROP TABLE retained_chat_mappings;
    ${creationTable};
    ${assignRoot};
    ${protectRoot};
  `);
}

export function verifyUpgradedProjectChatThreads(db) {
  const invalid = () => {
    throw Object.assign(new Error('Project conversation thread mapping is invalid.'), {
      status: 409
    });
  };
  const object = db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?');
  for (const [type, name, expected] of [
    ['table', 'project_chat_threads', threadTable],
    ['table', 'project_chat_turn_threads', mappingTable],
    ['table', 'project_chat_thread_creations', creationTable],
    ['trigger', 'project_chat_turn_assign_root', assignRoot],
    ['trigger', 'project_chat_root_no_delete', protectRoot]
  ]) {
    if (object.get(type, name)?.sql !== expected) invalid();
  }
  if (
    !db.prepare("SELECT 1 FROM project_chat_threads WHERE id='root' AND title='Orchestrator'").get()
  )
    invalid();
  if (
    db
      .prepare(
        `SELECT 1 FROM project_chat_turns t LEFT JOIN project_chat_turn_threads m ON m.turnId=t.id
    LEFT JOIN project_chat_threads p ON p.id=m.threadId WHERE m.turnId IS NULL OR p.id IS NULL LIMIT 1`
      )
      .get()
  )
    invalid();
  if (
    db
      .prepare(
        `SELECT 1 FROM project_chat_turn_threads m LEFT JOIN project_chat_turns t ON t.id=m.turnId
    WHERE t.id IS NULL LIMIT 1`
      )
      .get()
  )
    invalid();
  for (const row of db
    .prepare(
      `SELECT t.id,t.title,c.operationId,r.digest,r.receipt
    FROM project_chat_threads t LEFT JOIN project_chat_thread_creations c ON c.threadId=t.id
    LEFT JOIN command_receipts r ON r.operationId=c.operationId WHERE t.id!='root'`
    )
    .iterate()) {
    const branchTable = db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='project_chat_branch_threads'"
      )
      .get();
    const branch =
      branchTable &&
      db.prepare('SELECT 1 FROM project_chat_branch_threads WHERE threadId=?').get(row.id);
    if (branch) {
      if (row.operationId) invalid();
      readBranchThread(db, row.id);
      continue;
    }
    let receipt;
    try {
      receipt = JSON.parse(row.receipt);
    } catch {
      invalid();
    }
    const digest = createHash('sha256')
      .update(JSON.stringify(['chat.thread.create', { title: row.title }]))
      .digest('hex');
    if (
      !row.operationId ||
      row.digest !== digest ||
      receipt.operationId !== row.operationId ||
      receipt.thread?.id !== row.id ||
      receipt.thread?.title !== row.title
    )
      invalid();
  }
  if (
    db
      .prepare(
        `SELECT 1 FROM project_chat_thread_creations c LEFT JOIN project_chat_threads t ON t.id=c.threadId
    WHERE t.id IS NULL OR c.threadId='root' LIMIT 1`
      )
      .get()
  )
    invalid();
}
