import { createHash } from 'node:crypto';
import { NativeStore, nativeFileId, validateNativeId } from './native-store.mjs';
import { probeReleaseArtifact } from './native-release.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const need = (ok, message, status = 409) => {
  if (!ok) throw Object.assign(new Error(message), { status });
};
export function normalizeRegression(name, raw) {
  const keys =
    name === 'release.bisect'
      ? ['releaseId', 'goodGeneration']
      : ['diagnosisId', 'expectedTarget', 'expectedGeneration'];
  need(
    ['release.bisect', 'release.revert'].includes(name) &&
      raw &&
      Object.keys(raw).length === keys.length &&
      keys.every((k) => Object.hasOwn(raw, k)),
    'Unexpected regression operation input',
    400
  );
  const n = raw[keys.at(-1)];
  need(Number.isSafeInteger(n) && n >= 1, 'Select a positive mainline generation', 400);
  for (const k of keys.slice(0, -1)) validateNativeId(raw[k]);
  return Object.fromEntries(keys.map((k) => [k, raw[k]]));
}
export function installNativeRegression(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS native_regression_records(id TEXT PRIMARY KEY,operationId TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,
    releaseId TEXT NOT NULL REFERENCES native_release_candidates(id),record TEXT NOT NULL);`);
}
function releaseRow(db, id) {
  const row = db.prepare('SELECT record FROM native_release_candidates WHERE id=?').get(id);
  need(row, 'Unknown native release');
  const r = JSON.parse(row.record);
  need(r.id === id && r.state === 'failed', 'Select a retained failing release');
  return r;
}
function lookup(db, id, kind) {
  const row = db.prepare('SELECT kind,record FROM native_regression_records WHERE id=?').get(id);
  need(row && (!kind || row.kind === kind), 'Native regression record is unavailable', 404);
  return JSON.parse(row.record);
}
function firstFailure(db, input, release) {
  const lower = input.goodGeneration,
    upper = release.generation;
  need(
    lower < upper && upper - lower <= 31,
    'Select a good baseline preceding the failed release by at most 31 generations'
  );
  const events = db
    .prepare(
      "SELECT * FROM native_ref_events WHERE repository=? AND name='mainline' AND generation BETWEEN ? AND ? ORDER BY generation"
    )
    .all(release.repository, lower, upper);
  need(
    events.length === upper - lower + 1 && events.at(-1).revisionId === release.source,
    'Native release interval lost historical mainline events'
  );
  const sampled = new Map(),
    probeOrder = [];
  function probe(index) {
    if (sampled.has(index)) return sampled.get(index);
    const event = events[index],
      attempt = probeReleaseArtifact(db, release, event.revisionId);
    need(attempt.recipeDigest === release.recipeDigest, 'Release recipe changed during bisection');
    const evidence = { generation: event.generation, ...attempt };
    sampled.set(index, evidence);
    probeOrder.push(evidence.generation);
    return evidence;
  }
  need(probe(0).state === 'passed', 'Selected baseline fails this exact artifact recipe');
  const final = probe(events.length - 1);
  need(
    final.state === 'failed' &&
      final.artifactDigest === release.artifactDigest &&
      equal(final.failures, release.validation.failures),
    'Retained regression no longer matches the selected release'
  );
  let left = 0,
    right = events.length - 1;
  while (right - left > 1) {
    const mid = Math.floor((left + right) / 2);
    if (probe(mid).state === 'passed') left = mid;
    else right = mid;
  }
  // Verify the entire small interval: a green run between two failures defeats
  // the monotonicity assumption of ordinary bisection.
  const probes = events.map((_, i) => probe(i)),
    transitions = probes
      .filter((p, i) => i && p.state !== probes[i - 1].state)
      .map((p) => p.generation);
  const bad = events[transitions[0] - lower],
    row = db
      .prepare('SELECT revisionId FROM native_landings WHERE operationId=?')
      .get(bad.operationId);
  need(row, 'First observed regression lacks its reviewed native landing');
  return {
    goodGeneration: lower,
    badGeneration: upper,
    probeOrder,
    transitions,
    probes,
    firstFailure: {
      generation: bad.generation,
      source: bad.revisionId,
      previous: bad.expectedRevision,
      landingId: bad.operationId,
      revisionId: row.revisionId
    }
  };
}
function makeRevert(db, diagnosis, input) {
  const release = releaseRow(db, diagnosis.releaseId),
    first = diagnosis.firstFailure;
  const source = db
    .prepare('SELECT record FROM native_submissions WHERE id=?')
    .get(first.revisionId);
  need(source, 'Diagnosed landing lost its submission');
  const r = JSON.parse(source.record),
    native = new NativeStore({ db }),
    file = (id) => native.file({ repository: r.repository, revisionId: id, path: r.path });
  const old = file(first.previous),
    changed = file(first.source),
    current = file(input.expectedTarget);
  need(
    r.repository === release.repository &&
      r.epoch === release.epoch &&
      old.mode === '100644' &&
      changed.mode === old.mode &&
      current.mode === old.mode &&
      old.fileId === r.oldFileId &&
      changed.fileId === r.newFileId &&
      current.fileId === changed.fileId,
    'Reviewed path has changed since the proposed inverse'
  );
  need(
    db
      .prepare(
        "SELECT 1 FROM native_ref_events WHERE repository=? AND name='mainline' AND generation=? AND revisionId=?"
      )
      .get(r.repository, input.expectedGeneration, input.expectedTarget) &&
      input.expectedGeneration >= first.generation,
    'Proposed inverse target is outside historical mainline'
  );
  const desired = old.bytes.toString('utf8');
  const objective =
    'Restore ' +
    r.path +
    ' to the exact UTF-8 contents in this JSON string: ' +
    JSON.stringify(desired);
  need(objective.length <= 2000, 'Exact inverse exceeds the bounded development objective size');
  return {
    diagnosisId: diagnosis.id,
    base: input.expectedTarget,
    generation: input.expectedGeneration,
    path: r.path,
    objective,
    fromFileId: current.fileId,
    toFileId: old.fileId,
    sourceSubmission: first.revisionId
  };
}
function record(kind, input, operationId, release, body) {
  const id = digest(['native-regression-v1', kind, operationId, input]);
  return {
    id,
    operationId,
    releaseId: release.id,
    repository: release.repository,
    epoch: release.epoch,
    policyDigest: release.policyDigest,
    input,
    ...body
  };
}
export class NativeRegression {
  constructor(store, { authority }) {
    this.db = store.db;
    this.authority = authority;
    this.native = new NativeStore(store);
  }
  #owner(r) {
    const a = this.authority();
    need(
      a &&
        a.repository === r.repository &&
        a.epoch === r.epoch &&
        a.policyDigest === r.policyDigest,
      'Native regression authority changed'
    );
  }
  #save(kind, v) {
    need(this.db.isTransaction, 'Regression evidence requires writer transaction');
    need(
      this.db.prepare('SELECT count(*) n FROM native_regression_records').get().n < 128,
      'Native regression evidence capacity reached'
    );
    this.db
      .prepare('INSERT INTO native_regression_records VALUES(?,?,?,?,?)')
      .run(v.id, v.operationId, kind, v.releaseId, JSON.stringify(v));
    return { [kind]: v };
  }
  bisect(raw, operationId) {
    const input = normalizeRegression('release.bisect', raw),
      r = releaseRow(this.db, input.releaseId);
    this.#owner(r);
    return this.#save(
      'diagnosis',
      record('diagnosis', input, operationId, r, firstFailure(this.db, input, r))
    );
  }
  revert(raw, operationId) {
    const input = normalizeRegression('release.revert', raw),
      d = lookup(this.db, input.diagnosisId, 'diagnosis'),
      r = releaseRow(this.db, d.releaseId);
    this.#owner(r);
    const head = this.native.ref({ repository: r.repository, name: 'mainline' });
    need(
      input.expectedGeneration === head.generation && input.expectedTarget === head.revisionId,
      'Native revert expected target or generation changed'
    );
    return this.#save(
      'revert',
      record('revert', input, operationId, r, makeRevert(this.db, d, input))
    );
  }
  view({ id }) {
    validateNativeId(id);
    const item = lookup(this.db, id);
    this.#owner(item);
    return item;
  }
}
export function validateRevertAdmission(db, input, authority) {
  if (!input.revertId) return;
  const r = lookup(db, input.revertId, 'revert'),
    head = new NativeStore({ db }).ref({ repository: r.repository, name: 'mainline' });
  need(
    r.repository === authority.repository &&
      r.epoch === authority.epoch &&
      r.policyDigest === authority.policyDigest &&
      input.base === r.base &&
      input.path === r.path &&
      input.objective === r.objective &&
      head.generation === r.generation &&
      head.revisionId === r.base,
    'Native inverse source, admission or target changed'
  );
}
export function validateRevertOutput(db, grant, bytes) {
  if (!grant.revertId) return;
  const r = lookup(db, grant.revertId, 'revert');
  need(
    grant.base === r.base &&
      grant.path === r.path &&
      grant.objective === r.objective &&
      r.toFileId === nativeFileId(bytes),
    'Author output differs from the exact reviewed inverse grant'
  );
}
export function verifyNativeRegression(db) {
  let diagnoses = 0,
    reverts = 0;
  for (const row of db
    .prepare('SELECT * FROM native_regression_records ORDER BY rowid')
    .iterate()) {
    const v = JSON.parse(row.record),
      kind = row.kind,
      name = kind === 'diagnosis' ? 'release.bisect' : 'release.revert',
      input = normalizeRegression(name, v.input);
    const r = releaseRow(db, row.releaseId),
      prior = kind === 'revert' ? lookup(db, input.diagnosisId, 'diagnosis') : null;
    need(
      kind === 'diagnosis' ? input.releaseId === r.id : prior?.releaseId === r.id,
      'Native diagnosis is bound to a different release'
    );
    const body = kind === 'diagnosis' ? firstFailure(db, input, r) : makeRevert(db, prior, input);
    need(
      ['diagnosis', 'revert'].includes(kind) &&
        equal(v, record(kind, input, row.operationId, r, body)) &&
        v.id === row.id,
      'Native regression history differs from retained artifacts or inverse bytes'
    );
    const receipt = db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(v.operationId);
    const out = receipt && JSON.parse(receipt.receipt);
    need(
      receipt?.digest === digest([name, input]) &&
        out?.operationId === v.operationId &&
        equal(out[kind], v),
      'Native regression historical owner receipt changed'
    );
    if (kind === 'diagnosis') diagnoses++;
    else reverts++;
  }
  for (const row of db
    .prepare("SELECT admission FROM native_goals WHERE json_type(admission,'$.revertId')='text'")
    .iterate()) {
    const a = JSON.parse(row.admission),
      r = lookup(db, a.revertId, 'revert');
    need(
      a.base === r.base && a.path === r.path && a.objective === r.objective,
      'Native revert goal lost its attributed inverse proposal'
    );
  }
  for (const row of db
    .prepare(
      "SELECT s.record,g.admission FROM native_submissions s JOIN native_goals g ON g.goalId=json_extract(s.record,'$.goalId') WHERE json_type(g.admission,'$.revertId')='text'"
    )
    .iterate()) {
    const r = JSON.parse(row.record),
      proposal = lookup(db, JSON.parse(row.admission).revertId, 'revert');
    need(
      r.newFileId === proposal.toFileId && r.oldFileId === proposal.fromFileId,
      'Retained native revert changed inverse bytes'
    );
  }
  need(
    !db
      .prepare(
        `SELECT 1 FROM command_receipts c LEFT JOIN native_regression_records r ON c.operationId=r.operationId
    WHERE (json_type(c.receipt,'$.diagnosis')='object' OR json_type(c.receipt,'$.revert')='object') AND r.id IS NULL LIMIT 1`
      )
      .get(),
    'Native regression receipt lost its historical record'
  );
  return { diagnoses, reverts };
}
