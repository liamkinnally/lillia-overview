import path from 'node:path';
import { attemptConfigHistory } from './effective-config.mjs';
import { Investigations } from './investigations.mjs';
import { planFollowupHistory } from './plan-followups.mjs';
import { NativeOperations } from './native-operations.mjs';
import { ProjectChat } from './project-chat.mjs';
import { readChatOrigin } from './project-chat-origins.mjs';
import { readChatContext, readChatSelection } from './project-chat-contexts.mjs';
import { readAttachmentPin } from './project-chat-attachment-pins.mjs';
import { readChatBranch } from './project-chat-branches.mjs';
import { NativeReview } from './native-review.mjs';
import { ResearchLibrary } from './research-library.mjs';
import { goalRevisionPage } from './goal-lifecycle.mjs';
import { readProjectChange } from './project-development.mjs';
import { readGitInspection } from './harness-git.mjs';
import { planView } from './native-objective-planning.mjs';
import { NativeAuthority } from './native-authority.mjs';
import { normalizeSessionProfile } from './session-profile.mjs';
import { GitProject } from './git-project.mjs';
import { ResearchCatalog } from './research.mjs';
import { formatVersion, hashed, check } from './recovery-format.mjs';

export function readInspection(db, manifest, tables, kind, id, input) {
  let result;
  if (kind === 'summary') {
    result = {
      counts: {},
      excluded: manifest.excluded,
      activation: manifest.activation,
      predecessorEpoch: manifest.predecessorEpoch
    };
    for (const table of [
      'goals',
      'tasks',
      'attempts',
      'command_receipts',
      'criterion_evidence',
      'research_versions',
      'git_captures'
    ])
      result.counts[table] = tables.has(table)
        ? db.prepare('SELECT count(*) AS n FROM ' + table).get().n
        : 0;
    if (tables.has('native_revisions')) result.native = manifest.objects.native;
    if (tables.has('native_release_candidates'))
      result.nativeRelease = manifest.objects.nativeRelease;
    for (const key of [
      'javascript',
      'nativePlans',
      'harnessGit',
      'taskHandoffs',
      'projectValidation',
      'projectChanges'
    ]) {
      if (Object.hasOwn(manifest.objects, key)) result[key] = manifest.objects[key];
    }
    if (tables.has('native_job_capabilities'))
      result.nativeJobs = { ...manifest.objects.nativeJobs, dispatchAuthorized: false };
    if (tables.has('project_chat_turns')) result.projectChat = manifest.objects.projectChat;
    const profile = db
      .prepare("SELECT value FROM settings WHERE key='platform.sessionProfile'")
      .get();
    if (profile) result.sessionProfile = normalizeSessionProfile(JSON.parse(profile.value));
    if (tables.has('native_owner')) result.nativeOwnership = manifest.objects.nativeOwnership;
    if (tables.has('bridge_mappings')) result.gitBridge = manifest.objects.gitBridge;
    if (tables.has('workspace_goals')) {
      result.workspaces = {
        goals:
          db.prepare('SELECT count(*) AS n FROM workspace_goals').get().n +
          (tables.has('native_goals')
            ? db.prepare('SELECT count(*) AS n FROM native_goals').get().n
            : 0),
        states: Object.fromEntries(
          db
            .prepare('SELECT state,count(*) AS n FROM agent_workspaces GROUP BY state')
            .all()
            .map((r) => [r.state, r.n])
        ),
        mutableFiles: 'excluded',
        dispatchAuthorized: false
      };
    }
    if (tables.has('service_drain'))
      result.serviceDrain = db
        .prepare(
          'SELECT mode,generation,cutoff,cutoffAt,attemptCursor,eventCursor,lastOperation FROM service_drain WHERE slot=1'
        )
        .get();
    if (tables.has('pending_effects'))
      result.pendingEffects = db
        .prepare(
          'SELECT operationId,kind,destination,createdAt FROM pending_effects ORDER BY rowid LIMIT 100'
        )
        .all();
  } else if (kind === 'chat' && tables.has('project_chat_turns')) {
    result = new ProjectChat({ db }, null).read(input);
  } else if (kind === 'chat.origin' && tables.has('project_chat_origins')) {
    result = readChatOrigin(db, { ...input, id });
  } else if (kind === 'chat.context' && tables.has('project_chat_context_pins')) {
    result = readChatContext(db, { ...input, id });
  } else if (kind === 'chat.selection' && tables.has('project_chat_context_selections')) {
    result = readChatSelection(db, { ...input, id });
  } else if (kind === 'chat.attachment.pin' && tables.has('project_chat_attachment_pins')) {
    result = readAttachmentPin(db, { ...input, id });
  } else if (kind === 'chat.branch' && tables.has('project_chat_branch_preparations')) {
    result = readChatBranch(db, { ...input, id });
  } else if (kind === 'chat.attachment' && tables.has('project_chat_turns')) {
    result = new ProjectChat({ db }, null).attachment(input);
  } else if (kind === 'goal' || kind === 'task' || kind === 'operation') {
    check(
      typeof id === 'string' && id.length > 0 && id.length <= 256,
      'Supply a retained record ID.',
      400
    );
    const sql = {
      goal: 'SELECT * FROM goals WHERE id=?',
      task: 'SELECT * FROM tasks WHERE id=?',
      operation: 'SELECT receipt FROM command_receipts WHERE operationId=?'
    }[kind];
    result = db.prepare(sql).get(id);
    check(result, 'Retained record not found.', 404);
    if (kind === 'operation') result = JSON.parse(result.receipt);
    if (kind === 'goal') {
      const completion = db.prepare('SELECT snapshot FROM goal_completions WHERE goalId=?').get(id);
      const nativeFlow =
        tables.has('native_goals') &&
        db
          .prepare(
            "SELECT 'native' AS backend,stage,cycle,revisionId,authorTaskId,reviewerTaskId,detail FROM native_goals WHERE goalId=?"
          )
          .get(id);
      const flow =
        nativeFlow ||
        (tables.has('change_flows') &&
          db
            .prepare(
              'SELECT stage,cycle,revisionId,authorTaskId,reviewerTaskId,detail FROM change_flows WHERE goalId=?'
            )
            .get(id));
      result = {
        ...result,
        ...goalRevisionPage(db, id, input),
        criteria: JSON.parse(result.criteria),
        tasks: db
          .prepare('SELECT taskId FROM goal_tasks WHERE goalId=?')
          .all(id)
          .map((r) => r.taskId),
        completion: completion ? JSON.parse(completion.snapshot) : null,
        development: flow || null
      };
      if (nativeFlow && tables.has('native_objective_plans'))
        result.development.planner = planView(db, id);
      if (tables.has('project_changes')) result.projectChange = readProjectChange(db, id);
      if (tables.has('harness_git_inspections')) result.inspection = readGitInspection(db, id);
      if (tables.has('plan_followups'))
        result.followups = db
          .prepare('SELECT id FROM goal_plans WHERE goalId=? ORDER BY goalVersion')
          .all(id)
          .flatMap((p) => planFollowupHistory(db, p.id));
      if (tables.has('time_clock'))
        result.activeTime = db
          .prepare(
            `SELECT b.maxActiveSeconds,b.elapsedUncertain,k.highWaterMs,
          coalesce(sum(r.closedMs-r.startedMs),0) AS activeMs FROM time_budgets b CROSS JOIN time_clock k
          LEFT JOIN timed_attempts r ON r.goalId=b.goalId WHERE b.goalId=? GROUP BY b.goalId`
          )
          .get(id);
    }
    if (kind === 'task')
      result = {
        ...result,
        dependsOn: JSON.parse(result.dependsOn),
        attempts: db.prepare('SELECT * FROM attempts WHERE taskId=? ORDER BY ordinal').all(id),
        configurations: tables.has('attempt_configs') ? attemptConfigHistory(db, id) : []
      };
    if (kind === 'task' && tables.has('native_job_capabilities')) {
      result.nativeJobs = db
        .prepare(
          `SELECT c.id,c.provider,c.epoch,c.revision,c.path,c.attemptOrdinal,c.actions,c.grantedAt,c.expiresAt,c.revokedAt,
          b.attemptId,b.configDigest FROM native_job_capabilities c LEFT JOIN native_job_bindings b ON b.capabilityId=c.id
          WHERE c.taskId=? ORDER BY c.rowid DESC LIMIT 100`
        )
        .all(id)
        .map((r) => ({
          ...r,
          actions: JSON.parse(r.actions),
          dispatchAuthorized: false,
          observations: db
            .prepare(
              'SELECT id,operationId,text,createdAt FROM native_job_observations WHERE capabilityId=? ORDER BY rowid LIMIT 32'
            )
            .all(r.id)
        }));
    }
    if (kind === 'task' && tables.has('agent_workspaces')) {
      const r = db
        .prepare(
          'SELECT workspaceId,role,generation,state,capture,grant FROM agent_workspaces WHERE taskId=?'
        )
        .get(id);
      const admission = db
        .prepare('SELECT generation,profile,digest FROM workspace_admissions WHERE taskId=?')
        .get(id);
      result.workspace = r
        ? {
            ...r,
            capture: JSON.parse(r.capture),
            grant: JSON.parse(r.grant),
            admission: admission ?? null,
            mutableFiles: 'excluded'
          }
        : null;
    }
  } else if (
    tables.has('research_library_notes') &&
    ['research.noted', 'research.citation', 'research.library'].includes(kind)
  ) {
    const library = new ResearchLibrary({ db });
    result =
      kind === 'research.noted'
        ? library.note({ id })
        : kind === 'research.citation'
          ? library.passage(input)
          : library.list({ kind: input.kindFilter, limit: input.limit });
  } else if (
    ['research.find', 'research.record', 'research.passage', 'research.versions'].includes(kind)
  ) {
    const catalog = new ResearchCatalog({ db });
    result = catalog[kind.split('.')[1]]({ ...input, id });
  } else if (kind === 'worktree' && tables.has('worktree_captures')) {
    check(
      typeof id === 'string' && /^worktree-capture-v[12]-[0-9a-f]{64}$/.test(id),
      'Supply a retained working capture ID.',
      400
    );
    const row = db.prepare('SELECT record FROM worktree_captures WHERE id=?').get(id);
    check(row, 'Working capture not found.', 404);
    result = JSON.parse(row.record);
  } else if (kind === 'investigation' && tables.has('investigation_runs')) {
    result = new Investigations({ db }).show({ id });
  } else if (
    [
      'native.file',
      'native.tree',
      'native.revision',
      'native.history',
      'native.diff',
      'native.search'
    ].includes(kind) &&
    tables.has('native_owner')
  ) {
    const authority = tables.has('native_authority') ? new NativeAuthority({ db }) : null;
    const source = new NativeOperations(
      { db },
      authority
        ? { mainline: () => authority.status(), policyAt: (digest) => authority.current(digest) }
        : {}
    );
    result = source.query(kind, input);
  } else if (kind === 'native.review' && tables.has('native_submissions')) {
    check(typeof id === 'string' && id.length <= 128, 'Supply a native submission ID.', 400);
    const review = new NativeReview({ db }, {});
    result = tables.has('native_series_versions')
      ? new NativeAuthority({ db }).reviewView(review, id)
      : review.view(id);
  } else if (
    ['native.release', 'native.artifact'].includes(kind) &&
    tables.has('native_release_candidates')
  ) {
    check(typeof id === 'string' && /^[0-9a-f]{64}$/.test(id), 'Supply a native release ID.', 400);
    const row = db.prepare('SELECT record FROM native_release_candidates WHERE id=?').get(id);
    check(row, 'Retained release candidate not found.', 404);
    const release = JSON.parse(row.record);
    if (kind === 'native.release')
      result = { release, eligible: false, reason: 'Inspect-only recovery point.' };
    else {
      const data = db
        .prepare('SELECT bytes FROM native_release_artifacts WHERE digest=? AND length(bytes)=?')
        .get(release.artifactDigest, release.artifactBytes);
      check(
        data && hashed(data.bytes) === release.artifactDigest,
        'Retained artifact failed its digest check.'
      );
      result = {
        id,
        digest: release.artifactDigest,
        base64: Buffer.from(data.bytes).toString('base64')
      };
    }
  } else if (kind === 'review' && tables.has('review_versions')) {
    check(
      typeof id === 'string' && id.length > 0 && id.length <= 128,
      'Supply a retained submitted revision ID.',
      400
    );
    const row = db.prepare('SELECT record FROM review_versions WHERE id=?').get(id);
    check(row, 'Retained review revision not found.', 404);
    const records = (table) =>
      db
        .prepare('SELECT record FROM ' + table + ' WHERE version=? ORDER BY rowid')
        .all(id)
        .map((r) => JSON.parse(r.record));
    result = {
      revision: JSON.parse(row.record),
      reviews: records('review_decisions'),
      checks: records('review_checks'),
      landing: records('review_landings')[0] ?? null
    };
  } else if (
    ['git.search', 'git.diff', 'git.status', 'git.file'].includes(kind) &&
    tables.has('git_revisions')
  ) {
    const project = new GitProject({ db }, {});
    result = project[kind.split('.')[1]](input);
  } else check(false, 'Unsupported recovery inspection.', 400);
  return {
    formatVersion: manifest.formatVersion,
    ...(manifest.projection
      ? {
          projection: {
            profile: manifest.projection.profile,
            proof: 'Projected private-binding equality; not original secret-bearing proof bytes.'
          }
        }
      : {}),
    mode: 'inspect-only',
    epoch: manifest.epoch,
    recoveryPoint: manifest.recoveryPoint,
    result
  };
}
