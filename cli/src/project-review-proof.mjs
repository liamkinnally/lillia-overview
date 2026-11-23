import {
  projectAdmissionDigest,
  projectSeed,
  verifyProjectRepairInput,
  rejectedProject
} from './project-repair.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { verifyProjectReviewRecovery } from './project-review-recovery.mjs';
import { parseFlatVerdict } from './native-review.mjs';
import { NativeStore, nativeFileId } from './native-store.mjs';
import { NativeAuthority } from './native-authority.mjs';
import {
  normalizeProjectGoal,
  projectRolePrompt,
  readProjectFile,
  requireProject as need
} from './project-source.mjs';
import { projectMcpArguments } from './project-mcp.mjs';
import {
  claudeProfileScope,
  codexProjectProfileScope,
  matchProjectProfile
} from './effective-config.mjs';
import { projectExecution, projectNativeIdentity } from './project-execution.mjs';
import { verifyCodexProjectFinal } from './project-review-codex-proof.mjs';
import { ProjectValidation, verifyProjectCheck } from './project-validation.mjs';
import { projectValidationTarget } from './project-validation-targets.mjs';

import { workspaceProjectArguments, workspaceProjectEnvelope } from './project-workspace-tools.mjs';
import {
  workspaceProfile,
  workspaceMutation,
  workspaceObservation,
  verifyWorkspaceEdit
} from './project-workspace-operations.mjs';
import { verifyWorkspaceSequence } from './project-workspace-proof.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const has = (db, name) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
const plain = (s) => (s == null ? null : JSON.parse(s));
const id = (s) => typeof s === 'string' && s.length > 0 && s.length <= 256;

export function verifyProjectSequence(f, facts, base, final, target = projectValidationTarget()) {
  const a = f.authorFinal,
    r = f.reviewerFinal;
  need(
    base.test !== final.test && base.component !== final.component,
    'Project change must retain a new test and implementation.'
  );
  need(
    a?.decision === 'submit' &&
      r?.decision === 'approve' &&
      a.revisionId === f.candidate &&
      r.revisionId === f.candidate,
    'Project candidate lacks a submission and an independent approval.'
  );
  const green = facts.findIndex(
    (o) =>
      o.role === 'author' &&
      o.tool === 'run_check' &&
      o.id === a.checkId &&
      o.revision === f.candidate &&
      o.component === final.component &&
      o.test === final.test &&
      o.outcome === 'passed'
  );
  const red = facts.findIndex(
    (o, i) =>
      i < green &&
      o.role === 'author' &&
      o.tool === 'run_check' &&
      o.outcome === 'failed' &&
      o.assertion &&
      o.component === base.component &&
      o.test === final.test &&
      o.failedTitles.every((title) => facts[green].passedTitles.includes(title))
  );
  need(
    red >= 0 &&
      !facts
        .slice(0, red)
        .some((o) => o.tool === 'replace_text' && o.path === target.componentPath) &&
      !facts
        .slice(red + 1, green)
        .some((o) => o.tool === 'replace_text' && o.path === target.testPath),
    'Project change lacks an unchanged regression from its initial red assertion through its exact green check.'
  );
  const review = facts.filter(
    (o) =>
      o.role === 'reviewer' && o.attemptId === r.evidence.attemptId && o.revision === f.candidate
  );
  need(
    [target.componentPath, target.testPath].every((p) =>
      review.some((o) => o.tool === 'read_file' && o.path === p)
    ) &&
      review.some(
        (o) =>
          o.tool === 'run_check' &&
          o.id === r.checkId &&
          o.outcome === 'passed' &&
          o.component === final.component &&
          o.test === final.test &&
          same([...o.passedTitles].sort(), [...facts[green].passedTitles].sort())
      ),
    'Independent review lacks exact source reads or its own green check.'
  );
}

function admission(db, f, ancestors) {
  const input = normalizeProjectGoal(JSON.parse(f.input), { allowRepair: true }),
    execution = projectExecution(input),
    row = db.prepare('SELECT * FROM command_receipts WHERE operationId=?').get(f.operationId);
  const out = plain(row?.receipt),
    g = out?.goal;
  const initial = {
    goalId: f.goalId,
    operationId: f.operationId,
    input,
    epoch: f.epoch,
    policyDigest: input.policyDigest,
    stage: 'author',
    candidate: projectSeed(input),
    authorTaskId: f.authorTaskId,
    reviewerTaskId: null,
    authorFinal: null,
    reviewerFinal: null,
    detail: null
  };
  need(
    f.policyDigest === input.policyDigest &&
      row?.digest === projectAdmissionDigest(input) &&
      out.operationId === f.operationId &&
      g?.id === f.goalId &&
      g.objective === input.objective &&
      g.workerProvider === execution.provider &&
      (execution.provider === 'claude'
        ? g.claudeModel?.model === execution.model
        : !g.claudeModel) &&
      same(out.projectChange, initial),
    'Project change lacks its exact immutable owner admission.'
  );
  if (input.repair) {
    const parentId = verifyProjectRepairInput(db, input);
    verifyRejectedProject(db, parentId, undefined, ancestors);
  }
  const a = new NativeAuthority({ db }).current(input.policyDigest);
  const seed = db
    .prepare(
      "SELECT * FROM native_ref_events WHERE repository=? AND name='mainline' AND generation=?"
    )
    .get(input.repository, input.expectedGeneration);
  need(
    a?.repository === input.repository &&
      a.epoch === f.epoch &&
      a.policyDigest === input.policyDigest &&
      seed?.revisionId === input.base,
    'Project admission points to a different protected target or policy.'
  );
  const recipe = new ProjectValidation({ store: { db } }).get(input.recipeId);
  const target = input.version === 3 ? null : projectValidationTarget(recipe.profile);
  need(
    (input.version === 3) === (recipe.profile === workspaceProfile) &&
      recipe.epoch === f.epoch &&
      recipe.generation === input.expectedGeneration &&
      same(recipe.input, {
        repository: input.repository,
        base: input.base,
        ...(target ? { componentPath: target.componentPath, testPath: target.testPath } : {}),
        ...(recipe.input.profile === undefined ? {} : { profile: recipe.input.profile })
      }),
    'Project change uses a different enrolled recipe.'
  );
  return input;
}

function roleState(db, f, input, role, final, checkEvidence, target) {
  const execution = projectExecution(input);
  const taskId = role === 'author' ? f.authorTaskId : f.reviewerTaskId;
  if (!taskId) {
    need(!final, 'Missing terminal project task');
    return null;
  }
  const task = db
    .prepare(
      'SELECT t.*,g.goalId,g.goalVersion,g.specVersion,g.provider FROM tasks t JOIN goal_tasks g ON g.taskId=t.id WHERE t.id=?'
    )
    .get(taskId);
  const revisionId = role === 'author' ? projectSeed(input) : f.candidate;
  const subject = {
    goalId: f.goalId,
    operationId: f.operationId,
    role,
    repository: input.repository,
    base: input.base,
    recipeId: input.recipeId,
    revisionId,
    ...(input.repair ? { repair: input.repair } : {}),
    ...(input.version === 3
      ? { workflow: 'workspace', scopeDigest: target.scope.digest }
      : { componentPath: target.componentPath, testPath: target.testPath })
  };
  need(
    task?.goalId === f.goalId &&
      task.provider === execution.provider &&
      task.model === execution.model &&
      task.specVersion === 1 &&
      task.prompt === projectRolePrompt(subject, input.objective),
    'Retained project role prompt differs from the admitted goal.'
  );
  const attempts = db.prepare('SELECT * FROM attempts WHERE taskId=? ORDER BY ordinal').all(taskId);
  for (const a of attempts) {
    const ctx = db
        .prepare('SELECT * FROM task_contexts WHERE taskId=? AND ordinal=?')
        .get(taskId, a.ordinal),
      m = plain(ctx?.manifest);
    need(
      ctx &&
        hash(ctx.manifest) === ctx.digest &&
        m.taskId === taskId &&
        m.ordinal === a.ordinal &&
        m.accountInstance === a.accountInstance &&
        m.goalId === f.goalId &&
        m.version === 1 &&
        m.scopeVersion === 1 &&
        m.specVersion === task.specVersion &&
        m.goalVersion === task.goalVersion &&
        m.provider === execution.provider &&
        m.requestedModel === execution.model &&
        ['handoff', 'rollover', 'research', 'workspace'].every((k) => !Object.hasOwn(m, k)) &&
        m.input === task.prompt &&
        m.promptDigest === hash(task.prompt) &&
        same(m.projectChange, subject) &&
        [m.dependencies, m.mailbox, m.coordinationRoutes].every(
          (x) => Array.isArray(x) && x.length === 0
        ),
      'Project attempt dispatch context differs from its committed role.'
    );
    a.contextDigest = ctx.digest;
    const c = db.prepare('SELECT * FROM attempt_configs WHERE attemptId=?').get(a.id);
    if (c) {
      const b = db
          .prepare('SELECT * FROM provider_config_baselines WHERE driver=? AND scope=?')
          .get(execution.provider, c.scope),
        manifest = plain(c.manifest);
      need(
        c.driver === execution.provider &&
          c.scope ===
            (execution.provider === 'claude'
              ? claudeProfileScope(execution.model, role, manifest.nativeVersion)
              : codexProjectProfileScope(
                  execution.model,
                  role,
                  manifest.nativeVersion,
                  manifest.projectDynamic?.version
                )) &&
          manifest.model === execution.model &&
          (execution.provider === 'claude' ||
            (manifest.reasoningEffort === execution.reasoning &&
              (input.version === 3) === (manifest.projectDynamic?.version === 5))) &&
          hash(c.manifest) === c.digest &&
          b?.digest === c.digest &&
          b.manifest === c.manifest &&
          c.contextDigest === ctx.digest &&
          matchProjectProfile(c.driver, c.scope, manifest) === role,
        'Project attempt lacks its verified tool and model configuration.'
      );
      a.configDigest = c.digest;
    }
  }
  if (final) {
    const a = attempts.at(-1),
      e = final.evidence,
      result = a && db.prepare('SELECT * FROM claude_results WHERE attemptId=?').get(a.id);
    if (execution.provider === 'claude') {
      need(
        task.status === 'completed' &&
          a?.status === 'completed' &&
          a.driver === 'claude' &&
          a.accountRoute === 'installed-claude' &&
          a.observedModel === input.claudeModel &&
          !a.modelRerouted &&
          a.requestedModel === input.claudeModel &&
          [
            a.accountInstance,
            a.executionId,
            a.nativeSessionId,
            a.nativeMessageId,
            a.nativeResultId,
            a.configDigest
          ].every(id) &&
          result?.accountInstance === a.accountInstance &&
          hash(result.text) === result.digest,
        'Missing terminal installed-account project attempt.'
      );
      const expected = {
        taskId,
        specVersion: task.specVersion,
        goalVersion: task.goalVersion,
        attemptId: a.id,
        driver: 'claude',
        accountInstance: a.accountInstance,
        sessionId: a.nativeSessionId,
        messageId: a.nativeMessageId,
        resultId: a.nativeResultId,
        itemId: a.nativeResultId,
        digest: result.digest,
        runId: a.executionId,
        contextDigest: a.contextDigest,
        configDigest: a.configDigest
      };
      const { evidence, ...body } = final;
      need(
        same(e, expected) &&
          same(
            parseFlatVerdict(result.text, ['decision', 'revisionId', 'checkId', 'note']),
            body
          ) &&
          same(Object.keys(body).sort(), ['checkId', 'decision', 'note', 'revisionId']) &&
          ['submit', ...(role === 'reviewer' ? ['approve', 'reject'] : [])].includes(
            body.decision
          ) &&
          (role === 'author' ? body.decision === 'submit' : body.decision !== 'submit') &&
          body.revisionId === f.candidate &&
          /^[a-f0-9]{64}$/.test(body.checkId) &&
          typeof body.note === 'string' &&
          body.note.trim() &&
          body.note.length <= 2048,
        'Project verdict or native result binding differs from the actual terminal evidence.'
      );
    } else {
      need(
        a?.configDigest &&
          a.contextDigest &&
          (!a.requestedModel || a.requestedModel === execution.model) &&
          (!a.observedModel || a.observedModel === execution.model),
        'Project Codex attempt lacks its admitted model or configuration.'
      );
      const text = verifyCodexProjectFinal(db, task, a, e);
      const { evidence, ...body } = final;
      need(
        same(parseFlatVerdict(text, ['decision', 'revisionId', 'checkId', 'note']), body) &&
          same(Object.keys(body).sort(), ['checkId', 'decision', 'note', 'revisionId']) &&
          (role === 'author'
            ? body.decision === 'submit'
            : ['approve', 'reject'].includes(body.decision)) &&
          body.revisionId === f.candidate &&
          /^[a-f0-9]{64}$/.test(body.checkId) &&
          typeof body.note === 'string' &&
          body.note.trim() &&
          body.note.length <= 2048,
        'Project verdict or native result binding differs from the actual terminal evidence.'
      );
    }
    if (checkEvidence) checkEvidence(db, e);
  }
  return { task, attempts };
}

function toolJournal(db, f, input, roles, checkRun, target) {
  const source = new NativeStore({ db }),
    rows = db
      .prepare('SELECT * FROM project_tool_operations WHERE goalId=? ORDER BY rowid')
      .all(f.goalId);
  const used = new Set(),
    facts = [];
  let current = projectSeed(input);
  for (const o of rows) {
    const r = roles[o.role],
      a = r?.attempts.find((x) => x.id === o.attemptId);
    need(
      a &&
        a.taskId === o.taskId &&
        a.configDigest &&
        a.contextDigest &&
        a.driver === projectExecution(input).provider &&
        o.revisionBefore === current &&
        [0, 1].includes(o.denied) &&
        id(o.operationId) &&
        id(o.observationId) &&
        hash(o.text) === o.digest,
      'Project tool operation differs from the reserved role, candidate or digest.'
    );
    const args = plain(o.args),
      reply = plain(o.text),
      native = plain(o.native),
      subject = {
        repository: input.repository,
        revisionId: current,
        componentPath: target.componentPath,
        testPath: target.testPath
      };
    if (input.version === 3 && o.denied && native) workspaceProjectEnvelope(o.role, o.tool, args);
    else if (!o.denied || native)
      (input.version === 3 ? workspaceProjectArguments : projectMcpArguments)(o.role, o.tool, args);
    if (native) {
      const identity = projectNativeIdentity(a);
      need(
        native.runId === identity.runId &&
          native.sessionId === identity.sessionId &&
          [native.runId, native.sessionId, native.toolUseId].every(id) &&
          !used.has(native.toolUseId) &&
          same(native.response, {
            operationId: o.operationId,
            observationId: o.observationId,
            digest: o.digest
          }) &&
          native.argumentsDigest === hash(o.args) &&
          same(Object.keys(native).sort(), [
            'argumentsDigest',
            'response',
            'runId',
            'sessionId',
            'toolUseId'
          ]),
        'Project tool observation lacks a unique matching native invocation.'
      );
      used.add(native.toolUseId);
    }
    const fact = {
      role: o.role,
      tool: o.tool,
      revision: current,
      path: args.path,
      ...(input.version === 3 && o.tool === 'read_file' ? { at: args.at ?? 'candidate' } : {})
    };
    if (o.denied) {
      need(
        o.revisionAfter === current &&
          same(Object.keys(reply), ['error']) &&
          typeof reply.error === 'string' &&
          reply.error.length <= 400,
        'A denied project operation changed source or has a success payload.'
      );
    } else if (input.version === 3 && workspaceMutation(o.tool)) {
      need(
        o.taskId === f.authorTaskId && same(reply, verifyWorkspaceEdit(source, target, o)),
        'Workspace mutation differs from its retained source and receipt.'
      );
      current = o.revisionAfter;
    } else if (o.tool === 'replace_text') {
      const before = readProjectFile(source, subject, args.path),
        rev = source.revision({ repository: input.repository, revisionId: o.revisionAfter });
      const fileId = nativeFileId(Buffer.from(args.text)),
        actor = {
          name: 'Project author',
          email: 'project@localhost.invalid',
          seconds: rev.author.seconds,
          offset: '+0000'
        };
      need(
        before.fileId === args.expectedFileId &&
          before.fileId !== fileId &&
          same(rev.parents, [current]) &&
          same(rev.edits, [{ path: args.path, mode: '100644', fileId }]) &&
          same(rev.author, actor) &&
          same(rev.committer, actor) &&
          rev.message === 'Update ' + args.path &&
          same(rev.provenance, { principal: 'project-author', taskId: o.taskId }) &&
          same(reply, { path: args.path, fileId, revisionId: o.revisionAfter }),
        'Project change bytes, path or native revision lineage differ from the authorized edit.'
      );
      current = o.revisionAfter;
    } else {
      need(o.revisionAfter === current, 'Read-only project observation changed its candidate.');
      if (input.version === 3 && o.tool !== 'run_check')
        need(
          same(
            reply,
            workspaceObservation(source, target, { ...subject, role: o.role }, o.tool, args)
          ),
          'Workspace observation differs from the retained revision.'
        );
      if (input.version !== 3 && o.tool === 'list_files')
        need(
          same(reply, { revisionId: current, paths: [target.componentPath, target.testPath] }),
          'Project path inventory exceeds the enrolled scope.'
        );
      if (input.version !== 3 && o.tool === 'read_file') {
        need(
          same(reply, readProjectFile(source, subject, args.path)),
          'Project tool read differs from the exact retained source.'
        );
        fact.path = args.path;
      }
      if (o.tool === 'run_check') {
        const { checkId, ...check } = reply;
        need(
          checkId === hash(JSON.stringify([o.taskId, a.id, o.operationId, check])) &&
            check.role === o.role &&
            check.repository === input.repository &&
            checkRun(db, input.recipeId, current, check),
          'Project check differs from its role or exact validation subject.'
        );
        Object.assign(fact, {
          id: checkId,
          outcome: check.outcome,
          component: check.componentFileId,
          test: check.testFileId,
          assertion: check.checks.some((c) => c.status === 'failed' && c.assertionFailure === true),
          failedTitles: check.checks.filter((c) => c.assertionFailure).map((c) => c.title),
          passedTitles: check.checks.filter((c) => c.status === 'passed').map((c) => c.title)
        });
      }
    }
    if (native && !o.denied) facts.push({ ...fact, attemptId: a.id });
  }
  need(current === f.candidate, 'Project journal does not reconstruct its candidate.');
  return { facts, rows, source };
}
export function verifyProjectAttempts(f, roles, rows, recovery) {
  const authors = roles.author?.attempts ?? [],
    reviewers = roles.reviewer?.attempts ?? [];
  need(
    authors.length <= 1 && (!authors.length || authors[0].ordinal === 1),
    'Project author has an additional or noninitial attempt.'
  );
  if (!recovery) {
    need(
      reviewers.length <= 1 && (!reviewers.length || reviewers[0].ordinal === 1),
      'Additional project review lacks a verified owner recovery.'
    );
    return;
  }
  const [prior, next] = reviewers;
  need(
    reviewers.length >= 1 &&
      reviewers.length <= 2 &&
      recovery.goalId === f.goalId &&
      recovery.candidate === f.candidate &&
      recovery.taskId === f.reviewerTaskId &&
      prior.taskId === recovery.taskId &&
      prior.status === 'recovery_needed' &&
      prior.id === recovery.attemptId &&
      prior.ordinal === 1 &&
      recovery.ordinal === prior.ordinal &&
      prior.accountInstance === recovery.accountInstance &&
      prior.contextDigest === recovery.contextDigest &&
      prior.configDigest === recovery.configDigest &&
      prior.executionId === recovery.executionId &&
      prior.nativeSessionId === recovery.sessionId,
    'Prior project review differs from its sealed recovery.'
  );
  if (next)
    need(
      next.taskId === prior.taskId &&
        next.ordinal === prior.ordinal + 1 &&
        next.id !== prior.id &&
        next.accountInstance === prior.accountInstance,
      'Replacement project reviewer differs from its authorized task, account or ordinal.'
    );
  for (const field of ['executionId', 'nativeSessionId']) {
    const observed = [...authors, ...reviewers].map((a) => a[field]).filter((v) => v != null);
    need(
      observed.every(id) && new Set(observed).size === observed.length,
      'Project recovery reused an earlier native execution or session.'
    );
  }
  let replacementStarted = false;
  for (const row of rows) {
    if (next && row.attemptId === next.id) replacementStarted = true;
    if (row.attemptId !== prior.id) continue;
    need(
      !replacementStarted &&
        row.role === 'reviewer' &&
        row.taskId === prior.taskId &&
        ['read_file', 'list_files', 'run_check'].includes(row.tool) &&
        row.revisionBefore === f.candidate &&
        row.revisionAfter === f.candidate,
      'Retired project reviewer exceeded its original read-only candidate or acted after its replacement.'
    );
  }
}

function boundFlow(db, row, checkEvidence, checkRun, terminal, ancestors = new Set()) {
  need(
    !ancestors.has(row.goalId) && ancestors.size < 16,
    'Project repair ancestry is cyclic or exceeds its bound.'
  );
  ancestors = new Set([...ancestors, row.goalId]);
  const f = {
      ...row,
      authorFinal: plain(row.authorFinal),
      reviewerFinal: plain(row.reviewerFinal)
    },
    input = admission(db, f, ancestors),
    recipe = new ProjectValidation({ store: { db } }).get(input.recipeId),
    target = input.version === 3 ? recipe : projectValidationTarget(recipe.profile);
  need(
    ['author', 'reviewer', 'completed', 'blocked', 'superseded'].includes(f.stage) &&
      Boolean(f.reviewerTaskId) === Boolean(f.authorFinal) &&
      (!f.reviewerFinal || f.reviewerTaskId) &&
      !(f.stage === 'author' && f.reviewerTaskId) &&
      !(f.stage === 'reviewer' && !f.reviewerTaskId),
    'Project workflow stage and recorded role admissions disagree.'
  );
  const roles = Object.fromEntries(
    ['author', 'reviewer'].map((role) => [
      role,
      roleState(db, f, input, role, f[role + 'Final'], checkEvidence, target)
    ])
  );
  const { facts, rows, source } = toolJournal(db, f, input, roles, checkRun, target);
  const recovery = verifyProjectReviewRecovery(db, f.goalId);
  verifyProjectAttempts(f, roles, rows, recovery);
  for (const role of ['author', 'reviewer']) {
    const verdict = f[role + 'Final'];
    if (!verdict) continue;
    need(
      facts.some(
        (o) =>
          o.role === role &&
          o.tool === 'run_check' &&
          o.attemptId === verdict.evidence.attemptId &&
          o.revision === verdict.revisionId &&
          o.id === verdict.checkId &&
          (verdict.decision === 'reject' || o.outcome === 'passed')
      ),
      'Retained project verdict lacks its own confirmed check on the selected candidate.'
    );
  }
  if (!terminal) return;
  const a = f.authorFinal?.evidence,
    r = f.reviewerFinal?.evidence;
  const reviewerStart = rows.findIndex((o) => o.role === 'reviewer');
  need(
    reviewerStart >= 0 && rows.slice(reviewerStart).every((o) => o.role === 'reviewer'),
    'Author operations continued after the independent review began.'
  );
  need(
    a &&
      r &&
      (projectExecution(input).provider === 'codex'
        ? ['taskId', 'attemptId', 'threadId', 'turnId', 'runId'].every(
            (k) => a[k] && r[k] && a[k] !== r[k]
          )
        : ['taskId', 'attemptId', 'sessionId', 'runId', 'messageId', 'resultId'].every(
            (k) => a[k] !== r[k]
          )) &&
      a.accountInstance === r.accountInstance &&
      rows.every(
        (o) =>
          (recovery && o.attemptId === recovery.attemptId) ||
          (o.native && o.attemptId === (o.role === 'author' ? a.attemptId : r.attemptId))
      ),
    'Project landing lacks independent, confirmed role executions.'
  );
  const state = (revisionId) => {
    const s = source.select({ repository: input.repository, revisionId });
    return {
      component: s.read(target.componentPath).fileId,
      test: s.read(target.testPath).fileId
    };
  };
  if (input.version === 3) {
    const changeSet = workspaceObservation(
      source,
      recipe,
      { role: 'reviewer', revisionId: f.candidate },
      'changed_files',
      {}
    );
    verifyWorkspaceSequence(f, facts, changeSet.files);
  } else verifyProjectSequence(f, facts, state(input.base), state(f.candidate), target);
  return {
    version: 1,
    goalId: f.goalId,
    operationId: 'project-land-' + f.goalId,
    repository: input.repository,
    epoch: f.epoch,
    policyDigest: f.policyDigest,
    recipeId: input.recipeId,
    expectedTarget: input.base,
    expectedGeneration: input.expectedGeneration,
    candidate: f.candidate,
    generation: input.expectedGeneration + 1,
    authorAttemptId: a.attemptId,
    reviewerAttemptId: r.attemptId
  };
}

export function projectLandingProof(db, goalId, checkRetainedEvidence) {
  const row = db.prepare('SELECT * FROM project_changes WHERE goalId=?').get(goalId);
  need(row, 'No retained project change owns this landing.');
  return boundFlow(db, row, checkRetainedEvidence, verifyProjectCheck, true);
}

export function verifiedProjectLanding(db, event) {
  if (!has(db, 'project_landings')) return null;
  const row = db
    .prepare('SELECT * FROM project_landings WHERE operationId=?')
    .get(event.operationId);
  if (!row) return null;
  const expected = projectLandingProof(db, row.goalId),
    record = plain(row.record);
  need(
    same(record, expected) &&
      row.operationId === expected.operationId &&
      event.name === 'mainline' &&
      event.repository === expected.repository &&
      event.expectedRevision === expected.expectedTarget &&
      event.expectedGeneration === expected.expectedGeneration &&
      event.revisionId === expected.candidate &&
      event.generation === expected.generation,
    'Project landing differs from its authenticated role evidence and protected event.'
  );
  const flow = db.prepare('SELECT * FROM project_changes WHERE goalId=?').get(row.goalId);
  need(flow.stage === 'completed', 'Published project workflow lacks its completion state.');
  completedGoal(db, flow, record);
  return record;
}

function completedGoal(db, f, landing) {
  const row = db.prepare('SELECT * FROM goals WHERE id=?').get(f.goalId);
  const saved = db.prepare('SELECT snapshot FROM goal_completions WHERE goalId=?').get(f.goalId);
  const c = plain(saved?.snapshot),
    history = db
      .prepare("SELECT * FROM goal_revisions WHERE id=? AND changeKind='goal.completed'")
      .all(f.goalId);
  const created = db.prepare('SELECT * FROM goal_revisions WHERE id=? AND version=1').get(f.goalId);
  const criterion = plain(created?.criteria)?.[0],
    objective = plain(f.input).objective;
  const criteria = [{ ...criterion, evidence: [landing.candidate] }];
  need(
    criterion?.verifier === 'reviewed-project-change' &&
      row?.state === 'completed' &&
      row.objective === objective &&
      c?.policy === 'reviewed-project-v1' &&
      c.goalId === f.goalId &&
      c.scopeVersion === 1 &&
      c.version === row.version &&
      c.version === c.verifiedGoalVersion + 1 &&
      c.objective === objective &&
      same(c.criteria, criteria) &&
      same(plain(row.criteria), criteria) &&
      same(c.evidence, [{ criterionId: criterion.id, landing }]) &&
      history.length === 1 &&
      history[0].version === c.version &&
      history[0].createdAt === c.completedAt &&
      history[0].objective === objective &&
      history[0].state === 'completed' &&
      same(plain(history[0].criteria), criteria),
    'Project completion differs from its criterion, historical version or protected landing.'
  );
}

export function verifyProjectWorkflows(db, checkRetainedEvidence) {
  if (!has(db, 'project_changes')) return { changes: 0, landings: 0 };
  need(
    !db
      .prepare(
        `SELECT 1 FROM command_receipts r LEFT JOIN project_changes f ON f.operationId=r.operationId
    WHERE json_type(r.receipt,'$.projectChange.goalId')='text' AND f.goalId IS NOT json_extract(r.receipt,'$.projectChange.goalId') LIMIT 1`
      )
      .get(),
    'Acknowledged project admission lacks its historical goal.'
  );
  need(
    !db
      .prepare(
        'SELECT 1 FROM project_tool_operations p LEFT JOIN project_changes f ON f.goalId=p.goalId WHERE f.goalId IS NULL LIMIT 1'
      )
      .get() &&
      !db
        .prepare(
          'SELECT 1 FROM project_landings p LEFT JOIN project_changes f ON f.goalId=p.goalId WHERE f.goalId IS NULL LIMIT 1'
        )
        .get(),
    'Project role history is detached from its owner admission.'
  );
  let changes = 0,
    landings = 0;
  for (const f of db.prepare('SELECT * FROM project_changes').iterate()) {
    changes++;
    const landing = db.prepare('SELECT * FROM project_landings WHERE goalId=?').get(f.goalId);
    if (!landing) {
      need(
        f.stage !== 'completed' &&
          !db.prepare('SELECT 1 FROM goal_completions WHERE goalId=?').get(f.goalId),
        'Completed project change lacks its landing.'
      );
      boundFlow(db, f, checkRetainedEvidence, verifyProjectCheck, false);
    } else {
      const event = db
        .prepare('SELECT * FROM native_ref_events WHERE operationId=?')
        .get(landing.operationId);
      need(
        f.stage === 'completed' && event && verifiedProjectLanding(db, event),
        'Historical project landing lacks its protected event.'
      );
      for (const name of ['authorFinal', 'reviewerFinal'])
        if (checkRetainedEvidence) checkRetainedEvidence(db, plain(f[name]).evidence);
      landings++;
    }
  }
  return { changes, landings };
}

export function verifyRejectedProject(db, goalId, checkEvidence, ancestors = new Set()) {
  const row = db.prepare('SELECT * FROM project_changes WHERE goalId=?').get(goalId);
  const final = row?.reviewerFinal && JSON.parse(row.reviewerFinal);
  need(row && final, 'Missing rejected project evidence.');
  rejectedProject(db, {
    rejectedGoalId: goalId,
    expectedCandidate: row.candidate,
    expectedReviewDigest: hash(JSON.stringify(final))
  });
  boundFlow(db, row, checkEvidence, verifyProjectCheck, false, ancestors);
  const author = JSON.parse(row.authorFinal).evidence,
    reviewer = final.evidence;
  const operations = db
    .prepare(
      'SELECT role,attemptId,native FROM project_tool_operations WHERE goalId=? ORDER BY rowid'
    )
    .all(goalId);
  const firstReview = operations.findIndex((operation) => operation.role === 'reviewer');
  need(
    ['taskId', 'attemptId', 'threadId', 'turnId', 'runId'].every(
      (key) => author[key] && reviewer[key] && author[key] !== reviewer[key]
    ) &&
      author.accountInstance === reviewer.accountInstance &&
      firstReview >= 0 &&
      operations.slice(firstReview).every((operation) => operation.role === 'reviewer') &&
      operations.every(
        (operation) =>
          operation.native &&
          operation.attemptId ===
            (operation.role === 'author' ? author.attemptId : reviewer.attemptId)
      ),
    'Rejected project seed lacks independent confirmed role history.'
  );
  return true;
}
