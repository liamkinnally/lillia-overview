// Version 47 records the existing conversation's identity without changing
// receipt or turn bytes. Multi-thread writers are not enabled by this schema.
export const projectChatThreadTables = ['project_chat_threads', 'project_chat_turn_threads'];

const rootTable = `CREATE TABLE project_chat_threads (
  id TEXT NOT NULL PRIMARY KEY CHECK (id='root'),
  title TEXT NOT NULL CHECK (title='Orchestrator')
)`;
const mappingTable = `CREATE TABLE project_chat_turn_threads (
  turnId INTEGER PRIMARY KEY REFERENCES project_chat_turns(id) ON DELETE CASCADE,
  threadId TEXT NOT NULL REFERENCES project_chat_threads(id) CHECK (threadId='root')
)`;

const assignRoot = `CREATE TRIGGER project_chat_turn_assign_root
AFTER INSERT ON project_chat_turns
BEGIN
  INSERT INTO project_chat_turn_threads (turnId,threadId) VALUES (NEW.id,'root');
END`;

const protectRoot = `CREATE TRIGGER project_chat_root_no_delete
BEFORE DELETE ON project_chat_threads
BEGIN
  SELECT RAISE(ABORT,'cannot delete the root thread');
END`;

export function installProjectChatThreads(db) {
  db.exec(`
    ${rootTable};
    INSERT INTO project_chat_threads(id,title) VALUES ('root','Orchestrator');
    ${protectRoot};
    ${mappingTable};
    INSERT INTO project_chat_turn_threads(turnId,threadId) SELECT id,'root' FROM project_chat_turns;
    ${assignRoot};
  `);
}

export function verifyProjectChatThreads(db) {
  const invalid = () => {
    throw Object.assign(new Error('Project conversation thread mapping is invalid.'), {
      status: 409
    });
  };
  const names = new Set(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
      .all()
      .map((row) => row.name)
  );
  if (!projectChatThreadTables.every((name) => names.has(name))) invalid();
  const tableSql = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?");
  if (
    tableSql.get('project_chat_threads')?.sql !== rootTable ||
    tableSql.get('project_chat_turn_threads')?.sql !== mappingTable
  )
    invalid();
  const roots = db.prepare('SELECT id,title FROM project_chat_threads').all();
  if (roots.length !== 1 || roots[0].id !== 'root' || roots[0].title !== 'Orchestrator') invalid();
  const trigger = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='project_chat_turn_assign_root'"
    )
    .get();
  if (trigger?.sql !== assignRoot) invalid();
  const guard = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='project_chat_root_no_delete'"
    )
    .get();
  if (guard?.sql !== protectRoot) invalid();
  if (
    db
      .prepare(
        `SELECT 1 FROM project_chat_turns t LEFT JOIN project_chat_turn_threads m ON m.turnId=t.id
    WHERE m.turnId IS NULL OR m.threadId IS NOT 'root' LIMIT 1`
      )
      .get()
  )
    invalid();
  if (
    db
      .prepare(
        `SELECT 1 FROM project_chat_turn_threads m LEFT JOIN project_chat_turns t ON t.id=m.turnId
    WHERE t.id IS NULL OR m.threadId IS NOT 'root' LIMIT 1`
      )
      .get()
  )
    invalid();
  if (
    db
      .prepare('SELECT 1 FROM project_chat_turn_threads GROUP BY turnId HAVING count(*)!=1 LIMIT 1')
      .get()
  )
    invalid();
}
