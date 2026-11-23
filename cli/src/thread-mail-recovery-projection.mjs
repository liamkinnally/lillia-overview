import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { recoveryConflict } from './recovery-format.mjs';
import { replaceJsonLeaves } from './thread-mail-recovery-projection-json.mjs';
export const projectionProfile = 'thread-mail-private-bindings-v1';
export const retainedRecoverySettings = [
  'chat.incomingThreadMail',
  'platform.sessionProfile',
  'paused',
  'platform.workspace',
  'platform.installationEpoch',
  'codex.accountInstance',
  'claude.accountInstance'
];
export const privateBindingKeys = ['codex.accountBinding', 'claude.accountBinding'];

export function verifyProjectedSettings(db, manifest) {
  const allowed = new Set(retainedRecoverySettings);
  const expected = new Map();
  if (manifest) {
    if (
      !['backup', 'inspect-only'].includes(manifest.mode) ||
      !manifest.epoch ||
      (manifest.mode === 'inspect-only' &&
        (!manifest.predecessorEpoch || manifest.epoch === manifest.predecessorEpoch))
    )
      throw recoveryConflict('Projected recovery settings have invalid epoch or mode.');
    allowed.add('recovery.manifest');
    expected.set('platform.installationEpoch', manifest.epoch);
    if (manifest.mode === 'inspect-only') {
      allowed.add('recovery.mode');
      allowed.add('recovery.predecessorEpoch');
      expected.set('recovery.mode', 'inspect-only');
      expected.set('recovery.predecessorEpoch', manifest.predecessorEpoch);
      expected.set('paused', 'true');
    }
  }
  const rows = new Map(
    db
      .prepare('SELECT key,value FROM settings')
      .all()
      .map((row) => [row.key, row.value])
  );
  if (
    [...rows.keys()].some((key) => !allowed.has(key)) ||
    [...expected].some(([key, value]) => !rows.has(key) || rows.get(key) !== value) ||
    (manifest && !rows.has('recovery.manifest')) ||
    db.prepare('SELECT 1 FROM agent_workspaces WHERE identity IS NOT NULL LIMIT 1').get()
  )
    throw recoveryConflict('Projected settings or workspace identity sanitation differs.');
}
const need = (ok) => {
  if (!ok) throw recoveryConflict('Unsupported private mail projection shape.');
};
export function mailPrivateLeaves(table, row, ownerActions) {
  const leaves = [];
  const add = (column, path, value) => {
    need(value === null || typeof value === 'string');
    leaves.push({ column, path, value });
  };
  function snapshot(column) {
    if (row[column] === null) return null;
    let data;
    try {
      data = JSON.parse(row[column]);
    } catch {
      throw recoveryConflict('Unsupported private mail projection shape.');
    }
    need(Array.isArray(data) && data.length === 6 && Array.isArray(data[2]));
    const keys = new Set();
    for (const [i, pair] of data[2].entries()) {
      need(Array.isArray(pair) && pair.length === 2 && !keys.has(pair[0]));
      keys.add(pair[0]);
      need(
        ['codex.accountInstance', 'claude.accountInstance', ...privateBindingKeys].includes(pair[0])
      );
      if (privateBindingKeys.includes(pair[0])) add(column, [2, i, 1], pair[1]);
    }
    return data;
  }
  if (table === 'thread_mail_authority') snapshot('snapshot');
  if (table === 'thread_mail_authority_events') {
    const prior = snapshot('prior');
    const current = snapshot('snapshot');
    if (row.reason.startsWith('account-')) {
      need(prior && current);
      const ref = JSON.parse(row.reference);
      need(Object.keys(ref).sort().join(',') === 'key,old,value');
      const before = new Map(prior[2]);
      const after = new Map(current[2]);
      const inserted = row.reason === 'account-insert';
      const deleted = row.reason === 'account-delete';
      need(inserted || deleted || row.reason === 'account-update');
      need(before.has(ref.key) === !inserted && after.has(ref.key) === !deleted);
      need(ref.old === (inserted ? null : before.get(ref.key)));
      need(ref.value === (deleted ? null : after.get(ref.key)));
      before.delete(ref.key);
      after.delete(ref.key);
      // Only the named account slot may change in this event.
      need(isDeepStrictEqual(prior.with(2, [...before]), current.with(2, [...after])));
      if (privateBindingKeys.includes(ref.key)) {
        add('reference', ['old'], ref.old);
        add('reference', ['value'], ref.value);
      }
    }
  }
  const field =
    table === 'thread_mail_owner_authorizations'
      ? ['record', ['relationship', 'accountBinding']]
      : table === 'thread_mail_owner_actions'
        ? ['result', ['authorization', 'relationship', 'accountBinding']]
        : table === 'command_receipts' && ownerActions?.has(row.operationId)
          ? ['receipt', ['authorization', 'relationship', 'accountBinding']]
          : table === 'thread_mail_native_confirmations'
            ? ['record', ['accountBinding']]
            : null;
  if (field) {
    const [column, path] = field;
    let value = JSON.parse(row[column]);
    for (const key of path) value = value?.[key];
    if (value !== undefined) add(column, path, value);
    else if (table !== 'command_receipts') need(false);
  }
  if (['thread_mail_effects', 'thread_mail_native_requests'].includes(table))
    add('accountBinding', null, row.accountBinding);
  return leaves;
}
function publicInitialManagedPair(db, key, value) {
  if (
    key !== 'platform.managedPair' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
    return false;
  const operationId = 'initial-' + value;
  const row = db
    .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
    .get(operationId);
  const digest = createHash('sha256')
    .update(JSON.stringify(['daemon.drain', { expectedGeneration: 0 }]))
    .digest('hex');
  if (!row || row.digest !== digest) return false;
  try {
    const receipt = JSON.parse(row.receipt);
    const cutoffAt = receipt?.drain?.cutoffAt;
    if (typeof cutoffAt !== 'string' || !Number.isFinite(Date.parse(cutoffAt))) return false;
    return isDeepStrictEqual(receipt, {
      operationId,
      drain: {
        mode: 'draining',
        generation: 1,
        cutoff: operationId,
        cutoffAt,
        attemptCursor: 0,
        eventCursor: 0,
        lastOperation: operationId,
        phase: 'quiescent',
        counts: {
          queuedTasks: 0,
          activeTasks: 0,
          uncertainTasks: 0,
          inFlight: 0,
          workers: 0,
          callbacks: 0,
          liveControls: 0,
          pendingEffects: 0,
          pendingControls: 0,
          unconfirmedControls: 0,
          uncertainWorkspaces: 0
        },
        sample: { inFlight: [], tasks: [], effects: [], controls: [], workspaces: [] }
      }
    });
  } catch {
    return false;
  }
}
export function createMailRecoveryProjection(db) {
  const labels = new Map(),
    secrets = new Set(),
    locations = [];
  let hasBindings = false;
  function label(value) {
    hasBindings = true;
    if (value === null || value === '') return value;
    need(typeof value === 'string');
    secrets.add(value);
    if (!labels.has(value)) labels.set(value, 'mail-private:' + (labels.size + 1));
    return labels.get(value);
  }
  const rows = new Map();
  const ownerActions = new Set(
    db.prepare("SELECT name FROM sqlite_schema WHERE name='thread_mail_owner_actions'").get()
      ? db
          .prepare('SELECT operationId FROM thread_mail_owner_actions')
          .all()
          .map((r) => r.operationId)
      : []
  );
  for (const table of [
    'thread_mail_authority',
    'thread_mail_authority_events',
    'thread_mail_owner_authorizations',
    'thread_mail_owner_actions',
    'command_receipts',
    'thread_mail_effects',
    'thread_mail_native_requests',
    'thread_mail_native_confirmations'
  ]) {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name=? AND type='table'").get(table))
      continue;
    for (const row of db
      .prepare('SELECT rowid AS __projectionRowid,* FROM "' + table + '" ORDER BY rowid')
      .all()) {
      const changes = new Map();
      for (const leaf of mailPrivateLeaves(table, row, ownerActions)) {
        const replacement = label(leaf.value);
        if (leaf.value === null || leaf.value === '') continue;
        locations.push({
          table,
          rowid: row.__projectionRowid,
          column: leaf.column,
          path: leaf.path
        });
        if (leaf.path === null) row[leaf.column] = replacement;
        else {
          if (!changes.has(leaf.column)) changes.set(leaf.column, new Map());
          changes.get(leaf.column).set(JSON.stringify(leaf.path), replacement);
        }
      }
      for (const [col, changesForColumn] of changes)
        row[col] = replaceJsonLeaves(row[col], changesForColumn);
      rows.set(table + ':' + row.__projectionRowid, row);
    }
  }
  const currentAccounts = [];
  for (const row of db.prepare('SELECT key,value FROM settings ORDER BY key').all()) {
    if (privateBindingKeys.includes(row.key)) currentAccounts.push([row.key, label(row.value)]);
    // This omitted routing setting stores an already public neutral-workspace ID,
    // not a binding. Its exact thread/created copy must remain unchanged.
    const publicWorkspace =
      row.key.startsWith('codex.neutralWorkspace.') &&
      db
        .prepare(
          "SELECT 1 FROM events WHERE type='thread/created' AND json_extract(payload,'$.threadId')=? AND json_extract(payload,'$.neutralWorkspaceId')=?"
        )
        .get(row.key.slice('codex.neutralWorkspace.'.length), row.value);
    if (
      !retainedRecoverySettings.includes(row.key) &&
      row.value &&
      !publicWorkspace &&
      !publicInitialManagedPair(db, row.key, row.value)
    )
      secrets.add(row.value);
  }
  function assertBytes(bytes) {
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const secret of secrets) {
      if (
        data.includes(Buffer.from(secret)) ||
        data.includes(Buffer.from(JSON.stringify(secret).slice(1, -1)))
      )
        throw recoveryConflict('Known private content collision prevents recovery projection.');
    }
  }
  function assertSanitized(value) {
    if (value === null) return;
    const data =
      value instanceof Uint8Array
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : Buffer.from(String(value));
    assertBytes(data);
    // Only valid UTF-8 can carry JSON. Opaque bytes were checked directly above.
    let text;
    try {
      text =
        typeof value === 'string' ? value : new TextDecoder('utf-8', { fatal: true }).decode(data);
      JSON.parse(text);
    } catch {
      return;
    }
    // Scan string tokens in the validated text. Parsed objects drop repeated members.
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '"') continue;
      const start = i;
      while (text[++i] !== '"') {
        if (text[i] === '\\') i++;
      }
      assertSanitized(JSON.parse(text.slice(start, i + 1)));
    }
  }
  return {
    descriptor: {
      profile: projectionProfile,
      sourceSchema: 58,
      labels: [...labels.values()],
      currentAccounts,
      locations
    },
    hasBindings,
    row(table, row) {
      return rows.get(table + ':' + row.__projectionRowid) || row;
    },
    assertBytes,
    assertSanitized
  };
}
