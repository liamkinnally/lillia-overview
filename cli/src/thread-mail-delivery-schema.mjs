export const mailDeliverySchema = [];
const table = (name, body) =>
  mailDeliverySchema.push(['table', name, `CREATE TABLE ${name} (${body}\n)`]);
table(
  'thread_mail_reply_requests',
  `
  operationId TEXT PRIMARY KEY REFERENCES thread_mail_owner_authorizations(operationId),
  turnId INTEGER NOT NULL REFERENCES project_chat_turns(id),
  replyOperationId TEXT NOT NULL REFERENCES command_receipts(operationId) DEFERRABLE INITIALLY DEFERRED`
);
table(
  'thread_mail_turn_selections',
  `
  operationId TEXT PRIMARY KEY REFERENCES thread_mail_owner_authorizations(operationId),
  turnId INTEGER NOT NULL REFERENCES project_chat_turns(id),
  record TEXT NOT NULL CHECK(json_valid(record))`
);
table(
  'thread_mail_effects',
  `
  operationId TEXT PRIMARY KEY REFERENCES thread_mail_turn_selections(operationId),
  effectId TEXT NOT NULL UNIQUE,
  taskId TEXT NOT NULL REFERENCES goal_tasks(taskId),
  attemptId TEXT NOT NULL REFERENCES attempts(id),
  turnId INTEGER NOT NULL REFERENCES project_chat_turns(id),
  promptDigest TEXT NOT NULL,
  contextDigest TEXT NOT NULL,
  accountInstance TEXT NOT NULL,
  accountBinding TEXT NOT NULL`
);
table(
  'thread_mail_native_requests',
  `
  attemptId TEXT PRIMARY KEY REFERENCES attempts(id),
  taskId TEXT NOT NULL REFERENCES goal_tasks(taskId),
  nativeThreadId TEXT NOT NULL CHECK(length(nativeThreadId) BETWEEN 1 AND 256),
  inputDigest TEXT NOT NULL,
  contextDigest TEXT NOT NULL,
  accountInstance TEXT NOT NULL,
  accountBinding TEXT NOT NULL`
);
table(
  'thread_mail_native_confirmations',
  `
  attemptId TEXT PRIMARY KEY REFERENCES thread_mail_native_requests(attemptId),
  nativeThreadId TEXT NOT NULL CHECK(length(nativeThreadId) BETWEEN 1 AND 256),
  nativeTurnId TEXT NOT NULL CHECK(length(nativeTurnId) BETWEEN 1 AND 256),
  record TEXT NOT NULL CHECK(json_valid(record)),
  UNIQUE(nativeThreadId,nativeTurnId)`
);
for (const [, table] of [...mailDeliverySchema])
  for (const event of ['UPDATE', 'DELETE']) {
    const name = table + '_no_' + event.toLowerCase();
    mailDeliverySchema.push([
      'trigger',
      name,
      `CREATE TRIGGER ${name} BEFORE ${event} ON ${table}
BEGIN SELECT RAISE(ABORT,'immutable thread mail effect binding'); END`
    ]);
  }
export const mailDeliveryTables = mailDeliverySchema
  .filter((x) => x[0] === 'table')
  .map((x) => x[1]);
export function installMailDelivery(db) {
  if (!db.isTransaction) throw Error('Mail delivery schema requires the migration transaction.');
  for (const [, , sql] of mailDeliverySchema) db.exec(sql);
}
