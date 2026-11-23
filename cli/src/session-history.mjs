import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const maxExchanges = 6;
function conversation(project, accountBinding, fn) {
  if (typeof accountBinding !== 'string' || !accountBinding)
    throw Error('Connect your Codex account first.');
  const db = new DatabaseSync(join(project.stateDir, 'conversation.sqlite'));
  try {
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS exchanges
      (id INTEGER PRIMARY KEY, account TEXT NOT NULL, project TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL)`);
    return fn(db, accountBinding, project.workspaceRoot);
  } finally {
    db.close();
  }
}

export function readConversation(project, accountBinding) {
  return conversation(project, accountBinding, (db, account, root) =>
    db
      .prepare(
        'SELECT question,answer FROM exchanges WHERE account=? AND project=? ORDER BY id DESC LIMIT ?'
      )
      .all(account, root, maxExchanges)
      .reverse()
      .flatMap((row) => [
        { role: 'user', text: row.question },
        { role: 'assistant', text: row.answer }
      ])
  );
}
export function saveExchange(project, accountBinding, question, answer) {
  conversation(project, accountBinding, (db, account, root) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO exchanges(account,project,question,answer) VALUES(?,?,?,?)').run(
        account,
        root,
        question.slice(0, 3000),
        answer.slice(0, 3000)
      );
      db.prepare(
        'DELETE FROM exchanges WHERE account=? AND project=? AND id NOT IN (SELECT id FROM exchanges WHERE account=? AND project=? ORDER BY id DESC LIMIT ?)'
      ).run(account, root, account, root, maxExchanges);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}
