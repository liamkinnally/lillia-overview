import { verifiedProjectLanding } from './project-review-proof.mjs';
import { reviewInbox } from './review-inbox.mjs';
import { researchForDevelopment, researchPin } from './research-disclosure.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { NativeStore, validateNativeId } from './native-store.mjs';
import { NativeOperations } from './native-operations.mjs';
import { makeReviewRecipe } from './git-review-recipe.mjs';
import { validateNativeReviewPath } from './native-review.mjs';
import { NativeReviewSeries } from './native-series.mjs';
import { nativePolicyAt, pathAdmitted, hasSeries } from './native-policy.mjs';
import {
  normalizeGitCutover,
  qualifyGitCutover,
  readCutover,
  verifyCutoverRecord,
  verifyGitCutoverGraph
} from './git-cutover.mjs';
import { normalizeDevelopment } from './change-flow.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requireValue(ok, message, status = 409) {
  if (!ok) throw Object.assign(Error(message), { status });
}
export function normalizeActivation(input) {
  requireValue(
    input &&
      Object.keys(input).length === 6 &&
      ['repository', 'draft', 'revision', 'expectedGeneration', 'allowedPaths', 'checks'].every(
        (k) => Object.hasOwn(input, k)
      ),
    'Expected a named draft, exact revision and generation, review paths and checks.',
    400
  );
  const { repository, draft, revision, expectedGeneration } = input;
  validateNativeId(revision);
  requireValue(
    Number.isSafeInteger(expectedGeneration) && expectedGeneration >= 1,
    'Invalid seed generation.',
    400
  );
  requireValue(
    Array.isArray(input.allowedPaths) && input.allowedPaths.length <= 32,
    'Select up to 32 review paths.',
    400
  );
  const allowedPaths = input.allowedPaths.map(validateNativeReviewPath).sort();
  requireValue(
    new Set(allowedPaths.map((p) => p.toLowerCase())).size === allowedPaths.length,
    'Native agent review requires unique, unprotected source paths.',
    400
  );
  const { checks } = makeReviewRecipe(repository, revision, input.checks);
  return { repository, draft, revision, expectedGeneration, allowedPaths, checks };
}
export function installNativeAuthority(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS native_authority(slot INTEGER PRIMARY KEY CHECK(slot=1),epoch TEXT UNIQUE NOT NULL,
    operationId TEXT UNIQUE NOT NULL,admission TEXT NOT NULL,record TEXT NOT NULL);`);
}
function record(input, epoch, operationId) {
  const { repository, revision: seed, allowedPaths, checks } = input;
  const ref = 'mainline',
    policyDigest = hash({ version: 1, repository, epoch, ref, seed, allowedPaths, checks });
  return { repository, epoch, ref, seed, policyDigest, allowedPaths, checks, operationId };
}
export class NativeAuthority {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.source = new NativeStore(store);
    this.drafts = new NativeOperations(store);
  }
  activate(input, operationId) {
    requireValue(this.db.isTransaction, 'Activation requires an owner command receipt.');
    requireValue(
      !this.db.prepare('SELECT 1 FROM native_authority').get(),
      'Native authority is already active.'
    );
    requireValue(
      !this.db.prepare('SELECT 1 FROM review_main').get(),
      'This installation already has a protected Git mainline.'
    );
    return this.#seed(input, operationId);
  }
  migrate(raw, operationId, verifyHistory) {
    const input = normalizeGitCutover(raw);
    requireValue(
      !readCutover(this.db) && !this.db.prepare('SELECT 1 FROM native_authority').get(),
      'This installation already has a native writer.'
    );
    const { main, migration } = qualifyGitCutover(this.db, input, verifyHistory);
    const { repository, draft, revision, expectedGeneration } = input;
    const activation = normalizeActivation({
      repository,
      draft,
      revision,
      expectedGeneration,
      allowedPaths: main.nativeReviewPaths,
      checks: main.checks
    });
    const result = this.#seed(activation, operationId);
    this.db
      .prepare('INSERT INTO git_cutover VALUES(1,?,?,?)')
      .run(operationId, JSON.stringify(input), JSON.stringify(migration));
    return { ...result, migration };
  }
  #seed(input, operationId) {
    const { draft } = this.drafts.query('native.ref', {
      repository: input.repository,
      name: input.draft
    });
    requireValue(
      draft.revisionId === input.revision && draft.generation === input.expectedGeneration,
      'Native seed draft changed.'
    );
    for (const path of input.allowedPaths) {
      const file = this.source.file({
        repository: input.repository,
        revisionId: input.revision,
        path
      });
      requireValue(
        file.mode === '100644' && file.bytes.length <= 4096,
        'Granted source must be a regular file of at most 4 KiB.'
      );
    }
    const authority = record(input, randomUUID(), operationId);
    this.source.advanceRef({
      repository: input.repository,
      name: authority.ref,
      revisionId: input.revision,
      expectedRevision: null,
      expectedGeneration: 0,
      operationId
    });
    this.db
      .prepare('INSERT INTO native_authority VALUES(1,?,?,?,?)')
      .run(authority.epoch, operationId, JSON.stringify(input), JSON.stringify(authority));
    return { authority };
  }
  current(requestedDigest) {
    const row = this.db.prepare('SELECT * FROM native_authority WHERE slot=1').get();
    if (!row) return null;
    const input = normalizeActivation(JSON.parse(row.admission)),
      value = record(input, row.epoch, row.operationId);
    const receipt = this.db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(row.operationId);
    const event = this.db
      .prepare('SELECT * FROM native_ref_events WHERE operationId=?')
      .get(row.operationId);
    const retired = readCutover(this.db);
    let expectedReceipt = { operationId: row.operationId, authority: value },
      expectedDigest = hash(['authority.activate', input]);
    if (retired) {
      const proof = verifyCutoverRecord(this.db, retired),
        { repository, draft, revision, expectedGeneration } = proof.input;
      requireValue(
        retired.operationId === row.operationId &&
          isDeepStrictEqual(
            input,
            normalizeActivation({
              repository,
              draft,
              revision,
              expectedGeneration,
              allowedPaths: proof.main.nativeReviewPaths,
              checks: proof.main.checks
            })
          ),
        'Native policy differs from retired Git scope.'
      );
      expectedDigest = hash(['authority.migrate', proof.input]);
      expectedReceipt = { ...expectedReceipt, migration: proof.migration };
    } else
      requireValue(
        !this.db.prepare('SELECT 1 FROM review_main').get(),
        'Git and native protected writers conflict.'
      );
    requireValue(
      isDeepStrictEqual(value, JSON.parse(row.record)) &&
        receipt?.digest === expectedDigest &&
        isDeepStrictEqual(JSON.parse(receipt.receipt), expectedReceipt) &&
        event?.name === value.ref &&
        event.repository === value.repository &&
        event.revisionId === value.seed &&
        event.generation === 1 &&
        !event.expectedRevision,
      'Native activation, exclusive target or original owner receipt is inconsistent.'
    );
    return nativePolicyAt(this.db, value, requestedDigest);
  }
  status() {
    const authority = this.current(),
      mainline = authority
        ? this.source.ref({ repository: authority.repository, name: authority.ref })
        : null;
    if (mainline) {
      const event = this.db
        .prepare('SELECT * FROM native_ref_events WHERE repository=? AND name=? AND generation=?')
        .get(authority.repository, authority.ref, mainline.generation);
      requireValue(
        event?.revisionId === mainline.revisionId,
        'Protected native target lacks a publication event.'
      );
      if (mainline.generation === 1)
        requireValue(event.operationId === authority.operationId, 'Native seed event changed.');
      else {
        const row = this.db
          .prepare('SELECT record FROM native_landings WHERE operationId=?')
          .get(event.operationId);
        const project = verifiedProjectLanding(this.db, event);
        requireValue(!row || !project, 'Two authorities claim the same landing.');
        const landed = project ?? (row && JSON.parse(row.record));
        requireValue(
          landed?.candidate === mainline.revisionId && landed.generation === mainline.generation,
          'Protected native target lacks a matching reviewed landing.'
        );
      }
    }
    const cutover = readCutover(this.db);
    return {
      authority,
      mainline,
      ...(cutover
        ? { migration: { operationId: cutover.operationId, ...JSON.parse(cutover.record) } }
        : {})
    };
  }
  submissions(input) {
    return reviewInbox(this.db, this.current(), input);
  }
  reviewView(review, id) {
    const detail = review.view(id),
      r = detail.revision,
      a = this.current(r.policyDigest);
    requireValue(
      a &&
        r.repository === a.repository &&
        r.epoch === a.epoch &&
        r.policyDigest === a.policyDigest &&
        pathAdmitted(a, r),
      'Submission exceeds the active native review policy.',
      403
    );
    const read = (revisionId) => {
      const f = this.source.file({ repository: r.repository, revisionId, path: r.path });
      requireValue(
        f.bytes.length <= 4096 && f.mode === '100644',
        'Review file exceeds its retained grant.'
      );
      return new TextDecoder('utf-8', { fatal: true }).decode(f.bytes);
    };
    const releases = this.db
      .prepare(
        `SELECT id,artifactDigest,json_extract(record,'$.state') AS state FROM native_release_candidates
      WHERE revisionId=? ORDER BY rowid DESC LIMIT 256`
      )
      .all(id);
    let discussion;
    if (hasSeries(this.db)) {
      const t = new NativeReviewSeries(this.store, { authority: () => a, review }).thread({
        revisionId: id
      });
      discussion = {
        seriesId: t.seriesId,
        latestRevisionId: t.latestRevisionId,
        versions: t.versions,
        actions: t.actions,
        openFindings: t.openFindings,
        requiredOwner: t.requiredOwner,
        independentHumanRequired: t.independentHumanRequired
      };
    }
    return {
      ...detail,
      ...(discussion ? { discussion } : {}),
      diff: { path: r.path, oldText: read(r.base), newText: read(r.commit) },
      releases
    };
  }
  fenceGit() {
    requireValue(
      !this.db.prepare('SELECT 1 FROM native_authority').get(),
      'This protected target uses native authority.'
    );
  }
}

export const nativeAuthorityTables = ['native_authority', 'native_goals', 'native_roles'];
export function verifyNativeWorkflow(db) {
  const current = new NativeAuthority({ db }),
    { authority } = current.status();
  const count = (table, where = '') =>
    db.prepare('SELECT count(*) n FROM ' + table + ' ' + where).get().n;
  requireValue(
    count(
      'command_receipts',
      "WHERE json_type(receipt,'$.authority.epoch')='text' AND json_type(receipt,'$.authority.policyVersion') IS NULL"
    ) === (authority ? 1 : 0),
    'Historical native activation is missing.'
  );
  requireValue(
    !db
      .prepare(
        `SELECT 1 FROM command_receipts r LEFT JOIN native_goals f ON f.operationId=json_extract(r.receipt,'$.flow.operationId')
    WHERE json_type(r.receipt,'$.flow.epoch')='text' AND json_type(r.receipt,'$.flow.admission.base')='text'
    AND (f.goalId IS NULL OR f.goalId IS NOT json_extract(r.receipt,'$.goal.id')) LIMIT 1`
      )
      .get() &&
      !db
        .prepare(
          `SELECT 1 FROM goal_revisions r,json_each(r.criteria) c WHERE json_extract(c.value,'$.verifier')='reviewed-native-change'
      AND NOT EXISTS(SELECT 1 FROM native_goals f WHERE f.goalId=r.id) LIMIT 1`
        )
        .get(),
    'An acknowledged native development flow is missing.'
  );
  if (!authority) {
    requireValue(
      !readCutover(db) &&
        !count('native_goals') &&
        !count('native_roles') &&
        !count('native_submissions') &&
        !count('native_reviews') &&
        !count('native_refs', "WHERE name='mainline'"),
      'Native mainline or submitted work lacks authority.'
    );
    return { active: false, goals: 0, roles: 0 };
  }
  const transition = readCutover(db);
  if (transition) verifyGitCutoverGraph(db, verifyCutoverRecord(db, transition).migration);
  const { repository, epoch, ref } = authority;
  for (const event of db.prepare('SELECT * FROM native_ref_events WHERE name=?').iterate(ref)) {
    requireValue(event.repository === repository, 'Unexpected protected native mainline.');
    if (event.generation === 1)
      requireValue(
        event.operationId === authority.operationId && event.revisionId === authority.seed,
        'Native seed publication is inconsistent.'
      );
    else {
      const row = db
          .prepare('SELECT record FROM native_landings WHERE operationId=?')
          .get(event.operationId),
        project = verifiedProjectLanding(db, event);
      requireValue(!row || !project, 'Two authorities claim the same landing.');
      const landing = project ?? (row && JSON.parse(row.record));
      requireValue(
        landing?.candidate === event.revisionId &&
          landing.generation === event.generation &&
          landing.expectedTarget === event.expectedRevision,
        'Native protected event lacks its exact reviewed landing.'
      );
    }
  }
  const flows = db.prepare('SELECT * FROM native_goals').all(),
    byGoal = new Map();
  for (const f of flows) {
    const input = normalizeDevelopment(JSON.parse(f.admission), { native: true });
    const receipt = db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(f.operationId);
    const admitted = receipt && JSON.parse(receipt.receipt).flow;
    const revision = db
      .prepare('SELECT objective,criteria FROM goal_revisions WHERE id=? AND version=?')
      .get(f.goalId, f.scopeVersion);
    requireValue(
      receipt?.digest === hash(['goal.develop', input]) &&
        admitted?.goalId === f.goalId &&
        admitted.epoch === f.epoch &&
        epoch === f.epoch &&
        repository === f.repository &&
        admitted.repository === repository &&
        isDeepStrictEqual(admitted.admission, input) &&
        revision?.objective === input.objective &&
        JSON.parse(revision.criteria)[0]?.verifier === 'reviewed-native-change' &&
        (['author', 'reviewer', 'check', 'land', 'completed', 'blocked', 'superseded'].includes(
          f.stage
        ) ||
          (f.stage === 'planner' && input.plannerProvider === 'codex')),
      'Historical native goal authorization differs from its original receipt.'
    );
    const research = researchForDevelopment({ db }, input, f.operationId, { historical: true });
    if (hasSeries(db)) {
      const pin = db
        .prepare('SELECT digest FROM native_policy_enrollments WHERE goalId=?')
        .get(f.goalId);
      requireValue(
        pin &&
          pin.digest ===
            (admitted.policyDigest ??
              JSON.parse(db.prepare('SELECT record FROM native_authority').get().record)
                .policyDigest) &&
          pathAdmitted(current.current(pin.digest), input),
        'Native goal lost its historical path policy'
      );
    }
    byGoal.set(f.goalId, { f, input, research });
  }
  const roles = new Map();
  for (const r of db
    .prepare(
      'SELECT r.*,g.provider,g.goalId AS taskGoal,g.specVersion,t.prompt FROM native_roles r JOIN goal_tasks g ON r.taskId=g.taskId JOIN tasks t ON t.id=r.taskId'
    )
    .iterate()) {
    const f = byGoal.get(r.goalId);
    requireValue(
      f &&
        r.taskGoal === r.goalId &&
        r.specVersion === 1 &&
        ['author', 'reviewer'].includes(r.role) &&
        f.input[r.role + 'Provider'] === r.provider &&
        r.cycle >= 1 &&
        r.cycle <= f.f.cycle &&
        createHash('sha256').update(r.prompt).digest('hex') === r.promptDigest,
      'Native role differs from its owner goal or prompt.'
    );
    const packet = JSON.parse(r.prompt),
      finding = r.role === 'author' ? packet.researchFinding : packet.packet?.researchFinding;
    requireValue(
      isDeepStrictEqual(finding, f.research?.material),
      'Historical role research differs from its authorized projection.'
    );
    for (const ctx of db
      .prepare('SELECT manifest FROM task_contexts WHERE taskId=?')
      .iterate(r.taskId))
      requireValue(
        isDeepStrictEqual(JSON.parse(ctx.manifest).research ?? null, researchPin(f.research)),
        'Historical native dispatch lost its disclosure binding.'
      );
    roles.set(r.taskId, r);
  }
  for (const { f } of byGoal.values()) {
    const a = roles.get(f.authorTaskId),
      r = roles.get(f.reviewerTaskId);
    if (!f.authorTaskId && byGoal.get(f.goalId).input.plannerProvider === 'codex') {
      requireValue(
        !r && !f.revisionId && ['planner', 'blocked', 'superseded'].includes(f.stage),
        'Native planned goal lost its author'
      );
      continue;
    }
    requireValue(
      a?.goalId === f.goalId &&
        a.role === 'author' &&
        a.cycle === f.cycle &&
        (!f.reviewerTaskId ||
          (r?.goalId === f.goalId && r.role === 'reviewer' && r.cycle === f.cycle)),
      'Native flow role references are inconsistent.'
    );
  }
  for (const row of db.prepare('SELECT record FROM native_submissions').iterate()) {
    const r = JSON.parse(row.record),
      g = byGoal.get(r.goalId),
      role = roles.get(r.author.taskId);
    const policy = current.current(r.policyDigest);
    if (hasSeries(db))
      requireValue(
        db.prepare('SELECT digest FROM native_policy_enrollments WHERE goalId=?').get(r.goalId)
          ?.digest === r.policyDigest,
        'Native revision policy differs from its owner-admitted goal'
      );
    requireValue(
      pathAdmitted(policy, r) &&
        r.jsRecipe === g?.input.jsRecipe &&
        r.ownerPolicy === g?.input.ownerPolicy &&
        isDeepStrictEqual(r.policy.ownerReviewPaths ?? [], policy.ownerReviewPaths ?? []) &&
        g &&
        role?.goalId === r.goalId &&
        role.role === 'author' &&
        g.input.base === r.base &&
        g.input.path === r.path &&
        g.input.objective === r.objective &&
        isDeepStrictEqual(r.research ?? null, g.research) &&
        isDeepStrictEqual(r.requires ?? [], g.input.requires ?? []) &&
        r.feedback === role.feedback &&
        r.policy.seed === policy.seed &&
        r.policy.policyDigest === policy.policyDigest &&
        isDeepStrictEqual(r.policy.allowedPaths, policy.allowedPaths) &&
        isDeepStrictEqual(r.policy.checks, policy.checks) &&
        r.scopeVersion === g.f.scopeVersion &&
        r.epoch === epoch &&
        r.repository === repository,
      'Retained native submission exceeds its role delegation.'
    );
  }
  for (const row of db
    .prepare(
      'SELECT r.record,s.record AS submission FROM native_reviews r JOIN native_submissions s ON s.id=r.revisionId'
    )
    .iterate()) {
    const r = JSON.parse(row.record),
      s = JSON.parse(row.submission),
      role = roles.get(r.evidence.taskId);
    requireValue(
      role?.role === 'reviewer' &&
        role.goalId === s.goalId &&
        roles.get(s.author.taskId)?.cycle === role.cycle,
      'Native decision lacks its independent delegated role.'
    );
  }
  for (const { f } of byGoal.values()) {
    if (f.stage !== 'completed') continue;
    const proof = JSON.parse(f.evidence),
      done = db.prepare('SELECT snapshot FROM goal_completions WHERE goalId=?').get(f.goalId);
    const stored = (table, id) => {
      const row = db.prepare('SELECT record FROM ' + table + ' WHERE id=?').get(id);
      return row && JSON.parse(row.record);
    };
    const landing = db
      .prepare('SELECT record FROM native_landings WHERE revisionId=? AND checkId=?')
      .get(f.revisionId, f.checkId);
    requireValue(
      isDeepStrictEqual(proof.research ?? null, researchPin(byGoal.get(f.goalId).research)) &&
        proof.epoch === epoch &&
        proof.repository === repository &&
        proof.revisionId === f.revisionId &&
        isDeepStrictEqual(proof.decision, stored('native_reviews', f.decisionId)) &&
        isDeepStrictEqual(proof.check, stored('native_checks', f.checkId)) &&
        proof.decision.decision === 'approve' &&
        proof.check.state === 'passed' &&
        isDeepStrictEqual(proof.author, stored('native_submissions', f.revisionId)?.author) &&
        isDeepStrictEqual(proof.reviewer, proof.decision.evidence) &&
        isDeepStrictEqual(proof.landing, landing && JSON.parse(landing.record)) &&
        isDeepStrictEqual(done && JSON.parse(done.snapshot).evidence, [proof]),
      'Historical native goal lacks its exact checked and landed evidence.'
    );
  }
  return { active: true, epoch, repository, goals: flows.length, roles: roles.size };
}
