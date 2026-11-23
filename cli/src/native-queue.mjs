import { createHash } from 'node:crypto';
import { installNativeRegression, verifyNativeRegression } from './native-regression.mjs';
import { seriesGateAt } from './native-series.mjs';
import { nativePrerequisites } from './native-release.mjs';
import { evaluateFileRecipe } from './git-review-recipe.mjs';
import { hasSeries } from './native-policy.mjs';
import { NativeStore, nativeRevisionId } from './native-store.mjs';

const digest = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function need(ok, reason) {
  if (!ok) throw Object.assign(new Error(reason), { status: 409 });
}
function wait(reason) {
  throw Object.assign(new Error(reason), { status: 409, code: 'NATIVE_PREREQUISITE_WAIT' });
}
export const nativeQueueTables = [
  'native_queue_entries',
  'native_queue_previews',
  'native_regression_records'
];
export function installNativeQueue(db) {
  installNativeRegression(db);
  db.exec(`CREATE TABLE IF NOT EXISTS native_queue_entries(sequence INTEGER PRIMARY KEY,revisionId TEXT UNIQUE NOT NULL REFERENCES native_submissions(id),
      previewId TEXT REFERENCES native_queue_previews(id));
    CREATE TABLE IF NOT EXISTS native_queue_previews(id TEXT PRIMARY KEY,revisionId TEXT NOT NULL REFERENCES native_submissions(id),record TEXT NOT NULL);`);
}
const available = ` FROM native_queue_entries q JOIN native_submissions s ON s.id=q.revisionId
  JOIN goals g ON g.id=json_extract(s.record,'$.goalId') LEFT JOIN native_goals n ON n.goalId=g.id
  WHERE g.state='active' AND (n.goalId IS NULL OR (n.revisionId=q.revisionId AND n.stage IN ('check','land')))
  AND NOT EXISTS(SELECT 1 FROM native_landings l WHERE l.revisionId=q.revisionId)`;
function summary(db, c, r) {
  const series = !!db
    .prepare("SELECT 1 FROM sqlite_schema WHERE name='native_series_checks'")
    .get();
  const sequence = series
    ? db.prepare('SELECT sequence FROM native_series_checks WHERE checkId=?').get(c.id)?.sequence
    : null;
  return {
    revisionId: r.id,
    repository: r.repository,
    epoch: r.epoch,
    policyDigest: c.policyDigest,
    recipeDigest: c.recipeDigest,
    reviewId: c.reviewId,
    patchDigest: c.patchDigest,
    expectedTarget: c.expectedTarget,
    expectedGeneration: c.expectedGeneration,
    candidate: c.candidate,
    state: c.state,
    failures: c.failures,
    ...(c.discussion ? { discussion: c.discussion, discussionSequence: sequence } : {}),
    prerequisites: (c.prerequisites ?? []).map(({ revisionId, target, generation, fileId }) => ({
      revisionId,
      target,
      generation,
      fileId
    }))
  };
}
export class NativeQueue {
  #cached;
  constructor(store, { authority, review }) {
    this.store = store;
    this.db = store.db;
    this.authority = authority;
    this.review = review;
    this.native = new NativeStore(store);
  }
  #writer() {
    need(this.db.isTransaction, 'Queue changes require writer transaction');
  }
  #items() {
    return this.db
      .prepare(
        'SELECT q.sequence,q.revisionId,q.previewId,s.record' +
          available +
          ' ORDER BY q.sequence LIMIT 33'
      )
      .all();
  }
  ensure(revisionId) {
    this.#writer();
    if (this.db.prepare('SELECT 1 FROM native_queue_entries WHERE revisionId=?').get(revisionId))
      return;
    if (this.#items().length >= 32)
      wait('Native integration queue is full. Existing work retains its order.');
    this.review.view(revisionId);
    this.db.prepare('INSERT INTO native_queue_entries(revisionId) VALUES(?)').run(revisionId);
  }
  #remember(row, preview) {
    const id = digest(preview);
    if (row.previewId === id) return false;
    const prior = this.db.prepare('SELECT record FROM native_queue_previews WHERE id=?').get(id);
    if (prior) need(prior.record === JSON.stringify(preview), 'Native preview identity mismatch');
    else {
      need(
        this.db.prepare('SELECT count(*) n FROM native_queue_previews').get().n < 8192,
        'Native speculative history capacity exhausted'
      );
      this.db
        .prepare('INSERT INTO native_queue_previews VALUES(?,?,?)')
        .run(id, row.revisionId, JSON.stringify(preview));
    }
    this.db
      .prepare('UPDATE native_queue_entries SET previewId=? WHERE revisionId=?')
      .run(id, row.revisionId);
    return true;
  }
  // Both operations below are strictly synchronous SQLite mutations. The savepoint
  // rolls back all provisional objects, events and checks before any preview is stored.
  run() {
    this.#writer();
    const items = this.#items();
    if (!items.length) return false;
    const a = this.authority();
    need(a, 'Missing native integration authority');
    const head = this.native.ref({ repository: a.repository, name: 'mainline' });
    // Fast reuse covers unchanged plans and a prefix that really landed exactly as
    // projected. Every actual checkout of a check revalidates native evidence below.
    const hasSeries = !!this.db
      .prepare("SELECT 1 FROM sqlite_schema WHERE name='native_review_actions'")
      .get();
    const input = items.map((q) => {
      const r = JSON.parse(q.record),
        reviews = this.db
          .prepare('SELECT id FROM native_reviews WHERE revisionId=? ORDER BY rowid')
          .all(r.id);
      const goal = this.store.goal(r.goalId);
      const deps = this.db
        .prepare(
          `WITH RECURSIVE chain(id) AS (
        SELECT prerequisite FROM native_prerequisites WHERE revisionId=?
        UNION SELECT p.prerequisite FROM native_prerequisites p JOIN chain ON p.revisionId=chain.id)
        SELECT c.id,(SELECT newer.id FROM native_submissions newer WHERE json_extract(newer.record,'$.goalId')=json_extract(s.record,'$.goalId')
          ORDER BY newer.rowid DESC LIMIT 1) AS latest FROM chain c JOIN native_submissions s ON s.id=c.id ORDER BY c.id`
        )
        .all(r.id);
      const disclosure = r.research
        ? this.db
            .prepare('SELECT digest,revokedAt FROM research_disclosures WHERE id=?')
            .get(r.research.grantId)
        : null;
      const series = hasSeries
        ? [
            this.db
              .prepare(
                'SELECT revisionId FROM native_series_versions WHERE goalId=? ORDER BY ordinal DESC LIMIT 1'
              )
              .get(r.goalId),
            this.db
              .prepare('SELECT id FROM native_review_actions WHERE revisionId=? ORDER BY sequence')
              .all(r.id)
          ]
        : null;
      const checkCount = this.db
        .prepare('SELECT count(*) n FROM native_checks WHERE revisionId=?')
        .get(r.id).n;
      return [
        r.id,
        digest([r, goal.version, goal.state, reviews, deps, disclosure, series, checkCount >= 50])
      ];
    });
    const universe = digest([
      a,
      this.db
        .prepare(
          "SELECT key,value FROM settings WHERE key LIKE '%.accountInstance' OR key LIKE '%.accountBinding' ORDER BY key"
        )
        .all()
    ]);
    const cached = this.#cached;
    if (
      cached &&
      cached.universe === universe &&
      items.every((q) => q.previewId === cached.ids.get(q.revisionId))
    ) {
      if (same(input, cached.input) && same(head, cached.head)) return false;
      const remaining = new Map(input),
        past = cached.input.filter(([id]) => !remaining.has(id));
      const sameSuffix = input.every(([id, k]) =>
        cached.input.some(([old, e]) => old === id && e === k)
      );
      const exactPrefix =
        past.length > 0 &&
        past.length === head.generation - cached.head.generation &&
        past.every(([id]) => {
          const preview = cached.previews.get(id),
            row = this.db.prepare('SELECT record FROM native_landings WHERE revisionId=?').get(id);
          const l = row && JSON.parse(row.record);
          return (
            preview?.state === 'passed' &&
            l?.candidate === preview.candidate &&
            l.expectedTarget === preview.expectedTarget &&
            l.expectedGeneration === preview.expectedGeneration
          );
        });
      if (
        sameSuffix &&
        exactPrefix &&
        input.every(([id]) =>
          ['passed', 'failed', 'conflict'].includes(cached.previews.get(id)?.state)
        ) &&
        input.some(([id]) => cached.previews.get(id)?.expectedTarget === head.revisionId)
      ) {
        this.#cached = { ...cached, head, input };
        return false;
      }
    }
    let target = head.revisionId,
      generation = head.generation,
      count = 0;
    const prefix = [];
    const context = () => ({
      source: head.revisionId,
      generation: head.generation,
      prefix: [...prefix]
    });
    const fingerprints = new Map(input),
      frames = new Map();
    const projected = new Map(),
      remaining = new Map(items.map((q) => [q.revisionId, q]));
    this.db.exec('SAVEPOINT native_queue_projection');
    try {
      let advanced = true;
      while (advanced && remaining.size && count < 4) {
        advanced = false;
        for (const [id, row] of remaining) {
          if (count === 4) break;
          const r = JSON.parse(row.record);
          this.db.exec('SAVEPOINT native_queue_trial');
          let session;
          try {
            // These frames exist only in memory. Replay reconstructs a previously verified
            // hypothetical prefix inside the outer rollback-only savepoint. Actual take()
            // always performs a fresh check against the real head.
            const prior = cached?.frames?.get(id),
              before = context(),
              fingerprint = fingerprints.get(id);
            const ancestry = prefix.map((entry) => fingerprints.get(entry.revisionId));
            let result = prior?.preview;
            const eligible =
              prior &&
              cached.universe === universe &&
              prior.fingerprint === fingerprint &&
              same(prior.ancestry, ancestry) &&
              row.previewId === cached.ids.get(id) &&
              result.expectedTarget === target &&
              result.expectedGeneration === generation &&
              same(result.projection, before);
            let reused = false;
            if (eligible) {
              this.db.exec('SAVEPOINT native_queue_cached');
              try {
                reused = this.db.applyChangeset(prior.delta);
              } catch {
                reused = false;
              }
              if (!reused) this.db.exec('ROLLBACK TO native_queue_cached');
              this.db.exec('RELEASE native_queue_cached');
            }
            if (reused) frames.set(id, prior);
            else {
              session = this.db.createSession();
              const { check } = this.review.check(id, target, generation);
              result = { ...summary(this.db, check, r), projection: before };
              if (check.state === 'passed')
                this.review.land(id, check.id, target, generation, 'projection.' + id);
              const delta = session.changeset();
              if (delta.length <= 256 * 1024)
                frames.set(id, { fingerprint, ancestry, preview: result, delta });
            }
            if (result.state === 'passed') {
              target = result.candidate;
              generation++;
              count++;
              advanced = true;
              prefix.push({
                revisionId: id,
                candidate: target,
                reviewId: result.reviewId,
                ...(result.discussionSequence
                  ? { discussionSequence: result.discussionSequence }
                  : {}),
                ...(result.discussion ? { discussion: result.discussion } : {})
              });
            }
            projected.set(id, result);
            remaining.delete(id);
            this.db.exec('RELEASE native_queue_trial');
          } catch (error) {
            this.db.exec('ROLLBACK TO native_queue_trial; RELEASE native_queue_trial');
            if (![400, 403, 404, 409].includes(error.status)) throw error;
            const waiting = error.code === 'NATIVE_PREREQUISITE_WAIT';
            projected.set(id, {
              revisionId: id,
              repository: r.repository,
              epoch: r.epoch,
              expectedTarget: target,
              expectedGeneration: generation,
              state: waiting ? 'waiting' : 'invalid',
              reason: error.message,
              projection: context()
            });
            if (!waiting) remaining.delete(id);
          } finally {
            session?.close();
          }
        }
      }
    } finally {
      this.db.exec('ROLLBACK TO native_queue_projection; RELEASE native_queue_projection');
    }
    let changed = false;
    for (const row of items) {
      const preview = projected.get(row.revisionId) ?? {
        revisionId: row.revisionId,
        repository: a.repository,
        epoch: a.epoch,
        expectedTarget: target,
        expectedGeneration: generation,
        state: 'deferred',
        projection: context()
      };
      if (this.#remember(row, preview)) changed = true;
    }
    this.#cached = {
      universe,
      input,
      head,
      frames,
      previews: projected,
      ids: new Map(this.#items().map((q) => [q.revisionId, q.previewId]))
    };
    return changed;
  }
  take(id) {
    this.#writer();
    this.ensure(id);
    this.run();
    const q = this.db
      .prepare(
        'SELECT p.record FROM native_queue_entries q JOIN native_queue_previews p ON p.id=q.previewId WHERE q.revisionId=?'
      )
      .get(id);
    const p = q && JSON.parse(q.record);
    need(p, 'Native submission is no longer eligible for the queue');
    const head = this.native.ref({ repository: p.repository, name: 'mainline' });
    if (
      ['waiting', 'deferred'].includes(p.state) ||
      p.expectedTarget !== head.revisionId ||
      p.expectedGeneration !== head.generation
    )
      wait(p.reason ?? 'An earlier reviewed candidate has priority in the projected native queue.');
    const { check } = this.review.check(id, head.revisionId, head.generation);
    const { projection, discussionSequence = 0, ...expected } = p;
    const { discussionSequence: currentSequence = 0, ...actual } = summary(
      this.db,
      check,
      this.review.view(id).revision
    );
    need(
      currentSequence >= discussionSequence && same(actual, expected),
      'Native approval, dependency or exact projected candidate changed'
    );
    return { check };
  }
  status() {
    const items = this.#items().map((row) => ({
      sequence: row.sequence,
      revisionId: row.revisionId,
      preview: row.previewId
        ? JSON.parse(
            this.db
              .prepare('SELECT record FROM native_queue_previews WHERE id=?')
              .get(row.previewId).record
          )
        : null
    }));
    return { profile: 'native-fifo-projection-v1', capacity: 32, batchLimit: 4, items };
  }
}
// Reconstruct scratch candidates from the retained starting mainline and immutable
// reviewed deltas. Historical archive inspection never writes provisional objects.
function verifyProjection(db, p) {
  const native = new NativeStore({ db }),
    ctx = p.projection;
  need(
    ctx &&
      Array.isArray(ctx.prefix) &&
      ctx.prefix.length <= 4 &&
      p.expectedGeneration === ctx.generation + ctx.prefix.length &&
      db
        .prepare(
          "SELECT 1 FROM native_ref_events WHERE repository=? AND name='mainline' AND generation=? AND revisionId=?"
        )
        .get(p.repository, ctx.generation, ctx.source),
    'Native projection lost its confirmed base generation'
  );
  const snapshot = native.select({ repository: p.repository, revisionId: ctx.source }),
    files = new Map(snapshot.entries.map((e) => [e.path, { ...e, source: ctx.source }]));
  const ancestry = new Set();
  for (let id = ctx.source; id; ) {
    ancestry.add(id);
    id = native.revision({ repository: p.repository, revisionId: id }).parents[0];
  }
  let target = ctx.source;
  const projectedLandings = new Map();
  function prerequisitePins(revision) {
    return nativePrerequisites(db, revision, { historical: true }).map((id) => {
      const row = db.prepare('SELECT record FROM native_submissions WHERE id=?').get(id);
      const dep = JSON.parse(row.record);
      let placement = projectedLandings.get(id);
      if (!placement) {
        const event = db
          .prepare(
            `SELECT e.revisionId AS target,e.generation FROM native_landings l JOIN native_ref_events e ON e.operationId=l.operationId
          AND e.revisionId=json_extract(l.record,'$.candidate') AND e.generation=json_extract(l.record,'$.generation')
          WHERE l.revisionId=? AND e.repository=? AND e.name='mainline' AND e.generation<=?`
          )
          .get(id, p.repository, ctx.generation);
        need(event, 'Projected prerequisite lacks a confirmed or preceding projected landing');
        placement = event;
      }
      const file = files.get(dep.path);
      need(
        file?.mode === '100644' && file.fileId === dep.newFileId,
        'Projected prerequisite differs from the retained path'
      );
      return {
        revisionId: id,
        target: placement.target,
        generation: placement.generation,
        fileId: dep.newFileId
      };
    });
  }
  function evaluate(id, reviewId, evidence) {
    const raw = db.prepare('SELECT record FROM native_submissions WHERE id=?').get(id);
    const approval = db
      .prepare('SELECT record FROM native_reviews WHERE revisionId=? AND id=?')
      .get(id, reviewId);
    const r = raw && JSON.parse(raw.record),
      review = approval && JSON.parse(approval.record);
    need(
      r && r.repository === p.repository && r.epoch === p.epoch && review?.decision === 'approve',
      'Projected candidate lost its immutable independent approval'
    );
    const cutoff = evidence.discussionSequence ?? 0;
    need(
      Number.isSafeInteger(cutoff) &&
        cutoff >= 0 &&
        (!cutoff ||
          db.prepare('SELECT 1 FROM native_review_actions WHERE sequence=?').get(cutoff)) &&
        same(seriesGateAt(db, r, review, cutoff) ?? null, evidence.discussion ?? null),
      'Native speculative discussion evidence differs from its historical review'
    );
    const prerequisites = prerequisitePins(r),
      old = files.get(r.path);
    if (!ancestry.has(r.base) || old?.mode !== '100644' || old.fileId !== r.oldFileId)
      return {
        candidate: null,
        state: 'conflict',
        prerequisites,
        failures: ['Reviewed source path or base ancestry changed.']
      };
    const change = native.revision({ repository: p.repository, revisionId: r.commit });
    const candidate =
      r.base === target
        ? r.commit
        : nativeRevisionId({
            repository: p.repository,
            parents: [target, r.commit],
            edits: change.edits,
            author: change.author,
            committer: change.committer,
            message: 'Compose independently reviewed native change',
            provenance: { principal: 'native-review', taskId: null }
          });
    files.set(r.path, { ...change.edits[0], source: r.commit });
    const read = (path) => {
      const file = files.get(path);
      return file ? native.file({ repository: p.repository, revisionId: file.source, path }) : null;
    };
    const failures = evaluateFileRecipe(read, r.policy.checks);
    if (r.path.endsWith('.json'))
      try {
        JSON.parse(read(r.path).bytes.toString('utf8'));
      } catch {
        failures.push({ reason: 'Changed JSON is invalid.' });
      }
    return { candidate, state: failures.length ? 'failed' : 'passed', failures, prerequisites };
  }
  const used = new Set();
  for (const step of ctx.prefix) {
    const result = evaluate(step.revisionId, step.reviewId, step);
    need(
      !used.has(step.revisionId) &&
        result.state === 'passed' &&
        result.candidate === step.candidate,
      'Projected queue prefix differs from its reviewed source or checks'
    );
    used.add(step.revisionId);
    target = result.candidate;
    ancestry.add(target);
    projectedLandings.set(step.revisionId, { target, generation: ctx.generation + used.size });
  }
  need(
    target === p.expectedTarget && !used.has(p.revisionId),
    'Native speculative target differs from its ordered prefix'
  );
  if (p.reviewId) {
    const result = evaluate(p.revisionId, p.reviewId, p);
    need(
      result.candidate === p.candidate &&
        result.state === p.state &&
        same(result.prerequisites, p.prerequisites) &&
        same(result.failures, p.failures),
      'Native speculative result differs from recomputed candidate'
    );
  }
}
export function verifyNativeQueue(db) {
  let entries = 0,
    previews = 0;
  for (const row of db.prepare('SELECT * FROM native_queue_previews').iterate()) {
    const p = JSON.parse(row.record),
      s = db.prepare('SELECT record FROM native_submissions WHERE id=?').get(row.revisionId),
      r = s && JSON.parse(s.record);
    need(
      r &&
        digest(p) === row.id &&
        p.revisionId === r.id &&
        p.repository === r.repository &&
        p.epoch === r.epoch &&
        ['waiting', 'invalid', 'deferred', 'failed', 'conflict', 'passed'].includes(p.state) &&
        /^[a-f0-9]{64}$/.test(p.expectedTarget) &&
        Number.isSafeInteger(p.expectedGeneration) &&
        p.expectedGeneration > 0,
      'Native speculative evidence lost its exact subject'
    );
    const checked = ['passed', 'failed', 'conflict'].includes(p.state);
    need(
      checked
        ? typeof p.reviewId === 'string' && p.reviewId.length > 0
        : !Object.hasOwn(p, 'reviewId') &&
            !Object.hasOwn(p, 'candidate') &&
            !Object.hasOwn(p, 'prerequisites'),
      'Native speculative result lacks its exact review or includes evidence outside its state'
    );
    if (p.reviewId) {
      const d = db
          .prepare('SELECT record FROM native_reviews WHERE id=? AND revisionId=?')
          .get(p.reviewId, r.id),
        review = d && JSON.parse(d.record);
      need(
        review?.decision === 'approve' &&
          review.patchDigest === p.patchDigest &&
          p.policyDigest === r.policyDigest &&
          p.recipeDigest === r.policy.recipeDigest,
        'Native projection lost its original review'
      );
    }
    verifyProjection(db, p);
    previews++;
  }
  for (const q of db.prepare('SELECT * FROM native_queue_entries').iterate()) {
    if (q.previewId)
      need(
        db
          .prepare('SELECT 1 FROM native_queue_previews WHERE id=? AND revisionId=?')
          .get(q.previewId, q.revisionId),
        'Queue references the wrong preview'
      );
    entries++;
  }
  return { entries, previews, ...verifyNativeRegression(db) };
}
