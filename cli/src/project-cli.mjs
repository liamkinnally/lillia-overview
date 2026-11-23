import { parseArgs, inspect } from 'node:util';
import { randomUUID } from 'node:crypto';
import { superviseProjectReview } from './project-review-fence.mjs';
import { normalizeProjectReviewRetry } from './project-review-recovery.mjs';
import { daemonStatus, ensureDaemon, callService } from './local-service.mjs';
import { normalizeProjectGoal } from './project-source.mjs';
import { normalizeProjectValidation } from './project-validation.mjs';
import { workspaceProfile } from './project-workspace-operations.mjs';
import { normalizeProjectStart } from './project-start.mjs';
import { normalizeProjectRepair } from './project-repair.mjs';

export const projectHelp = `lillia project start REPO [--profile PROFILE] --operation-id ID [--max-attempts N --max-active-seconds N] OBJECTIVE
Start enrolls the current native source and prepares its test cache. Uses Astra 6.2/High, default 2 attempts and 1500 active seconds.
lillia project validation-enroll REPO BASE COMPONENT TEST [--profile darwin-league-sample-profile-vitest-v2] --operation-id ID
lillia project develop REPO BASE --generation N --policy DIGEST --recipe ID --claude-model MODEL --max-attempts N --max-active-seconds N --operation-id ID OBJECTIVE
lillia project develop REPO BASE --generation N --policy DIGEST --recipe ID --provider codex --model gpt-6.2-astra --reasoning ultra --max-attempts N --max-active-seconds N --operation-id ID OBJECTIVE
lillia project retry-review GOAL TASK ATTEMPT CANDIDATE --extra-active-seconds 300 --operation-id ID REASON
lillia project repair GOAL CANDIDATE REVIEW_DIGEST --max-attempts N --max-active-seconds N --operation-id ID INSTRUCTIONS
All commands accept --json.`;
const usage = (message) => Object.assign(Error(message + '\n' + projectHelp), { exitCode: 2 });
const developFlags = [
  'generation',
  'policy',
  'recipe',
  'claude-model',
  'provider',
  'model',
  'reasoning',
  'max-attempts',
  'max-active-seconds'
];
function positive(value) {
  if (
    typeof value !== 'string' ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1
  )
    throw usage('Use positive integer limits and generation.');
  return Number(value);
}
export function parseProjectCli(raw) {
  const flags = {
    'operation-id': { type: 'string' },
    'extra-active-seconds': { type: 'string' },
    profile: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }
  };
  for (const key of developFlags) flags[key] = { type: 'string' };
  let parsed;
  try {
    parsed = parseArgs({ args: raw, allowPositionals: true, options: flags, tokens: true });
  } catch (e) {
    throw usage(e.message);
  }
  const {
    positionals: [verb, ...p],
    values: v,
    tokens
  } = parsed;
  if (v.help) return { help: true };
  const options = tokens.filter((x) => x.kind === 'option').map((x) => x.name);
  if (options.length !== new Set(options).size) throw usage('Supply each option once.');
  if (
    v['operation-id'] !== undefined &&
    !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v['operation-id'])
  )
    throw usage('Supply a valid operation ID.');
  let name, input;
  if (!['validation-enroll', 'start'].includes(verb) && v.profile !== undefined)
    throw usage('Profile requires validation enrollment.');
  if (verb !== 'retry-review' && v['extra-active-seconds'] !== undefined)
    throw usage('Extra active seconds require a reviewer retry.');
  if (verb === 'repair') {
    if (
      p.length !== 4 ||
      !v['operation-id'] ||
      developFlags
        .filter((k) => !['max-attempts', 'max-active-seconds'].includes(k))
        .some((k) => v[k] !== undefined)
    )
      throw usage(
        'Supply the rejected goal, exact candidate and review, new limits and instructions.'
      );
    name = 'project.repair';
    try {
      input = normalizeProjectRepair({
        rejectedGoalId: p[0],
        expectedCandidate: p[1],
        expectedReviewDigest: p[2],
        repairInstructions: p[3],
        maxAttempts: positive(v['max-attempts']),
        maxActiveSeconds: positive(v['max-active-seconds'])
      });
    } catch (e) {
      throw usage(e.message);
    }
  } else if (verb === 'start') {
    if (
      p.length !== 2 ||
      !v['operation-id'] ||
      developFlags
        .filter((k) => !['max-attempts', 'max-active-seconds'].includes(k))
        .some((k) => v[k] !== undefined)
    )
      throw usage('Supply repository, stable operation ID and quoted objective.');
    name = 'project.start';
    try {
      input = normalizeProjectStart({
        repository: p[0],
        profile: v.profile ?? workspaceProfile,
        objective: p[1],
        maxAttempts: positive(v['max-attempts'] ?? '2'),
        maxActiveSeconds: positive(v['max-active-seconds'] ?? '1500')
      });
    } catch (e) {
      throw usage(e.message);
    }
  } else if (verb === 'validation-enroll') {
    if (p.length !== 4 || developFlags.some((k) => v[k] !== undefined))
      throw usage('Supply exactly repository, base, component and test.');
    const [repository, base, componentPath, testPath] = p;
    name = 'project.validation.enroll';
    try {
      input = normalizeProjectValidation({
        repository,
        base,
        componentPath,
        testPath,
        ...(v.profile === undefined ? {} : { profile: v.profile })
      });
    } catch (e) {
      throw usage(e.message);
    }
  } else if (verb === 'develop') {
    const codex = v.provider !== undefined || v.model !== undefined || v.reasoning !== undefined;
    const required = [
      'generation',
      'policy',
      'recipe',
      'max-attempts',
      'max-active-seconds',
      ...(codex ? ['provider', 'model', 'reasoning'] : ['claude-model'])
    ];
    if (
      p.length !== 3 ||
      v.profile !== undefined ||
      required.some((k) => v[k] === undefined) ||
      (codex && v['claude-model'] !== undefined)
    )
      throw usage('Supply the exact project scope, model, allowance and quoted objective.');
    const [repository, base, objective] = p;
    name = 'project.develop';
    try {
      input = normalizeProjectGoal({
        ...(codex ? { version: 2 } : {}),
        repository,
        base,
        objective,
        expectedGeneration: positive(v.generation),
        policyDigest: v.policy,
        recipeId: v.recipe,
        ...(codex
          ? { executionSelection: { provider: v.provider, model: v.model, reasoning: v.reasoning } }
          : { claudeModel: v['claude-model'] }),
        maxAttempts: positive(v['max-attempts']),
        maxActiveSeconds: positive(v['max-active-seconds'])
      });
    } catch (e) {
      throw usage(e.message);
    }
  } else if (verb === 'retry-review') {
    if (p.length !== 5 || !v['operation-id'] || developFlags.some((k) => v[k] !== undefined))
      throw usage('Supply the original reviewer, exact candidate, time and stable operation ID.');
    const [goalId, taskId, attemptId, candidate, reason] = p;
    try {
      input = normalizeProjectReviewRetry({
        goalId,
        taskId,
        attemptId,
        candidate,
        reason,
        expectedLimit: 2,
        additionalAttempts: 1,
        additionalActiveSeconds: positive(v['extra-active-seconds'])
      });
    } catch (e) {
      throw usage(e.message);
    }
    name = 'project.review.retry';
  } else throw usage('Unknown project action.');
  return { name, input, operationId: v['operation-id'] ?? randomUUID(), json: Boolean(v.json) };
}
export async function runProjectCli(args, context) {
  const req = parseProjectCli(args);
  if (req.help) {
    console.log(projectHelp);
    return;
  }

  const retry = req.name === 'project.review.retry';
  const daemon = retry ? null : await ensureDaemon(context.dataDir, context.workspaceRoot);
  let result;
  try {
    if (retry) result = await superviseProjectReview(context, req, { daemonStatus, ensureDaemon });
    else {
      ({ result } = await callService(context.dataDir, {
        name: req.name,
        input: req.input,
        operationId: req.operationId,
        workspaceRoot: daemon.workspaceRoot
      }));
    }
  } catch (e) {
    if (!e.status || e.status >= 500) {
      e.exitCode = 4;
      e.message += '\nCommand outcome unknown. Retry with --operation-id ' + req.operationId;
    }
    throw e;
  }
  console.log(
    req.json
      ? JSON.stringify({ version: 1, result })
      : inspect(result, { depth: null, colors: process.stdout.isTTY, compact: false })
  );
}
