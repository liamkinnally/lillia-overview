import {
  blockWorkflowGoal,
  reconcileBlockedWorkflows,
  reactivateForNativeRepair
} from './goal-lifecycle.mjs';
import {
  authorizedPlannerPacket,
  authenticatedGuidance,
  acceptObjectivePlan,
  createObjectivePlan,
  planGuidance,
  planView
} from './native-objective-planning.mjs';
import { NativeJavascript } from './native-javascript.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { enrollReviewGoal, hasSeries, pathAdmitted, policyEnrollment } from './native-policy.mjs';
import { NativeReview } from './native-review.mjs';
import { validateCompatibilityAdmission } from './git-compatibility.mjs';
import { validateRevertAdmission } from './native-regression.mjs';
import { NativeQueue } from './native-queue.mjs';
import { researchForDevelopment, researchPin } from './research-disclosure.mjs';
import { attemptAllowance } from './allowance.mjs';
import { fileWorkerProfile } from './workspace-sandbox.mjs';

const hash = (x) => createHash('sha256').update(x).digest('hex');
function need(value, message) {
  if (!value) throw Object.assign(new Error(message), { status: 409 });
}
export function installNativeDevelopment(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS native_goals(goalId TEXT PRIMARY KEY REFERENCES goals(id),operationId TEXT NOT NULL UNIQUE,
    repository TEXT NOT NULL,admission TEXT NOT NULL,epoch TEXT NOT NULL REFERENCES native_authority(epoch),scopeVersion INTEGER NOT NULL,
    stage TEXT NOT NULL,cycle INTEGER NOT NULL,authorTaskId TEXT,reviewerTaskId TEXT,revisionId TEXT,decisionId TEXT,checkId TEXT,detail TEXT,evidence TEXT);
    CREATE TABLE IF NOT EXISTS native_roles(taskId TEXT PRIMARY KEY REFERENCES goal_tasks(taskId),goalId TEXT NOT NULL REFERENCES native_goals(goalId),
    role TEXT NOT NULL,cycle INTEGER NOT NULL,promptDigest TEXT NOT NULL,feedback TEXT,UNIQUE(goalId,role,cycle))`);
}
const objectivePlannerRoleSQL = `OR EXISTS(
  SELECT 1 FROM native_objective_plans p JOIN native_goals n ON n.goalId=p.goalId JOIN native_authority a ON a.epoch=n.epoch
  WHERE p.taskId=g.taskId AND p.goalId=g.goalId AND n.stage='planner' AND p.record IS NULL AND g.provider='codex'
    AND json_extract(n.admission,'$.plannerProvider')='codex' AND g.specVersion=1 AND g.goalVersion=n.scopeVersion
    AND n.scopeVersion=(SELECT max(version) FROM goal_revisions WHERE id=g.goalId AND changeKind IN ('created','goal.amend')))`;
export function nativeRoleSQL(hasObjectivePlanning) {
  return `(NOT EXISTS(SELECT 1 FROM native_goals n WHERE n.goalId=g.goalId) ${hasObjectivePlanning ? objectivePlannerRoleSQL : ''} OR EXISTS(
  SELECT 1 FROM native_goals n JOIN native_roles r ON r.goalId=n.goalId JOIN native_authority a ON a.epoch=n.epoch
  JOIN agent_workspaces w ON w.taskId=r.taskId JOIN workspace_admissions v ON v.taskId=w.taskId
  WHERE n.goalId=g.goalId AND r.taskId=g.taskId AND n.stage=r.role AND n.cycle=r.cycle AND w.role=r.role AND w.goalId=g.goalId
    AND w.state='ready' AND v.generation=w.generation AND v.profile='darwin-seatbelt-file-v1'
    AND v.digest=json_extract(w.grant,'$.sourceDigest') AND json_extract(w.grant,'$.epoch')=n.epoch
    AND json_extract(w.grant,'$.promptDigest')=r.promptDigest AND g.specVersion=1 AND g.goalVersion>=n.scopeVersion
    AND n.scopeVersion=(SELECT max(version) FROM goal_revisions WHERE id=g.goalId AND changeKind IN ('created','goal.amend'))
    AND (json_extract(n.admission,'$.researchGrantId') IS NULL OR EXISTS(
      SELECT 1 FROM research_disclosures d WHERE d.id=json_extract(n.admission,'$.researchGrantId') AND d.forOperation=n.operationId AND d.revokedAt IS NULL
        AND json_extract(n.admission,'$.authorProvider') IN (SELECT value FROM json_each(d.destinations))
        AND json_extract(n.admission,'$.reviewerProvider') IN (SELECT value FROM json_each(d.destinations))))
    AND ((r.role='author' AND n.authorTaskId=g.taskId) OR (r.role='reviewer' AND n.reviewerTaskId=g.taskId))))`;
}

export const currentNativeRoleSQL = nativeRoleSQL(true);

export class NativeDevelopment {
  #waitingForCapacity = new Set();
  constructor(store, { authority, workspaces, workspaceRoot, capacity }) {
    this.store = store;
    this.db = store.db;
    this.authority = authority;
    this.workspaces = workspaces;
    this.root = workspaceRoot;
    this.capacity = capacity;
    this.javascript = new NativeJavascript(store, { authority: () => authority.current() });
    this.review = new NativeReview(store, {
      authority: () => authority.current(),
      role: (id, kind) => this.role(id, kind)
    });
    this.queue = this.db
      .prepare("SELECT 1 FROM sqlite_schema WHERE name='native_queue_entries'")
      .get()
      ? new NativeQueue(store, { authority: () => authority.current(), review: this.review })
      : null;
  }
  view(id) {
    const row = this.db.prepare('SELECT * FROM native_goals WHERE goalId=?').get(id);
    const policyDigest =
      row && hasSeries(this.db)
        ? this.db.prepare('SELECT digest FROM native_policy_enrollments WHERE goalId=?').get(id)
            ?.digest
        : null;
    const admission = row && JSON.parse(row.admission);
    const planner = admission?.plannerProvider ? planView(this.db, id) : null;
    return row
      ? {
          ...row,
          ...(planner ? { planner } : {}),
          ...(policyDigest ? { policyDigest } : {}),
          backend: 'native',
          admission,
          evidence: JSON.parse(row.evidence)
        }
      : null;
  }
  role(taskId, kind) {
    return this.#role(taskId, kind);
  }
  #role(taskId, kind, inspectBlockedGoal = null) {
    const r = this.db.prepare('SELECT * FROM native_roles WHERE taskId=?').get(taskId);
    need(r && r.role === kind, 'Native task lacks the selected role.');
    const f = this.view(r.goalId),
      goal = this.store.goal(r.goalId),
      { task } = this.store.taskView(taskId);
    const receipt = this.db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(f.operationId);
    const admission = receipt && JSON.parse(receipt.receipt);
    const auth = this.authority.current();
    need(
      auth?.epoch === f.epoch &&
        auth.repository === f.repository &&
        pathAdmitted(auth, f.admission) &&
        policyEnrollment(this.db, f.goalId, auth) &&
        receipt?.digest === hash(JSON.stringify(['goal.develop', f.admission])) &&
        admission.flow?.epoch === f.epoch &&
        admission.flow?.scopeVersion === f.scopeVersion &&
        admission.flow?.repository === f.repository &&
        admission.flow?.goalId === r.goalId &&
        isDeepStrictEqual(admission.flow.admission, f.admission) &&
        task.goalId === r.goalId &&
        goal.scopeVersion === f.scopeVersion &&
        (goal.state === 'active' || (goal.state === 'blocked' && inspectBlockedGoal === goal.id)) &&
        task.specVersion === 1 &&
        task.goalVersion >= f.scopeVersion &&
        task.provider === f.admission[kind + 'Provider'] &&
        hash(task.prompt) === r.promptDigest,
      'Native goal, original receipt, role or authority changed.'
    );
    const research = researchForDevelopment(this.store, f.admission, f.operationId);
    const guidance = authenticatedGuidance(this.store, f);
    return {
      ...(guidance ? { objectivePlan: guidance } : {}),
      ...(research ? { research } : {}),
      repository: f.repository,
      epoch: f.epoch,
      base: f.admission.base,
      path: f.admission.path,
      goalId: r.goalId,
      taskId,
      scopeVersion: f.scopeVersion,
      objective: f.admission.objective,
      feedback: r.feedback,
      ...(f.admission.jsRecipe ? { jsRecipe: f.admission.jsRecipe } : {}),
      ...(f.admission.ownerPolicy ? { ownerPolicy: f.admission.ownerPolicy } : {}),
      ...(f.admission.compatId ? { compatId: f.admission.compatId } : {}),
      ...(f.admission.revertId ? { revertId: f.admission.revertId } : {}),
      ...(f.admission.requires ? { requires: f.admission.requires } : {})
    };
  }
  delegate(f, role, prompt, feedback = null) {
    const task = this.store.submit(
      { goalId: f.goalId, prompt, provider: f.admission[role + 'Provider'] },
      this.root
    );
    this.db
      .prepare('INSERT INTO native_roles VALUES(?,?,?,?,?,?)')
      .run(task.id, f.goalId, role, f.cycle, hash(prompt), feedback);
    return task.id;
  }
  admit(input, operationId) {
    need(this.db.isTransaction, 'Native development requires an owner receipt.');
    const { authority, mainline } = this.authority.status();
    need(
      authority && mainline.revisionId === input.base && pathAdmitted(authority, input),
      'Select the current native mainline and an authorized path.'
    );
    const research = researchForDevelopment(this.store, input, operationId);
    validateRevertAdmission(this.db, input, authority);
    validateCompatibilityAdmission(this.db, input, authority);
    const prompt = this.review.authorPrompt({
      ...input,
      research,
      repository: authority.repository
    });
    const workerProvider = [input.authorProvider, input.reviewerProvider].includes('claude')
      ? 'claude'
      : 'codex';
    const goal = this.store.createGoal({
      objective: input.objective,
      criteria: ['Independently review, check and land ' + input.path],
      workerProvider,
      claudeModel: input.claudeModel,
      maxAttempts: input.maxAttempts,
      maxActiveSeconds: input.maxActiveSeconds
    });
    const criteria = JSON.stringify([{ ...goal.criteria[0], verifier: 'reviewed-native-change' }]);
    this.db.prepare('UPDATE goals SET criteria=? WHERE id=?').run(criteria, goal.id);
    this.db
      .prepare('UPDATE goal_revisions SET criteria=? WHERE id=? AND version=1')
      .run(criteria, goal.id);
    this.db
      .prepare(
        "INSERT INTO native_goals(goalId,operationId,repository,admission,epoch,scopeVersion,stage,cycle) VALUES(?,?,?,?,?,?,'author',1)"
      )
      .run(
        goal.id,
        operationId,
        authority.repository,
        JSON.stringify(input),
        authority.epoch,
        goal.scopeVersion
      );
    enrollReviewGoal(this.db, goal.id, authority);
    if (input.plannerProvider) {
      this.db.prepare("UPDATE native_goals SET stage='planner' WHERE goalId=?").run(goal.id);
      createObjectivePlan(this.store, this.view(goal.id), authority, this.root);
    } else {
      const id = this.delegate(this.view(goal.id), 'author', prompt);
      this.db.prepare('UPDATE native_goals SET authorTaskId=? WHERE goalId=?').run(id, goal.id);
    }
    return { goal: this.store.goal(goal.id), flow: this.view(goal.id) };
  }
  validatePlannerDispatch(taskId, prompt, manifest) {
    if (this.store.hasObjectivePlanning === false) return;
    const row = this.db.prepare('SELECT * FROM native_objective_plans WHERE taskId=?').get(taskId);
    if (!row) return;
    const f = this.view(row.goalId),
      a = this.authority.current(),
      receipt = this.db
        .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
        .get(f.operationId);
    researchForDevelopment(this.store, f.admission, f.operationId);
    need(
      f.stage === 'planner' &&
        this.current(f) &&
        !row.record &&
        f.planner.taskId === taskId &&
        manifest.goalId === f.goalId &&
        manifest.scopeVersion === f.scopeVersion &&
        a.epoch === f.epoch &&
        this.authority.status().mainline.revisionId === f.admission.base &&
        pathAdmitted(a, f.admission) &&
        policyEnrollment(this.db, f.goalId, a) &&
        receipt?.digest === hash(JSON.stringify(['goal.develop', f.admission])) &&
        JSON.parse(receipt.receipt).flow.planner.taskId === taskId &&
        row.packet === authorizedPlannerPacket(this.db, f, a) &&
        prompt === row.packet &&
        manifest.input === row.packet &&
        !manifest.research &&
        !manifest.rollover &&
        !manifest.workspace &&
        [manifest.mailbox, manifest.dependencies, manifest.coordinationRoutes].every(
          (x) => !x.length
        ),
      'Planner dispatch scope, intent or inputs changed.'
    );
  }
  current(f) {
    const goal = this.store.goal(f.goalId),
      row = this.view(f.goalId);
    return (
      goal.state === 'active' &&
      goal.scopeVersion === f.scopeVersion &&
      row.stage === f.stage &&
      row.cycle === f.cycle &&
      row.epoch === this.authority.current()?.epoch
    );
  }
  async admitLease(f, id) {
    const prior = this.workspaces.view({ taskId: id });
    if (prior) {
      need(prior.state === 'ready', 'Inspect the preserved native workspace before dispatch.');
      if (
        this.db
          .prepare('SELECT 1 FROM workspace_admissions WHERE taskId=? AND generation=?')
          .get(id, prior.generation)
      )
        return false;
    } else if (
      f.stage === 'author' &&
      this.db
        .prepare(
          "SELECT count(*) n FROM agent_workspaces WHERE role='author' AND state NOT IN ('sealed','released')"
        )
        .get().n >= 2
    )
      return false;
    const lease = this.workspaces.lease(id, f.stage),
      proof = await this.workspaces.validateLease({ taskId: id, generation: lease.generation });
    return this.store.transaction(() => {
      if (!this.current(f) || this.store.getTask(id).status !== 'queued') return false;
      researchForDevelopment(this.store, f.admission, f.operationId);
      const active = this.workspaces.view({ taskId: id });
      need(
        active.state === 'ready' &&
          active.generation === proof.generation &&
          active.sourceDigest === proof.digest &&
          proof.profile === fileWorkerProfile,
        'Native lease changed during admission.'
      );
      this.db
        .prepare('INSERT INTO workspace_admissions VALUES(?,?,?,?)')
        .run(id, proof.generation, proof.profile, proof.digest);
      this.store.activity('workspace.ready', f.goalId, id);
      return true;
    });
  }
  async advance() {
    this.#waitingForCapacity.clear();
    const rows = this.db
      .prepare(
        "SELECT goalId,stage FROM native_goals WHERE stage NOT IN ('completed','blocked','superseded') ORDER BY rowid"
      )
      .all();
    const checking =
      this.queue &&
      rows.some((row) => row.stage === 'check' && this.store.goal(row.goalId).state === 'active');
    if (checking && (!this.capacity || this.capacity.operationAvailable('review.check')))
      this.store.transaction(() => {
        for (const { goalId } of rows) {
          const f = this.view(goalId);
          if (
            f.admission.jsRecipe ||
            f.stage !== 'check' ||
            this.store.goal(goalId).state !== 'active'
          )
            continue;
          try {
            this.queue.ensure(f.revisionId);
          } catch (error) {
            if (error.code !== 'NATIVE_PREREQUISITE_WAIT') throw error;
          }
        }
        // take() runs the projection under the reservation for the selected check.
      });
    let changed = false;
    for (const { goalId } of rows) {
      const f = this.view(goalId),
        goal = this.store.goal(goalId);
      if (goal.state === 'paused') continue;
      if (goal.state !== 'active' || goal.scopeVersion !== f.scopeVersion) {
        this.db.prepare("UPDATE native_goals SET stage='superseded' WHERE goalId=?").run(goalId);
        changed = true;
        continue;
      }
      try {
        if (await this.advanceWithCapacity(f)) changed = true;
      } catch (error) {
        if (error.code === 'NATIVE_PREREQUISITE_WAIT' && this.current(f)) {
          if (f.detail !== error.message) {
            this.db
              .prepare('UPDATE native_goals SET detail=? WHERE goalId=?')
              .run(error.message, goalId);
            this.store.activity('native.waiting', goalId);
          }
          continue;
        }
        if (![400, 403, 404, 409].includes(error.status)) throw error;
        if (this.current(f)) {
          this.store.transaction(() => {
            this.db
              .prepare("UPDATE native_goals SET stage='blocked',detail=? WHERE goalId=?")
              .run(error.message.slice(0, 600), goalId);
            this.store.activity('native.blocked', goalId);
            blockWorkflowGoal(this.store, 'native_goals', goalId);
          });
          changed = true;
        }
      }
    }
    return reconcileBlockedWorkflows(this.store, 'native_goals') || changed;
  }
  canRetryCapacity() {
    return [...this.#waitingForCapacity].some((name) => this.capacity.operationAvailable(name));
  }
  async advanceWithCapacity(f) {
    if (f.stage === 'planner') return this.step(f);
    let name;
    if (f.stage === 'check' || f.stage === 'land') name = 'review.' + f.stage;
    else {
      const id = f[f.stage + 'TaskId'],
        status = this.store.getTask(id).status;
      if (status === 'queued') {
        if (
          this.db
            .prepare(
              `SELECT 1 FROM workspace_admissions a JOIN agent_workspaces w ON w.taskId=a.taskId AND w.generation=a.generation
          WHERE a.taskId=? AND w.state='ready'`
            )
            .get(id)
        )
          return false;
        name = 'workspace.validate';
      } else if (status === 'completed')
        name = f.stage === 'author' ? 'review.submit' : 'review.attest';
    }
    let release;
    if (name && this.capacity) {
      try {
        release = this.capacity.reserve(name);
      } catch (error) {
        if (error.status !== 409) throw error;
        this.#waitingForCapacity.add(name);
        const detail = 'Waiting for host capacity. ' + error.message;
        if (f.detail !== detail) {
          this.db.prepare('UPDATE native_goals SET detail=? WHERE goalId=?').run(detail, f.goalId);
          this.store.activity('native.waiting', f.goalId);
        }
        return false;
      }
    }
    try {
      if (f.detail?.startsWith('Waiting for host capacity. '))
        this.db.prepare('UPDATE native_goals SET detail=NULL WHERE goalId=?').run(f.goalId);
      return await this.step(f);
    } finally {
      release?.();
    }
  }
  canRepair(f) {
    const allowance = attemptAllowance(this.db, f.goalId),
      { mainline } = this.authority.status();
    return (
      f.cycle < 2 &&
      allowance.remainingAttempts >= 2 &&
      allowance.activeTime.remainingMs > 0 &&
      mainline?.revisionId === f.admission.base
    );
  }
  repairActions(f) {
    if (!f.revisionId || !f.decisionId || !this.canRepair(f)) return [];
    try {
      const review = new NativeReview(this.store, {
        authority: () => this.authority.current(),
        role: (id, kind) => this.#role(id, kind, f.goalId)
      });
      if (
        this.workspaces.view({ taskId: f.reviewerTaskId })?.state !== 'reviewed' ||
        review.verifiedDecision(f.revisionId, f.reviewerTaskId, f.decisionId).decision !== 'reject'
      )
        return [];
      return [
        {
          name: 'goal.repair',
          input: {
            id: f.goalId,
            revisionId: f.revisionId,
            decisionId: f.decisionId,
            expectedVersion: this.store.goal(f.goalId).version
          }
        }
      ];
    } catch (error) {
      if ([400, 403, 404, 409].includes(error.status)) return [];
      throw error;
    }
  }
  repair(f, feedback) {
    if (!this.canRepair(f)) return false;
    // An earlier cycle remains independently inspectable under its original tasks and submission.
    const note = String(feedback).slice(0, 1900),
      cycle = f.cycle + 1;
    const research = researchForDevelopment(this.store, f.admission, f.operationId);
    const prompt = this.review.authorPrompt({
      ...f.admission,
      repository: f.repository,
      feedback: note,
      research,
      objectivePlan: authenticatedGuidance(this.store, f)
    });
    const taskId = this.delegate({ ...f, cycle }, 'author', prompt, note);
    this.db
      .prepare(
        `UPDATE native_goals SET cycle=?,stage='author',authorTaskId=?,reviewerTaskId=NULL,revisionId=NULL,
      decisionId=NULL,checkId=NULL,detail=? WHERE goalId=?`
      )
      .run(cycle, taskId, note, f.goalId);
    this.store.activity('native.repair', f.goalId, taskId);
    return true;
  }
  retryRejected({ id, revisionId, decisionId, expectedVersion }) {
    need(this.db.isTransaction, 'Repair requires the owner command transaction.');
    const f = this.view(id);
    need(
      expectedVersion === undefined || expectedVersion === this.store.goal(id).version,
      'Goal changed. Inspect its current repair action.'
    );
    reactivateForNativeRepair(this.store, id);
    need(
      f?.stage === 'blocked' &&
        f.revisionId === revisionId &&
        f.decisionId === decisionId &&
        this.current(f),
      'Select the current blocked goal and its exact rejected decision.'
    );
    const review = this.review.verifiedDecision(revisionId, f.reviewerTaskId, decisionId);
    need(
      review.id === decisionId &&
        review.decision === 'reject' &&
        this.workspaces.view({ taskId: f.reviewerTaskId })?.state === 'reviewed',
      'The selected cycle has no confirmed independent rejection.'
    );
    need(
      this.repair(f, review.note),
      'This goal has no eligible repair cycle at the original target and allowance.'
    );
    return { goal: this.store.goal(id), flow: this.view(id) };
  }
  async step(f) {
    const research = researchForDevelopment(this.store, f.admission, f.operationId);
    if (f.stage === 'planner') {
      const task = this.store.getTask(f.planner.taskId);
      if (task.status === 'queued') {
        const box = this.store.coordination.dispatch(task.id);
        need(
          !box.blocked && !box.messages.length && !task.dependsOn.length,
          'A fixed planner packet cannot include additional mailbox or prerequisite inputs. Admit a fresh owner objective.'
        );
        need(
          this.authority.status().mainline.revisionId === f.admission.base,
          'Native mainline changed before planner dispatch.'
        );
        return false;
      }
      if (
        ['starting', 'running', 'waiting_for_input', 'interrupting', 'recovery_needed'].includes(
          task.status
        )
      )
        return false;
      need(
        task.status === 'completed',
        'The native planner ended ' + task.status + '. Inspect its evidence.'
      );
      return this.store.transaction(() => {
        if (!this.current(f)) return false;
        const record = acceptObjectivePlan(this.store, f, this.authority.current());
        const prompt = this.review.authorPrompt({
          ...f.admission,
          repository: f.repository,
          research,
          objectivePlan: planGuidance(record)
        });
        const id = this.delegate(f, 'author', prompt);
        this.db
          .prepare("UPDATE native_goals SET stage='author',authorTaskId=? WHERE goalId=?")
          .run(id, f.goalId);
        this.store.activity('native.planned', f.goalId, task.id);
        return true;
      });
    }
    if (f.stage === 'author' || f.stage === 'reviewer') {
      const taskId = f[f.stage + 'TaskId'],
        task = this.store.getTask(taskId);
      if (task.status === 'queued') return this.admitLease(f, taskId);
      if (
        ['starting', 'running', 'waiting_for_input', 'interrupting', 'recovery_needed'].includes(
          task.status
        )
      )
        return false;
      need(
        task.status === 'completed',
        'The native ' + f.stage + ' ended ' + task.status + '. Inspect its evidence.'
      );
      const lease = this.workspaces.view({ taskId });
      need(lease, 'Native role has no admitted workspace.');
      if (f.stage === 'author') {
        const captured = await this.workspaces.prepareCapture({
          taskId,
          generation: lease.generation
        });
        if (!this.current(f)) return false;
        const token = this.review.prepareSubmit(taskId);
        return this.store.transaction(() => {
          if (!this.current(f)) return false;
          const { revision } = this.review.submit(token);
          this.workspaces.sealNativeCapture(captured, { revision });
          const id = this.delegate(f, 'reviewer', this.review.reviewerRequest(revision.id).prompt);
          this.db
            .prepare(
              "UPDATE native_goals SET stage='reviewer',revisionId=?,reviewerTaskId=? WHERE goalId=?"
            )
            .run(revision.id, id, f.goalId);
          this.store.activity('native.submitted', f.goalId, taskId);
          return true;
        });
      }
      const proof = await this.workspaces.validateLease({ taskId, generation: lease.generation });
      return this.store.transaction(() => {
        if (!this.current(f)) return false;
        const { review } = this.review.attest(f.revisionId, taskId);
        this.workspaces.sealReviewer({
          taskId,
          generation: lease.generation,
          reviewId: review.id,
          leaseProof: proof
        });
        this.db
          .prepare('UPDATE native_goals SET stage=?,decisionId=?,detail=? WHERE goalId=?')
          .run(
            review.decision === 'approve' ? 'check' : 'blocked',
            review.id,
            review.decision === 'approve' ? null : review.note,
            f.goalId
          );
        if (review.decision === 'reject') this.repair(f, review.note);
        blockWorkflowGoal(this.store, 'native_goals', f.goalId);
        this.store.activity('native.reviewed', f.goalId, taskId);
        return true;
      });
    }
    if (f.admission.jsRecipe) await this.javascript.ensure(f.revisionId);
    return this.store.transaction(() => {
      if (!this.current(f)) return false;
      const { mainline } = this.authority.status();
      if (f.stage === 'check') {
        const { check } =
          this.queue && !f.admission.jsRecipe
            ? this.queue.take(f.revisionId)
            : this.review.check(f.revisionId, mainline.revisionId, mainline.generation);
        need(check.reviewId === f.decisionId, 'The native check names a different review.');
        this.db
          .prepare('UPDATE native_goals SET stage=?,checkId=?,detail=? WHERE goalId=?')
          .run(
            check.state === 'passed' ? 'land' : 'blocked',
            check.id,
            check.state === 'passed' ? null : JSON.stringify(check.failures).slice(0, 600),
            f.goalId
          );
        if (check.state === 'failed' && check.expectedTarget === f.admission.base)
          this.repair(f, JSON.stringify(check.failures));
        blockWorkflowGoal(this.store, 'native_goals', f.goalId);
        this.store.activity('native.checked', f.goalId);
        return true;
      }
      need(f.stage === 'land', 'Unknown native development phase.');
      const submitted = this.review.view(f.revisionId),
        check = submitted.checks.find((c) => c.id === f.checkId);
      if (
        check?.expectedGeneration !== mainline.generation ||
        check.expectedTarget !== mainline.revisionId
      ) {
        this.db
          .prepare("UPDATE native_goals SET stage='check',checkId=NULL WHERE goalId=?")
          .run(f.goalId);
        return true;
      }
      let landed;
      try {
        landed = this.review.land(
          f.revisionId,
          f.checkId,
          mainline.revisionId,
          mainline.generation,
          'land.' + f.goalId + '.' + f.cycle
        );
      } catch (error) {
        if (error.code !== 'NATIVE_CHECK_OBSOLETE') throw error;
        this.db
          .prepare("UPDATE native_goals SET stage='check',checkId=NULL WHERE goalId=?")
          .run(f.goalId);
        return true;
      }
      const { landing } = landed;
      const decision = submitted.reviews.find((r) => r.id === landing.reviewId);
      const a = this.workspaces.view({ taskId: f.authorTaskId }),
        r = this.workspaces.view({ taskId: f.reviewerTaskId });
      need(
        a?.state === 'sealed' &&
          r?.state === 'reviewed' &&
          a.capture?.attemptId === submitted.revision.author.attemptId &&
          decision?.evidence?.taskId === r.taskId &&
          decision.id === f.decisionId &&
          check.state === 'passed',
        'Native completion lacks its role or check evidence.'
      );
      const goal = this.store.goal(f.goalId),
        version = goal.version + 1,
        completedAt = new Date().toISOString();
      const evidence = {
        criterionId: goal.criteria[0].id,
        repository: f.repository,
        epoch: f.epoch,
        author: submitted.revision.author,
        reviewer: decision.evidence,
        revisionId: f.revisionId,
        decision,
        check,
        landing,
        workspaces: [a.workspaceId, r.workspaceId],
        ...(f.planner ? { objectivePlanId: f.planner.accepted.id } : {}),
        ...(research ? { research: researchPin(research) } : {})
      };
      const criteria = JSON.stringify([{ ...goal.criteria[0], evidence: [check.id] }]);
      this.db.prepare('INSERT INTO goal_completions VALUES(?,?)').run(
        goal.id,
        JSON.stringify({
          goalId: goal.id,
          version,
          verifiedGoalVersion: goal.version,
          scopeVersion: f.scopeVersion,
          objective: goal.objective,
          criteria: JSON.parse(criteria),
          evidence: [evidence],
          completedAt,
          policy: 'reviewed-native-change-v1'
        })
      );
      this.db
        .prepare("UPDATE goals SET state='completed',version=?,criteria=? WHERE id=?")
        .run(version, criteria, goal.id);
      this.db
        .prepare("INSERT INTO goal_revisions VALUES(?,?,?,?,'completed','goal.completed',?)")
        .run(goal.id, version, goal.objective, criteria, completedAt);
      this.db
        .prepare("UPDATE native_goals SET stage='completed',evidence=? WHERE goalId=?")
        .run(JSON.stringify(evidence), goal.id);
      this.store.activity('goal.completed', goal.id);
      return true;
    });
  }
}
