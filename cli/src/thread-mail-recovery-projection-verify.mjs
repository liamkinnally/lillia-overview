import { recoveryConflict } from './recovery-format.mjs';
import { createHash } from 'node:crypto';
import { chatProject } from './project-chat-origins.mjs';
import { threadMailAuthoritySchema as objects } from './thread-mail-authority.mjs';
import { mailOwnerSchema } from './thread-mail-owner-schema.mjs';
import { mailDeliverySchema } from './thread-mail-delivery-schema.mjs';
import {
  mailPrivateLeaves,
  privateBindingKeys,
  projectionProfile
} from './thread-mail-recovery-projection.mjs';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail() {
  throw recoveryConflict('Projected mail authority or descriptor differs.');
}
function readProjectedAuthority(db, threadId, descriptor) {
  const row = db
    .prepare(
      'SELECT a.*,i.snapshot AS current FROM thread_mail_authority a JOIN thread_mail_authority_inputs i ON i.threadId=a.threadId WHERE a.threadId=?'
    )
    .get(threadId);
  if (!row) fail();
  const current = JSON.parse(row.current);
  for (const [key, value] of descriptor.currentAccounts)
    if (key.startsWith('codex.') || threadId === 'root') current[2].push([key, value]);
  current[2].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (row.projectId !== chatProject(db).projectId || row.snapshot !== JSON.stringify(current))
    fail();
  const last = db
    .prepare('SELECT snapshot FROM thread_mail_authority_events WHERE threadId=? AND version=?')
    .get(threadId, row.version);
  if (!last || last.snapshot !== row.snapshot) fail();
  return { projectId: row.projectId, version: row.version };
}
export function verifyMailRecoveryProjection(db, descriptor) {
  if (
    !descriptor ||
    Object.keys(descriptor).sort().join(',') !==
      'currentAccounts,labels,locations,profile,schemaDigest,sourceSchema' ||
    descriptor.profile !== projectionProfile ||
    descriptor.sourceSchema !== 58 ||
    !Array.isArray(descriptor.labels) ||
    !Array.isArray(descriptor.currentAccounts) ||
    !Array.isArray(descriptor.locations)
  )
    fail();
  const labels = new Set(descriptor.labels),
    used = new Set(),
    locations = [];
  if (
    labels.size !== descriptor.labels.length ||
    descriptor.labels.some((s, i) => s !== 'mail-private:' + (i + 1))
  )
    fail();
  function reference(value) {
    if (value === null || value === '') return;
    if (!labels.has(value)) fail();
    used.add(value);
  }
  const ownerActions = new Set(
    db
      .prepare('SELECT operationId FROM thread_mail_owner_actions')
      .all()
      .map((r) => r.operationId)
  );
  const keys = new Set();
  for (const pair of descriptor.currentAccounts) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !privateBindingKeys.includes(pair[0]) ||
      keys.has(pair[0])
    )
      fail();
    keys.add(pair[0]);
    reference(pair[1]);
  }
  if (
    db
      .prepare(
        "SELECT 1 FROM settings WHERE key IN ('codex.accountBinding','claude.accountBinding')"
      )
      .get()
  )
    fail();
  for (const table of [
    'thread_mail_authority',
    'thread_mail_authority_events',
    'thread_mail_owner_authorizations',
    'thread_mail_owner_actions',
    'command_receipts',
    'thread_mail_effects',
    'thread_mail_native_requests',
    'thread_mail_native_confirmations'
  ])
    for (const row of db
      .prepare('SELECT rowid AS __projectionRowid,* FROM "' + table + '" ORDER BY rowid')
      .all())
      for (const leaf of mailPrivateLeaves(table, row, ownerActions)) {
        reference(leaf.value);
        if (leaf.value !== null && leaf.value !== '')
          locations.push({
            table,
            rowid: row.__projectionRowid,
            column: leaf.column,
            path: leaf.path
          });
      }
  if (
    used.size !== labels.size ||
    JSON.stringify(locations) !== JSON.stringify(descriptor.locations)
  )
    fail();
  return verifyProjectedHistory(db, descriptor);
}
function verifyProjectedHistory(db, descriptor) {
  const get = db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?');
  for (const [type, name, sql] of objects) if (get.get(type, name)?.sql !== sql) fail();
  const expected = new Set(
    [...objects, ...mailOwnerSchema, ...mailDeliverySchema].map((x) => x[1])
  );
  for (const row of db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE (name LIKE 'thread_mail_%' OR tbl_name IN ('thread_mail_authority','thread_mail_authority_events','thread_mail_permissions')) AND sql IS NOT NULL"
    )
    .iterate())
    if (!expected.has(row.name) && row.name !== 'thread_mail_operations') fail();
  let threads = 0,
    count = 0;
  for (const row of db.prepare('SELECT * FROM thread_mail_permissions').iterate()) {
    const input = {
      projectId: chatProject(db).projectId,
      threadId: row.threadId,
      enabled: Boolean(row.enabled)
    };
    const saved = db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(row.operationId);
    if (!saved || saved.digest !== hash(['chat.mail.permission', input])) fail();
    const receipt = JSON.parse(saved.receipt);
    if (
      receipt.operationId !== row.operationId ||
      JSON.stringify(receipt.mailPermission) !== JSON.stringify(input)
    )
      fail();
  }
  for (const t of db.prepare('SELECT id FROM project_chat_threads').iterate()) {
    const current = readProjectedAuthority(db, t.id, descriptor);
    let prior = null,
      version = 0;
    for (const event of db
      .prepare('SELECT * FROM thread_mail_authority_events WHERE threadId=? ORDER BY version')
      .iterate(t.id)) {
      if (event.version !== ++version || event.prior !== prior) fail();
      const ref = JSON.parse(event.reference);
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail();
      if (version === 1) {
        if (event.reason !== 'initialize' || ref.threadId !== t.id) fail();
      } else {
        if (event.snapshot === prior) fail();
        if (event.reason === 'parent-revoke') {
          if (
            !db
              .prepare(
                'SELECT 1 FROM project_chat_parent_revocations WHERE grantId=? AND operationId=?'
              )
              .get(ref.grantId, ref.operationId)
          )
            fail();
        } else if (event.reason.startsWith('account-')) {
          if (
            ![
              'codex.accountInstance',
              'codex.accountBinding',
              'claude.accountInstance',
              'claude.accountBinding'
            ].includes(ref.key)
          )
            fail();
        } else if (/^permission-(insert|update)$/.test(event.reason)) {
          const input = {
            projectId: current.projectId,
            threadId: ref.threadId,
            enabled: Boolean(ref.enabled)
          };
          const saved = db
            .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
            .get(ref.operationId);
          if (!saved || saved.digest !== hash(['chat.mail.permission', input])) fail();
          const receipt = JSON.parse(saved.receipt);
          if (
            receipt.operationId !== ref.operationId ||
            JSON.stringify(receipt.mailPermission) !== JSON.stringify(input)
          )
            fail();
        } else if (/^lineage-(insert|update|delete)$/.test(event.reason)) {
          if (
            !db.prepare('SELECT 1 FROM command_receipts WHERE operationId=?').get(ref.operationId)
          )
            fail();
        } else fail();
      }
      prior = event.snapshot;
      count++;
    }
    if (version !== current.version) fail();
    threads++;
  }
  if (
    db.prepare('SELECT count(*) n FROM thread_mail_authority').get().n !== threads ||
    db.prepare('SELECT count(*) n FROM thread_mail_authority_events').get().n !== count
  )
    fail();
  return { threads, events: count };
}
