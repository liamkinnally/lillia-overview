import { previewSubtreeScope } from './subtree-scope-owner.mjs';
import { readFinalOutput } from './task-context.mjs';
import { readMailSetting, readMailSubjects } from './thread-mail-settings.mjs';
import { problem, schemaVersion } from './goal-store.mjs';
import { objectWith, requiredText, page } from './platform-input.mjs';
import { chatProject, readChatOrigin } from './project-chat-origins.mjs';
import { readChatContext, readChatSelection } from './project-chat-contexts.mjs';
import { readAttachmentPin } from './project-chat-attachment-pins.mjs';
import { readChatBranch, verifyParentGrant } from './project-chat-branches.mjs';
import { previewBranchSelection, readBranchAttempt } from './project-chat-branch-runtime.mjs';
import { projectBranchAttempt } from './project-chat-branch-present.mjs';

export function createPlatformQueryHandler({
  mail,
  chat,
  jobs,
  drain,
  series,
  harnessGit,
  projectDevelopment,
  nativeDevelopment,
  regressions,
  authority,
  disclosures,
  store,
  project,
  research,
  evaluation,
  root,
  planning,
  adapter,
  releases,
  compatibility,
  bridge,
  native,
  investigations,
  library,
  worktree,
  capacity,
  observeWorktree,
  review,
  development,
  workspaces,
  getStartupFailed,
  getChatError,
  getPlanningError
}) {
  function queryChatRead(input) {
    objectWith(input, ['before', 'limit', 'threadId']);
    return chat.read(input);
  }

  function queryChatAttachment(input) {
    return chat.attachment(input);
  }

  async function queryProviderUsage(input) {
    objectWith(input, ['provider']);
    const { provider } = input;
    if (!['codex', 'claude'].includes(provider)) throw problem(400, 'Select Codex or Claude.');
    const cached = adapter.runtimeInfo?.providers?.[provider]?.usage ?? {
      observedAt: null,
      windows: []
    };
    const finish = drain.enterBackground('provider usage');
    if (!finish)
      return {
        provider,
        usage: cached,
        state: 'drained',
        detail: 'The service is drained. Showing the last observation.'
      };
    try {
      if (!adapter.refreshUsage)
        return {
          provider,
          usage: cached,
          state: 'unavailable',
          detail: 'This driver cannot refresh usage.'
        };
      return await adapter.refreshUsage(provider);
    } finally {
      finish();
    }
  }

  function queryAuthorityStatus(input) {
    objectWith(input, []);
    return authority.status();
  }

  function queryJsShow(input) {
    objectWith(input, ['id']);
    return nativeDevelopment.javascript.show(input);
  }

  function queryJsRecipes(input) {
    objectWith(input, []);
    return nativeDevelopment.javascript.list();
  }

  function queryReleaseCandidate(input, name) {
    objectWith(input, ['id']);
    const selected = { id: requiredText(input.id, 'Release candidate ID', 128) };
    return name === 'release.show' ? releases.view(selected) : releases.artifact(selected);
  }

  function queryCompatInspection(input) {
    objectWith(input, ['goalId']);
    const inspection = harnessGit?.view(requiredText(input.goalId, 'Goal ID', 128));
    if (!inspection) throw problem(404, 'Unknown Git inspection goal.');
    return { inspection };
  }

  function queryCompatibilityRecord(input, name) {
    objectWith(input, ['id']);
    return name === 'compat.show' ? compatibility.view(input) : compatibility.bundle(input);
  }

  function queryReviewThread(input) {
    objectWith(input, ['revisionId']);
    return series.thread({ revisionId: requiredText(input.revisionId, 'Native submission', 128) });
  }

  function queryQueueStatus(input) {
    objectWith(input, []);
    return nativeDevelopment.queue.status();
  }

  function queryRegression(input) {
    objectWith(input, ['id']);
    return regressions.view({ id: requiredText(input.id, 'Regression record ID', 64) });
  }

  function queryAuthoritySubmissions(input) {
    return authority.submissions(input);
  }

  function queryAuthorityReview(input) {
    objectWith(input, ['id']);
    return authority.reviewView(
      nativeDevelopment.review,
      requiredText(input.id, 'Native submission', 128)
    );
  }

  function queryBridgeMapping(input) {
    return bridge.mapping(input);
  }

  function queryNative(input, name) {
    return native.query(name, input);
  }

  function queryJobObservations(input) {
    objectWith(input, ['taskId', 'after', 'limit']);
    return jobs.observations(input);
  }

  function queryDaemonDrainStatus(input) {
    objectWith(input, []);
    return drain.view();
  }

  function queryMailList(input) {
    objectWith(input, ['goalId', 'taskId', 'after', 'limit']);
    return store.coordination.view(input);
  }

  function queryResearchInvestigation(input) {
    objectWith(input, ['id']);
    return investigations.show(input);
  }

  function queryResearchRuns(input) {
    objectWith(input, ['after', 'limit']);
    return investigations.list(input);
  }

  function queryResearchDisclosure(input) {
    objectWith(input, ['id']);
    return disclosures.preview(input.id);
  }

  function queryResearchPermission(input) {
    objectWith(input, ['id']);
    return disclosures.show(input.id);
  }

  function queryWorktreeShow(input) {
    objectWith(input, ['id']);
    return worktree.view(input);
  }

  async function queryWorktreePreview(input, name) {
    objectWith(input, ['base', 'paths']);
    const release = capacity.reserve(name);
    try {
      return await observeWorktree(() => worktree.preview(input));
    } finally {
      release();
    }
  }

  function queryProjectStatus(input) {
    objectWith(input, ['limit']);
    return project.status(input);
  }

  function queryProjectCapture(input) {
    objectWith(input, ['captureId']);
    return project.capture(input);
  }

  function querySourceSearch(input) {
    objectWith(input, ['revision', 'query', 'mode', 'after', 'limit']);
    return project.search(input);
  }

  function querySourceFile(input) {
    objectWith(input, ['revision', 'path', 'offset', 'limit']);
    return project.file(input);
  }

  function querySourceDiff(input) {
    objectWith(input, ['base', 'revision', 'path', 'limit']);
    return project.diff(input);
  }

  function queryReviewStatus(input) {
    objectWith(input, []);
    return review.status();
  }

  function queryReviewShow(input) {
    objectWith(input, ['id']);
    return review.view({ id: requiredText(input.id, 'Revision or change ID', 128) });
  }

  function queryOperation(input) {
    objectWith(input, ['id']);
    const receipt = store.db
      .prepare('SELECT receipt FROM command_receipts WHERE operationId=?')
      .get(requiredText(input.id, 'Operation ID', 128));
    if (!receipt) {
      const pending = store.db
        .prepare(
          'SELECT operationId,kind,digest,destination,createdAt FROM pending_effects WHERE operationId=?'
        )
        .get(input.id);
      if (pending) return { pending };
      throw problem(404, 'Operation not found.');
    }
    return { receipt: JSON.parse(receipt.receipt) };
  }

  function queryResearchLibrary(input) {
    objectWith(input, ['kind', 'after', 'limit']);
    return library.list(input);
  }

  function queryResearchCitation(input) {
    objectWith(input, ['documentId', 'startLine', 'endLine', 'expectedDigest']);
    return library.passage(input);
  }

  function queryResearchNoted(input) {
    objectWith(input, ['id']);
    return library.note(input);
  }

  function queryResearchFind(input) {
    objectWith(input, ['query', 'limit', 'version']);
    return research.find(input);
  }

  function queryResearchRecord(input) {
    objectWith(input, ['id', 'version']);
    return research.record(input);
  }

  function queryResearchPassage(input) {
    objectWith(input, ['id', 'version', 'startLine', 'endLine']);
    return research.passage(input);
  }

  function queryResearchVersions(input) {
    objectWith(input, ['limit']);
    return research.versions(input);
  }

  function queryStatus(input) {
    objectWith(input, []);
    return {
      workspaceRoot: root,
      schemaVersion,
      driver: 'codex',
      configuredRoute: 'installed-chatgpt',
      sessionProfile: store.sessionProfile,
      provider: getStartupFailed()
        ? { status: 'error', error: 'Provider startup failed.' }
        : adapter.runtimeInfo,
      executionProfile: 'supplied-text-only',
      resources: capacity.status(),
      chatError: getChatError(),
      planningError: getPlanningError(),
      budgetMonitorError: store.budgetMonitorError ?? null
    };
  }

  function queryGoals(input) {
    return store.goals(...page(input, 50, 100));
  }

  function queryGoal(input) {
    objectWith(input, ['id', 'after', 'limit', 'afterVersion', 'historyLimit', 'summary']);
    const id = requiredText(input.id, 'Goal ID', 128);
    const [after, limit] = page({ after: input.after, limit: input.limit }, 50, 100);
    const [afterVersion, historyLimit] = page(
      { after: input.afterVersion, limit: input.historyLimit },
      8,
      16
    );
    if (input.summary !== undefined && typeof input.summary !== 'boolean')
      throw problem(400, 'Invalid summary option.');
    const view = store.goalView(id, {
      after,
      limit,
      afterVersion,
      historyLimit,
      summary: input.summary
    });
    const scopes = [...new Set([view.goal.scopeVersion, ...view.revisions.map((r) => r.version)])];
    const plans = store.db
      .prepare(
        'SELECT * FROM goal_plans WHERE goalId=? AND goalVersion IN (SELECT value FROM json_each(?)) ORDER BY goalVersion DESC'
      )
      .all(id, JSON.stringify(scopes))
      .map((row) => planning.describe(row));
    const inspection = harnessGit?.view(id) ?? null,
      flow = nativeDevelopment.view(id) ?? development.view(id);
    const projectChange = projectDevelopment?.view(id) ?? null;
    const stopped = projectChange ?? flow ?? inspection;
    const blocker =
      view.goal.state === 'blocked' && stopped?.stage === 'blocked'
        ? {
            workflow: projectChange
              ? 'project-development'
              : inspection
                ? 'git-inspection'
                : flow.backend === 'native'
                  ? 'native-development'
                  : 'git-development',
            reason:
              view.goal.scopeVersion !== (stopped.scopeVersion ?? 1)
                ? 'The objective changed after this workflow stopped. Admit a new workflow for the revised objective.'
                : stopped.detail,
            actions:
              flow?.backend === 'native' && flow.scopeVersion === view.goal.scopeVersion
                ? nativeDevelopment.repairActions(flow)
                : []
          }
        : null;
    return {
      ...view,
      plans,
      ...evaluation.view(id, scopes),
      inspection,
      flow,
      projectChange,
      ...(projectChange
        ? {
            projectRepairSupported: typeof projectDevelopment.repair === 'function',
            projectRepairSuccessor:
              store.db
                .prepare(
                  "SELECT p.goalId AS id,g.state FROM project_changes p JOIN goals g ON g.id=p.goalId WHERE json_extract(p.input,'$.repair.rejectedGoalId')=? AND g.state!='cancelled' ORDER BY p.rowid DESC LIMIT 1"
                )
                .get(id) ?? null
          }
        : {}),
      blocker
    };
  }

  function queryTask(input) {
    objectWith(input, ['id']);
    const id = requiredText(input.id, 'Task ID', 128);
    const view = store.taskView(id);
    let finalOutput = null,
      finalOutputUnavailable = null;
    if (view.task.status === 'completed') {
      try {
        finalOutput = readFinalOutput(store, id);
      } catch (error) {
        if (error.status !== 409) throw error;
        finalOutputUnavailable = error.message;
      }
    }
    const pendingRequests = [...(adapter.approvals?.values() ?? [])]
      .filter((item) => item.taskId === id)
      .map(({ id, method }) => ({ id, method }));
    return {
      ...view,
      pendingRequests,
      finalOutput,
      finalOutputUnavailable,
      workspace: workspaces.view({ taskId: id })
    };
  }

  function queryEvents(input) {
    return store.readActivity(...page(input, 100, 500));
  }

  const routes = new Map([
    ['authority.status', queryAuthorityStatus],
    ['authority.submissions', queryAuthoritySubmissions],
    ['authority.review', queryAuthorityReview],
    ['bridge.mapping', queryBridgeMapping],
    ['chat.read', queryChatRead],
    [
      'chat.project',
      (input) => {
        objectWith(input, []);
        return chatProject(store.db);
      }
    ],
    ['chat.origin', (input) => readChatOrigin(store.db, input)],
    ['chat.context', (input) => readChatContext(store.db, input)],
    ['chat.selection', (input) => readChatSelection(store.db, input)],
    ['chat.attachment.pin', (input) => readAttachmentPin(store.db, input)],
    ['chat.branch', (input) => readChatBranch(store.db, input)],
    ['chat.branch.preview', (input) => previewBranchSelection(store.db, input)],
    [
      'chat.branch.attempt',
      (input) => {
        objectWith(input, ['projectId', 'operationId']);
        if (chatProject(store.db).projectId !== input.projectId)
          throw problem(404, 'Branch attempt not found.');
        const attempt = readBranchAttempt(store.db, input.operationId);
        return attempt.readiness === 'reserved'
          ? { status: 'reserved', attemptId: attempt.attempt.steps.attempt }
          : projectBranchAttempt(store.db, input.operationId);
      }
    ],
    [
      'chat.parent.grant',
      (input) => {
        objectWith(input, ['projectId', 'id', 'selectionId', 'accountInstance']);
        return { grant: verifyParentGrant(store.db, input) };
      }
    ],
    [
      'chat.threads',
      (input) => {
        objectWith(input, []);
        return chat.threads();
      }
    ],
    ['chat.attachment', queryChatAttachment],
    ['compat.inspection', queryCompatInspection],
    ['compat.show', queryCompatibilityRecord],
    ['compat.bundle', queryCompatibilityRecord],
    ['daemon.drain-status', queryDaemonDrainStatus],
    ['events', queryEvents],
    ['goal', queryGoal],
    ['goals', queryGoals],
    ['job.observations', queryJobObservations],
    ['js.show', queryJsShow],
    ['js.recipes', queryJsRecipes],
    ['mail.list', queryMailList],
    ['operation', queryOperation],
    ['project.status', queryProjectStatus],
    ['project.capture', queryProjectCapture],
    [
      'project.validation.recipes',
      (input) => {
        if (!projectDevelopment?.validation)
          throw problem(409, 'Project validation requires schema 46.');
        return projectDevelopment.validation.recipes(input);
      }
    ],
    ['provider.usage', queryProviderUsage],
    ['queue.status', queryQueueStatus],
    ['release.show', queryReleaseCandidate],
    ['release.artifact', queryReleaseCandidate],
    ['release.diagnosis', queryRegression],
    ['release.proposal', queryRegression],
    ['research.investigation', queryResearchInvestigation],
    ['research.runs', queryResearchRuns],
    ['research.disclosure', queryResearchDisclosure],
    ['research.permission', queryResearchPermission],
    ['research.library', queryResearchLibrary],
    ['research.citation', queryResearchCitation],
    ['research.noted', queryResearchNoted],
    ['research.find', queryResearchFind],
    ['research.record', queryResearchRecord],
    ['research.passage', queryResearchPassage],
    ['research.versions', queryResearchVersions],
    ['review.thread', queryReviewThread],
    ['review.status', queryReviewStatus],
    ['review.show', queryReviewShow],
    ['source.search', querySourceSearch],
    ['source.file', querySourceFile],
    ['source.diff', querySourceDiff],
    ['status', queryStatus],
    ['task', queryTask],
    ['worktree.show', queryWorktreeShow],
    ['worktree.preview', queryWorktreePreview]
  ]);

  return function query(name, input, actor) {
    if (name === 'chat.scope.preview') {
      objectWith(input, ['projectId', 'threadId']);
      return previewSubtreeScope(store, input, actor);
    }
    if (name === 'chat.mail.settings') return readMailSetting(store.db, input, actor);
    if (name === 'chat.mail.subjects') return readMailSubjects(store.db, input, actor);
    if (name === 'chat.mail.read') return mail.read(actor, input);
    if (name === 'chat.mail.list') return mail.list(actor, input);
    const handler = routes.get(name);
    if (handler) return handler(input, name);
    if (name.startsWith('native.')) return queryNative(input, name);
    throw problem(404, 'Unknown query.');
  };
}
