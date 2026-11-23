import { createHash } from 'node:crypto';
import { NativeStore, validateNativeId } from './native-store.mjs';
import {
  hasSeries,
  hashRecord as hash,
  normalizePolicy,
  pathAdmitted,
  replaceNativePolicy,
  requireReview as need
} from './native-policy.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const uuid = (s) =>
  typeof s === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(s);
export const reviewSeriesTables = [
  'native_policy_versions',
  'native_policy_enrollments',
  'native_series_versions',
  'native_review_actions',
  'native_series_checks'
];
export function installReviewSeries(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS native_policy_versions(version INTEGER PRIMARY KEY,digest TEXT UNIQUE NOT NULL,operationId TEXT UNIQUE NOT NULL,target TEXT NOT NULL REFERENCES native_revisions(id),generation INTEGER NOT NULL,admission TEXT NOT NULL,record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS native_policy_enrollments(goalId TEXT PRIMARY KEY REFERENCES native_goals(goalId),digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS native_series_versions(revisionId TEXT PRIMARY KEY REFERENCES native_submissions(id),goalId TEXT NOT NULL REFERENCES goals(id),ordinal INTEGER NOT NULL,previousId TEXT REFERENCES native_submissions(id),UNIQUE(goalId,ordinal));
    CREATE TABLE IF NOT EXISTS native_review_actions(sequence INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,revisionId TEXT NOT NULL REFERENCES native_submissions(id),operationId TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,admission TEXT NOT NULL,record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS native_series_checks(checkId TEXT PRIMARY KEY REFERENCES native_checks(id),sequence INTEGER NOT NULL);`);
  const a = db.prepare('SELECT record FROM native_authority').get();
  if (a)
    db.prepare(
      'INSERT OR IGNORE INTO native_policy_enrollments SELECT goalId,? FROM native_goals'
    ).run(JSON.parse(a.record).policyDigest);
  for (const row of db
    .prepare(
      'SELECT s.record FROM native_submissions s LEFT JOIN native_series_versions v ON v.revisionId=s.id WHERE v.revisionId IS NULL ORDER BY s.rowid'
    )
    .all())
    bindSeriesRevision(db, JSON.parse(row.record));
  db.exec('INSERT OR IGNORE INTO native_series_checks SELECT id,0 FROM native_checks');
}
export function bindSeriesRevision(db, r) {
  if (!hasSeries(db)) return;
  const latest = db
    .prepare(
      'SELECT ordinal,revisionId FROM native_series_versions WHERE goalId=? ORDER BY ordinal DESC LIMIT 1'
    )
    .get(r.goalId);
  need((latest?.ordinal ?? 0) < 128, 'Review series capacity reached');
  db.prepare('INSERT INTO native_series_versions VALUES(?,?,?,?)').run(
    r.id,
    r.goalId,
    (latest?.ordinal ?? 0) + 1,
    latest?.revisionId ?? null
  );
}
function note(value) {
  need(
    typeof value === 'string' &&
      value.isWellFormed() &&
      value.trim() &&
      Buffer.byteLength(value) <= 2000 &&
      !value.includes('\0'),
    'Expected a bounded review note',
    400
  );
  return value;
}
export function normalizeReviewAction(name, input) {
  if (name === 'authority.policy') return normalizePolicy(input);
  const fields = {
    'review.comment': ['revisionId', 'side', 'line', 'kind', 'text'],
    'review.owner': ['revisionId', 'patchDigest', 'decision', 'note'],
    'review.resolve': ['revisionId', 'findingId', 'note']
  }[name];
  need(
    fields &&
      input &&
      Object.keys(input).length === fields.length &&
      fields.every((k) => Object.hasOwn(input, k)) &&
      uuid(input.revisionId),
    'Invalid native discussion operation',
    400
  );
  if (name === 'review.comment')
    need(
      ['old', 'new'].includes(input.side) &&
        Number.isSafeInteger(input.line) &&
        input.line >= 1 &&
        input.line <= 4097 &&
        ['comment', 'blocking'].includes(input.kind) &&
        note(input.text),
      'Invalid anchored finding',
      400
    );
  else if (name === 'review.owner')
    need(
      validateNativeId(input.patchDigest) &&
        ['approve', 'reject'].includes(input.decision) &&
        note(input.note),
      'Invalid owner review',
      400
    );
  else {
    validateNativeId(input.findingId);
    note(input.note);
  }
  return Object.fromEntries(fields.map((k) => [k, input[k]]));
}
function anchored(native, r, input) {
  const file = native.file({
    repository: r.repository,
    revisionId: input.side === 'old' ? r.base : r.commit,
    path: r.path
  });
  const lines = file.bytes.toString('utf8').split('\n');
  need(input.line <= lines.length, 'Comment line does not exist in this revision');
  return { path: r.path, fileId: file.fileId, lineDigest: sha(lines[input.line - 1]) };
}
function actionRows(db, id, until = Number.MAX_SAFE_INTEGER) {
  return db
    .prepare(
      'SELECT * FROM native_review_actions WHERE revisionId=? AND sequence<=? ORDER BY sequence'
    )
    .all(id, until);
}
function seriesActions(db, r, until = Number.MAX_SAFE_INTEGER) {
  return db
    .prepare(
      `SELECT a.* FROM native_review_actions a JOIN native_series_versions v ON v.revisionId=a.revisionId
    JOIN native_series_versions selected ON selected.revisionId=?
    WHERE v.goalId=selected.goalId AND v.ordinal<=selected.ordinal AND a.sequence<=?
      AND (a.revisionId=? OR a.kind='review.resolve' OR (a.kind='review.comment' AND json_extract(a.record,'$.kind')='blocking'))
    ORDER BY a.sequence`
    )
    .all(r.id, until, r.id);
}
function outstanding(db, rows) {
  const pending = new Map();
  for (const row of rows) {
    const v = verifyReceipt(db, row);
    if (row.kind === 'review.comment' && v.kind === 'blocking') pending.set(v.id, v);
    if (row.kind === 'review.resolve')
      need(
        pending.delete(v.findingId),
        'Resolution refers to an absent or previously resolved finding'
      );
  }
  return [...pending.values()];
}
function verifyReceipt(db, row) {
  const p = JSON.parse(row.record),
    input = normalizeReviewAction(row.kind, JSON.parse(row.admission)),
    k = row.kind.split('.')[1];
  const receipt = db
    .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
    .get(row.operationId);
  const out = receipt && JSON.parse(receipt.receipt);
  need(
    p.id === row.id &&
      p.id === hash([row.kind, row.operationId, input]) &&
      p.operationId === row.operationId &&
      p.revisionId === row.revisionId &&
      p.principal === 'local-owner' &&
      same(
        normalizeReviewAction(
          row.kind,
          Object.fromEntries(Object.keys(input).map((k) => [k, p[k]]))
        ),
        input
      ) &&
      receipt?.digest === hash([row.kind, input]) &&
      out.operationId === row.operationId &&
      same(out[k], p),
    'Native review action lost its owner receipt'
  );
  return p;
}
function awaitOwner(message) {
  throw Object.assign(new Error(message), { status: 409, code: 'NATIVE_PREREQUISITE_WAIT' });
}
function gateAt(db, r, review, rows) {
  const findings = new Set();
  let owner = null,
    rejected = false;
  const significant = [];
  for (const row of rows) {
    const v = verifyReceipt(db, row);
    if (row.kind === 'review.comment' && v.kind === 'blocking') {
      findings.add(v.id);
      significant.push(v.id);
    }
    if (row.kind === 'review.resolve') {
      need(findings.delete(v.findingId), 'Finding resolution no longer matches an open finding');
      significant.push(v.id);
    }
    if (row.kind === 'review.owner') {
      if (v.decision === 'reject') rejected = true;
      owner = v;
      significant.push(v.id);
    }
  }
  if (findings.size) awaitOwner('An anchored blocking finding awaits owner resolution.');
  need(!rejected, 'The owner rejected this revision. Submit a revised change for fresh review.');
  if (r.ownerPolicy) {
    if (r.origin?.principal === 'local-owner')
      awaitOwner('A distinct authorized human must approve this owner-authored protected change.');
    if (!owner) awaitOwner('This policy path awaits independent agent and owner approval.');
    need(
      owner.reviewId === review.id &&
        owner.patchDigest === review.patchDigest &&
        owner.policyDigest === r.policyDigest &&
        owner.commit === r.commit,
      'Owner approval differs from this independent decision, policy or patch'
    );
  }
  return significant.length
    ? { actionsDigest: hash(significant), ownerDecisionId: owner?.id ?? null }
    : null;
}
export function seriesGateAt(db, r, review, sequence) {
  if (!hasSeries(db)) return null;
  return gateAt(db, r, review, seriesActions(db, r, sequence));
}
export function requireSeriesLatest(db, r) {
  if (!hasSeries(db)) return;
  need(
    db
      .prepare(
        'SELECT revisionId FROM native_series_versions WHERE goalId=? ORDER BY ordinal DESC LIMIT 1'
      )
      .get(r.goalId)?.revisionId === r.id,
    'A newer review series version superseded this revision'
  );
}
export function seriesGate(db, r, review) {
  if (!hasSeries(db)) return null;
  requireSeriesLatest(db, r);
  return gateAt(db, r, review, seriesActions(db, r));
}
export function bindSeriesCheck(db, c) {
  if (hasSeries(db))
    db.prepare('INSERT INTO native_series_checks VALUES(?,?)').run(
      c.id,
      db.prepare('SELECT coalesce(max(sequence),0) n FROM native_review_actions').get().n
    );
}
export class NativeReviewSeries {
  constructor(store, { authority, review }) {
    this.db = store.db;
    this.authority = authority;
    this.review = review;
    this.native = new NativeStore(store);
  }
  thread({ revisionId }) {
    const detail = this.review.view(revisionId),
      r = detail.revision,
      a = this.authority();
    need(
      a?.epoch === r.epoch && a.repository === r.repository,
      'Review thread is outside the active repository'
    );
    const versions = this.db
      .prepare(
        'SELECT revisionId,ordinal,previousId FROM native_series_versions WHERE goalId=? ORDER BY ordinal'
      )
      .all(r.goalId)
      .map((x) => ({ ...x }));
    const actions = actionRows(this.db, r.id).map((row) => verifyReceipt(this.db, row));
    return {
      seriesId: r.goalId,
      revisionId,
      latestRevisionId: versions.at(-1)?.revisionId,
      versions,
      actions,
      openFindings: outstanding(this.db, seriesActions(this.db, r)),
      requiredOwner: Boolean(r.ownerPolicy),
      independentHumanRequired: !!(r.ownerPolicy && r.origin?.principal === 'local-owner'),
      ...detail
    };
  }
  apply(name, raw, op) {
    need(this.db.isTransaction, 'Owner policy and review actions require a writer transaction');
    const input = normalizeReviewAction(name, raw),
      a = this.authority();
    if (name === 'authority.policy') return replaceNativePolicy(this.db, a, input, op);
    const t = this.thread({ revisionId: input.revisionId }),
      r = t.revision;
    need(
      t.latestRevisionId === r.id &&
        !t.landings.length &&
        r.policyDigest === a?.policyDigest &&
        pathAdmitted(a, r),
      'Revision is superseded, landed or outside current review policy'
    );
    need(t.actions.length < 128, 'Native review action capacity reached');
    const k = name.split('.')[1],
      item = {
        id: hash([name, op, input]),
        operationId: op,
        principal: 'local-owner',
        commit: r.commit,
        policyDigest: r.policyDigest,
        ...input
      };
    if (k === 'comment') Object.assign(item, anchored(this.native, r, input));
    if (k === 'resolve') {
      const finding = t.openFindings.find((v) => v.id === input.findingId);
      need(finding, 'Unknown or previously resolved finding');
      item.findingRevision = finding.revisionId;
    }
    if (k === 'owner') {
      need(
        input.decision !== 'approve' || !t.independentHumanRequired,
        'Protected owner-authored work requires a distinct authorized human'
      );
      const d = t.reviews[0];
      need(
        d?.decision === 'approve' &&
          d.patchDigest === input.patchDigest &&
          !t.reviews.some((v) => v.decision === 'reject'),
        'Owner decision requires independent approval of this exact patch'
      );
      item.reviewId = d.id;
    }
    this.db
      .prepare(
        'INSERT INTO native_review_actions(id,revisionId,operationId,kind,admission,record) VALUES(?,?,?,?,?,?)'
      )
      .run(item.id, r.id, op, name, JSON.stringify(input), JSON.stringify(item));
    return { [k]: item };
  }
}
export function verifyReviewSeries(db) {
  let revisions = 0,
    checks = 0,
    actions = 0;
  const previous = new Map(),
    native = new NativeStore({ db });
  for (const row of db.prepare('SELECT * FROM native_submissions ORDER BY rowid').iterate()) {
    const r = JSON.parse(row.record),
      v = db.prepare('SELECT * FROM native_series_versions WHERE revisionId=?').get(r.id),
      prior = previous.get(r.goalId);
    need(
      v?.goalId === r.goalId &&
        v.ordinal === (prior?.ordinal ?? 0) + 1 &&
        v.previousId === (prior?.revisionId ?? null),
      'Native review series lost an immutable version link'
    );
    previous.set(r.goalId, v);
    revisions++;
    const all = actionRows(db, r.id);
    for (const a of all) {
      const v = verifyReceipt(db, a);
      need(
        v.commit === r.commit && v.policyDigest === r.policyDigest,
        'Anchored action lost its revision'
      );
      if (a.kind === 'review.comment') {
        const pin = anchored(native, r, v);
        need(
          ['path', 'fileId', 'lineDigest'].every((k) => v[k] === pin[k]),
          'Native discussion anchor changed'
        );
      } else if (a.kind === 'review.resolve') {
        const open = outstanding(db, seriesActions(db, r, a.sequence - 1));
        need(
          open.some((item) => item.id === v.findingId && item.revisionId === v.findingRevision),
          'Native finding resolution lost its anchor'
        );
      } else {
        const rr = db
            .prepare('SELECT record FROM native_reviews WHERE id=? AND revisionId=?')
            .get(v.reviewId, r.id),
          d = rr && JSON.parse(rr.record);
        need(
          d?.decision === 'approve' &&
            d.patchDigest === v.patchDigest &&
            (v.decision !== 'approve' || !(r.ownerPolicy && r.origin?.principal === 'local-owner')),
          'Native owner approval lost its independent decision'
        );
      }
      actions++;
    }
    for (const c of db.prepare('SELECT * FROM native_checks WHERE revisionId=?').iterate(r.id)) {
      const body = JSON.parse(c.record),
        review = JSON.parse(
          db.prepare('SELECT record FROM native_reviews WHERE id=?').get(c.reviewId).record
        );
      const stamp = db
        .prepare('SELECT sequence FROM native_series_checks WHERE checkId=?')
        .get(c.id);
      need(
        stamp &&
          same(
            body.discussion ?? null,
            gateAt(db, r, review, seriesActions(db, r, stamp.sequence))
          ),
        'Historical native check lost its discussion or approval state'
      );
      checks++;
    }
  }
  need(
    !db
      .prepare(
        `SELECT 1 FROM command_receipts c WHERE (json_extract(c.receipt,'$.comment.principal')='local-owner' OR json_extract(c.receipt,'$.resolve.principal')='local-owner' OR json_extract(c.receipt,'$.owner.principal')='local-owner')
    AND NOT EXISTS(SELECT 1 FROM native_review_actions a WHERE a.operationId=c.operationId) LIMIT 1`
      )
      .get(),
    'Native discussion receipt lost its action'
  );
  for (const row of db.prepare('SELECT * FROM native_policy_versions ORDER BY version').iterate()) {
    const a = JSON.parse(row.record);
    need(
      db
        .prepare(
          "SELECT 1 FROM native_ref_events WHERE repository=? AND name='mainline' AND revisionId=? AND generation=?"
        )
        .get(a.repository, row.target, row.generation),
      'Native policy lacks its selected historical target'
    );
    for (const path of [...a.allowedPaths, ...a.ownerReviewPaths]) {
      const file = native.file({ repository: a.repository, revisionId: row.target, path });
      need(
        file.mode === '100644' && file.bytes.length <= 4096,
        'Native policy referenced an unsupported file'
      );
    }
  }
  need(
    !db
      .prepare(
        `SELECT 1 FROM command_receipts c WHERE json_type(c.receipt,'$.authority.policyVersion')='integer' AND
    NOT EXISTS(SELECT 1 FROM native_policy_versions v WHERE v.operationId=c.operationId) LIMIT 1`
      )
      .get(),
    'Native policy receipt lost its version'
  );
  return {
    revisions,
    checks,
    actions,
    policies: db.prepare('SELECT count(*) n FROM native_policy_versions').get().n
  };
}
