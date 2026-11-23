import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { NativeStore, validateNativeId, validateNativeLabel } from './native-store.mjs';
import { GitReview } from './git-review.mjs';
import { verifyGitBridge } from './git-bridge.mjs';
import { budget, need, readBundle } from './git-bridge-format.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ordered = (value) =>
  Array.isArray(value)
    ? value.map(ordered)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, ordered(value[k])])
        )
      : value;
const fields = [
  'target',
  'generation',
  'repository',
  'draft',
  'revision',
  'expectedGeneration',
  'cutoff',
  'drainGeneration'
];
export function normalizeGitCutover(value) {
  need(
    value &&
      typeof value === 'object' &&
      Object.keys(value).length === fields.length &&
      fields.every((k) => Object.hasOwn(value, k)),
    'Select exact Git and draft revisions, generations and named drain.',
    400
  );
  need(
    typeof value.target === 'string' &&
      /^[a-f0-9]{40}$/.test(value.target) &&
      ['generation', 'expectedGeneration', 'drainGeneration'].every(
        (k) => Number.isSafeInteger(value[k]) && value[k] > 0
      ) &&
      typeof value.cutoff === 'string' &&
      /^[a-zA-Z0-9._:-]{1,128}$/.test(value.cutoff),
    'Invalid Git target, drain cutoff or generation.',
    400
  );
  validateNativeId(value.revision);
  validateNativeLabel(value.repository);
  validateNativeLabel(value.draft);
  return Object.fromEntries(fields.map((k) => [k, value[k]]));
}
const frozen = [
  'review_main',
  'review_changes',
  'review_versions',
  'review_agent_grants',
  'review_recipes',
  'review_candidates',
  'review_decisions',
  'review_checks',
  'review_landings',
  'review_dependencies',
  'change_flows',
  'change_delegations'
];
const fences = new Map();
fences.set(
  'cutover_git_dispatch',
  `BEFORE UPDATE OF status ON tasks
  WHEN EXISTS(SELECT 1 FROM git_cutover) AND EXISTS(SELECT 1 FROM change_delegations WHERE taskId=NEW.id)
    AND OLD.status IN ('queued','blocked') AND NEW.status IN ('starting','running','waiting_for_input','interrupting')
  BEGIN SELECT RAISE(ABORT,'Git protected task retired.'); END`
);
for (const table of frozen)
  for (const action of ['insert', 'update', 'delete'])
    fences.set(
      'cutover_' + table + '_' + action,
      'BEFORE ' +
        action +
        ' ON ' +
        table +
        " WHEN EXISTS(SELECT 1 FROM git_cutover) BEGIN SELECT RAISE(ABORT,'Git protected writer retired.'); END"
    );
export function installGitCutover(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS git_cutover(slot INTEGER PRIMARY KEY CHECK(slot=1),operationId TEXT UNIQUE NOT NULL,admission TEXT NOT NULL,record TEXT NOT NULL)'
  );
  for (const [name, body] of fences) db.exec('CREATE TRIGGER IF NOT EXISTS ' + name + ' ' + body);
}
function verifyFences(db) {
  const rows = new Map(
    db
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name GLOB 'cutover_*'")
      .all()
      .map((r) => [r.name, r.sql])
  );
  const compact = (sql) => sql?.replace(/\s+/g, ' ').trim();
  for (const [name, body] of fences)
    need(
      compact(rows.get(name)) === compact('CREATE TRIGGER ' + name + ' ' + body),
      'Git cutover lost a required writer fence.'
    );
}
export function readCutover(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='git_cutover'").get())
    return null;
  return (
    db.prepare('SELECT operationId,admission,record FROM git_cutover WHERE slot=1').get() ?? null
  );
}
function original(db, id) {
  const r = db.prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?').get(id);
  const receipt = r && JSON.parse(r.receipt);
  need(receipt?.operationId === id, 'Missing original migration evidence receipt.');
  return { ...r, receipt };
}
function pins(db, input) {
  const {
    target,
    generation,
    repository,
    draft,
    revision,
    expectedGeneration,
    cutoff,
    drainGeneration
  } = input;
  const main = new GitReview({ db }, {}).status().mainline;
  need(
    main && main.target === target && main.generation === generation,
    'Git mainline no longer matches selected target and generation.'
  );
  const init = db
    .prepare(
      "SELECT operationId,receipt FROM command_receipts WHERE json_extract(receipt,'$.mainline.generation')=1 AND json_extract(receipt,'$.mainline.target')=?"
    )
    .all(main.initial);
  need(
    init.length === 1,
    'Git cutover requires an unambiguous original protected-mainline initialization receipt.'
  );
  const bound = original(db, init[0].operationId),
    seed = bound.receipt.mainline;
  const initialInputs = [];
  for (const paths of [false, true])
    for (const recipe of [false, true]) {
      if ((!paths && main.nativeReviewPaths.length) || (!recipe && main.checks.length)) continue;
      initialInputs.push({
        base: main.initial,
        ...(paths ? { nativeReviewPaths: main.nativeReviewPaths } : {}),
        ...(recipe ? { checks: main.checks } : {})
      });
    }
  need(
    initialInputs.some((i) => hash(['review.init', ordered(i)]) === bound.digest),
    'Git initialization must have a reconstructible owner admission with sorted exact review paths.'
  );
  const captures = db
    .prepare(
      `SELECT c.metadata,r.operationId,r.digest,r.receipt FROM git_captures c JOIN command_receipts r
    ON json_extract(r.receipt,'$.capture.captureId')=c.id WHERE c.revision=? ORDER BY r.rowid`
    )
    .all(main.initial);
  const capture = captures.find((r) => {
    const metadata = JSON.parse(r.metadata),
      ack = JSON.parse(r.receipt);
    return (
      ack.operationId === r.operationId &&
      metadata.revision === main.initial &&
      isDeepStrictEqual(ack.capture, metadata) &&
      [
        hash(['project.register', {}]),
        hash(['project.register', { expectedRevision: main.initial }]),
        hash(['project.register', metadata.projectId, metadata.captureId, main.initial])
      ].includes(r.digest)
    );
  });
  need(capture, 'Git initial revision lacks an acknowledged owner project registration.');
  need(
    isDeepStrictEqual(seed, { ...main, target: main.initial, generation: 1 }),
    'Git policy differs from its acknowledged protected-mainline grant.'
  );
  const imported = db
    .prepare(
      'SELECT * FROM bridge_imports WHERE repository=? AND name=? AND gitId=? AND revisionId=?'
    )
    .get(repository, draft, target, revision);
  need(imported, 'Select a draft imported from this exact retained Git mainline.');
  const im = original(db, imported.operationId);
  need(
    im.digest === hash(['bridge.import', { repository, head: target, draft }]) &&
      im.receipt.draft?.sourceKind === 'git-import' &&
      im.receipt.draft.generation === expectedGeneration &&
      im.receipt.draft.revisionId === revision &&
      im.receipt.bridge?.commits === imported.commits,
    'Git bridge import differs from the acknowledged operation.'
  );
  const drain = original(db, cutoff);
  need(
    drain.receipt.drain?.mode === 'draining' &&
      drain.receipt.drain.cutoff === cutoff &&
      drain.receipt.drain.generation === drainGeneration &&
      drain.digest === hash(['daemon.drain', { expectedGeneration: drainGeneration - 1 }]),
    'Migration is missing its original named drain receipt.'
  );
  return {
    main,
    migration: {
      profile: 'retained-git-cutover-v1',
      ...input,
      initial: main.initial,
      scopeDigest: main.scopeDigest,
      recipeDigest: main.recipeDigest,
      captureOperation: capture.operationId,
      initOperation: init[0].operationId,
      importOperation: imported.operationId,
      commits: imported.commits
    }
  };
}
export function qualifyGitCutover(db, input, verifyHistory) {
  need(
    db.isTransaction && typeof verifyHistory === 'function',
    'Migration requires a writer transaction and independent Git history verification.'
  );
  const state = db.prepare('SELECT * FROM service_drain WHERE slot=1').get();
  need(
    state.mode === 'draining' &&
      state.cutoff === input.cutoff &&
      state.generation === input.drainGeneration,
    'Named drain cutoff or generation changed.'
  );
  const unresolved = [
    "SELECT 1 FROM tasks WHERE status IN ('queued','blocked','starting','running','waiting_for_input','interrupting') OR (status='recovery_needed' AND recoveryCleared=0)",
    "SELECT 1 FROM task_controls WHERE state IN ('pending','requested','sent','unconfirmed')",
    'SELECT 1 FROM pending_effects',
    "SELECT 1 FROM agent_workspaces WHERE state NOT IN ('released','reviewed','sealed')",
    "SELECT 1 FROM change_flows WHERE stage NOT IN ('completed','superseded')",
    'SELECT 1 FROM review_changes c WHERE NOT EXISTS(SELECT 1 FROM review_landings l WHERE l.version=c.latest)'
  ];
  need(
    unresolved.every((sql) => !db.prepare(sql + ' LIMIT 1').get()),
    'Git migration requires quiescence. Settle pending tasks, controls, changes, flows, workspaces and external effects first.'
  );
  const totals = db
    .prepare('SELECT count(*) n,coalesce(sum(length(bundle)),0) bytes FROM git_revisions')
    .get();
  need(
    totals.n <= 48 &&
      totals.bytes <= 48 * 1024 * 1024 &&
      db.prepare('SELECT count(*) n FROM bridge_imports').get().n <= 8 &&
      db.prepare('SELECT count(*) n FROM bridge_exports').get().n <= 8,
    'Migration exceeds the bounded history verification profile.'
  );
  const result = pins(db, input);
  verifyGitCutoverGraph(db, result.migration);
  verifyHistory(db);
  verifyGitBridge(db);
  return result;
}
export function verifyGitCutoverGraph(db, migration) {
  const { repository, revision, target, initial, commits: expected } = migration;
  verifyFences(db);
  const mainBundle = db.prepare('SELECT bundle FROM review_main WHERE slot=1').get()?.bundle;
  need(mainBundle, 'Retired protected Git mainline bundle is missing.');
  const deadline = budget(),
    { commits, files } = readBundle(Buffer.from(mainBundle), target, 'refs/heads/main', deadline);
  need(
    commits.size === expected && commits.has(initial),
    'Protected mainline ancestry differs from the selected imported Git graph.'
  );
  const native = new NativeStore({ db }),
    seen = new Map(),
    queue = [[revision, target]];
  const mapping = db.prepare(
    'SELECT gitId FROM bridge_mappings WHERE repository=? AND revisionId=?'
  );
  while (queue.length) {
    deadline();
    const [revisionId, gitId] = queue.pop(),
      old = seen.get(gitId);
    if (old) {
      need(old === revisionId, 'Native parent graph has conflicting Git identities.');
      continue;
    }
    const git = commits.get(gitId),
      r = native.revision({ repository, revisionId });
    need(
      git &&
        mapping.get(repository, revisionId)?.gitId === gitId &&
        r.parents.length === git.parents.length &&
        isDeepStrictEqual(r.author, git.author) &&
        isDeepStrictEqual(r.committer, git.committer) &&
        r.message === git.message &&
        r.provenance === null,
      'Cutover history has differing native parents, Git mapping or commit provenance.'
    );
    const tree = native.select({ repository, revisionId });
    need(
      tree.entries.length === git.tree.size,
      'Native and Git snapshots have different file counts.'
    );
    for (const entry of tree.entries) {
      deadline();
      const item = git.tree.get(entry.path);
      need(
        item?.mode === entry.mode && files.get(item.oid).equals(tree.read(entry.path).bytes),
        'Native and Git path, mode or bytes differ.'
      );
    }
    seen.set(gitId, revisionId);
    r.parents.forEach((id, index) => queue.push([id, git.parents[index]]));
  }
  need(seen.size === expected, 'Migration does not cover every mapped Git ancestor.');
}
export function verifyCutoverRecord(db, row) {
  const input = normalizeGitCutover(JSON.parse(row.admission)),
    { main, migration } = pins(db, input);
  need(
    isDeepStrictEqual(JSON.parse(row.record), migration),
    'Historical migration differs from its acknowledged Git target or evidence.'
  );
  return { input, main, migration };
}
