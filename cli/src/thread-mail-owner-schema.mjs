export const mailOwnerTables = [
  'thread_mail_owner_authorizations',
  'thread_mail_owner_actions',
  'thread_mail_owner_previews'
];
export const mailOwnerSchema = [
  [
    'table',
    mailOwnerTables[2],
    `CREATE TABLE thread_mail_owner_previews (
  operationId TEXT PRIMARY KEY REFERENCES command_receipts(operationId) DEFERRABLE INITIALLY DEFERRED,
  record TEXT NOT NULL CHECK(json_valid(record))
)`
  ],
  [
    'table',
    mailOwnerTables[0],
    `CREATE TABLE thread_mail_owner_authorizations (
  operationId TEXT PRIMARY KEY REFERENCES thread_mail_operations(operationId) DEFERRABLE INITIALLY DEFERRED,
  record TEXT NOT NULL CHECK(json_valid(record))
)`
  ],
  [
    'table',
    mailOwnerTables[1],
    `CREATE TABLE thread_mail_owner_actions (
  operationId TEXT PRIMARY KEY REFERENCES command_receipts(operationId) DEFERRABLE INITIALLY DEFERRED,
  name TEXT NOT NULL CHECK(name IN ('chat.mail.send','chat.mail.acknowledge','chat.mail.resolve')),
  input TEXT NOT NULL CHECK(json_valid(input)),
  result TEXT NOT NULL CHECK(json_valid(result))
)`
  ]
];
for (const table of mailOwnerTables)
  for (const event of ['UPDATE', 'DELETE']) {
    const name = table + '_no_' + event.toLowerCase();
    mailOwnerSchema.push([
      'trigger',
      name,
      `CREATE TRIGGER ${name} BEFORE ${event} ON ${table}
BEGIN SELECT RAISE(ABORT,'immutable owner mail authority'); END`
    ]);
  }
export function installMailOwner(db) {
  if (!db.isTransaction) throw Error('Owner mail schema requires the migration transaction.');
  for (const [, , sql] of mailOwnerSchema) db.exec(sql);
}
