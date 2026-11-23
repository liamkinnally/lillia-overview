import {
  deriveProjectRepairInput,
  normalizeProjectRepair,
  projectAdmissionDigest,
  projectSeed,
  requireSettledRepair,
  verifyProjectRepairInput
} from './project-repair.mjs';
import { verifyRejectedProject } from './project-review-proof.mjs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import {
  claudeProfileScope,
  codexProjectProfileScope,
  matchProjectProfile
} from './effective-config.mjs';
import { nativeFileId, NativeStore } from './native-store.mjs';
import { parseFlatVerdict } from './native-review.mjs';
import { readFinalOutput } from './task-context.mjs';
import { blockWorkflowGoal, reconcileBlockedWorkflows } from './goal-lifecycle.mjs';
import { jobSocketPath } from './job-client.mjs';
import { projectExecution, projectNativeIdentity } from './project-execution.mjs';
import {
  normalizeProjectGoal,
  prepareProjectEdit,
  projectRolePrompt,
  projectTools,
  readProjectFile,
  requireProject as need
} from './project-source.mjs';

import {
  workspaceProjectToolNames,
  workspaceProjectArguments
} from './project-workspace-tools.mjs';
import {
  workspaceProfile,
  workspaceMutation,
  workspaceObservation,
  prepareWorkspaceEdit,
  workspaceEditResult,
  verifyWorkspaceEdit
} from './project-workspace-operations.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const decode = (s) => (s === null ? null : JSON.parse(s));
const fields = (v, expected) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === expected.length &&
  expected.every((k) => Object.hasOwn(v, k));
const id = (s) => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(s);
const profileScope = (driver, model, role, manifest) =>
  driver === 'codex'
    ? codexProjectProfileScope(
        model,
        role,
        manifest.nativeVersion,
        manifest.projectDynamic?.version
      )
    : claudeProfileScope(model, role, manifest.nativeVersion);
const criterion = 'Independently review and rerun the regression on the combined project revision';
export const projectChangeTables = [
  'project_changes',
  'project_tool_operations',
  'project_landings'
];
export function installProjectChanges(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_changes(goalId TEXT PRIMARY KEY REFERENCES goals(id),operationId TEXT NOT NULL UNIQUE,input TEXT NOT NULL,
    epoch TEXT NOT NULL,policyDigest TEXT NOT NULL,stage TEXT NOT NULL,candidate TEXT NOT NULL REFERENCES native_revisions(id),
    authorTaskId TEXT NOT NULL UNIQUE REFERENCES goal_tasks(taskId),reviewerTaskId TEXT UNIQUE REFERENCES goal_tasks(taskId),
    authorFinal TEXT,reviewerFinal TEXT,detail TEXT);
    CREATE TABLE IF NOT EXISTS project_tool_operations(operationId TEXT PRIMARY KEY,goalId TEXT NOT NULL REFERENCES project_changes(goalId),
    taskId TEXT NOT NULL REFERENCES goal_tasks(taskId),attemptId TEXT NOT NULL REFERENCES attempts(id),role TEXT NOT NULL,tool TEXT NOT NULL,
    args TEXT NOT NULL,revisionBefore TEXT NOT NULL REFERENCES native_revisions(id),revisionAfter TEXT NOT NULL REFERENCES native_revisions(id),
    observationId TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,text TEXT NOT NULL,denied INTEGER NOT NULL CHECK(denied IN(0,1)),native TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS project_native_tool_call ON project_tool_operations(attemptId,json_extract(native,'$.toolUseId')) WHERE native IS NOT NULL;
    CREATE TABLE IF NOT EXISTS project_landings(operationId TEXT PRIMARY KEY,goalId TEXT UNIQUE NOT NULL REFERENCES project_changes(goalId),record TEXT NOT NULL);`);
}
export function readProjectChange(db, id) {
  const row = db.prepare('SELECT * FROM project_changes WHERE goalId=?').get(id);
  return row
    ? {
        ...row,
        input: decode(row.input),
        authorFinal: decode(row.authorFinal),
        reviewerFinal: decode(row.reviewerFinal)
      }
    : null;
}
export function roleSubject(flow, role, recipe) {
  return {
    goalId: flow.goalId,
    operationId: flow.operationId,
    role,
    repository: flow.input.repository,
    base: flow.input.base,
    recipeId: flow.input.recipeId,
    revisionId: role === 'author' ? projectSeed(flow.input) : flow.authorFinal.revisionId,
    ...(flow.input.repair ? { repair: flow.input.repair } : {}),
    ...(flow.input.version === 3
      ? { workflow: 'workspace', scopeDigest: recipe.scope.digest }
      : { componentPath: recipe.input.componentPath, testPath: recipe.input.testPath })
  };
}
export class ProjectDevelopment {
  #tokens = new Map();
  #busy = new Set();
  constructor(
    store,
    { dataDir, workspaceRoot, authority, validation, proveLanding, checkEvidence, capacity }
  ) {
    Object.assign(this, {
      store,
      db: store.db,
      dataDir,
      workspaceRoot,
      authority,
      validation,
      proveLanding,
      checkEvidence,
      capacity
    });
    this.source = new NativeStore(store);
  }
  view(id) {
    return readProjectChange(this.db, id);
  }
  #recipe(input, epoch) {
    const recipe = this.validation.get(input.recipeId);
    need(
      (input.version === 3) === (recipe.profile === workspaceProfile),
      'Project workflow and enrolled tooling differ.'
    );
    const { authority, mainline } = this.authority.status();
    need(
      authority?.repository === input.repository &&
        authority.epoch === epoch &&
        authority.policyDigest === input.policyDigest &&
        mainline.revisionId === input.base &&
        mainline.generation === input.expectedGeneration,
      'The admitted project base, generation or policy changed.'
    );
    need(
      recipe.input.repository === input.repository &&
        recipe.input.base === input.base &&
        recipe.epoch === epoch &&
        recipe.generation === input.expectedGeneration,
      'The validation recipe belongs to a different project generation.'
    );
    return recipe;
  }
  repair(raw, operationId) {
    const request = normalizeProjectRepair(raw);
    requireSettledRepair(this.db, request.rejectedGoalId);
    verifyRejectedProject(this.db, request.rejectedGoalId, this.checkEvidence);
    return this.#admit(deriveProjectRepairInput(this.db, request), operationId, true);
  }
  admit(raw, operationId) {
    return this.#admit(raw, operationId, false);
  }
  #admit(raw, operationId, allowRepair) {
    const input = normalizeProjectGoal(raw, { allowRepair }),
      execution = projectExecution(input),
      epoch = this.authority.current()?.epoch;
    const recipe = this.#recipe(input, epoch);
    need(
      (input.version === 3) === (recipe.profile === workspaceProfile),
      'Project workflow and enrolled tooling differ.'
    );
    need(
      execution.provider === 'codex'
        ? ['codex-only', 'mixed'].includes(this.store.sessionProfile.mode)
        : this.store.sessionProfile.mode === 'mixed',
      'This workflow needs its authorized installed provider route.'
    );
    need(
      this.db.prepare('SELECT count(*) AS n FROM project_changes').get().n < 128,
      'Project workflow history reached its bound.'
    );
    const goal = this.store.createGoal(
      {
        objective: input.objective,
        criteria: [criterion],
        workerProvider: execution.provider,
        claudeModel: input.claudeModel,
        ...(execution.provider === 'codex' ? { executionSelection: execution } : {}),
        maxAttempts: input.maxAttempts,
        maxActiveSeconds: input.maxActiveSeconds
      },
      { projectExecution: true }
    );
    const criteria = JSON.stringify([{ ...goal.criteria[0], verifier: 'reviewed-project-change' }]);
    this.db.prepare('UPDATE goals SET criteria=? WHERE id=?').run(criteria, goal.id);
    this.db
      .prepare('UPDATE goal_revisions SET criteria=? WHERE id=? AND version=1')
      .run(criteria, goal.id);
    const subject = roleSubject({ goalId: goal.id, operationId, input }, 'author', recipe);
    const task = this.store.submit(
      {
        goalId: goal.id,
        provider: execution.provider,
        prompt: projectRolePrompt(subject, input.objective),
        ...(execution.provider === 'codex'
          ? { executionSelection: execution, expectedVersion: goal.version }
          : {})
      },
      this.workspaceRoot,
      { projectExecution: true }
    );
    this.db
      .prepare("INSERT INTO project_changes VALUES(?,?,?,?,?,'author',?,?,NULL,NULL,NULL,NULL)")
      .run(
        goal.id,
        operationId,
        JSON.stringify(input),
        epoch,
        input.policyDigest,
        projectSeed(input),
        task.id
      );
    this.store.activity('project.admitted', goal.id, task.id);
    return { goal: this.store.goal(goal.id), projectChange: this.view(goal.id) };
  }
  validateDispatch(taskId) {
    const owner = this.db.prepare('SELECT goalId FROM goal_tasks WHERE taskId=?').get(taskId);
    if (!owner) return null;
    const f = this.view(owner.goalId);
    if (!f) {
      need(
        !this.db
          .prepare(
            "SELECT 1 FROM command_receipts WHERE json_extract(receipt,'$.projectChange.goalId')=?"
          )
          .get(owner.goalId),
        'Project task lost its owner admission.'
      );
      return null;
    }
    const role = f.stage,
      goal = this.store.goal(f.goalId);
    need(
      ['author', 'reviewer'].includes(role) &&
        f[role + 'TaskId'] === taskId &&
        goal.state === 'active' &&
        goal.scopeVersion === 1,
      'Project role is inactive or superseded.'
    );
    const receipt = this.db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(f.operationId);
    const admitted = receipt && decode(receipt.receipt)?.projectChange;
    need(
      receipt?.digest === projectAdmissionDigest(f.input) &&
        admitted?.goalId === f.goalId &&
        admitted.authorTaskId === f.authorTaskId &&
        admitted.policyDigest === f.policyDigest &&
        admitted.epoch === f.epoch &&
        same(admitted.input, f.input),
      'Project role lost its exact owner admission.'
    );
    if (f.input.repair) {
      verifyProjectRepairInput(this.db, f.input);
      verifyRejectedProject(this.db, f.input.repair.rejectedGoalId, this.checkEvidence);
    }
    const subject = roleSubject(f, role, this.#recipe(f.input, f.epoch));
    this.validateCandidate(f, subject);
    const { task } = this.store.taskView(taskId),
      execution = projectExecution(f.input);
    need(
      task.provider === execution.provider &&
        task.model === execution.model &&
        task.specVersion === 1 &&
        !task.dependsOn.length &&
        task.prompt === projectRolePrompt(subject, f.input.objective),
      'Project role input or model changed.'
    );
    const box = this.store.coordination.dispatch(taskId);
    need(
      !box.blocked && !box.messages.length,
      'Additional mailbox data requires a new project admission.'
    );
    return subject;
  }
  validateCandidate(flow, subject) {
    let tip = projectSeed(flow.input);
    const edits = this.db
      .prepare(
        "SELECT * FROM project_tool_operations WHERE goalId=? AND tool IN ('replace_text','write_file','delete_file') AND denied=0 ORDER BY rowid"
      )
      .all(flow.goalId);
    for (const row of edits) {
      if (flow.input.version === 3) {
        need(
          row.taskId === flow.authorTaskId && row.role === 'author' && row.revisionBefore === tip,
          'Workspace edit history differs from its author or parent.'
        );
        verifyWorkspaceEdit(this.source, this.validation.get(flow.input.recipeId), row);
        tip = row.revisionAfter;
        continue;
      }
      const args = decode(row.args),
        revision = this.source.revision({
          repository: subject.repository,
          revisionId: row.revisionAfter
        });
      need(
        row.taskId === flow.authorTaskId &&
          row.role === 'author' &&
          row.revisionBefore === tip &&
          [subject.componentPath, subject.testPath].includes(args.path) &&
          Array.isArray(revision.parents) &&
          same(revision.parents, [tip]) &&
          same(revision.provenance, { principal: 'project-author', taskId: row.taskId }) &&
          same(revision.edits, [
            { path: args.path, mode: '100644', fileId: nativeFileId(Buffer.from(args.text)) }
          ]),
        'The retained project edit chain differs from the admitted author or source.'
      );
      tip = row.revisionAfter;
    }
    need(flow.candidate === tip, 'The project candidate does not match its admitted edit history.');
    if (subject.role === 'reviewer')
      need(
        flow.authorFinal?.revisionId === tip &&
          same(flow.authorFinal, this.#final(flow, 'author', flow.authorTaskId)),
        'The project reviewer requires the original submitted revision and check.'
      );
  }
  coldReviewState(attemptId, goalId) {
    return {
      brokerUnissued: !this.#tokens.has(attemptId),
      operationsIdle: !this.#busy.has(goalId)
    };
  }
  #drop(attemptId) {
    const token = this.#tokens.get(attemptId);
    if (!token) return;
    this.#tokens.delete(attemptId);
    rmSync(token.dir, { recursive: true, force: true });
  }
  close() {
    for (const key of this.#tokens.keys()) this.#drop(key);
  }
  toolSession(taskId) {
    const subject = this.validateDispatch(taskId);
    if (!subject) return null;
    const { task, attempts } = this.store.taskView(taskId),
      a = attempts.at(-1);
    need(
      a?.driver === task.provider &&
        a.status === task.status &&
        ['starting', 'running'].includes(a.status),
      'The project tool session requires its live reserved attempt.'
    );
    let entry = this.#tokens.get(a.id);
    if (!entry) {
      const dir = mkdtempSync(join(this.dataDir, 'project-tool-')),
        credentialFile = join(dir, 'capability'),
        secret = randomBytes(32).toString('base64url');
      try {
        writeFileSync(credentialFile, secret + '\n', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      entry = {
        dir,
        secret,
        descriptor: {
          version: subject.workflow === 'workspace' ? 2 : 1,
          ...(subject.workflow === 'workspace' ? { workflow: 'workspace' } : {}),
          taskId,
          attemptId: a.id,
          role: subject.role,
          ...(task.provider === 'codex'
            ? { executionSelection: projectExecution(this.view(task.goalId).input) }
            : {}),
          tools:
            subject.workflow === 'workspace'
              ? workspaceProjectToolNames(subject.role)
              : [...projectTools[subject.role]],
          socketPath: jobSocketPath(this.dataDir),
          credentialFile
        }
      };
      this.#tokens.set(a.id, entry);
    }
    return entry.descriptor;
  }
  #authorized(p) {
    const token = this.#tokens.get(p.attemptId);
    need(
      token?.descriptor.taskId === p.taskId &&
        typeof p.credential === 'string' &&
        /^[a-zA-Z0-9_-]{43}$/.test(p.credential) &&
        timingSafeEqual(Buffer.from(p.credential), Buffer.from(token.secret)),
      'Project capability unavailable.',
      403
    );
    const subject = this.validateDispatch(p.taskId),
      { task, attempts } = this.store.taskView(p.taskId),
      attempt = attempts.at(-1);
    need(
      subject &&
        attempt.id === p.attemptId &&
        attempt.status === task.status &&
        ['starting', 'running', 'waiting_for_input'].includes(task.status) &&
        attempt.accountInstance ===
          this.db
            .prepare('SELECT value FROM settings WHERE key=?')
            .get(task.provider + '.accountInstance')?.value,
      'Project attempt is no longer current.',
      403
    );
    const config = this.db
      .prepare('SELECT * FROM attempt_configs WHERE attemptId=?')
      .get(attempt.id);
    const ctx = this.db
      .prepare('SELECT digest,manifest FROM task_contexts WHERE taskId=? AND ordinal=?')
      .get(task.id, attempt.ordinal);
    const manifest = ctx && decode(ctx.manifest);
    need(
      (task.provider === 'codex'
        ? ['mixed', 'codex-only'].includes(this.store.sessionProfile.mode)
        : this.store.sessionProfile.mode === 'mixed') &&
        config?.driver === task.provider &&
        config.scope ===
          profileScope(task.provider, task.model, subject.role, decode(config.manifest)) &&
        !attempt.modelRerouted &&
        (!attempt.observedModel || attempt.observedModel === task.model) &&
        hash(config.manifest) === config.digest &&
        ctx &&
        config.contextDigest === ctx.digest &&
        hash(ctx.manifest) === ctx.digest &&
        same(manifest.projectChange, subject) &&
        manifest.taskId === task.id &&
        manifest.accountInstance === attempt.accountInstance &&
        manifest.requestedModel === task.model &&
        manifest.ordinal === attempt.ordinal &&
        manifest.promptDigest === hash(task.prompt) &&
        ['handoff', 'research', 'workspace', 'rollover'].every(
          (k) => !Object.hasOwn(manifest, k)
        ) &&
        [manifest.mailbox, manifest.dependencies, manifest.coordinationRoutes].every(
          (v) => Array.isArray(v) && v.length === 0
        ) &&
        matchProjectProfile(config.driver, config.scope, decode(config.manifest)) ===
          subject.role &&
        (task.provider !== 'codex' ||
          (subject.workflow === 'workspace') ===
            (decode(config.manifest).projectDynamic?.version === 5)),
      'Project tools require the bound native role profile and dispatch context.',
      403
    );
    return { subject, flow: this.view(subject.goalId), attempt };
  }
  #receipt(row) {
    return {
      version: 1,
      operationId: row.operationId,
      observationId: row.observationId,
      digest: row.digest,
      text: row.text
    };
  }
  #record(p, subject, before, after, value, denied) {
    const text = JSON.stringify(value),
      digest = hash(text),
      observationId = randomUUID();
    this.db
      .prepare('INSERT INTO project_tool_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)')
      .run(
        p.operationId,
        subject.goalId,
        p.taskId,
        p.attemptId,
        subject.role,
        p.tool,
        JSON.stringify(p.arguments),
        before,
        after,
        observationId,
        digest,
        text,
        Number(denied)
      );
    return {
      status: denied ? 403 : 200,
      body: { version: 1, operationId: p.operationId, observationId, digest, text }
    };
  }
  async request(p) {
    need(
      fields(p, [
        'version',
        'operationId',
        'taskId',
        'attemptId',
        'credential',
        'tool',
        'arguments'
      ]) &&
        p.version === 1 &&
        [p.operationId, p.taskId, p.attemptId, p.tool].every(id) &&
        p.arguments &&
        typeof p.arguments === 'object' &&
        !Array.isArray(p.arguments),
      'Invalid project tool packet.',
      400
    );
    const { subject, flow } = this.#authorized(p);
    const old = this.db
      .prepare('SELECT * FROM project_tool_operations WHERE operationId=?')
      .get(p.operationId);
    if (old) {
      need(
        old.taskId === p.taskId &&
          old.attemptId === p.attemptId &&
          old.tool === p.tool &&
          same(decode(old.args), p.arguments),
        'Project operation identity already used.'
      );
      return { status: old.denied ? 403 : 200, body: this.#receipt(old) };
    }
    const n = this.db
      .prepare('SELECT count(*) AS n FROM project_tool_operations WHERE attemptId=?')
      .get(p.attemptId).n;
    need(
      n < (flow.input.version === 3 ? 128 : 48) && !this.#busy.has(flow.goalId),
      'Project tool allowance is exhausted or another call is in progress.'
    );
    this.#busy.add(flow.goalId);
    const before = flow.candidate,
      selection = { ...subject, revisionId: before },
      args = p.arguments;
    let value, edit, release;
    try {
      try {
        need(
          (flow.input.version === 3
            ? workspaceProjectToolNames(subject.role)
            : projectTools[subject.role]
          ).includes(p.tool),
          'Tool is outside the selected role.',
          403
        );
        if (flow.input.version === 3 && p.tool !== 'run_check') {
          const recipe = this.validation.get(flow.input.recipeId);
          workspaceProjectArguments(subject.role, p.tool, args);
          if (workspaceMutation(p.tool))
            edit = prepareWorkspaceEdit(this.source, recipe, selection, p.taskId, p.tool, args);
          else value = workspaceObservation(this.source, recipe, selection, p.tool, args);
        } else if (p.tool === 'list_files') {
          need(fields(args, []), 'Unexpected list arguments.', 400);
          value = { revisionId: before, paths: [selection.componentPath, selection.testPath] };
        } else if (p.tool === 'read_file') {
          need(fields(args, ['path']), 'Supply one selected path.', 400);
          value = readProjectFile(this.source, selection, args.path);
        } else if (p.tool === 'replace_text') {
          need(
            fields(args, ['path', 'expectedFileId', 'text']),
            'Supply one selected file and its exact current identity.',
            400
          );
          edit = prepareProjectEdit(this.source, selection, p.taskId, args);
        } else {
          need(fields(args, []), 'Unexpected check arguments.', 400);
          const count = this.db
            .prepare(
              "SELECT count(*) n FROM project_tool_operations WHERE attemptId=? AND tool='run_check'"
            )
            .get(p.attemptId).n;
          need(count < 6, 'Project check allowance exhausted.', 403);
          release = this.capacity?.reserve('project.validation.check');
          const check = await this.validation.check({
            recipeId: flow.input.recipeId,
            repository: selection.repository,
            revisionId: before,
            role: subject.role
          });
          value = {
            checkId: hash(JSON.stringify([p.taskId, p.attemptId, p.operationId, check])),
            ...check
          };
        }
      } catch (error) {
        if (![400, 403, 404, 409, 422].includes(error.status)) throw error;
        this.#authorized(p);
        return this.store.transaction(() =>
          this.#record(
            p,
            subject,
            before,
            before,
            { error: String(error.message).slice(0, 400) },
            true
          )
        );
      }
      return this.store.transaction(() => {
        const now = this.#authorized(p);
        need(now.flow.candidate === before, 'The project revision changed while checking.');
        let after = before;
        if (edit) {
          after = this.source.acceptRevision(edit).revisionId;
          this.db
            .prepare('UPDATE project_changes SET candidate=? WHERE goalId=? AND candidate=?')
            .run(after, flow.goalId, before);
          value =
            flow.input.version === 3
              ? workspaceEditResult(edit, after)
              : { path: args.path, fileId: edit.edits[0].fileId, revisionId: after };
        }
        return this.#record(p, subject, before, after, value, false);
      });
    } finally {
      release?.();
      this.#busy.delete(flow.goalId);
    }
  }
  confirmToolUse(p) {
    const { subject, attempt } = this.#authorized({
      ...p,
      credential: this.#tokens.get(p.attemptId)?.secret
    });
    need(
      [p.toolUseId, p.runId, p.sessionId].every(id) &&
        p.runId === projectNativeIdentity(attempt).runId &&
        p.sessionId === projectNativeIdentity(attempt).sessionId,
      'Native tool response lacks its bound session.'
    );
    const row = this.db
      .prepare('SELECT * FROM project_tool_operations WHERE operationId=?')
      .get(p.response.operationId);
    need(
      row &&
        row.goalId === subject.goalId &&
        row.taskId === p.taskId &&
        row.attemptId === p.attemptId &&
        row.tool === p.tool &&
        same(decode(row.args), p.arguments) &&
        row.observationId === p.response.observationId &&
        row.digest === p.response.digest &&
        Boolean(row.denied) === p.denied,
      'Native tool response contradicts the broker receipt.'
    );
    const binding = JSON.stringify({
      runId: p.runId,
      sessionId: p.sessionId,
      toolUseId: p.toolUseId,
      response: {
        operationId: row.operationId,
        observationId: row.observationId,
        digest: row.digest
      },
      argumentsDigest: hash(row.args)
    });
    need(
      row.native === null || row.native === binding,
      'Tool observation belongs to another native call.'
    );
    this.db
      .prepare('UPDATE project_tool_operations SET native=? WHERE operationId=?')
      .run(binding, p.response.operationId);
  }
  #final(f, role, taskId) {
    const { text, ...proof } = readFinalOutput(this.store, taskId);
    const answer = parseFlatVerdict(text, ['decision', 'revisionId', 'checkId', 'note']);
    need(
      answer.revisionId === f.candidate &&
        /^[a-f0-9]{64}$/.test(answer.checkId) &&
        answer.note.trim() &&
        answer.note.length <= 2048 &&
        (role === 'author'
          ? answer.decision === 'submit'
          : ['approve', 'reject'].includes(answer.decision)),
      'The native final must identify the combined revision, its own check and its decision.'
    );
    const bound = this.db
      .prepare(
        `SELECT a.executionId,a.nativeSessionId,a.threadId,a.turnId,a.modelRerouted,a.observedModel,c.contextDigest,c.digest,c.driver,c.scope,c.manifest FROM attempts a JOIN attempt_configs c ON c.attemptId=a.id
      WHERE a.id=?`
      )
      .get(proof.attemptId);
    const profile = bound && decode(bound.manifest),
      execution = projectExecution(f.input),
      native = bound && projectNativeIdentity(bound);
    need(
      native?.runId &&
        native.sessionId &&
        bound.driver === execution.provider &&
        !bound.modelRerouted &&
        (!bound.observedModel || bound.observedModel === execution.model) &&
        bound.scope === profileScope(execution.provider, execution.model, role, profile) &&
        matchProjectProfile(bound.driver, bound.scope, profile) === role,
      'The terminal project role lacks its exact native run and configuration.'
    );
    const check = this.db
      .prepare(
        `SELECT text FROM project_tool_operations WHERE attemptId=? AND role=? AND tool='run_check' AND denied=0
      AND native IS NOT NULL AND revisionAfter=? AND json_extract(text,'$.checkId')=?`
      )
      .get(proof.attemptId, role, f.candidate, answer.checkId);
    need(
      check && (answer.decision === 'reject' || decode(check.text).outcome === 'passed'),
      'The native final lacks a matching observed check result.'
    );
    return {
      ...answer,
      evidence: {
        ...proof,
        runId: native.runId,
        contextDigest: bound.contextDigest,
        configDigest: bound.digest
      }
    };
  }
  #complete(f) {
    const landing = this.proveLanding(this.db, f.goalId, this.checkEvidence);
    this.source.advanceRef({
      repository: landing.repository,
      name: 'mainline',
      expectedRevision: landing.expectedTarget,
      expectedGeneration: landing.expectedGeneration,
      revisionId: landing.candidate,
      operationId: landing.operationId
    });
    this.db
      .prepare('INSERT INTO project_landings VALUES(?,?,?)')
      .run(landing.operationId, f.goalId, JSON.stringify(landing));
    const goal = this.store.goal(f.goalId),
      version = goal.version + 1,
      completedAt = new Date().toISOString();
    const criteria = [{ ...goal.criteria[0], evidence: [landing.candidate] }];
    const evidence = [{ criterionId: criteria[0].id, landing }];
    this.db.prepare("UPDATE project_changes SET stage='completed' WHERE goalId=?").run(f.goalId);
    this.db
      .prepare("UPDATE goals SET state='completed',version=?,criteria=? WHERE id=?")
      .run(version, JSON.stringify(criteria), f.goalId);
    this.db
      .prepare("INSERT INTO goal_revisions VALUES(?,?,?,?,'completed','goal.completed',?)")
      .run(f.goalId, version, goal.objective, JSON.stringify(criteria), completedAt);
    this.db.prepare('INSERT INTO goal_completions VALUES(?,?)').run(
      f.goalId,
      JSON.stringify({
        goalId: f.goalId,
        version,
        verifiedGoalVersion: goal.version,
        scopeVersion: 1,
        objective: goal.objective,
        criteria,
        evidence,
        completedAt,
        policy: 'reviewed-project-v1'
      })
    );
    this.store.activity('goal.completed', f.goalId);
  }
  advance() {
    let changed = false;
    const rows = this.db
      .prepare("SELECT goalId FROM project_changes WHERE stage IN ('author','reviewer')")
      .all();
    for (const { goalId } of rows) {
      const f = this.view(goalId),
        role = f.stage,
        taskId = f[role + 'TaskId'],
        g = this.store.goal(goalId);
      if (g.state === 'paused') continue;
      if (g.state !== 'active' || g.scopeVersion !== 1) {
        this.db
          .prepare(
            "UPDATE project_changes SET stage='superseded',detail='Owner goal changed' WHERE goalId=?"
          )
          .run(goalId);
        changed = true;
        continue;
      }
      const { task, attempts } = this.store.taskView(taskId);
      if (
        ['starting', 'running', 'waiting_for_input', 'interrupting', 'recovery_needed'].includes(
          task.status
        )
      )
        continue;
      try {
        this.validateDispatch(taskId);
        if (task.status === 'queued') continue;
        need(
          task.status === 'completed',
          'The project ' + role + ' ended ' + task.status + '. Inspect its retained attempt.'
        );
        const final = this.#final(f, role, taskId),
          recipe = this.#recipe(f.input, f.epoch);
        this.store.transaction(() => {
          if (role === 'author') {
            const subject = roleSubject({ ...f, authorFinal: final }, 'reviewer', recipe);
            const reviewer = this.store.submit(
              {
                goalId,
                provider: projectExecution(f.input).provider,
                prompt: projectRolePrompt(subject, f.input.objective),
                ...([2, 3].includes(f.input.version)
                  ? { executionSelection: f.input.executionSelection, expectedVersion: g.version }
                  : {})
              },
              this.workspaceRoot,
              { projectExecution: true }
            );
            this.db
              .prepare(
                "UPDATE project_changes SET stage='reviewer',authorFinal=?,reviewerTaskId=? WHERE goalId=?"
              )
              .run(JSON.stringify(final), reviewer.id, goalId);
            this.store.activity('project.submitted', goalId, taskId);
          } else {
            this.db
              .prepare('UPDATE project_changes SET reviewerFinal=? WHERE goalId=?')
              .run(JSON.stringify(final), goalId);
            if (final.decision === 'approve') this.#complete(f);
            else {
              this.db
                .prepare("UPDATE project_changes SET stage='blocked',detail=? WHERE goalId=?")
                .run(final.note, goalId);
              this.store.activity('project.rejected', goalId, taskId);
              blockWorkflowGoal(this.store, 'project_changes', goalId);
            }
          }
        });
        changed = true;
      } catch (error) {
        this.store.transaction(() => {
          this.db
            .prepare("UPDATE project_changes SET stage='blocked',detail=? WHERE goalId=?")
            .run(String(error.message).slice(0, 512), goalId);
          this.store.activity('project.blocked', goalId, taskId);
          blockWorkflowGoal(this.store, 'project_changes', goalId);
        });
        changed = true;
      } finally {
        if (attempts.length) this.#drop(attempts.at(-1).id);
      }
    }
    return reconcileBlockedWorkflows(this.store, 'project_changes') || changed;
  }
}
