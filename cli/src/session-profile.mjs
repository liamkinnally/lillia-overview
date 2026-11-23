import { ServiceDrain } from './service-drain.mjs';

const mixed = Object.freeze({ mode: 'mixed', codexSlots: 1 });
function reject(message, status = 409) {
  throw Object.assign(new Error(message), { status });
}

export function normalizeSessionProfile(profile) {
  if (
    !profile ||
    typeof profile !== 'object' ||
    Array.isArray(profile) ||
    Object.keys(profile).some((k) => !['mode', 'codexSlots'].includes(k)) ||
    !['mixed', 'codex-only'].includes(profile.mode)
  )
    reject('Select the mixed or codex-only session profile.', 400);
  const codexSlots = profile.codexSlots ?? (profile.mode === 'mixed' ? 1 : 2);
  if (
    !Number.isInteger(codexSlots) ||
    codexSlots < 1 ||
    codexSlots > 4 ||
    (profile.mode === 'mixed' && codexSlots !== 1)
  )
    reject(
      'Select one to four Codex sessions in the Codex-only profile. The mixed profile uses one Codex slot.',
      400
    );
  return Object.freeze({ mode: profile.mode, codexSlots });
}

// Called under the daemon's directory writer lock, before constructing native adapters.
export function selectSessionProfile(store, requested) {
  return store.transaction(() => {
    const stored = store.db
      .prepare("SELECT value FROM settings WHERE key='platform.sessionProfile'")
      .get();
    const previous = stored ? normalizeSessionProfile(JSON.parse(stored.value)) : mixed;
    const selected = requested === undefined ? previous : normalizeSessionProfile(requested);
    const changed = previous.mode !== selected.mode || previous.codexSlots !== selected.codexSlots;
    if (changed && (stored || store.db.prepare('SELECT 1 FROM command_receipts LIMIT 1').get())) {
      if (new ServiceDrain(store).view().phase !== 'quiescent')
        reject(
          'Drain the current installation to a quiescent named cutoff, then stop it before changing its session profile.'
        );
    }
    if (!stored || changed)
      store.db
        .prepare(
          "INSERT INTO settings VALUES('platform.sessionProfile',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        )
        .run(JSON.stringify(selected));
    return selected;
  });
}
