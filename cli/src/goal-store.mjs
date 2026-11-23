import { installSubtreeScope, verifySubtreeScope } from './subtree-scope-schema.mjs';
import { verifyScopeDeliveryClaims } from './subtree-scope-claim-schema.mjs';
import { assertSubtreeAdmission } from './subtree-scope-owner.mjs';
import { installThreadMailStore } from './thread-mail-store.mjs';
import { installMailOwner } from './thread-mail-owner-schema.mjs';
import { installMailDelivery } from './thread-mail-delivery-schema.mjs';
import { verifyMailDelivery } from './thread-mail-delivery-recovery.mjs';
import { reserveMailEffects } from './thread-mail-delivery.mjs';
import { verifyMailOwner } from './thread-mail-owner-recovery.mjs';
import { installThreadMailAuthority, verifyThreadMailAuthority } from './thread-mail-authority.mjs';
import { verifyThreadMailStore } from './thread-mail-recovery.mjs';
import { Coordination, installCoordination } from './coordination.mjs';
import { randomUUID } from 'node:crypto';
import { TaskStore } from './store.mjs';
import {
  readExecutionPin,
  resolveStoredExecution,
  installExecutionPins,
  verifyExecutionPins
} from './execution-pins.mjs';
import { installGoalHistory, makeCriteria, goalRevisionPage } from './goal-lifecycle.mjs';
import { installPlanning, planOutputSchema } from './planning.mjs';
import { observeTimeClock, validateActiveSeconds } from './time-budget.mjs';
import { installAllowances, attemptAllowance } from './allowance.mjs';
import {
  installTaskContext,
  recordFinalOutput,
  buildTaskContext,
  persistContext
} from './task-context.mjs';
import { installResearch } from './research.mjs';
import { installInvestigations } from './investigations.mjs';
import { installWorktreeCapture } from './worktree-capture.mjs';
import { installAgentWorkspaces } from './agent-workspace.mjs';
import { installServiceDrain } from './service-drain.mjs';
import { installNativeStore, installNativeOperations } from './native-store.mjs';
import { installPlanFollowups } from './plan-followups.mjs';
import { installGitBridge } from './git-bridge.mjs';
import { installReviewDependencies } from './review-dependencies.mjs';
import { installNativeReview } from './native-review.mjs';
import { installNativeAuthority } from './native-authority.mjs';
import { installNativeDevelopment, nativeRoleSQL } from './native-development.mjs';
import { installReviewSeries } from './native-series.mjs';
import { installResearchLibrary } from './research-library.mjs';
import { installNativeJavascript } from './native-javascript.mjs';
import { installProjectValidation } from './project-validation.mjs';
import { preserveRetiredReview } from './project-review-recovery.mjs';
import { installProjectChanges } from './project-development.mjs';
import { installTaskHandoffs, TaskHandoffs } from './task-handoff.mjs';
import { installHarnessGit, currentHarnessGitSQL } from './harness-git.mjs';
import { installGitCutover } from './git-cutover.mjs';
import {
  installNativeObjectivePlanning,
  nativeObjectiveOutputSchema
} from './native-objective-planning.mjs';
import { installGitCompatibility } from './git-compatibility.mjs';
import { installNativeQueue } from './native-queue.mjs';
import { installNativeRelease } from './native-release.mjs';
import { installProjectChat, mainChatOutputSchema } from './project-chat.mjs';
import { installChatOrigins, verifyChatOrigins } from './project-chat-origins.mjs';
import { installAttachmentPins, verifyAttachmentPins } from './project-chat-attachment-pins.mjs';
import { installChatBranches } from './project-chat-branches.mjs';
import { verifyChatBranches } from './project-chat-branch-recovery.mjs';
import { installBranchThreads, verifyBranchThreads } from './project-chat-branch-threads.mjs';
import { installBranchRuntime, verifyBranchRuntime } from './project-chat-branch-runtime.mjs';
import {
  installChatContexts,
  verifyChatContexts,
  installChatSelections,
  verifyChatSelections
} from './project-chat-contexts.mjs';
import { installProjectChatThreads, verifyProjectChatThreads } from './project-chat-threads.mjs';
import {
  upgradeProjectChatThreads,
  verifyUpgradedProjectChatThreads
} from './project-chat-thread-upgrade.mjs';
import { installJobCapabilities, installNativeJobCapabilities } from './job-capabilities.mjs';
import { installResearchDisclosures } from './research-disclosure.mjs';
import { installEffectiveConfigs, attemptConfigHistory } from './effective-config.mjs';
import { defaultClaudeModel, requireClaudeModel } from './claude-models.mjs';
import { installEvaluation } from './goal-evaluation.mjs';
import { installProviderRecords, observeClaude, finishClaude } from './provider-records.mjs';
import { installGitProject } from './git-project.mjs';
import {
  installGitReview,
  installGitReviewGrants,
  installGitReviewCandidates
} from './git-review.mjs';
import { installChangeFlow, currentDevelopmentRoleSQL } from './change-flow.mjs';
import { installTimeBudget } from './time-budget.mjs';

export const problem = (status, message) => Object.assign(new Error(message), { status });
export const applicationId = 0x5343494f;
export const schemaVersion = 58;

const initialSchema = `
  CREATE TABLE goals (
    id TEXT PRIMARY KEY, version INTEGER NOT NULL, objective TEXT NOT NULL,
    criteria TEXT NOT NULL, state TEXT NOT NULL, createdAt TEXT NOT NULL
  );
  CREATE TABLE goal_tasks (
    taskId TEXT PRIMARY KEY REFERENCES tasks(id), goalId TEXT NOT NULL REFERENCES goals(id),
    goalVersion INTEGER NOT NULL, specVersion INTEGER NOT NULL
  );
  CREATE INDEX tasks_by_goal ON goal_tasks(goalId);
  CREATE TABLE attempts (
    id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES goal_tasks(taskId),
    ordinal INTEGER NOT NULL, status TEXT NOT NULL, driver TEXT NOT NULL, accountRoute TEXT NOT NULL,
    threadId TEXT, turnId TEXT, startedAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    usage TEXT, UNIQUE(taskId,ordinal)
  );
  CREATE TABLE command_receipts (
    operationId TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL
  );
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
    goalId TEXT NOT NULL, taskId TEXT, createdAt TEXT NOT NULL
  );

  -- The original scheduler writes this transition synchronously before its first provider call.
  -- Use the same statement transaction to reserve the attempt and publish its state.
  CREATE TRIGGER reserve_attempt AFTER UPDATE OF status ON tasks
  WHEN NEW.status='starting' AND OLD.status='queued'
    AND EXISTS(SELECT 1 FROM goal_tasks WHERE taskId=NEW.id)
  BEGIN
    INSERT INTO attempts (id,taskId,ordinal,status,driver,accountRoute,threadId,turnId,startedAt,updatedAt)
      SELECT lower(hex(randomblob(16))), NEW.id, COALESCE(MAX(ordinal),0)+1, NEW.status,
             'codex', 'installed-chatgpt', NEW.threadId, NEW.turnId, NEW.updatedAt, NEW.updatedAt
      FROM attempts WHERE taskId=NEW.id;
  END;
  CREATE TRIGGER update_attempt AFTER UPDATE OF status,threadId,turnId ON tasks
  WHEN NEW.status!='starting' OR OLD.status!='queued'
  BEGIN
    UPDATE attempts SET status=NEW.status, threadId=NEW.threadId, turnId=NEW.turnId, updatedAt=NEW.updatedAt
    WHERE taskId=NEW.id AND ordinal=(SELECT MAX(ordinal) FROM attempts WHERE taskId=NEW.id);
  END;
  CREATE TRIGGER task_activity AFTER UPDATE OF status ON tasks WHEN NEW.status!=OLD.status
  BEGIN
    INSERT INTO activity(type,goalId,taskId,createdAt)
      SELECT 'task.' || NEW.status, goalId, NEW.id, NEW.updatedAt FROM goal_tasks WHERE taskId=NEW.id;
  END;
  PRAGMA application_id=${applicationId};
  PRAGMA user_version=1;
`;

export class GoalStore extends TaskStore {
  initialize(workspaceRoot, targetVersion = schemaVersion) {
    this.db.exec('PRAGMA foreign_keys=ON');
    this.transaction(() => {
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (
        targetVersion !== schemaVersion &&
        (version !== 0 ||
          !Number.isInteger(targetVersion) ||
          targetVersion < 33 ||
          targetVersion > schemaVersion)
      )
        throw problem(409, 'Historical bootstrap requires a new store and supported schema.');
      if (version === 0) this.db.exec(initialSchema);
      if (version <= 1)
        this.db.exec(`
        CREATE TABLE task_controls (
          id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES goal_tasks(taskId),
          kind TEXT NOT NULL, state TEXT NOT NULL, detail TEXT
        );
        CREATE INDEX controls_by_task ON task_controls(taskId);
        CREATE TRIGGER confirm_interruption AFTER UPDATE OF status ON tasks
        WHEN NEW.status='interrupted' AND OLD.status!='interrupted' AND NEW.recoveryCleared=1
        BEGIN
          UPDATE task_controls SET state='confirmed'
          WHERE taskId=NEW.id AND kind='task.cancel' AND state IN ('pending','sent','unconfirmed');
        END;
        PRAGMA user_version=2;
      `);
      if (version <= 2)
        this.db.exec(`
        DROP TRIGGER confirm_interruption;
        CREATE TRIGGER terminal_control AFTER UPDATE OF status ON tasks
        WHEN NEW.status!=OLD.status AND NEW.status IN ('completed','interrupted','failed','recovery_needed')
        BEGIN
          UPDATE task_controls SET state=CASE
            WHEN NEW.status='interrupted' AND NEW.recoveryCleared=1 THEN 'confirmed'
            WHEN NEW.status IN ('completed','failed') THEN 'superseded'
            ELSE 'unconfirmed' END
          WHERE taskId=NEW.id AND kind='task.cancel' AND state IN ('pending','requested','sent','unconfirmed');
        END;
        PRAGMA user_version=3;
      `);
      if (version <= 3) {
        installGoalHistory(this.db);
        this.db.exec('PRAGMA user_version=4');
      }
      if (version <= 4) {
        installPlanning(this.db);
        this.db.exec('PRAGMA user_version=5');
      }
      if (version <= 5) {
        installAllowances(this.db);
        // Earlier plans could persist a steering version instead of the objective revision.
        // Preserve ambiguous histories for inspection, never dispatch an obsolete proposal.
        this.db.exec(`
          CREATE TEMP TABLE scope_repairs AS
            SELECT p.id, p.goalId, p.goalVersion, max(r.version) AS scope
            FROM goal_plans p JOIN goal_revisions r ON r.id=p.goalId AND r.version<=p.goalVersion
              AND r.changeKind IN ('created','goal.amend') GROUP BY p.id;
          UPDATE goal_plans SET state='blocked',blocker='Inspect prior planner history and amend the goal to request a new proposal.'
            WHERE id IN (SELECT id FROM scope_repairs WHERE scope!=goalVersion);
          UPDATE goal_plans SET goalVersion=(SELECT scope FROM scope_repairs s WHERE s.id=goal_plans.id)
            WHERE id IN (SELECT id FROM scope_repairs s WHERE scope!=goalVersion AND
              (SELECT count(*) FROM scope_repairs peers WHERE peers.goalId=s.goalId AND peers.scope=s.scope)=1);
          DROP TABLE scope_repairs;
          PRAGMA user_version=6;
        `);
      }
      if (version <= 6) {
        installTaskContext(this.db);
        this.db.exec('PRAGMA user_version=7');
      }
      if (version <= 7) {
        installResearch(this.db);
        this.db.exec('PRAGMA user_version=8');
      }
      if (version <= 8) {
        installEvaluation(this.db);
        this.db.exec('PRAGMA user_version=9');
      }
      if (version <= 9) {
        installProviderRecords(this.db);
        this.db.exec('PRAGMA user_version=10');
      }
      if (version <= 10) {
        installGitProject(this.db);
        this.db.exec('PRAGMA user_version=11');
      }
      if (version <= 11)
        this.db.exec(
          'ALTER TABLE attempts ADD COLUMN requestedModel TEXT; PRAGMA user_version=12;'
        );
      if (version <= 12) {
        installGitReview(this.db);
        this.db.exec('PRAGMA user_version=13');
      }
      if (version <= 13)
        this.db.exec(`CREATE TABLE pending_effects (
        operationId TEXT PRIMARY KEY, digest TEXT NOT NULL, kind TEXT NOT NULL, destination TEXT NOT NULL, createdAt TEXT NOT NULL
      ); PRAGMA user_version=14;`);
      if (version <= 14) {
        installCoordination(this.db);
        this.db.exec('PRAGMA user_version=15');
      }
      if (version <= 15) {
        installGitReviewGrants(this.db);
        this.db.exec('PRAGMA user_version=16');
      }
      if (version <= 16) {
        installGitReviewCandidates(this.db);
        this.db.exec('PRAGMA user_version=17');
      }
      if (version <= 17) {
        installChangeFlow(this.db);
        this.db.exec('PRAGMA user_version=18');
      }
      if (version <= 18) {
        installTimeBudget(this.db);
        this.db.exec('PRAGMA user_version=19');
      }
      if (version < 20) {
        installInvestigations(this.db);
        this.db.exec('PRAGMA user_version=20');
      }
      if (version < 21) {
        installWorktreeCapture(this.db);
        this.db.exec('PRAGMA user_version=21');
      }
      if (version < 22) {
        installResearchDisclosures(this.db);
        this.db.exec('PRAGMA user_version=22');
      }
      if (version < 23) {
        installEffectiveConfigs(this.db);
        this.db
          .exec(`CREATE TABLE goal_model_pins(goalId TEXT PRIMARY KEY REFERENCES goals(id), model TEXT NOT NULL,
          origin TEXT NOT NULL CHECK(origin IN ('installation-default','owner-selection')));
          PRAGMA user_version=23`);
      }
      if (version < 24) {
        installAgentWorkspaces(this.db);
        this.db
          .exec(`CREATE TABLE workspace_goals(goalId TEXT PRIMARY KEY REFERENCES change_flows(goalId));
          CREATE TABLE workspace_admissions(taskId TEXT PRIMARY KEY REFERENCES agent_workspaces(taskId),
            generation INTEGER NOT NULL,profile TEXT NOT NULL,digest TEXT NOT NULL);
          PRAGMA user_version=24`);
      }
      if (version < 25) {
        installServiceDrain(this.db);
        this.db.exec('PRAGMA user_version=25');
      }
      if (version < 26) {
        installNativeStore(this.db);
        this.db.exec('PRAGMA user_version=26');
      }
      if (version < 27) {
        installJobCapabilities(this.db);
        this.db.exec('PRAGMA user_version=27');
      }
      if (version < 28) {
        installNativeOperations(this.db);
        this.db.exec('PRAGMA user_version=28');
      }
      if (version < 29) {
        installPlanFollowups(this.db);
        this.db.exec('PRAGMA user_version=29');
      }
      if (version < 30) {
        installGitBridge(this.db);
        this.db.exec('PRAGMA user_version=30');
      }
      if (version < 31) {
        installReviewDependencies(this.db);
        this.db.exec('PRAGMA user_version=31');
      }
      if (version < 32) {
        installNativeReview(this.db);
        this.db.exec('PRAGMA user_version=32');
      }
      if (version < 33) {
        installNativeAuthority(this.db);
        installNativeDevelopment(this.db);
        this.db.exec('PRAGMA user_version=33');
      }
      if (version < 34 && targetVersion >= 34) {
        installNativeRelease(this.db);
        this.db.exec('PRAGMA user_version=34');
      }
      if (version < 35 && targetVersion >= 35) {
        installProjectChat(this.db);
        this.db.exec('PRAGMA user_version=35');
      }
      if (version < 36 && targetVersion >= 36) {
        installNativeJobCapabilities(this.db);
        this.db.exec('PRAGMA user_version=36');
      }
      if (version < 37 && targetVersion >= 37) {
        installNativeQueue(this.db);
        this.db.exec('PRAGMA user_version=37');
      }
      if (version < 38 && targetVersion >= 38) {
        installGitCompatibility(this.db);
        this.db.exec('PRAGMA user_version=38');
      }
      if (version < 39 && targetVersion >= 39) {
        installReviewSeries(this.db);
        this.db.exec('PRAGMA user_version=39');
      }
      if (version < 40 && targetVersion >= 40) {
        installResearchLibrary(this.db);
        this.db.exec('PRAGMA user_version=40');
      }
      if (version < 41 && targetVersion >= 41) {
        installNativeJavascript(this.db);
        this.db.exec('PRAGMA user_version=41');
      }
      if (version < 42 && targetVersion >= 42) {
        installGitCutover(this.db);
        this.db.exec('PRAGMA user_version=42');
      }
      if (version < 43 && targetVersion >= 43) {
        installNativeObjectivePlanning(this.db);
        this.db.exec('PRAGMA user_version=43');
      }
      if (version < 44 && targetVersion >= 44) {
        installHarnessGit(this.db);
        this.db.exec('PRAGMA user_version=44');
      }
      if (version < 45 && targetVersion >= 45) {
        installTaskHandoffs(this.db);
        this.db.exec('PRAGMA user_version=45');
      }
      if (version < 46 && targetVersion >= 46) {
        installProjectValidation(this.db);
        installProjectChanges(this.db);
        this.db.exec('PRAGMA user_version=46');
      }
      if (version < 47 && targetVersion >= 47) {
        installProjectChatThreads(this.db);
        verifyProjectChatThreads(this.db);
        this.db.exec('PRAGMA user_version=47');
      }
      if (version < 48 && targetVersion >= 48) {
        upgradeProjectChatThreads(this.db);
        verifyUpgradedProjectChatThreads(this.db);
        this.db.exec('PRAGMA user_version=48');
      }
      if (version < 49 && targetVersion >= 49) {
        installChatOrigins(this.db);
        verifyChatOrigins(this.db);
        this.db.exec('PRAGMA user_version=49');
      }
      if (version < 50 && targetVersion >= 50) {
        installChatContexts(this.db);
        verifyChatContexts(this.db);
        this.db.exec('PRAGMA user_version=50');
      }
      if (version < 51 && targetVersion >= 51) {
        installChatSelections(this.db);
        verifyChatSelections(this.db);
        this.db.exec('PRAGMA user_version=51');
      }
      if (version < 52 && targetVersion >= 52) {
        installAttachmentPins(this.db);
        verifyAttachmentPins(this.db);
        this.db.exec('PRAGMA user_version=52');
      }
      if (version < 53 && targetVersion >= 53) {
        installChatBranches(this.db);
        verifyChatBranches(this.db);
        this.db.exec('PRAGMA user_version=53');
      }
      if (version < 54 && targetVersion >= 54) {
        installBranchThreads(this.db);
        verifyBranchThreads(this.db);
        this.db.exec('PRAGMA user_version=54');
      }
      if (version < 55 && targetVersion >= 55) {
        installBranchRuntime(this.db);
        verifyBranchRuntime(this.db);
        this.db.exec('PRAGMA user_version=55');
      }
      if (version < 56 && targetVersion >= 56) {
        installExecutionPins(this.db);
        this.db.exec('PRAGMA user_version=56');
        verifyExecutionPins(this.db);
      }
      if (version < 57 && targetVersion >= 57) {
        installThreadMailStore(this.db);
        installThreadMailAuthority(this.db);
        installMailOwner(this.db);
        installMailDelivery(this.db);
        this.db.exec('PRAGMA user_version=57');
      }
      if (targetVersion >= 57) {
        verifyThreadMailStore(this.db);
        verifyThreadMailAuthority(this.db);
        verifyMailOwner(this.db);
        verifyMailDelivery(this.db);
      }
      if (version < 58 && targetVersion >= 58) {
        installSubtreeScope(this.db);
        this.db.exec('PRAGMA user_version=58');
      }
      if (targetVersion >= 58) {
        verifySubtreeScope(this.db);
        verifyScopeDeliveryClaims(this.db);
      }
      const workspace = this.db
        .prepare("SELECT value FROM settings WHERE key='platform.workspace'")
        .get();
      if (workspace && workspace.value !== workspaceRoot) {
        throw problem(409, 'This data directory is bound to a different workspace.');
      }
      this.db
        .prepare("INSERT OR IGNORE INTO settings VALUES('platform.workspace',?)")
        .run(workspaceRoot);
      if (
        this.db
          .prepare(
            'SELECT 1 FROM tasks t LEFT JOIN goal_tasks g ON g.taskId=t.id WHERE g.taskId IS NULL LIMIT 1'
          )
          .get()
      ) {
        throw problem(
          409,
          'Store includes tasks without a registered goal. Inspect the data before starting workers.'
        );
      }
      this.db
        .prepare(
          "UPDATE task_controls SET state='unconfirmed', detail='Daemon restarted. Inspect the recorded native outcome.' WHERE state IN ('pending','requested','sent')"
        )
        .run();
    });
    this.hasProjectChanges = targetVersion >= 46;
    this.taskHandoffs = targetVersion >= 45 ? new TaskHandoffs(this) : null;
    this.hasProjectChat = targetVersion >= 35;
    this.hasObjectivePlanning = targetVersion >= 43;
    this.nativeRoleSQL = nativeRoleSQL(this.hasObjectivePlanning);
    this.harnessGitRoleSQL = targetVersion >= 44 ? currentHarnessGitSQL : '1';
    this.coordination = new Coordination(this);
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  accept(operationId, digest, execute) {
    return this.transaction(() => this.acceptWithinTransaction(operationId, digest, execute));
  }

  // A main-agent reply and its admitted child command share a transaction.
  acceptWithinTransaction(operationId, digest, execute) {
    if (!this.db.isTransaction) throw new Error('Command receipts require a transaction.');
    this.checkIntent(operationId, digest);
    const prior = this.db
      .prepare('SELECT * FROM command_receipts WHERE operationId=?')
      .get(operationId);
    if (prior) {
      if (prior.digest !== digest)
        throw problem(409, 'This operation ID already belongs to different inputs.');
      return JSON.parse(prior.receipt);
    }
    const receipt = { operationId, ...execute() };
    this.db
      .prepare('INSERT INTO command_receipts VALUES(?,?,?)')
      .run(operationId, digest, JSON.stringify(receipt));
    this.db.prepare('DELETE FROM pending_effects WHERE operationId=?').run(operationId);
    return receipt;
  }

  checkIntent(operationId, digest) {
    const existing = this.db
      .prepare('SELECT digest FROM pending_effects WHERE operationId=?')
      .get(operationId);
    if (existing && existing.digest !== digest)
      throw problem(409, 'The operation ID is reserved for another pending effect.');
  }

  reserveEffect(operationId, digest, kind, destination) {
    this.transaction(() => {
      this.checkIntent(operationId, digest);
      this.db
        .prepare('INSERT OR IGNORE INTO pending_effects VALUES(?,?,?,?,?)')
        .run(operationId, digest, kind, destination, new Date().toISOString());
    });
  }

  activity(type, goalId, taskId = null) {
    this.db
      .prepare('INSERT INTO activity(type,goalId,taskId,createdAt) VALUES(?,?,?,?)')
      .run(type, goalId, taskId, new Date().toISOString());
  }

  createGoal(
    {
      objective,
      criteria,
      maxAttempts,
      maxActiveSeconds,
      executionSelection,
      workerProvider = executionSelection?.provider ?? 'codex',
      claudeModel = executionSelection?.provider === 'claude' ? executionSelection.model : undefined
    },
    { projectExecution = false } = {}
  ) {
    const selected =
      executionSelection &&
      resolveStoredExecution(
        this,
        executionSelection,
        undefined,
        undefined,
        undefined,
        projectExecution
      );
    if (
      selected &&
      (workerProvider !== selected.provider ||
        (claudeModel !== undefined &&
          (selected.provider !== 'claude' || claudeModel !== selected.model)))
    )
      throw problem(409, 'Goal destination and execution selection disagree.');
    if (this.sessionProfile?.mode === 'codex-only' && workerProvider !== 'codex')
      throw problem(409, 'This installation is running the Codex-only session profile.');
    const id = randomUUID();
    if (maxActiveSeconds !== undefined) validateActiveSeconds(maxActiveSeconds);
    if (claudeModel !== undefined) {
      if (workerProvider !== 'claude')
        throw problem(400, 'A Claude model requires an authorized Claude destination.');
      requireClaudeModel(claudeModel);
    }
    const conditions = makeCriteria(criteria);
    this.db
      .prepare('INSERT INTO goals VALUES(?,1,?,?,?,?)')
      .run(id, objective, JSON.stringify(conditions), 'active', new Date().toISOString());
    if (maxActiveSeconds !== undefined)
      this.db
        .prepare('UPDATE time_budgets SET maxActiveSeconds=? WHERE goalId=?')
        .run(maxActiveSeconds, id);
    if (maxAttempts !== undefined)
      this.db
        .prepare('UPDATE goal_allowances SET attemptLimit=? WHERE goalId=?')
        .run(maxAttempts, id);
    this.db
      .prepare('UPDATE goal_destinations SET workerProvider=? WHERE goalId=?')
      .run(workerProvider, id);
    if (workerProvider === 'claude')
      this.db
        .prepare('INSERT INTO goal_model_pins VALUES(?,?,?)')
        .run(
          id,
          claudeModel ?? defaultClaudeModel,
          claudeModel === undefined ? 'installation-default' : 'owner-selection'
        );
    this.activity('goal.created', id);
    return { ...this.goal(id), ...(selected ? { executionSelection: selected } : {}) };
  }

  goal(id) {
    const row = this.db
      .prepare(
        `SELECT g.*, (SELECT workerProvider FROM goal_destinations WHERE goalId=g.id) AS workerProvider,
      (SELECT max(r.version) FROM goal_revisions r
      WHERE r.id=g.id AND r.changeKind IN ('created','goal.amend')) AS scopeVersion FROM goals g WHERE g.id=?`
      )
      .get(id);
    if (!row) throw problem(404, 'Goal not found.');
    const pin = this.db.prepare('SELECT model,origin FROM goal_model_pins WHERE goalId=?').get(id);
    const executionSelection = readExecutionPin(this.db, 'goal', id);
    return {
      ...row,
      criteria: JSON.parse(row.criteria),
      claudeModel: pin ? { ...pin } : null,
      ...(executionSelection ? { executionSelection } : {})
    };
  }

  goals(after, limit) {
    const page = this.db
      .prepare(
        `SELECT rowid AS cursor, * FROM goals WHERE rowid>?
      ${this.hasProjectChat ? 'AND NOT EXISTS (SELECT 1 FROM project_chat_carriers c WHERE c.goalId=goals.id)' : ''}
      ORDER BY rowid LIMIT ?`
      )
      .all(after, limit + 1);
    const hasMore = page.length > limit;
    const goals = page
      .slice(0, limit)
      .map(({ cursor, ...goal }) => ({ ...goal, criteria: JSON.parse(goal.criteria) }));
    return { goals, cursor: hasMore ? page[limit - 1].cursor : null };
  }

  queuedTasks(provider = null) {
    if (this.sessionProfile?.mode === 'codex-only') {
      if (provider && provider !== 'codex') return [];
      provider = 'codex';
    }
    if (this.budgetMonitorError || (this.serviceDrain && !this.serviceDrain.admissionsOpen()))
      return [];
    observeTimeClock(this.db);
    if (this.hostCapacity && !this.hostCapacity.workerAvailable()) {
      this.resourceWaiting = true;
      return [];
    }
    this.coordination.advance();
    return this.db
      .prepare(
        `SELECT t.id,g.provider FROM tasks t JOIN goal_tasks g ON g.taskId=t.id
      JOIN goals ON goals.id=g.goalId JOIN goal_allowance_usage u ON u.goalId=g.goalId JOIN goal_time_usage budget ON budget.goalId=g.goalId
      WHERE t.status='queued' AND goals.state='active' AND u.attemptsUsed<u.attemptLimit AND budget.clockRollback=0 AND budget.elapsedUncertain=0 AND budget.activeMs<budget.maxActiveSeconds*1000
      AND NOT EXISTS(SELECT 1 FROM coordination_messages m WHERE m.recipientTaskId=t.id AND m.resolutionRequired=1 AND m.resolution IS NULL)
      AND ${currentDevelopmentRoleSQL} AND ${this.nativeRoleSQL} AND ${this.harnessGitRoleSQL}
      AND (? IS NULL OR g.provider=?) ORDER BY t.createdAt,t.rowid`
      )
      .all(provider, provider)
      .filter((row) => {
        if (this.db.prepare('PRAGMA user_version').get().user_version < 58) return true;
        try {
          return this.transaction(() => {
            const goalId = this.db
              .prepare('SELECT goalId FROM goal_tasks WHERE taskId=?')
              .get(row.id)?.goalId;
            assertSubtreeAdmission(this, { goalId, taskId: row.id });
            return true;
          });
        } catch (error) {
          if (error.code === 'scope_admission_paused') return false;
          throw error;
        }
      })
      .map((row) => ({ ...this.getTask(row.id), provider: row.provider }));
  }

  taskIdForNativeTurn(threadId, turnId) {
    if (!threadId || !turnId) return null;
    const matches = this.db
      .prepare('SELECT taskId FROM attempts WHERE threadId=? AND turnId=? LIMIT 2')
      .all(threadId, turnId);
    return matches.length === 1 ? matches[0].taskId : null;
  }

  isProjectChatTask(taskId) {
    return (
      this.hasProjectChat &&
      typeof taskId === 'string' &&
      Boolean(this.db.prepare('SELECT 1 FROM project_chat_turns WHERE taskId=?').get(taskId))
    );
  }

  reserveDispatch(task) {
    if (this.serviceDrain && !this.serviceDrain.admissionsOpen()) return null;
    observeTimeClock(this.db);
    try {
      return this.transaction(() => {
        if (this.getTask(task.id)?.status !== 'queued') return null;
        if (this.db.prepare('PRAGMA user_version').get().user_version >= 58) {
          const goalId = this.db
            .prepare('SELECT goalId FROM goal_tasks WHERE taskId=?')
            .get(task.id)?.goalId;
          try {
            assertSubtreeAdmission(this, { goalId, taskId: task.id });
          } catch (error) {
            if (error.code === 'scope_admission_paused') return null;
            throw error;
          }
        }
        if (this.budgetMonitorError) return null;
        if (this.hostCapacity && !this.hostCapacity.workerAvailable()) {
          this.resourceWaiting = true;
          return null;
        }
        this.coordination.advance();
        const pending = this.db
          .prepare(
            'SELECT 1 FROM coordination_messages WHERE recipientTaskId=? AND resolutionRequired=1 AND resolution IS NULL'
          )
          .get(task.id);
        if (pending) return null;
        const { goalId, provider } = this.db
          .prepare('SELECT goalId,provider FROM goal_tasks WHERE taskId=?')
          .get(task.id);
        if (this.sessionProfile?.mode === 'codex-only' && provider !== 'codex') return null;
        if (
          !this.db
            .prepare(
              `SELECT 1 FROM goal_tasks g JOIN goals ON goals.id=g.goalId
          WHERE g.taskId=? AND goals.state='active' AND ${currentDevelopmentRoleSQL} AND ${this.nativeRoleSQL} AND ${this.harnessGitRoleSQL}`
            )
            .get(task.id)
        )
          return null;
        const allowance = attemptAllowance(this.db, goalId);
        if (!allowance.remainingAttempts || !allowance.activeTime.remainingMs) return null;
        const ownerChat = this.isProjectChatTask(task.id);
        const occupied = this.db
          .prepare(
            `SELECT count(*) AS n FROM tasks t
          WHERE (status IN ('starting','running','waiting_for_input','interrupting') OR (status='recovery_needed' AND recoveryCleared=0))
          AND ${this.hasProjectChat ? 'EXISTS (SELECT 1 FROM project_chat_turns c WHERE c.taskId=t.id)' : '0'}=?`
          )
          .get(Number(ownerChat)).n;
        const slotLimit = ownerChat
          ? 1
          : this.sessionProfile?.mode === 'codex-only'
            ? this.sessionProfile.codexSlots
            : 2;
        if (occupied >= slotLimit) return null;
        this.harnessGit?.validateDispatch(task.id);
        const { prompt, manifest } = buildTaskContext(this, task);
        persistContext(this, task.id, manifest);
        super.reserveDispatch(task);
        const attempt = this.db
          .prepare('SELECT id FROM attempts WHERE taskId=? AND ordinal=?')
          .get(task.id, manifest.ordinal);
        this.coordination.included(task.id, attempt.id, manifest.mailbox);
        reserveMailEffects(this, task, attempt, prompt, manifest);
        if (ownerChat) return { ...task, prompt, outputSchema: mainChatOutputSchema };
        if (
          this.hasObjectivePlanning &&
          this.db
            .prepare('SELECT 1 FROM native_objective_plans WHERE taskId=? AND record IS NULL')
            .get(task.id)
        )
          return { ...task, prompt, outputSchema: nativeObjectiveOutputSchema };
        const planner = this.db
          .prepare("SELECT 1 FROM goal_plans WHERE plannerTaskId=? AND state='pending'")
          .get(task.id);
        return planner ? { ...task, prompt, outputSchema: planOutputSchema } : { ...task, prompt };
      });
    } catch (error) {
      if (error.errcode === 1811 && error.message === 'Goal active-time admission is closed.')
        return null;
      if (error.status !== 409) throw error;
      this.updateTask(task.id, { status: 'blocked', error: error.message });
      return null;
    }
  }

  addEvent(taskId, type, payload) {
    const record = () => {
      super.addEvent(taskId, type, payload);
      if (type === 'item/completed') recordFinalOutput(this, taskId, payload);
      if (
        type === 'provider/modelChanged' &&
        this.taskIdForNativeTurn(payload.threadId, payload.turnId) === taskId
      ) {
        this.db
          .prepare(
            'UPDATE attempts SET requestedModel=coalesce(requestedModel,?),observedModel=?,modelRerouted=1 WHERE taskId=? AND threadId=? AND turnId=?'
          )
          .run(
            payload.requestedModel ?? null,
            payload.observedModel ?? null,
            taskId,
            payload.threadId,
            payload.turnId
          );
      }
    };
    return this.db.isTransaction ? record() : this.transaction(record);
  }

  observeClaudeIdentity(taskId, event) {
    this.transaction(() => observeClaude(this, taskId, event));
  }

  completeClaudeAttempt(taskId, event) {
    this.transaction(() => finishClaude(this, taskId, event));
  }

  recoverActive() {
    this.transaction(() => {
      this.db.exec(`UPDATE tasks SET status='recovery_needed', recoveryCleared=0,
        error='Inspect the previous Claude process. Native completion was not confirmed.'
        WHERE id IN (SELECT taskId FROM goal_tasks WHERE provider='claude') AND
        status IN ('starting','running','waiting_for_input','interrupting')`);
      super.recoverActive();
    });
  }

  updateTask(id, patch) {
    // Both a confirmed Codex turn/start response and turn/started persist the native turn ID.
    if (patch.turnId && this.coordination && !this.db.isTransaction)
      return this.transaction(() => this.updateTask(id, patch));
    const task = preserveRetiredReview(this, id, patch, () => super.updateTask(id, patch));
    if (
      patch.turnId &&
      this.coordination &&
      this.taskIdForNativeTurn(task.threadId, patch.turnId) === id
    ) {
      const attempt = this.db
        .prepare(
          "SELECT id FROM attempts WHERE taskId=? AND driver='codex' AND threadId=? AND turnId=?"
        )
        .get(id, task.threadId, patch.turnId);
      if (attempt) this.coordination.delivered(id, attempt.id);
    }
    if (['completed', 'failed', 'blocked', 'interrupted', 'recovery_needed'].includes(patch.status))
      this.onTerminalTask?.();
    return task;
  }

  submit(
    { goalId, prompt, provider, expectedVersion, executionSelection },
    cwd,
    { dependsOn = [], provider: roleProvider, projectExecution = false } = {}
  ) {
    if (!this.db.isTransaction)
      return this.transaction(() =>
        this.submit({ goalId, prompt, provider, expectedVersion, executionSelection }, cwd, {
          dependsOn,
          provider: roleProvider,
          projectExecution
        })
      );
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 58)
      assertSubtreeAdmission(this, { goalId });
    const goal = this.goal(goalId);
    const selected =
      executionSelection &&
      resolveStoredExecution(
        this,
        executionSelection,
        goal,
        expectedVersion,
        roleProvider,
        projectExecution
      );
    if (selected && provider !== undefined && provider !== selected.provider)
      throw problem(409, 'Provider and execution selection disagree.');
    const route = roleProvider ?? selected?.provider ?? provider ?? goal.workerProvider;
    if (route !== 'codex' && route !== goal.workerProvider)
      throw problem(409, 'This goal does not authorize the selected provider destination.');
    if (goal.state !== 'active')
      throw problem(409, 'The goal does not accept work in its current state.');
    const allowance = attemptAllowance(this.db, goalId);
    if (!allowance.activeTime.remainingMs)
      throw problem(409, 'The cumulative goal active-time allowance is closed.');
    if (!allowance.remainingAttempts)
      throw problem(409, 'The cumulative goal attempt allowance is exhausted.');
    const { count } = this.db
      .prepare(
        `SELECT count(*) AS count FROM goal_tasks g JOIN tasks t ON t.id=g.taskId
      WHERE g.goalId=? AND t.status='queued'`
      )
      .get(goalId);
    if (count >= 32) throw problem(409, 'The goal has reached its 32 queued tasks limit.');
    if (route === 'claude' && !goal.claudeModel)
      throw problem(
        409,
        'This prior goal has no authorized Claude model. Create a goal with an explicit model before dispatch.'
      );
    const task = this.createTask({
      title: prompt.slice(0, 80),
      prompt,
      cwd,
      sandbox: 'read-only',
      dependsOn,
      model: selected?.model ?? (route === 'claude' ? goal.claudeModel.model : undefined)
    });
    this.db
      .prepare(
        'INSERT INTO goal_tasks(taskId,goalId,goalVersion,specVersion,provider) VALUES(?,?,?,1,?)'
      )
      .run(task.id, goalId, goal.version, route);
    this.addEvent(task.id, 'task/queued', {});
    this.activity('task.queued', goalId, task.id);
    return {
      ...this.taskView(task.id).task,
      ...(selected ? { executionSelection: selected } : {})
    };
  }

  taskView(id) {
    const spec = this.db
      .prepare('SELECT goalId,goalVersion,specVersion,provider FROM goal_tasks WHERE taskId=?')
      .get(id);
    if (!spec) throw problem(404, 'Task not found.');
    const executionSelection = readExecutionPin(this.db, 'task', id);
    return {
      task: { ...this.getTask(id), ...spec, ...(executionSelection ? { executionSelection } : {}) },
      configurations: attemptConfigHistory(this.db, id),
      routeSelections:
        spec.provider === 'claude'
          ? this.db
              .prepare(
                `SELECT a.id AS attemptId,e.createdAt,
        json_extract(e.payload,'$.preferred') AS preferred,json_extract(e.payload,'$.preferredStatus') AS preferredStatus,
        json_extract(e.payload,'$.selected') AS selected,json_extract(e.payload,'$.reason') AS reason
        FROM events e JOIN attempts a ON a.id=json_extract(e.payload,'$.attemptId') AND a.taskId=e.taskId
        WHERE e.taskId=? AND e.type='provider/routeSelected' ORDER BY e.id DESC LIMIT 64`
              )
              .all(id)
              .reverse()
          : [],
      sessionEvents: this.db
        .prepare(
          `SELECT type,createdAt,json_extract(payload,'$.threadId') AS threadId,
        json_extract(payload,'$.turn.id') AS turnId,json_extract(payload,'$.neutralWorkspaceId') AS workspaceId
        FROM events WHERE taskId=? AND type IN ('thread/created','turn/started','turn/completed') ORDER BY id LIMIT 64`
        )
        .all(id),
      attempts: this.db.prepare('SELECT * FROM attempts WHERE taskId=? ORDER BY ordinal').all(id),
      controls: this.db
        .prepare('SELECT * FROM task_controls WHERE taskId=? ORDER BY rowid DESC')
        .all(id),
      contexts: this.db
        .prepare(
          'SELECT ordinal,digest,manifest FROM task_contexts WHERE taskId=? ORDER BY ordinal'
        )
        .all(id)
        .map((row) => ({ ...row, manifest: JSON.parse(row.manifest) }))
    };
  }

  reserveControl(id, kind, task) {
    if (
      this.db
        .prepare("SELECT 1 FROM task_controls WHERE taskId=? AND kind=? AND state='pending'")
        .get(task.id, kind)
    ) {
      throw problem(409, 'A control request is already in progress.');
    }
    this.db
      .prepare("INSERT INTO task_controls VALUES(?,?,?,'pending',NULL)")
      .run(id, task.id, kind);
    this.activity(kind + '.requested', task.goalId, task.id);
    if (kind === 'task.cancel' && ['queued', 'blocked'].includes(task.status)) {
      this.updateTask(task.id, { status: 'interrupted', error: null, recoveryCleared: true });
    }
    return { ...this.db.prepare('SELECT * FROM task_controls WHERE id=?').get(id) };
  }

  settleControl(action, state, detail = null) {
    const update = this.db
      .prepare("UPDATE task_controls SET state=?,detail=? WHERE id=? AND state='pending'")
      .run(state, detail, action.id);
    if (update.changes) {
      const { goalId } = this.db
        .prepare('SELECT goalId FROM goal_tasks WHERE taskId=?')
        .get(action.taskId);
      this.activity(action.kind + '.' + state, goalId, action.taskId);
    }
  }

  goalView(
    id,
    { after = 0, limit = 50, afterVersion = 0, historyLimit = 8, summary = false } = {}
  ) {
    const goal = this.goal(id);
    const rows = this.db
      .prepare(
        `SELECT g.rowid AS cursor,t.id,t.title,t.status,t.createdAt,t.updatedAt,t.cwd,t.model,t.sandbox,t.threadId,t.turnId,
      t.dependsOn,t.recoveryCleared,g.goalId,g.goalVersion,g.specVersion,g.provider,
      (SELECT count(*) FROM coordination_messages m WHERE m.recipientTaskId=t.id AND m.resolutionRequired=1 AND m.resolution IS NULL) AS pendingQuestions,
      CASE WHEN ?=0 AND length(t.prompt)+length(t.output)<=16384 THEN t.prompt END AS prompt,
      CASE WHEN ?=0 AND length(t.prompt)+length(t.output)<=16384 THEN t.output END AS output,
      substr(t.error,1,2000) AS error FROM goal_tasks g JOIN tasks t ON t.id=g.taskId
      WHERE g.goalId=? AND g.rowid>? ORDER BY g.rowid LIMIT ?`
      )
      .all(Number(summary), Number(summary), id, after, limit + 1);
    const taskCursor = rows.length > limit ? rows[limit - 1].cursor : null;
    const tasks = rows.slice(0, limit).map(({ cursor, prompt, output, ...row }) => ({
      ...row,
      dependsOn: JSON.parse(row.dependsOn),
      recoveryCleared: Boolean(row.recoveryCleared),
      ...(prompt === null ? { detailRequired: true } : { prompt, output })
    }));
    const attempts = this.db
      .prepare(
        `SELECT * FROM attempts WHERE taskId IN(SELECT value FROM json_each(?)) ORDER BY rowid`
      )
      .all(JSON.stringify(tasks.map((task) => task.id)));
    const { revisions, revisionCursor } = goalRevisionPage(this.db, id, {
      afterVersion,
      historyLimit
    });
    const counts = this.db
      .prepare(
        `SELECT count(*) AS taskCount,
      count(*) FILTER (WHERE t.status IN ('starting','running','waiting_for_input','interrupting')) AS executing,
      count(*) FILTER (WHERE t.status='recovery_needed' AND t.recoveryCleared=0) AS uncertain
      FROM goal_tasks g JOIN tasks t ON t.id=g.taskId WHERE g.goalId=?`
      )
      .get(id);
    const interruptions = this.db
      .prepare(
        `SELECT
      count(*) FILTER(WHERE c.state IN ('pending','requested','sent')) AS requested,
      count(*) FILTER(WHERE c.state='unconfirmed') AS unconfirmed,
      count(*) FILTER(WHERE c.state='confirmed') AS confirmed,
      count(*) FILTER(WHERE c.state='superseded') AS superseded
      FROM task_controls c JOIN goal_tasks g ON g.taskId=c.taskId WHERE g.goalId=? AND c.kind='task.cancel'`
      )
      .get(id);
    return {
      goal,
      revisions,
      revisionCursor,
      tasks,
      taskCursor,
      taskCount: counts.taskCount,
      attempts,
      allowance: attemptAllowance(this.db, id),
      quiescence: {
        executing: counts.executing,
        uncertain: counts.uncertain,
        interruptions: { ...interruptions }
      }
    };
  }

  readActivity(after, limit) {
    const events = this.db
      .prepare('SELECT * FROM activity WHERE id>? ORDER BY id LIMIT ?')
      .all(after, limit);
    return { events, cursor: events.at(-1)?.id ?? after };
  }
}
