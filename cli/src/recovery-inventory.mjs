import { verifyMailRecoveryProjection } from './thread-mail-recovery-projection-verify.mjs';
import { verifyProjectedSettings } from './thread-mail-recovery-projection.mjs';
import { assertTrustedRecoverySchema } from './recovery-projection-schema.mjs';
import { verifyScopeRecovery, scopeRecoveryTables } from './subtree-scope-recovery.mjs';
import { verifyThreadMailStore } from './thread-mail-recovery.mjs';
import { verifyMailOwner } from './thread-mail-owner-recovery.mjs';
import { verifyMailDelivery } from './thread-mail-delivery-recovery.mjs';
import { verifyThreadMailAuthority } from './thread-mail-authority.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { verifyEffectiveConfigs } from './effective-config.mjs';
import { executionPinTable, verifyExecutionPins } from './execution-pins.mjs';
import { GitReview } from './git-review.mjs';
import { verifyInvestigations } from './investigations.mjs';
import { verifyReviewDependencies } from './review-dependencies.mjs';
import { verifyPlanFollowups } from './plan-followups.mjs';
import { verifyGitBridge } from './git-bridge.mjs';
import { verifyJobCapabilities } from './job-capabilities.mjs';
import { ResearchDisclosures } from './research-disclosure.mjs';
import { verifyNativeOwnership } from './native-operations.mjs';
import { NativeStore } from './native-store.mjs';
import { nativeReleaseTables, verifyNativeRelease } from './native-release.mjs';
import { verifyProjectChat } from './project-chat.mjs';
import { projectChatThreadTables, verifyProjectChatThreads } from './project-chat-threads.mjs';
import { verifyUpgradedProjectChatThreads } from './project-chat-thread-upgrade.mjs';
import { originTables, verifyChatOrigins } from './project-chat-origins.mjs';
import { attachmentPinTables, verifyAttachmentPins } from './project-chat-attachment-pins.mjs';
import { chatBranchTables } from './project-chat-branches.mjs';
import { verifyChatBranches } from './project-chat-branch-recovery.mjs';
import { branchThreadTable, verifyBranchThreads } from './project-chat-branch-threads.mjs';
import { branchRuntimeTable, verifyBranchRuntime } from './project-chat-branch-runtime.mjs';
import {
  chatContextTables,
  verifyChatContexts,
  chatSelectionTables,
  verifyChatSelections
} from './project-chat-contexts.mjs';
import { nativeReviewTables, verifyNativeReview } from './native-review.mjs';
import { libraryTables, verifyResearchLibrary } from './research-library.mjs';
import { reviewSeriesTables, verifyReviewSeries } from './native-series.mjs';
import { gitCompatibilityTables, verifyGitCompatibility } from './git-compatibility.mjs';
import { nativeQueueTables, verifyNativeQueue } from './native-queue.mjs';
import { nativeJavascriptTables, verifyNativeJavascript } from './native-javascript.mjs';
import { projectValidationTables, verifyProjectValidation } from './project-validation.mjs';
import { projectChangeTables } from './project-development.mjs';
import { verifyProjectReviewRecoveries } from './project-review-recovery.mjs';
import { verifyProjectWorkflows } from './project-review-proof.mjs';
import { verifyTaskHandoffs } from './task-handoff.mjs';
import { harnessGitTables, verifyHarnessGit } from './harness-git.mjs';
import {
  nativeObjectiveTables,
  verifyNativeObjectivePlanning
} from './native-objective-planning.mjs';
import { nativeAuthorityTables, verifyNativeWorkflow } from './native-authority.mjs';
import {
  hashed,
  check,
  schema,
  chatTables,
  bridgeTables,
  nativeJobTables,
  nativeTables,
  nativeOwnerTables
} from './recovery-format.mjs';

function verifyGitBundle(db, row, main = false, commitParents) {
  check(
    /^[0-9a-f]{40}$/.test(row.revision) &&
      row.retentionRef === (main ? 'refs/heads/main' : 'refs/scion/retained/' + row.revision),
    'Invalid retained revision identity.'
  );
  const bytes = Buffer.from(row.bundle.buffer, row.bundle.byteOffset, row.bundle.byteLength);
  const header = Buffer.from('# v2 git bundle\n' + row.revision + ' ' + row.retentionRef + '\n\n');
  check(
    bytes.subarray(0, header.length).equals(header) && bytes.length <= 33 * 1024 * 1024,
    'Invalid retained Git bundle header or size.'
  );
  const dir = mkdtempSync(path.join(tmpdir(), 'scion-closure-'));
  let treeId;
  try {
    function git(args, input) {
      try {
        return execFileSync(
          '/usr/bin/git',
          ['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', ...args],
          {
            env: {
              PATH: '/usr/bin:/bin',
              LANG: 'C',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_NO_REPLACE_OBJECTS: '1',
              GIT_ALLOW_PROTOCOL: '',
              GIT_TERMINAL_PROMPT: '0',
              GIT_ALLOC_LIMIT: '64m',
              GIT_DIR: dir
            },
            cwd: dir,
            input,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 15000,
            maxBuffer: 4 * 1024 * 1024
          }
        );
      } catch {
        throw new Error('Retained Git bundle failed closure verification.');
      }
    }
    git(['init', '--bare', '--template=', '--object-format=sha1', dir]);
    git(['index-pack', '--stdin', '--strict', '--threads=1'], bytes.subarray(header.length));
    git(['fsck', '--full', '--strict', '--no-dangling', '--no-reflogs', row.revision]);
    treeId = git(['rev-parse', row.revision + '^{tree}'])
      .toString('ascii')
      .trim();
    if (commitParents)
      commitParents.set(
        row.revision,
        git(['rev-list', '--parents', '-1', row.revision])
          .toString('ascii')
          .trim()
          .split(' ')
          .slice(1)
      );
    const stored = new Map(
      db
        .prepare('SELECT path,mode,oid FROM git_paths WHERE revision=?')
        .all(row.revision)
        .map((e) => [e.path, e])
    );
    const tree = git(['ls-tree', '--full-tree', '-rz', row.revision]).toString('utf8');
    for (const entry of tree.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      const [mode, , oid] = entry.slice(0, tab).split(' ');
      const name = entry.slice(tab + 1),
        actual = stored.get(name);
      check(
        tab > 0 && actual?.mode === mode && actual.oid === oid,
        'Retained Git tree and indexed path disagree.'
      );
      stored.delete(name);
    }
    check(stored.size === 0, 'Extra paths outside retained Git tree.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { revision: row.revision, tree: treeId, sha256: hashed(bytes), bytes: bytes.length };
}

export function checkRetainedEvidence(db, proof) {
  const attempt = db
    .prepare('SELECT * FROM attempts WHERE id=? AND taskId=?')
    .get(proof.attemptId, proof.taskId);
  check(
    attempt && attempt.accountInstance === proof.accountInstance,
    'Retained evidence attempt or account reference mismatch.'
  );
  const result =
    proof.driver === 'claude'
      ? db
          .prepare('SELECT digest FROM claude_results WHERE attemptId=? AND accountInstance=?')
          .get(proof.attemptId, proof.accountInstance)
      : db
          .prepare(
            'SELECT digest FROM task_final_outputs WHERE attemptId=? AND threadId=? AND turnId=? AND itemId=?'
          )
          .get(proof.attemptId, proof.threadId, proof.turnId, proof.itemId);
  check(result?.digest === proof.digest, 'Retained evidence has no matching native output.');
  if (proof.driver === 'claude')
    check(
      attempt.nativeSessionId === proof.sessionId &&
        attempt.nativeResultId === proof.resultId &&
        attempt.nativeMessageId === proof.messageId,
      'Claude result identity mismatch.'
    );
  if (proof.contextDigest)
    check(
      db
        .prepare('SELECT digest FROM task_contexts WHERE taskId=? AND ordinal=?')
        .get(proof.taskId, attempt.ordinal)?.digest === proof.contextDigest,
      'Author context digest mismatch.'
    );
}
export function verifyGitCutoverHistory(db) {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
      .all()
      .map((r) => r.name)
  );
  const parents = new Map(),
    bundles = [];
  for (const row of db.prepare('SELECT * FROM git_revisions ORDER BY revision').iterate())
    bundles.push(verifyGitBundle(db, row, false, parents));
  for (const row of db.prepare('SELECT oid,bytes FROM git_blobs').iterate())
    check(
      createHash('sha1')
        .update('blob ' + row.bytes.length + '\0')
        .update(row.bytes)
        .digest('hex') === row.oid,
      'Git cutover blob digest mismatch.'
    );
  for (const [table, column] of [
    ['task_contexts', 'manifest'],
    ['task_final_outputs', 'text'],
    ['claude_results', 'text']
  ]) {
    const rows = db.prepare(
      'SELECT digest,' + column + ' AS content FROM ' + table + ' WHERE ' + column + ' IS NOT NULL'
    );
    for (const row of rows.iterate())
      check(
        row.digest === hashed(row.content),
        'Retained evidence bytes differ from their recorded digest.'
      );
  }
  check(
    !db.prepare('PRAGMA foreign_key_check').get(),
    'Git migration has missing referenced records.'
  );
  verifyReviewDependencies(db);
  return reviewClosure(db, bundles, tables, parents);
}
function reviewClosure(db, gitBundles, tables, commitParents) {
  const main = db.prepare('SELECT * FROM review_main WHERE slot=1').get();
  const commits = new Map(gitBundles.map((r) => [r.revision, r.tree]));
  const versions = new Map();
  for (const row of db.prepare('SELECT * FROM review_versions ORDER BY rowid').iterate()) {
    const r = JSON.parse(row.record);
    const attempt = db.prepare('SELECT id,taskId FROM attempts WHERE id=?').get(row.attemptId);
    check(
      main &&
        r.id === row.id &&
        r.changeId === row.changeId &&
        r.commit === row.commitId &&
        commits.has(r.base) &&
        commits.get(r.commit) === r.tree &&
        attempt?.id === r.author?.attemptId &&
        attempt?.taskId === r.author?.taskId,
      'Review revision lost its author or exact committed tree.'
    );
    checkRetainedEvidence(db, r.author);
    versions.set(row.id, r);
  }
  for (const row of db.prepare('SELECT id,latest FROM review_changes').iterate())
    check(
      versions.get(row.latest)?.changeId === row.id,
      'Review change is missing its latest version.'
    );
  const decisions = new Map();
  const ownerReceipts = new Map();
  for (const row of db
    .prepare(
      "SELECT operationId,digest,receipt FROM command_receipts WHERE json_extract(receipt,'$.review.reviewer')='local-owner'"
    )
    .iterate()) {
    const result = JSON.parse(row.receipt),
      d = result.review;
    const input = { decision: d.decision, note: d.note, revisionId: d.revisionId };
    check(
      result.operationId === row.operationId &&
        row.digest === hashed(JSON.stringify(['review.decide', input])) &&
        !ownerReceipts.has(d.id),
      'The retained Git owner decision differs from its original command intent.'
    );
    ownerReceipts.set(d.id, d);
  }
  for (const row of db.prepare('SELECT * FROM review_decisions').iterate()) {
    const d = JSON.parse(row.record),
      v = versions.get(row.version);
    check(
      v && row.id === d.id && d.revisionId === v.id && d.commit === v.commit,
      'Missing exact review decision target.'
    );
    if (d.reviewerKind === 'native-agent') {
      check(
        d.evidence?.taskId === d.reviewerTaskId && d.reviewerTaskId !== v.author.taskId,
        'Independent reviewer evidence is missing.'
      );
      checkRetainedEvidence(db, d.evidence);
      const source =
        d.evidence.driver === 'claude'
          ? db
              .prepare('SELECT text FROM claude_results WHERE attemptId=?')
              .get(d.evidence.attemptId)
          : db
              .prepare('SELECT text FROM task_final_outputs WHERE attemptId=? AND itemId=?')
              .get(d.evidence.attemptId, d.evidence.itemId);
      const verdict = source && JSON.parse(source.text);
      check(
        verdict &&
          ['decision', 'note', 'revisionId', 'patchDigest'].every((k) => verdict[k] === d[k]),
        'Retained Git reviewer verdict differs from its native output.'
      );
    } else {
      check(
        d.reviewer === 'local-owner' && isDeepStrictEqual(ownerReceipts.get(d.id), d),
        'Missing or inconsistent retained Git owner decision receipt.'
      );
      ownerReceipts.delete(d.id);
    }
    decisions.set(d.id, d);
  }
  check(!ownerReceipts.size, 'An accepted Git owner decision is missing from review history.');
  const checks = new Map();
  for (const row of db.prepare('SELECT * FROM review_checks').iterate()) {
    const c = JSON.parse(row.record),
      v = versions.get(row.version);
    const contemporary = Object.hasOwn(c, 'submitted'),
      candidate =
        contemporary && tables.has('review_candidates')
          ? db.prepare('SELECT * FROM review_candidates WHERE checkId=?').get(c.id)
          : null;
    const candidateMatches = contemporary
      ? c.submitted === v?.commit &&
        (c.state === 'conflict'
          ? !candidate && !c.candidate
          : candidate?.revisionId === v?.id &&
            candidate.commitId === c.candidate &&
            commits.get(c.candidate) === c.tree &&
            candidate.target === c.target &&
            candidate.generation === c.generation &&
            candidate.recipeDigest === c.recipeDigest &&
            candidate.equivalence === c.equivalence &&
            candidate.parents === JSON.stringify(c.parents) &&
            isDeepStrictEqual(commitParents.get(c.candidate), c.parents) &&
            c.parents.every((parent) => commits.has(parent)))
      : c.tree === v?.tree && c.candidate === v?.commit;
    check(
      v &&
        row.id === c.id &&
        c.revisionId === v.id &&
        candidateMatches &&
        c.base === v.base &&
        commits.has(c.target) &&
        decisions.get(c.approvalId)?.revisionId === v.id,
      'Missing exact check inputs or review approval.'
    );
    checks.set(c.id, c);
  }
  let generation = 1,
    target = main?.initial;
  for (const row of db.prepare('SELECT * FROM review_landings ORDER BY generation').iterate()) {
    const landed = JSON.parse(row.record),
      v = versions.get(row.version),
      c = checks.get(landed.checkId);
    check(
      v &&
        c?.state === 'passed' &&
        (c.submitted ?? c.candidate) === v.commit &&
        c.target === target &&
        c.generation === generation &&
        c.approvalId === landed.approvalId &&
        decisions.get(c.approvalId)?.decision === 'approve' &&
        row.generation === generation + 1 &&
        landed.generation === row.generation &&
        landed.previous === target &&
        landed.target === c.candidate &&
        landed.revisionId === v.id,
      'Broken retained landing or mainline generation.'
    );
    target = landed.target;
    generation = row.generation;
  }
  if (tables.has('review_agent_grants')) {
    const grant = db.prepare('SELECT * FROM review_agent_grants').get();
    if (grant) {
      const projectId = db
        .prepare('SELECT project FROM git_revisions WHERE revision=?')
        .get(grant.initial)?.project;
      const expected = hashed(
        JSON.stringify({
          version: 1,
          projectId,
          initial: grant.initial,
          ref: 'refs/heads/main',
          paths: JSON.parse(grant.paths)
        })
      );
      check(
        grant.initial === main?.initial && grant.version === 1 && expected === grant.digest,
        'Review path grant is missing its initial mainline or digest.'
      );
    }
    if (tables.has('review_recipes') && main) new GitReview({ db }, {}).status();
  }
  if (!main) return null;
  check(
    commits.has(main.initial) && target === main.target && generation === main.generation,
    'Private mainline differs from its retained landing history.'
  );
  return verifyGitBundle(
    db,
    { revision: target, retentionRef: 'refs/heads/main', bundle: main.bundle },
    true
  );
}

function verifyResearch(db, blobIds) {
  const read = db.prepare('SELECT bytes FROM research_blobs WHERE digest=?');
  function json(id) {
    check(blobIds.has(id), 'Missing research object in recovery closure.');
    return JSON.parse(Buffer.from(read.get(id).bytes).toString('utf8'));
  }
  for (const row of db
    .prepare('SELECT version,summary FROM research_versions ORDER BY version')
    .iterate()) {
    const s = JSON.parse(row.summary);
    check(
      row.version === hashed('research-v1\0' + s.manifestDigest + '\0' + s.catalogDigest),
      'Invalid research version identity.'
    );
    const manifest = json(s.manifestDigest),
      catalog = json(s.catalogDigest);
    const entries = new Map(manifest.files.map((f) => [f.path, f]));
    const paths = [
      'data/catalog.json',
      ...catalog.documents.map((d) => d.local_path),
      ...catalog.snapshots.filter((v) => v.manifest_path).map((v) => v.manifest_path)
    ];
    for (const name of paths)
      check(blobIds.has(entries.get(name)?.sha256), 'Missing research capture or snapshot object.');
    check(
      entries.get('data/catalog.json')?.sha256 === s.catalogDigest &&
        catalog.documents.every((d) => entries.get(d.local_path)?.sha256 === d.sha256),
      'Research document or catalog manifest digest mismatch.'
    );
    const edges = new Map(
      catalog.relations.map((e) => [
        JSON.stringify([e.from_id, e.to_id, e.relation]),
        JSON.stringify(e)
      ])
    );
    const retainedEdges = db
      .prepare('SELECT * FROM research_relations WHERE version=?')
      .all(row.version);
    check(
      retainedEdges.length === edges.size &&
        retainedEdges.every(
          (e) => edges.get(JSON.stringify([e.src, e.dst, e.relation])) === e.data
        ),
      'Research relation inventory mismatch.'
    );
    for (const kind of ['source', 'snapshot', 'document', 'record']) {
      const captured = catalog[kind + 's'];
      const retained = db
        .prepare('SELECT id,data FROM research_entities WHERE version=? AND kind=?')
        .all(row.version, kind);
      const byId = new Map(captured.map((v) => [v.id, JSON.stringify(v)]));
      check(
        retained.length === byId.size &&
          retained.every((record) => record.data === byId.get(record.id)),
        'Research catalog and retained entities disagree.'
      );
    }
  }
}

function verifyWorktreeCaptures(db, commitParents) {
  const revision = db.prepare('SELECT project,retentionRef FROM git_revisions WHERE revision=?');
  const entry = db.prepare('SELECT mode,oid FROM git_paths WHERE revision=? AND path=?');
  const blob = db.prepare('SELECT bytes FROM git_blobs WHERE oid=?');
  const tree = db.prepare('SELECT path,mode,oid FROM git_paths WHERE revision=? ORDER BY path');
  for (const row of db.prepare('SELECT * FROM worktree_captures').iterate()) {
    const record = JSON.parse(row.record),
      {
        previewDigest,
        id,
        revision: commit,
        retentionRef,
        workingOid,
        workingOids,
        ...preview
      } = record;
    const { base, projectId, version } = preview;
    const multi = version === 2,
      files = multi ? preview.files : [preview],
      oids = multi ? workingOids : [workingOid];
    check(
      row.id === id &&
        id === 'worktree-capture-v' + version + '-' + previewDigest &&
        previewDigest === hashed(JSON.stringify(preview)) &&
        (multi
          ? preview.profile === 'darwin-generation-set-v1' &&
            /^[0-9a-f]{64}$/.test(preview.guardDigest) &&
            workingOid === undefined &&
            Array.isArray(files) &&
            files.length >= 2 &&
            files.length <= 8 &&
            Array.isArray(oids) &&
            files.length === oids.length
          : version === 1 &&
            preview.profile === 'darwin-cow-single-regular-file-v1' &&
            workingOids === undefined) &&
        row.base === base &&
        row.revision === commit &&
        row.project === projectId &&
        revision.get(base)?.project === projectId &&
        revision.get(commit)?.project === projectId &&
        revision.get(commit)?.retentionRef === retentionRef,
      'Working capture identity or preview digest is invalid.'
    );
    const selected = new Set();
    for (const [i, { baseEntry, path: file, stage, working }] of files.entries()) {
      check(
        typeof file === 'string' &&
          (!multi || i === 0 || files[i - 1].path < file) &&
          !selected.has(file.toLowerCase()),
        'Working capture paths are not unique and ordered.'
      );
      selected.add(file.toLowerCase());
      const before = entry.get(base, file),
        after = entry.get(commit, file);
      check(
        (baseEntry ? before?.mode === baseEntry.mode && before?.oid === baseEntry.oid : !before) &&
          after?.mode === working.mode &&
          after?.oid === oids[i] &&
          ['100644', '100755'].includes(working.mode) &&
          (working.modeBits & 0o100 ? '100755' : '100644') === working.mode,
        'Working capture base or selected path generation differs.'
      );
      for (const [oid, metadata] of [[oids[i], working], ...(stage ? [[stage.oid, stage]] : [])]) {
        const bytes = blob.get(oid)?.bytes;
        check(
          bytes &&
            bytes.length === metadata.bytes &&
            hashed(bytes) === metadata.sha256 &&
            ['100644', '100755'].includes(metadata.mode),
          'Working capture is missing its selected or staged bytes.'
        );
      }
    }
    const names = new Set(files.map((f) => f.path));
    if (commit !== base)
      check(
        isDeepStrictEqual(commitParents.get(commit), [base]) &&
          isDeepStrictEqual(
            tree.all(base).filter((e) => !names.has(e.path)),
            tree.all(commit).filter((e) => !names.has(e.path))
          ),
        'Working capture parent or nonselected paths differ.'
      );
  }
}

function verifyNativeWorkspace(db, row, g) {
  const flow = db.prepare('SELECT * FROM native_goals WHERE goalId=?').get(row.goalId);
  const role = db
    .prepare(
      'SELECT d.*,t.prompt,t.status FROM native_roles d JOIN tasks t ON t.id=d.taskId WHERE d.taskId=?'
    )
    .get(row.taskId);
  const input = flow && JSON.parse(flow.admission);
  check(
    role &&
      flow &&
      role.goalId === row.goalId &&
      role.role === row.role &&
      role.promptDigest === hashed(role.prompt) &&
      g.promptDigest === role.promptDigest &&
      g.profile === 'native-private-projection-v1' &&
      g.projectId === flow.repository &&
      g.epoch === flow.epoch &&
      g.base === input.base &&
      g.path === input.path &&
      g.scopeVersion === flow.scopeVersion &&
      g.scopeDigest ===
        hashed(
          JSON.stringify([
            flow.repository,
            flow.epoch,
            input.base,
            input.path,
            row.goalId,
            flow.scopeVersion,
            input.objective
          ])
        ) &&
      Number.isSafeInteger(row.generation) &&
      row.generation >= 1 &&
      ['ready', 'sealed', 'reviewed', 'released', 'uncertain'].includes(row.state),
    'Historical native workspace grant differs from the immutable role or repository epoch.'
  );
  for (const ctx of db
    .prepare('SELECT manifest FROM task_contexts WHERE taskId=?')
    .iterate(row.taskId)) {
    const m = JSON.parse(ctx.manifest);
    check(
      m.sourceRevision === g.sourceRevision &&
        m.sourcePath === g.path &&
        m.scopeVersion === g.scopeVersion &&
        m.promptDigest === g.promptDigest,
      'Native workspace attempt context lost its retained source or role instructions.'
    );
  }
  const native = new NativeStore({ db });
  const file = native.file({ repository: g.projectId, revisionId: g.sourceRevision, path: g.path });
  check(
    file.mode === '100644' && file.fileId === g.sourceOid && hashed(file.bytes) === g.sourceDigest,
    'Native workspace source file identity differs.'
  );
  if (row.role === 'author') {
    check(
      g.sourceRevision === g.base && row.state !== 'reviewed',
      'Historical native author workspace subject differs.'
    );
    if (row.state === 'sealed') {
      const c = JSON.parse(row.capture),
        s =
          c &&
          db.prepare('SELECT record FROM native_submissions WHERE attemptId=?').get(c.attemptId),
        r = s && JSON.parse(s.record);
      check(
        c?.version === 1 &&
          c.fileWorkerProfile === 'darwin-seatbelt-file-v1' &&
          c.taskId === row.taskId &&
          c.workspaceId === row.workspaceId &&
          c.base === g.base &&
          c.path === g.path &&
          c.sourceOid === g.sourceOid &&
          r?.repository === g.projectId &&
          r.base === g.base &&
          r.epoch === g.epoch &&
          r.goalId === row.goalId &&
          r.scopeVersion === g.scopeVersion &&
          r.path === g.path &&
          r.author?.taskId === row.taskId &&
          r.author.attemptId === c.attemptId &&
          r.author.digest === c.outputDigest &&
          r.author.contextDigest === c.contextDigest &&
          r.newFileId === c.oid &&
          r.oldFileId === g.sourceOid,
        'Sealed native workspace capture differs from its authored submission.'
      );
      const actual = native.file({ repository: g.projectId, revisionId: r.commit, path: g.path });
      check(
        actual.fileId === c.oid &&
          actual.mode === '100644' &&
          actual.bytes.length === c.bytes &&
          hashed(actual.bytes) === c.digest,
        'Native workspace capture no longer matches the retained revision bytes.'
      );
      checkRetainedEvidence(db, r.author);
    }
  } else {
    const submission = db
        .prepare('SELECT record FROM native_submissions WHERE id=?')
        .get(g.reviewRevisionId),
      r = submission && JSON.parse(submission.record);
    check(
      row.role === 'reviewer' &&
        row.state !== 'sealed' &&
        !row.capture &&
        JSON.parse(role.prompt).revisionId === g.reviewRevisionId &&
        r?.commit === g.sourceRevision &&
        r.id === g.reviewRevisionId &&
        r.epoch === g.epoch &&
        r.goalId === row.goalId &&
        r.scopeVersion === g.scopeVersion &&
        r.repository === g.projectId &&
        r.base === g.base &&
        r.path === g.path &&
        r.newFileId === g.sourceOid,
      'Native reviewer workspace does not match the exact submitted revision.'
    );
    if (row.state === 'reviewed') {
      const decision = db
        .prepare(
          "SELECT record FROM native_reviews WHERE revisionId=? AND json_extract(record,'$.evidence.taskId')=?"
        )
        .get(r.id, row.taskId);
      check(decision, 'Native reviewer workspace has no matching independent decision.');
      checkRetainedEvidence(db, JSON.parse(decision.record).evidence);
    }
  }
  if (row.state === 'released') {
    const earlier = db.prepare('SELECT status FROM attempts WHERE taskId=?').all(row.taskId),
      terminal = ['completed', 'failed', 'interrupted', 'cancelled'];
    const goal = db.prepare('SELECT state FROM goals WHERE id=?').get(row.goalId);
    const scope = db
      .prepare(
        "SELECT max(version) AS v FROM goal_revisions WHERE id=? AND changeKind IN ('created','goal.amend')"
      )
      .get(row.goalId);
    check(
      !row.capture &&
        ((['queued', 'blocked'].includes(role.status) && !earlier.length) ||
          (terminal.includes(role.status) && earlier.every((a) => terminal.includes(a.status)))) &&
        (['failed', 'interrupted', 'cancelled'].includes(role.status) ||
          ['completed', 'cancelled'].includes(goal.state) ||
          flow.stage !== row.role ||
          flow[row.role + 'TaskId'] !== row.taskId ||
          scope.v !== g.scopeVersion),
      'Released native workspace retains active authority or ambiguous work.'
    );
  }
}

function verifyWorkspaceGrants(db) {
  const admissions = new Map();
  const hasNative = !!db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='native_goals'")
    .get();
  const goals =
    'SELECT goalId FROM workspace_goals' +
    (hasNative ? ' UNION SELECT goalId FROM native_goals' : '');
  for (const a of db
    .prepare(
      `SELECT a.*,w.role,w.workspaceId,w.generation AS latest,w.grant,g.goalId FROM workspace_admissions a
    JOIN agent_workspaces w ON w.taskId=a.taskId LEFT JOIN (${goals}) g ON g.goalId=w.goalId`
    )
    .iterate()) {
    check(
      a.goalId &&
        a.profile === 'darwin-seatbelt-file-v1' &&
        a.digest === JSON.parse(a.grant).sourceDigest &&
        a.generation >= 1 &&
        a.generation <= a.latest,
      'Historical workspace admission differs from its grant or generation.'
    );
    admissions.set(a.taskId, {
      id: a.workspaceId,
      generation: a.generation,
      role: a.role,
      profile: a.profile,
      sourceDigest: a.digest
    });
  }
  const planners =
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name='native_objective_plans'").get() &&
    db.prepare('SELECT 1 FROM native_objective_plans WHERE taskId=? AND goalId=?');
  for (const row of db
    .prepare(
      `SELECT c.taskId,c.manifest,t.goalId FROM task_contexts c JOIN goal_tasks t ON t.taskId=c.taskId JOIN (${goals}) w ON w.goalId=t.goalId`
    )
    .iterate()) {
    const manifest = JSON.parse(row.manifest);
    if (planners && planners.get(row.taskId, row.goalId)) {
      check(
        !admissions.has(row.taskId) && !manifest.workspace,
        'Native objective planner acquired a file workspace.'
      );
      continue;
    }
    check(
      admissions.has(row.taskId) &&
        isDeepStrictEqual(manifest.workspace, admissions.get(row.taskId)),
      'Dispatch context lost its historical workspace admission.'
    );
  }
  for (const row of db.prepare('SELECT * FROM agent_workspaces').iterate()) {
    const g = JSON.parse(row.grant);
    if (g.backend === 'native') {
      check(hasNative, 'Missing native workspace authority history.');
      verifyNativeWorkspace(db, row, g);
      continue;
    }
    const grant = db
      .prepare(
        `SELECT d.role,d.goalId,d.promptDigest,f.scopeVersion,f.scopeDigest,f.admission,t.prompt
      FROM change_delegations d JOIN change_flows f ON f.goalId=d.goalId JOIN tasks t ON t.id=d.taskId WHERE d.taskId=?`
      )
      .get(row.taskId);
    const input = grant && JSON.parse(grant.admission);
    const source = db
      .prepare(
        `SELECT p.oid,p.mode,b.bytes,r.project FROM git_paths p JOIN git_revisions r ON r.revision=p.revision
      JOIN git_blobs b ON b.oid=p.oid WHERE p.revision=? AND p.path=?`
      )
      .get(g.sourceRevision, g.path);
    check(
      grant &&
        g.profile === 'private-projection-v1' &&
        row.role === grant.role &&
        grant.goalId === row.goalId &&
        g.scopeVersion === grant.scopeVersion &&
        g.scopeDigest === grant.scopeDigest &&
        g.promptDigest === grant.promptDigest &&
        hashed(grant.prompt) === g.promptDigest &&
        input.base === g.base &&
        input.path === g.path &&
        source?.mode === '100644' &&
        source.oid === g.sourceOid &&
        source.project === g.projectId &&
        hashed(source.bytes) === g.sourceDigest &&
        Number.isSafeInteger(row.generation) &&
        row.generation > 0 &&
        ['ready', 'sealed', 'reviewed', 'uncertain', 'released'].includes(row.state),
      'Historical workspace grant or source mismatch.'
    );
    if (row.state === 'released') {
      const task = db.prepare('SELECT status FROM tasks WHERE id=?').get(row.taskId);
      const attempts = db.prepare('SELECT status FROM attempts WHERE taskId=?').all(row.taskId);
      const terminal = ['completed', 'failed', 'interrupted', 'cancelled'];
      const flow = db
        .prepare('SELECT stage,authorTaskId,reviewerTaskId FROM change_flows WHERE goalId=?')
        .get(row.goalId);
      const scope = db
        .prepare(
          "SELECT max(version) AS current FROM goal_revisions WHERE id=? AND changeKind IN ('created','goal.amend')"
        )
        .get(row.goalId);
      const goal = db.prepare('SELECT state FROM goals WHERE id=?').get(row.goalId);
      check(
        !row.capture &&
          ((['queued', 'blocked'].includes(task.status) && !attempts.length) ||
            (terminal.includes(task.status) &&
              attempts.every((a) => terminal.includes(a.status)))) &&
          (['failed', 'interrupted', 'cancelled'].includes(task.status) ||
            ['completed', 'cancelled'].includes(goal.state) ||
            flow.stage !== row.role ||
            flow[row.role + 'TaskId'] !== row.taskId ||
            scope.current !== g.scopeVersion),
        'Released workspace role retains dispatch authority or uncertain work.'
      );
    }
    if (row.role === 'reviewer') {
      const revision = db
        .prepare('SELECT commitId FROM review_versions WHERE id=?')
        .get(JSON.parse(grant.prompt).revisionId);
      check(
        revision?.commitId === g.sourceRevision && !row.capture,
        'Reviewer workspace has a different source revision or an author capture.'
      );
      if (row.state === 'reviewed')
        check(
          db
            .prepare(
              `SELECT 1 FROM review_decisions WHERE json_extract(record,'$.reviewerTaskId')=?
        AND json_extract(record,'$.commit')=? AND json_extract(record,'$.reviewerKind')='native-agent'`
            )
            .get(row.taskId, g.sourceRevision),
          'Reviewed workspace has no matching independent review.'
        );
    } else
      check(
        row.role === 'author' && g.sourceRevision === g.base && row.state !== 'reviewed',
        'Author workspace source mismatch.'
      );
    if (row.state === 'sealed') {
      const c = JSON.parse(row.capture);
      const v = db
        .prepare('SELECT commitId,record FROM review_versions WHERE attemptId=?')
        .get(c?.attemptId);
      const author = v && JSON.parse(v.record).author;
      const retained =
        v &&
        db
          .prepare(
            'SELECT p.mode,p.oid,b.bytes FROM git_paths p JOIN git_blobs b ON b.oid=p.oid WHERE p.revision=? AND p.path=?'
          )
          .get(v.commitId, g.path);
      check(
        c?.version === 1 &&
          c.fileWorkerProfile === 'darwin-seatbelt-file-v1' &&
          c.taskId === row.taskId &&
          c.workspaceId === row.workspaceId &&
          c.base === g.base &&
          c.path === g.path &&
          c.sourceOid === g.sourceOid &&
          author?.taskId === row.taskId &&
          author.digest === c.outputDigest &&
          author.contextDigest === c.contextDigest &&
          retained?.mode === '100644' &&
          retained.oid === c.oid &&
          retained.bytes.length === c.bytes &&
          hashed(retained.bytes) === c.digest,
        'Sealed workspace capture has no matching native output, context or committed bytes.'
      );
    }
  }
}

function verifyDrainHistory(db) {
  const initial = {
    mode: 'open',
    generation: 0,
    cutoff: null,
    cutoffAt: null,
    attemptCursor: 0,
    eventCursor: 0,
    lastOperation: null
  };
  let previous = initial;
  for (const row of db
    .prepare(
      "SELECT * FROM command_receipts WHERE json_type(receipt,'$.drain')='object' ORDER BY rowid"
    )
    .iterate()) {
    const { drain, operationId } = JSON.parse(row.receipt);
    const begin = previous.mode === 'open';
    const input = begin
      ? { expectedGeneration: previous.generation }
      : { cutoff: previous.cutoff, expectedGeneration: previous.generation };
    check(
      operationId === row.operationId &&
        row.digest === hashed(JSON.stringify([begin ? 'daemon.drain' : 'daemon.resume', input])) &&
        drain.mode === (begin ? 'draining' : 'open') &&
        drain.generation === previous.generation + 1 &&
        drain.lastOperation === operationId &&
        drain.cutoff === (begin ? operationId : previous.cutoff) &&
        Number.isFinite(Date.parse(drain.cutoffAt)) &&
        [drain.attemptCursor, drain.eventCursor].every((n) => Number.isSafeInteger(n) && n >= 0) &&
        (begin ||
          (drain.cutoffAt === previous.cutoffAt &&
            drain.attemptCursor === previous.attemptCursor &&
            drain.eventCursor === previous.eventCursor)),
      'Historical service drain receipt chain differs from its owner operation.'
    );
    previous = drain;
  }
  const state = db.prepare('SELECT * FROM service_drain WHERE slot=1').get();
  check(
    state && Object.keys(initial).every((key) => state[key] === previous[key]),
    'Service drain cutoff differs from its owner receipts.'
  );
}

export function inventory(db, application, projection, manifest) {
  if (projection) {
    check(
      [0x5343424b, 0x5343524f].includes(application),
      'Projection is only valid in a fenced archive.'
    );
    check(
      assertTrustedRecoverySchema(db) === projection.schemaDigest,
      'Projected schema identity differs.'
    );
    verifyProjectedSettings(db, manifest);
  }
  const tables = schema(db, application);
  if (tables.has('service_drain')) verifyDrainHistory(db);
  if (tables.has('review_dependencies')) verifyReviewDependencies(db);
  if (tables.has('plan_followups')) {
    verifyPlanFollowups(db);
    for (const row of db.prepare('SELECT record FROM plan_followups').iterate())
      checkRetainedEvidence(db, JSON.parse(row.record).evidence);
  }
  check(
    db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok' &&
      !db.prepare('PRAGMA foreign_key_check').get(),
    'SQLite integrity or foreign-key closure failure.'
  );
  const research = [],
    gitBlobs = [],
    gitBundles = [],
    commitParents = new Map();
  for (const row of db
    .prepare('SELECT digest,bytes FROM research_blobs ORDER BY digest')
    .iterate()) {
    check(hashed(row.bytes) === row.digest, 'Research blob digest mismatch.');
    research.push({ sha256: row.digest, bytes: row.bytes.length });
  }
  verifyResearch(db, new Set(research.map((r) => r.sha256)));
  const gitTables = ['git_blobs', 'git_revisions', 'git_paths', 'git_captures'];
  if (gitTables.some((n) => tables.has(n))) {
    check(
      gitTables.every((n) => tables.has(n)),
      'Retained Git tables are incomplete.'
    );
    check(
      !db
        .prepare(
          "SELECT 1 FROM git_paths p LEFT JOIN git_blobs b ON b.oid=p.oid WHERE p.mode!='160000' AND b.oid IS NULL LIMIT 1"
        )
        .get(),
      'Missing Git blob in recovery closure.'
    );
    for (const row of db.prepare('SELECT oid,bytes FROM git_blobs ORDER BY oid').iterate()) {
      const oid = createHash('sha1')
        .update('blob ' + row.bytes.length + '\0')
        .update(row.bytes)
        .digest('hex');
      check(oid === row.oid, 'Retained Git blob digest mismatch.');
      gitBlobs.push({ oid, bytes: row.bytes.length });
    }
    for (const row of db.prepare('SELECT * FROM git_revisions ORDER BY revision').iterate())
      gitBundles.push(verifyGitBundle(db, row, false, commitParents));
  }
  for (const [table, field] of [
    ['task_contexts', 'manifest'],
    ['task_final_outputs', 'text'],
    ['claude_results', 'text']
  ]) {
    for (const row of db
      .prepare(
        'SELECT digest,' + field + ' AS content FROM ' + table + ' WHERE ' + field + ' IS NOT NULL'
      )
      .iterate())
      check(row.digest === hashed(row.content), 'Retained context or result digest mismatch.');
  }
  const objects = { research, gitBlobs, gitBundles };
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 26 ||
    nativeTables.some((t) => tables.has(t))
  ) {
    check(
      nativeTables.every((t) => tables.has(t)),
      'Native storage tables are incomplete.'
    );
    objects.native = new NativeStore({ db }).verify();
  }
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 28 ||
    nativeOwnerTables.some((t) => tables.has(t))
  ) {
    check(
      nativeOwnerTables.every((t) => tables.has(t)) && nativeTables.every((t) => tables.has(t)),
      'Native owner storage tables are incomplete.'
    );
    objects.nativeOwnership = verifyNativeOwnership(db);
  }
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 30 ||
    bridgeTables.some((t) => tables.has(t))
  ) {
    check(
      bridgeTables.every((t) => tables.has(t)),
      'Git bridge storage tables are incomplete.'
    );
    objects.gitBridge = verifyGitBridge(db);
  }
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 32 ||
    nativeReviewTables.some((t) => tables.has(t))
  ) {
    check(
      nativeReviewTables.every((t) => tables.has(t)),
      'Native review storage tables are incomplete.'
    );
    objects.nativeReview = verifyNativeReview(db, checkRetainedEvidence);
  }
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 33 ||
    nativeAuthorityTables.some((t) => tables.has(t))
  ) {
    check(
      nativeAuthorityTables.every((t) => tables.has(t)),
      'Native workflow tables are incomplete.'
    );
    objects.nativeWorkflow = verifyNativeWorkflow(db);
  }
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 34 ||
    nativeReleaseTables.some((t) => tables.has(t))
  ) {
    check(
      nativeReleaseTables.every((t) => tables.has(t)) &&
        nativeReviewTables.every((t) => tables.has(t)),
      'Native release storage tables are incomplete.'
    );
    objects.nativeRelease = verifyNativeRelease(db);
  }
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 35 ||
    chatTables.some((name) => tables.has(name))
  ) {
    check(
      chatTables.every((name) => tables.has(name)),
      'Project chat storage tables are incomplete.'
    );
    objects.projectChat = verifyProjectChat(db);
  }
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 47 ||
    projectChatThreadTables.some((name) => tables.has(name))
  ) {
    if (db.prepare('PRAGMA user_version').get().user_version >= 48)
      verifyUpgradedProjectChatThreads(db);
    else verifyProjectChatThreads(db);
  }
  if (db.prepare('PRAGMA user_version').get().user_version >= 49) verifyChatOrigins(db);
  else
    check(!originTables.some((name) => tables.has(name)), 'Chat origin tables require schema 49.');
  if (db.prepare('PRAGMA user_version').get().user_version >= 50) verifyChatContexts(db);
  else
    check(
      !chatContextTables.some((name) => tables.has(name)),
      'Chat context tables require schema 50.'
    );
  if (db.prepare('PRAGMA user_version').get().user_version >= 51) verifyChatSelections(db);
  else
    check(
      !chatSelectionTables.some((name) => tables.has(name)),
      'Chat selections require schema 51.'
    );
  if (db.prepare('PRAGMA user_version').get().user_version >= 52) verifyAttachmentPins(db);
  else
    check(
      !attachmentPinTables.some((name) => tables.has(name)),
      'Chat attachment pins require schema 52.'
    );
  if (db.prepare('PRAGMA user_version').get().user_version >= 53) verifyChatBranches(db);
  else
    check(
      !chatBranchTables.some((name) => tables.has(name)),
      'Chat branch preparations require schema 53.'
    );
  if (db.prepare('PRAGMA user_version').get().user_version >= 54) verifyBranchThreads(db);
  else check(!tables.has(branchThreadTable), 'Chat branch threads require schema 54.');
  if (db.prepare('PRAGMA user_version').get().user_version >= 55) verifyBranchRuntime(db);
  else check(!tables.has(branchRuntimeTable), 'Chat branch attempts require schema 55.');
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 36 ||
    nativeJobTables.some((name) => tables.has(name))
  ) {
    check(
      nativeJobTables.every((name) => tables.has(name)),
      'Native job capability tables are incomplete.'
    );
    objects.nativeJobs = Object.fromEntries(
      nativeJobTables.map((name) => [name, db.prepare('SELECT count(*) AS n FROM ' + name).get().n])
    );
  }
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 37 ||
    nativeQueueTables.some((t) => tables.has(t))
  ) {
    check(
      nativeQueueTables.every((t) => tables.has(t)),
      'Native queue and regression tables are incomplete.'
    );
    objects.nativeQueue = verifyNativeQueue(db);
  }
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 38 ||
    gitCompatibilityTables.some((t) => tables.has(t))
  ) {
    check(
      gitCompatibilityTables.every((t) => tables.has(t)),
      'Git compatibility tables are incomplete.'
    );
    objects.gitCompatibility = verifyGitCompatibility(db);
  }
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 39 ||
    reviewSeriesTables.some((t) => tables.has(t))
  ) {
    check(
      reviewSeriesTables.every((t) => tables.has(t)),
      'Native review series or policy tables are incomplete.'
    );
    objects.reviewSeries = verifyReviewSeries(db);
  }
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 40 ||
    libraryTables.some((t) => tables.has(t))
  ) {
    check(
      libraryTables.every((t) => tables.has(t)),
      'Research library tables are incomplete.'
    );
    objects.library = verifyResearchLibrary(db);
  }
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 41 ||
    nativeJavascriptTables.some((t) => tables.has(t))
  ) {
    check(
      nativeJavascriptTables.every((t) => tables.has(t)),
      'JavaScript enrollment or validation storage is incomplete.'
    );
    objects.javascript = verifyNativeJavascript(db);
  }
  if (db.prepare('PRAGMA user_version').get().user_version >= 42)
    check(tables.has('git_cutover'), 'Protected-source migration storage is incomplete.');
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 43 ||
    nativeObjectiveTables.some((t) => tables.has(t))
  ) {
    check(
      nativeObjectiveTables.every((t) => tables.has(t)),
      'Native objective planning storage is incomplete.'
    );
    objects.nativePlans = verifyNativeObjectivePlanning(db, checkRetainedEvidence);
  }
  const mailSchema = db.prepare('PRAGMA user_version').get().user_version;
  if (mailSchema >= 57 || tables.has('thread_mail_operations')) {
    check(
      mailSchema >= 57 && tables.has('thread_mail_operations'),
      'Mail storage schema mismatch.'
    );
    objects.threadMail = verifyThreadMailStore(db);
    objects.threadMailAuthority = projection
      ? verifyMailRecoveryProjection(db, projection)
      : verifyThreadMailAuthority(db);
    objects.threadMailOwner = verifyMailOwner(db);
    objects.threadMailDelivery = verifyMailDelivery(db);
  }
  if (mailSchema >= 58 || scopeRecoveryTables.some((t) => tables.has(t))) {
    check(
      mailSchema >= 58 && scopeRecoveryTables.every((t) => tables.has(t)),
      'Scope storage schema mismatch.'
    );
    objects.subtreeScope = verifyScopeRecovery(db);
  }
  const projectTables = [...projectChangeTables, ...projectValidationTables];
  if (db.prepare('PRAGMA user_version').get().user_version >= 56 || tables.has(executionPinTable)) {
    check(
      db.prepare('PRAGMA user_version').get().user_version >= 56 && tables.has(executionPinTable),
      'Execution selection lookup storage is incomplete.'
    );
    objects.executionPins = verifyExecutionPins(db);
  }
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 46 ||
    projectTables.some((t) => tables.has(t))
  ) {
    check(
      projectTables.every((t) => tables.has(t)),
      'Project validation, tool history or publication records are incomplete.'
    );
    verifyProjectReviewRecoveries(db);
    objects.projectValidation = verifyProjectValidation(db);
    objects.projectChanges = verifyProjectWorkflows(db, checkRetainedEvidence);
  }
  if (db.prepare('PRAGMA user_version').get().user_version >= 45 || tables.has('task_handoffs')) {
    check(tables.has('task_handoffs'), 'Missing task handoff history.');
    objects.taskHandoffs = verifyTaskHandoffs(db);
  }
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 44 ||
    harnessGitTables.some((t) => tables.has(t))
  ) {
    check(
      harnessGitTables.every((t) => tables.has(t)),
      'Git inspection records are incomplete.'
    );
    objects.harnessGit = verifyHarnessGit(db, checkRetainedEvidence);
  }
  if (tables.has('review_main'))
    objects.reviewMain = reviewClosure(db, gitBundles, tables, commitParents);
  if (tables.has('coordination_messages')) {
    for (const row of db.prepare('SELECT * FROM coordination_messages').iterate()) {
      check(hashed(row.payload) === row.digest, 'Coordination payload digest mismatch.');
      const msg = JSON.parse(row.payload);
      check(
        ['id', 'goalId', 'scopeVersion', 'recipientTaskId', 'kind', 'acceptedAt'].every(
          (k) => msg[k] === row[k]
        ),
        'Coordination record and envelope disagree.'
      );
      if (msg.sender.principal === 'verified-worker') checkRetainedEvidence(db, msg.sender);
      const evidence = JSON.parse(row.resolution)?.evidence;
      if (evidence) checkRetainedEvidence(db, evidence);
    }
    check(
      !db
        .prepare(
          `SELECT 1 FROM coordination_deliveries d JOIN coordination_messages m ON d.messageId=m.id
      JOIN attempts a ON a.id=d.attemptId WHERE a.taskId!=m.recipientTaskId LIMIT 1`
        )
        .get(),
      'Delivery belongs to a different recipient.'
    );
  }
  if (tables.has('worktree_captures')) verifyWorktreeCaptures(db, commitParents);
  if (tables.has('investigation_runs')) verifyInvestigations(db);
  if (
    db.prepare('PRAGMA user_version').get().user_version >= 27 ||
    tables.has('job_capabilities') ||
    tables.has('job_observations')
  ) {
    check(
      tables.has('job_capabilities') && tables.has('job_observations'),
      'Job capability tables are incomplete.'
    );
    verifyJobCapabilities(db);
  }
  if (tables.has('attempt_configs')) verifyEffectiveConfigs(db);
  if (tables.has('agent_workspaces')) verifyWorkspaceGrants(db);
  if (tables.has('research_disclosures')) {
    const policy = new ResearchDisclosures({ db });
    check(
      !db
        .prepare(
          `SELECT 1 FROM command_receipts r WHERE json_type(r.receipt,'$.grant.id')='text' AND NOT EXISTS
      (SELECT 1 FROM research_disclosures d WHERE d.id=json_extract(r.receipt,'$.grant.id')) LIMIT 1`
        )
        .get(),
      'An acknowledged research disclosure is missing.'
    );
    for (const row of db.prepare('SELECT id FROM research_disclosures').iterate()) {
      const grant = policy.show(row.id),
        preview = policy.preview(grant.investigationId);
      const receipts = db
        .prepare("SELECT receipt FROM command_receipts WHERE json_extract(receipt,'$.grant.id')=?")
        .all(row.id)
        .map((r) => JSON.parse(r.receipt).grant);
      const original = { ...grant, state: 'active', revokedAt: null };
      const revocations = receipts.filter((r) => r.state === 'revoked');
      check(
        preview.digest === grant.digest &&
          receipts.some((r) => isDeepStrictEqual(r, original)) &&
          (grant.state === 'active'
            ? revocations.length === 0
            : revocations.length > 0 && revocations.every((r) => isDeepStrictEqual(r, grant))),
        'Research disclosure differs from its owner receipt or pinned input.'
      );
    }
  }
  if (tables.has('time_clock')) {
    const clock = db.prepare('SELECT highWaterMs FROM time_clock WHERE slot=1').get();
    check(
      !db
        .prepare(
          'SELECT 1 FROM goals g LEFT JOIN time_budgets b ON b.goalId=g.id WHERE b.goalId IS NULL LIMIT 1'
        )
        .get(),
      'Missing goal time envelope.'
    );
    check(
      Number.isSafeInteger(clock?.highWaterMs) && clock.highWaterMs >= 0,
      'Missing cumulative time high-water observation.'
    );
    check(
      !db
        .prepare(
          `SELECT 1 FROM attempts a JOIN goal_tasks g ON g.taskId=a.taskId LEFT JOIN timed_attempts r ON r.attemptId=a.id
      WHERE r.attemptId IS NULL OR r.goalId!=g.goalId OR r.startedMs>?
        OR r.closedMs IS NULL OR r.closedMs<r.startedMs OR r.closedMs>? LIMIT 1`
        )
        .get(clock.highWaterMs, clock.highWaterMs),
      'Timed reservation is open or its cumulative high-water observation is missing.'
    );
    check(
      !db
        .prepare(
          `SELECT 1 FROM timed_attempts r JOIN attempts a ON r.attemptId=a.id JOIN task_controls c ON c.id=r.interruptControl
      WHERE c.taskId!=a.taskId OR c.kind!='task.cancel' LIMIT 1`
        )
        .get(),
      'Budget interruption refers to another task.'
    );
  }
  if (tables.has('change_flows')) {
    for (const f of db.prepare('SELECT * FROM change_flows').iterate()) {
      const input = JSON.parse(f.admission),
        receipt = db
          .prepare('SELECT * FROM command_receipts WHERE operationId=?')
          .get(f.operationId);
      check(
        receipt?.digest === hashed(JSON.stringify(['goal.develop', input])) &&
          JSON.parse(receipt.receipt).goal?.id === f.goalId,
        'Missing reviewed-change owner admission.'
      );
      for (const d of db
        .prepare(
          'SELECT d.*,t.prompt,g.provider AS destination,g.goalId AS taskGoal FROM change_delegations d JOIN tasks t ON t.id=d.taskId JOIN goal_tasks g ON g.taskId=t.id WHERE d.goalId=?'
        )
        .iterate(f.goalId))
        check(
          d.goalId === d.taskGoal &&
            d.promptDigest === hashed(d.prompt) &&
            d.provider === d.destination &&
            d.provider === input[d.role + 'Provider'],
          'Broken reviewed-change delegation.'
        );
      if (f.stage === 'completed') {
        const e = JSON.parse(f.evidence),
          land = db.prepare('SELECT record FROM review_landings WHERE version=?').get(f.revisionId);
        const snapshot = db
          .prepare('SELECT snapshot FROM goal_completions WHERE goalId=?')
          .get(f.goalId);
        if (
          tables.has('workspace_goals') &&
          db.prepare('SELECT 1 FROM workspace_goals WHERE goalId=?').get(f.goalId)
        ) {
          for (const role of ['author', 'reviewer']) {
            const r = db
              .prepare('SELECT * FROM agent_workspaces WHERE taskId=?')
              .get(f[role + 'TaskId']);
            const expected = r && {
              taskId: r.taskId,
              workspaceId: r.workspaceId,
              goalId: r.goalId,
              role: r.role,
              generation: r.generation,
              state: r.state,
              ...JSON.parse(r.grant),
              capture: JSON.parse(r.capture),
              detail: r.detail
            };
            check(
              r?.state === (role === 'author' ? 'sealed' : 'reviewed') &&
                isDeepStrictEqual(e.workspaces?.[role], expected),
              'Completed workspace goal lost its sealed role evidence.'
            );
          }
        }
        if (input.researchGrantId) {
          const policy = new ResearchDisclosures({ db }),
            grant = policy.show(input.researchGrantId),
            source = policy.preview(grant.investigationId).source;
          check(
            grant.forOperation === f.operationId &&
              [input.authorProvider, input.reviewerProvider].every((p) =>
                grant.destinations.includes(p)
              ) &&
              isDeepStrictEqual(e.research, { grantId: grant.id, digest: grant.digest, source }),
            'Research-backed completion lost its original disclosure evidence.'
          );
        }
        check(
          land &&
            isDeepStrictEqual(e.landing, JSON.parse(land.record)) &&
            e.landing.approvalId === f.approvalId &&
            e.landing.checkId === f.checkId &&
            e.author.taskId === f.authorTaskId &&
            e.reviewer.taskId === f.reviewerTaskId &&
            snapshot &&
            isDeepStrictEqual(JSON.parse(snapshot.snapshot).evidence, [e]),
          'Broken reviewed-change completion evidence.'
        );
        checkRetainedEvidence(db, e.author);
        checkRetainedEvidence(db, e.reviewer);
      }
    }
  }
  return objects;
}
