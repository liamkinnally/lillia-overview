import { controlSubtreeScope } from './subtree-scope-owner.mjs';
import { deliverScopeStop } from './subtree-scope-delivery.mjs';
import { deliverControl as deliverCommittedControl } from './task-control-delivery.mjs';
import { createHash } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GoalStore, problem, applicationId, schemaVersion } from './goal-store.mjs';
import { steeringCommands } from './goal-lifecycle.mjs';
import { GoalPlanning } from './planning.mjs';
import { ProjectChat } from './project-chat.mjs';
import { maxChatAttachmentBytes } from './chat-attachments.mjs';
import { ResearchCatalog } from './research.mjs';
import { Investigations } from './investigations.mjs';
import { ResearchDisclosures } from './research-disclosure.mjs';
import { GoalEvaluation } from './goal-evaluation.mjs';
import { GitProject } from './git-project.mjs';
import { WorktreeCapture } from './worktree-capture.mjs';
import { AgentWorkspaces } from './agent-workspace.mjs';
import { ServiceDrain } from './service-drain.mjs';
import { JobCapabilities } from './job-capabilities.mjs';
import { selectSessionProfile } from './session-profile.mjs';
import { NativeOperations } from './native-operations.mjs';
import { HarnessGit } from './harness-git.mjs';
import { GitCompatibility } from './git-compatibility.mjs';
import { GitBridge } from './git-bridge.mjs';
import { NativeAuthority } from './native-authority.mjs';
import { NativeDevelopment } from './native-development.mjs';
import { NativeReviewSeries } from './native-series.mjs';
import { ResearchLibrary } from './research-library.mjs';
import { NativeRegression } from './native-regression.mjs';
import { NativeRelease } from './native-release.mjs';
import { GitReview } from './git-review.mjs';
import { ChangeFlow } from './change-flow.mjs';
import { HostCapacity } from './host-capacity.mjs';
import { reserveTimeInterruptions } from './time-budget.mjs';
import { assertManagedWriter } from './installation-gate.mjs';
import {
  assertWritableInstallation,
  checkRetainedEvidence,
  createBackup,
  validateBackupRequest
} from './recovery.mjs';
import { ProjectDevelopment } from './project-development.mjs';
import { retryProjectReview } from './project-review-recovery.mjs';
import { projectReviewerFence } from './project-review-fence.mjs';
import { projectLandingProof, verifyProjectWorkflows } from './project-review-proof.mjs';
import { startProject, prepareStartCache } from './project-start.mjs';
import { workspaceProfile } from './project-workspace-operations.mjs';
import { ProjectValidation } from './project-validation.mjs';
import { commandInput, reviewCommands } from './platform-input.mjs';
import { createAcceptedCommandHandler } from './platform-commands.mjs';
import { createPlatformQueryHandler } from './platform-queries.mjs';
import { replayChatSelection } from './project-chat-contexts.mjs';
import { replayAttachmentPin } from './project-chat-attachment-pins.mjs';
import {
  replayBranchPreparation,
  replayParentGrant,
  replayParentRevocation
} from './project-chat-branch-recovery.mjs';
import { replayBranchThread } from './project-chat-branch-threads.mjs';
import { advanceBranchAttempt, reserveBranchAttempt } from './project-chat-branch-runtime.mjs';
import { projectBranchAttempt } from './project-chat-branch-present.mjs';
import { readExecutionPin } from './execution-pins.mjs';
import { OwnerThreadMail } from './thread-mail-owner.mjs';
import { assertMailOwner } from './thread-mail-owner-input.mjs';
import { replayMailPreview } from './thread-mail-preview.mjs';
import { reconcileMailDeliveries } from './thread-mail-native.mjs';

const intentDigest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ownerMailActions = new Set(['chat.mail.send', 'chat.mail.acknowledge', 'chat.mail.resolve']);

// Older capture receipts hashed the captured identity. Reconstruct that hash
// from the accepted result so retries never depend on a mutable input directory.
function priorReceipt(store, operationId, name, input, digest) {
  const row = store.db
    .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
    .get(operationId);
  if (!row) return null;
  if (['goal.create', 'task.submit'].includes(name) && input.executionSelection) {
    if (row.digest !== digest)
      throw problem(409, 'This operation ID already belongs to different inputs.');
    const receipt = JSON.parse(row.receipt),
      kind = name === 'goal.create' ? 'goal' : 'task',
      pin = readExecutionPin(store.db, kind, receipt[kind]?.id);
    if (!pin || pin.operationId !== operationId)
      throw problem(409, 'Execution selection receipt is unavailable.');
    return receipt;
  }
  if (name === 'chat.branch.start') {
    if (row.digest !== digest)
      throw problem(409, 'This operation ID already belongs to different inputs.');
    return projectBranchAttempt(store.db, operationId);
  }
  const branchReplay = {
    'chat.branch.prepare': replayBranchPreparation,
    'chat.branch.create': replayBranchThread,
    'chat.parent.grant': replayParentGrant,
    'chat.parent.revoke': replayParentRevocation
  }[name];
  if (branchReplay) {
    if (row.digest !== digest)
      throw problem(409, 'This operation ID already belongs to different inputs.');
    return branchReplay(store.db, input, operationId, row.receipt);
  }
  if (name === 'chat.attachment.pin') {
    if (row.digest !== digest)
      throw problem(409, 'This operation ID already belongs to different inputs.');
    return replayAttachmentPin(store.db, input, operationId, row.receipt);
  }
  if (name === 'chat.selection.create') {
    if (row.digest !== digest)
      throw problem(409, 'This operation ID already belongs to different inputs.');
    return replayChatSelection(store.db, input, operationId, row.receipt);
  }
  const receipt = JSON.parse(row.receipt);
  if (row.digest === digest) return receipt;
  if (name === 'research.import' && receipt.catalog) {
    const version = receipt.catalog.version;
    if (
      (!input.expectedVersion || input.expectedVersion === version) &&
      row.digest === intentDigest([name, input.directory, version])
    )
      return receipt;
  }
  if (name === 'project.register' && receipt.capture) {
    const { revision, projectId, captureId } = receipt.capture;
    if (
      (!input.expectedRevision || input.expectedRevision === revision) &&
      row.digest === intentDigest([name, projectId, captureId, revision])
    )
      return receipt;
  }
  throw problem(409, 'This operation ID already belongs to different inputs.');
}

export async function openPlatform({
  dataDir,
  workspaceRoot,
  adapterFactory,
  resourceSample,
  requestedProfile,
  serviceWriter,
  managedWriter
}) {
  const root = await realpath(workspaceRoot);
  if (!(await stat(root)).isDirectory()) throw problem(400, 'Workspace root must be a directory.');
  const filename = path.join(dataDir, 'platform.sqlite');
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid())
      throw problem(409, 'Unexpected platform database file.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assertWritableInstallation(dataDir);
  assertManagedWriter(dataDir, managedWriter);
  // Check the schema before inherited TaskStore startup can issue any migrations.
  const probe = new DatabaseSync(filename);
  try {
    const version = probe.prepare('PRAGMA user_version').get().user_version;
    const owner = probe.prepare('PRAGMA application_id').get().application_id;
    const populated = probe.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
    if ((populated || version || owner) && owner !== applicationId)
      throw problem(409, 'Unrecognized database belongs to another application.');
    if (version < 0 || version > schemaVersion)
      throw problem(409, 'Unsupported platform schema version.');
    if (!owner) probe.exec('PRAGMA application_id=' + applicationId);
  } finally {
    probe.close();
  }
  const store = new GoalStore(filename);
  let capacity;
  let workspaces;
  let adapter;
  try {
    store.initialize(root);
    store.sessionProfile = selectSessionProfile(store, requestedProfile);
    const workers = store.db.prepare(`SELECT count(*) AS n FROM tasks WHERE status IN
      ('starting','running','waiting_for_input','interrupting') OR (status='recovery_needed' AND recoveryCleared=0)`);
    capacity = new HostCapacity({
      dataDir,
      sample: resourceSample,
      workers: () => workers.get().n
    });
    store.hostCapacity = capacity;
    store.recoverActive();
    workspaces = new AgentWorkspaces(store, { dataDir });
    const makeAdapter = adapterFactory ?? (await import('./provider-pool.mjs')).createProviderPool;
    adapter = await makeAdapter({ store, workspaceRoot: root });
    store.executionAdapters = () => adapter.runtimeInfo?.providers;
  } catch (error) {
    store.close();
    throw error;
  }

  let closed = false;
  let startupFailed = false;
  const controls = new Set();
  const drain = new ServiceDrain(store, {
    live: () => ({
      workers: adapter.active?.size ?? 0,
      callbacks: adapter.approvals?.size ?? 0,
      controls: controls.size
    })
  });
  store.serviceDrain = drain;
  const evaluation = new GoalEvaluation(store);
  const research = new ResearchCatalog(store);
  const library = new ResearchLibrary(store);
  const investigations = new Investigations(store);
  const disclosures = new ResearchDisclosures(store);
  const jobs = new JobCapabilities(store, { workspaceRoot: root });
  const authority = new NativeAuthority(store);
  const native = new NativeOperations(store, {
    mainline: () => authority.status(),
    policyAt: (digest) => authority.current(digest)
  });
  const bridge = new GitBridge(store, { dataDir, workspaceRoot: root });
  bridge.cleanupAccepted();
  const project = new GitProject(store, { dataDir, workspaceRoot: root });
  const worktree = new WorktreeCapture(store, { dataDir, workspaceRoot: root });
  let observingWorktree = false;
  async function observeWorktree(read) {
    if (observingWorktree)
      throw problem(
        409,
        'Another working-file observation is in progress. Retry after it finishes.'
      );
    observingWorktree = true;
    try {
      return await read();
    } finally {
      observingWorktree = false;
    }
  }
  const review = new GitReview(store, { dataDir });
  const development = new ChangeFlow(store, { workspaceRoot: root, review, capacity, workspaces });
  const nativeDevelopment = new NativeDevelopment(store, {
    authority,
    workspaces,
    workspaceRoot: root,
    capacity
  });
  function admitDevelopment(input, operationId) {
    if (authority.current()) return nativeDevelopment.admit(input, operationId);
    if (input.base.length !== 40)
      throw problem(409, 'Activate a native mainline before starting a native development goal.');
    return development.admit(input, operationId);
  }
  const chat = new ProjectChat(store, root, {
    readAttachment({ repository, name, revisionId, path }) {
      return native.query('native.file', {
        repository,
        name,
        revisionId,
        path,
        limit: maxChatAttachmentBytes + 1
      });
    },
    developmentScope() {
      const active = authority.status();
      if (active.authority)
        return { base: active.mainline.revisionId, paths: active.authority.allowedPaths };
      const main = review.status().mainline;
      return main ? { base: main.target, paths: main.nativeReviewPaths } : null;
    },
    createWork(action, { operationId, turnId }) {
      const isDevelopment = action.kind === 'develop';
      const name = isDevelopment ? 'goal.develop' : 'chat.start-plan';
      const input = isDevelopment
        ? commandInput('goal.develop', {
            objective: action.objective,
            path: action.path,
            base: action.base,
            authorProvider: action.authorProvider,
            reviewerProvider: action.reviewerProvider,
            claudeModel: action.claudeModel,
            maxAttempts: 2
          })
        : commandInput('goal.create', {
            objective: action.objective,
            criteria: action.criteria,
            workerProvider: action.workerProvider,
            claudeModel: action.claudeModel,
            maxAttempts: 8
          });
      const release = capacity.reserve(isDevelopment ? 'goal.develop' : 'goal.run');
      try {
        const receipt = store.acceptWithinTransaction(
          operationId,
          intentDigest([name, input]),
          () => {
            if (isDevelopment) return admitDevelopment(input, operationId);
            if (planningError) throw problem(503, planningError);
            const goal = store.createGoal(input);
            return {
              goal,
              plan: planning.start(goal.id, {
                fixedWorker: true,
                attachments: chat.attachmentsForTurn(turnId)
              })
            };
          }
        );
        return receipt.goal.id;
      } finally {
        release();
      }
    }
  });
  const planning = new GoalPlanning(store, root, {
    chatAttachments(goalId) {
      const turn = store.db
        .prepare('SELECT id FROM project_chat_turns WHERE workGoalId=?')
        .get(goalId);
      return turn ? chat.attachmentsForTurn(turn.id) : [];
    }
  });
  const regressions = new NativeRegression(store, { authority: () => authority.current() });
  const series = new NativeReviewSeries(store, {
    authority: () => authority.current(),
    review: nativeDevelopment.review
  });
  const compatibility = new GitCompatibility(store, {
    authority: () => authority.current(),
    role: (id, kind) => nativeDevelopment.role(id, kind)
  });
  const releases = new NativeRelease(store, {
    authority: () => authority.current(),
    review: nativeDevelopment.review
  });
  workspaces.native = {
    role: (id, kind) => nativeDevelopment.role(id, kind),
    view: (id) => nativeDevelopment.view(id),
    review: nativeDevelopment.review
  };
  store.nativeDevelopment = nativeDevelopment;
  const harnessGit =
    schemaVersion >= 44
      ? new HarnessGit(store, {
          authority: () => authority.current(),
          workspaceRoot: root,
          capacity
        })
      : null;
  store.harnessGit = harnessGit;
  const projectValidation = store.hasProjectChanges
    ? new ProjectValidation({ store, dataDir })
    : null;
  const projectDevelopment = projectValidation
    ? new ProjectDevelopment(store, {
        dataDir,
        workspaceRoot: root,
        authority,
        validation: projectValidation,
        proveLanding: projectLandingProof,
        checkEvidence: checkRetainedEvidence,
        capacity
      })
    : null;
  store.projectDevelopment = projectDevelopment;
  try {
    workspaces.recover();
  } catch (error) {
    try {
      await adapter.close();
    } finally {
      store.close();
    }
    throw error;
  }
  let preparingReview;
  let registration;
  let importing;
  let planningError = null;
  let planningWake;
  let planningWork;
  let planningDirty = false;
  let chatWake;
  let chatError = null;
  function wakeChat() {
    if (closed || chatWake) return;
    chatWake = setImmediate(() => {
      chatWake = null;
      if (closed) return;
      const release = drain.enterBackground('project chat');
      if (!release) return;
      try {
        if (chat.advance()) {
          adapter.kick();
          wakePlanning();
        }
        chatError = null;
      } catch {
        chatError = 'Conversation reconciliation failed. Inspect the service before retrying.';
      } finally {
        release();
      }
    });
  }
  function wakePlanning() {
    if (closed) return;
    planningDirty = true;
    if (planningWork || planningWake) return;
    planningWake = setImmediate(() => {
      planningWake = null;
      if (closed) return;
      planningDirty = false;
      const release = drain.enterBackground('planning');
      if (!release) return;
      planningWork = (async () => {
        try {
          const planned = planning.advance();
          const changed = await development.advance();
          const nativeChanged = await nativeDevelopment.advance();
          const inspected = await harnessGit?.advance();
          const projectChanged = projectDevelopment?.advance();
          evaluation.advance();
          planningError = null;
          if (planned || changed || nativeChanged || inspected || projectChanged) {
            adapter.kick();
            planningDirty = true;
          }
        } catch {
          planningError =
            'Goal reconciliation failed. Inspect store integrity before further admission.';
        }
      })().finally(() => {
        release();
        planningWork = null;
        if (planningDirty) wakePlanning();
      });
    });
  }
  function checkDelegatedOperation(name, input) {
    const goalId = input.goalId ?? (name.startsWith('goal.') ? input.id : null);
    if (
      goalId &&
      store.db.prepare('SELECT 1 FROM project_chat_carriers WHERE goalId=?').get(goalId)
    )
      throw problem(409, 'This goal is managed by project chat. Send a message to the main agent.');
    if (
      projectDevelopment &&
      [
        'goal.run',
        'goal.accept',
        'goal.repair',
        'task.submit',
        'task.handoff',
        'mail.post',
        'mail.resolve',
        'job.grant'
      ].includes(name)
    ) {
      const taskId = input.taskId ?? input.sourceTaskId;
      const id =
        goalId ??
        (taskId &&
          store.db.prepare('SELECT goalId FROM goal_tasks WHERE taskId=?').get(taskId)?.goalId);
      if (id && projectDevelopment.view(id))
        throw problem(
          409,
          'This project goal only accepts the selected author and reviewer workflow.'
        );
    }
    if (
      harnessGit &&
      [
        'goal.run',
        'goal.accept',
        'goal.repair',
        'task.submit',
        'mail.post',
        'mail.resolve',
        'job.grant'
      ].includes(name)
    ) {
      const id =
        goalId ??
        (name === 'job.grant'
          ? store.db.prepare('SELECT goalId FROM goal_tasks WHERE taskId=?').get(input.taskId)
              ?.goalId
          : null);
      if (id && harnessGit.view(id))
        throw problem(
          409,
          'This inspection is limited to its selected Git reads and provider tasks.'
        );
    }
    if (name === 'job.grant' && store.isProjectChatTask(input.taskId))
      throw problem(409, 'Project chat uses the conversation and supplied project status.');
    if (
      ['task.submit', 'mail.post', 'mail.resolve', 'goal.run'].includes(name) &&
      (development.view(input.goalId ?? input.id) ||
        nativeDevelopment.view(input.goalId ?? input.id))
    )
      throw problem(
        409,
        'This reviewed-change goal uses its admitted role tasks. Inspect its flow or steer the goal.'
      );
    if (
      reviewCommands.has(name) &&
      name !== 'review.decide' &&
      (input.revisionId || input.taskId)
    ) {
      const bound = store.db
        .prepare(
          `SELECT 1 FROM change_delegations d WHERE d.taskId=? OR EXISTS (
        SELECT 1 FROM review_versions v JOIN attempts a ON a.id=v.attemptId WHERE a.taskId=d.taskId AND v.id=?
      ) LIMIT 1`
        )
        .get(input.taskId ?? null, input.revisionId ?? null);
      if (bound)
        throw problem(
          409,
          'The reviewed-change goal owns this operation. Inspect its current phase.'
        );
    }
  }
  store.onTerminalTask = () => {
    wakeChat();
    wakePlanning();
  };
  const capacityTimer = setInterval(() => {
    if (
      closed ||
      !(
        (store.resourceWaiting && capacity.workerAvailable()) ||
        nativeDevelopment.canRetryCapacity() ||
        harnessGit?.canRetryCapacity()
      )
    )
      return;
    store.resourceWaiting = false;
    adapter.kick();
    wakeChat();
    wakePlanning();
  }, 2000);
  capacityTimer.unref();
  wakeChat();
  wakePlanning();
  let startup;
  function startProviders() {
    if (closed || startup) return;
    const release = drain.enterBackground('provider startup');
    if (!release) return;
    startup = Promise.resolve()
      .then(() => adapter.start())
      .catch(() => {
        startupFailed = true;
      })
      .finally(release);
  }
  startProviders();

  function deliver(action, task) {
    if (action.state !== 'pending') return;
    const delivery = deliverCommittedControl(store, adapter, action, task, {
      isClosed: () => closed
    });
    controls.add(delivery);
    delivery.then(
      () => controls.delete(delivery),
      () => controls.delete(delivery)
    );
  }
  function checkTime() {
    if (closed) return;
    try {
      for (const { action, task } of reserveTimeInterruptions(store)) {
        if (adapter.active?.has(task.id)) deliver(action, task);
        else
          store.transaction(() =>
            store.settleControl(
              action,
              'unconfirmed',
              'No active local handle. Inspect the previous native attempt.'
            )
          );
      }
      if (store.budgetMonitorError) {
        store.budgetMonitorError = null;
        adapter.kick();
      }
    } catch {
      store.budgetMonitorError =
        'Active-time monitoring failed. Inspect store integrity before dispatch.';
    }
  }
  const budgetTimer = setInterval(checkTime, 1000);
  budgetTimer.unref();
  checkTime();
  const mail = new OwnerThreadMail(store);
  reconcileMailDeliveries(store);
  const acceptCommand = createAcceptedCommandHandler({
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
    admitDevelopment,
    disclosures,
    store,
    project,
    research,
    evaluation,
    root,
    planning,
    adapter,
    getPlanningError: () => planningError
  });
  const query = createPlatformQueryHandler({
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
    getStartupFailed: () => startupFailed,
    getChatError: () => chatError,
    getPlanningError: () => planningError
  });
  const preparedCommands = new Map([
    ['chat.branch.start', prepareBranchStart],
    ['project.review.retry', prepareProjectReviewRetry],
    ['project.validation.enroll', prepareProjectValidationEnroll],
    ['release.prepare', prepareRelease],
    ['bridge.import', prepareBridgeImport],
    ['bridge.export', prepareBridgeExport],
    ['bridge.abandon', prepareBridgeAbandon],
    ['worktree.capture', prepareWorktreeCapture],
    ['research.fetch', prepareResearchLibrary],
    ['research.note', prepareResearchLibrary],
    ['research.run', prepareResearchRun],
    ['backup.create', prepareBackupCreate],
    ...Array.from(reviewCommands, (name) => [name, prepareGitReview])
  ]);

  function prepareBranchStart(name, normalized, operationId) {
    reserveBranchAttempt(store, normalized, operationId);
    advanceBranchAttempt(store, operationId);
    return projectBranchAttempt(store.db, operationId);
  }

  function prepareProjectReviewRetry(name, input, operationId) {
    return retryProjectReview(store, input, operationId, {
      verifyWorkflow(db) {
        verifyProjectWorkflows(db, checkRetainedEvidence);
        return true;
      },
      coldFence() {
        return projectReviewerFence({
          dataDir,
          workspaceRoot: root,
          operationId,
          input,
          serviceWriter,
          drain,
          broker: projectDevelopment.coldReviewState(input.attemptId, input.goalId)
        });
      }
    });
  }

  function preparedCommand(name) {
    if (name.startsWith('compat.') && name !== 'compat.inspect') return prepareCompat;
    if (name.startsWith('native.')) return prepareNative;
    return preparedCommands.get(name);
  }

  async function prepareProjectValidationEnroll(name, normalized, operationId, digest) {
    if (!projectValidation) throw problem(409, 'Project validation requires schema 46.');
    const prepared = await projectValidation.prepare(normalized);
    return store.accept(operationId, digest, () => projectValidation.enroll(prepared, operationId));
  }

  async function prepareRelease(name, normalized, operationId, digest) {
    const prepared = await releases.prepareChecked(normalized, nativeDevelopment.javascript);
    return store.accept(operationId, digest, () => releases.candidate(prepared, operationId));
  }

  async function prepareCompat(name, normalized, operationId, digest) {
    const token = await compatibility.prepare(name, normalized);
    return store.accept(operationId, digest, () => compatibility.apply(token, operationId));
  }

  function prepareBridgeImport(name, normalized, operationId, digest) {
    return bridge.import(normalized, operationId);
  }

  function prepareBridgeExport(name, normalized, operationId, digest) {
    return bridge.export(normalized, operationId);
  }

  function prepareBridgeAbandon(name, normalized, operationId, digest) {
    return bridge.abandon(normalized, operationId);
  }

  function prepareNative(name, normalized, operationId, digest) {
    const prepared = native.prepare(name, normalized, operationId);
    return store.accept(operationId, digest, () => native.apply(prepared));
  }

  async function prepareWorktreeCapture(name, normalized, operationId, digest) {
    const token = await observeWorktree(() => worktree.prepare(normalized));
    if (closed) throw problem(503, 'Service is stopping.');
    return store.accept(operationId, digest, () => ({ capture: worktree.accept(token) }));
  }

  async function prepareResearchLibrary(name, normalized, operationId, digest) {
    const prepared = await library.prepare(name, normalized);
    return store.accept(operationId, digest, () => library.apply(prepared, operationId));
  }

  function prepareResearchRun(name, normalized, operationId, digest) {
    const proof = investigations.prepare(normalized);
    return store.accept(operationId, digest, () => ({
      investigation: investigations.record(proof)
    }));
  }

  async function prepareBackupCreate(name, normalized, operationId, digest) {
    // No await between reservation, SQLite snapshot and receipt. Native callbacks and
    // other admissions run only once the synchronous single-writer checkpoint returns.
    const parent = await realpath(path.dirname(normalized.destination));
    const destination = path.join(parent, path.basename(normalized.destination));
    const data = await realpath(dataDir);
    if (
      [data, root].some(
        (p) =>
          destination === p ||
          destination.startsWith(p + path.sep) ||
          p.startsWith(destination + path.sep)
      )
    )
      throw problem(
        409,
        'Backup destination must be separate from the project and active data directory.'
      );
    if (closed) throw problem(503, 'Service is stopping.');
    const accepted = priorReceipt(store, operationId, name, normalized, digest);
    if (accepted) return accepted;
    if (registration || importing || preparingReview || planningWork || observingWorktree)
      throw problem(409, 'Retry once the active source or catalog operation has finished.');
    const options = { store, destination, operationId };
    validateBackupRequest(options);
    store.reserveEffect(operationId, digest, name, destination);
    let backup;
    try {
      backup = createBackup(options);
    } catch (error) {
      if (error.noEffect === true)
        store.db
          .prepare('DELETE FROM pending_effects WHERE operationId=? AND digest=?')
          .run(operationId, digest);
      throw error;
    }
    const { mode, formatVersion, schemaVersion, epoch, recoveryPoint, database, excluded } = backup;
    return store.accept(operationId, digest, () => ({
      backup: {
        destination,
        mode,
        formatVersion,
        schemaVersion,
        epoch,
        recoveryPoint,
        database,
        excluded
      }
    }));
  }

  async function prepareGitReview(name, normalized, operationId, digest) {
    authority.fenceGit();
    if (
      preparingReview &&
      (preparingReview.operationId !== operationId || preparingReview.digest !== digest)
    )
      throw problem(409, 'Another review operation is being prepared. Retry after it settles.');
    preparingReview ??= { operationId, digest, promise: review.prepare(name, normalized) };
    const pending = preparingReview;
    try {
      const token = await pending.promise;
      if (closed) throw problem(503, 'Service is stopping.');
      return store.accept(operationId, digest, () => {
        authority.fenceGit();
        return review.apply(token);
      });
    } finally {
      if (preparingReview === pending) preparingReview = null;
    }
  }

  async function applyCommand(name, normalized, operationId, digest, actor) {
    checkDelegatedOperation(name, normalized);
    if (name === 'chat.scope.control') {
      const receipt = controlSubtreeScope(store, normalized, operationId, actor);
      // Receipt and all reservations commit before a once-only native claim is taken.
      for (const r of receipt.reservations) {
        if (
          !r.pinnedAttempt ||
          !['starting', 'running', 'waiting_for_input'].includes(r.pinnedTask.status)
        )
          continue;
        const finish = drain.enterBackground('scope control delivery');
        if (!finish) continue;
        const work = deliverScopeStop(
          store,
          adapter,
          {
            projectId: normalized.projectId,
            threadId: normalized.threadId,
            operationId,
            taskId: r.taskId,
            controlId: r.control.id
          },
          actor
        );
        controls.add(work);
        work.then(
          () => {
            controls.delete(work);
            finish();
          },
          () => {
            controls.delete(work);
            finish();
          }
        );
      }
      if (normalized.action === 'resume') {
        adapter.kick();
        wakeChat();
      }
      return receipt;
    }
    if (ownerMailActions.has(name)) {
      const receipt = mail.command(name, normalized, operationId, actor, () =>
        acceptCommand({ name, normalized, operationId, actor })
      );
      if (name === 'chat.mail.send') wakeChat();
      return receipt;
    }
    const prepare = preparedCommand(name);
    if (prepare) return prepare(name, normalized, operationId, digest);
    let bundle;
    let capture;
    if (name === 'project.register') {
      registration ??= project.prepareRegistration();
      const pending = registration;
      try {
        capture = await pending;
      } finally {
        if (registration === pending) registration = null;
      }
      if (closed) throw problem(503, 'Service is stopping.');
      if (normalized.expectedRevision && normalized.expectedRevision !== capture.revision)
        throw problem(409, 'Repository HEAD differs from the expected revision.');
    }
    if (name === 'research.import') {
      if (importing && importing.directory !== normalized.directory)
        throw problem(409, 'A different catalog import is in progress.');
      importing ??= {
        directory: normalized.directory,
        promise: research.prepareImport(normalized.directory)
      };
      const active = importing;
      try {
        bundle = await active.promise;
      } finally {
        if (importing === active) importing = null;
      }
      if (closed) throw problem(503, 'Service is stopping.');
      if (normalized.expectedVersion && normalized.expectedVersion !== bundle.version)
        throw problem(409, 'Catalog contents do not match the expected version.');
    }
    const deliveries = [];
    const receipt = store.accept(operationId, digest, () =>
      acceptCommand({
        name,
        normalized,
        operationId,
        actor,
        capture,
        bundle,
        deliveries
      })
    );
    // An existing receipt cannot repeat an external control, even after reconnect.
    for (const { action, task } of deliveries) {
      deliver(action, task);
    }
    if (name === 'daemon.resume') startProviders();
    if (
      [
        'daemon.resume',
        'compat.inspect',
        'project.develop',
        'project.repair',
        'goal.develop',
        'task.submit',
        'task.handoff',
        'goal.resume',
        'goal.run',
        'mail.post',
        'mail.resolve'
      ].includes(name)
    )
      adapter.kick();
    if (name === 'chat.send' || name === 'chat.mail.send' || name === 'daemon.resume') wakeChat();
    if (
      [
        'daemon.resume',
        'compat.inspect',
        'project.develop',
        'project.repair',
        'goal.develop',
        'goal.repair',
        'research.revoke',
        'review.owner',
        'review.comment',
        'review.resolve',
        'authority.policy'
      ].includes(name) ||
      steeringCommands.has(name)
    )
      wakePlanning();
    return receipt;
  }
  return {
    sessionProfile: store.sessionProfile,
    async projectRequest(packet) {
      if (closed || !projectDevelopment) throw problem(503, 'Project service unavailable.');
      const finish = drain.enterBackground('project job');
      if (!finish) throw problem(409, 'Job service is drained.');
      try {
        return await projectDevelopment.request(packet);
      } finally {
        finish();
      }
    },
    async jobRequest(packet) {
      if (closed) throw problem(503, 'Service is stopping.');
      const finish = drain.enterBackground('job request');
      if (!finish) throw problem(409, 'Job service is drained.');
      try {
        return await jobs.request(packet);
      } finally {
        finish();
      }
    },
    command: async function command(name, input, operationId, actor) {
      if (closed) throw problem(503, 'Service is stopping.');
      if (typeof operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(operationId)) {
        throw problem(
          400,
          'Supply a stable operation ID of 1 to 128 letters, numbers or . _ : - .'
        );
      }
      if (name === 'project.start') {
        if (!projectValidation) throw problem(409, 'Project workflow is unavailable.');
        const rpc = (method, body, id) =>
          id ? command(method, body, id, actor) : query(method, body, actor);
        return startProject(input, operationId, {
          rpc,
          async prepareCache(recipe) {
            const finish = drain.enter('project.start', operationId, intentDigest([name, input]));
            let release;
            try {
              release = capacity.reserve('project.validation.enroll');
              if (recipe.profile === workspaceProfile) await projectValidation.prepareCache(recipe);
              else await prepareStartCache(recipe, dataDir, rpc);
            } finally {
              release?.();
              finish();
            }
          }
        });
      }
      const normalized = commandInput(name, input);
      if (['chat.mail.configure', 'chat.mail.preview'].includes(name)) assertMailOwner(actor);
      const digest = intentDigest([name, normalized]);
      if (name === 'chat.scope.control') {
        assertMailOwner(actor);
        if (store.db.prepare('SELECT 1 FROM command_receipts WHERE operationId=?').get(operationId))
          return controlSubtreeScope(store, normalized, operationId, actor);
      }
      const prior =
        name === 'chat.mail.preview'
          ? replayMailPreview(store, normalized, operationId, actor)
          : ownerMailActions.has(name)
            ? mail.replay(name, normalized, operationId, actor)
            : priorReceipt(store, operationId, name, normalized, digest);
      if (prior) {
        if (name === 'bridge.export') bridge.cleanupAccepted(operationId);
        return prior;
      }
      store.checkIntent(operationId, digest);
      const finish = drain.enter(name, operationId, digest);
      try {
        const release = capacity.reserve(name);
        try {
          return await applyCommand(name, normalized, operationId, digest, actor);
        } finally {
          release();
        }
      } finally {
        finish();
      }
    },
    async query(name, input = {}, actor) {
      if (closed) throw problem(503, 'Service is stopping.');
      return query(name, input, actor);
    },
    async close() {
      if (closed) return;
      closed = true;
      clearImmediate(chatWake);
      clearImmediate(planningWake);
      clearInterval(capacityTimer);
      clearInterval(budgetTimer);
      try {
        await planningWork;
        await adapter.close();
        await startup;
        await Promise.allSettled(controls);
      } finally {
        projectDevelopment?.close();
        store.close();
      }
    }
  };
}
