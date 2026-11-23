import { isDeepStrictEqual as same } from 'node:util';
import { hashRecord } from './native-policy.mjs';
import { normalizeProjectGoal, requireProject as need } from './project-source.mjs';
import { projectValidationTarget } from './project-validation-targets.mjs';
import { workspaceProfile } from './project-workspace-operations.mjs';
import { prepareTools, sum } from './project-validation-tools.mjs';

const selection = { provider: 'codex', model: 'gpt-6.2-astra', reasoning: 'high' };
export function normalizeProjectStart(input) {
  const keys = ['repository', 'profile', 'objective', 'maxAttempts', 'maxActiveSeconds'];
  need(
    input &&
      Object.keys(input).length === keys.length &&
      keys.every((k) => Object.hasOwn(input, k)),
    'Supply a repository, supported profile, objective and limits.',
    400
  );
  need(typeof input.profile === 'string', 'Select a supported project profile.', 400);
  need(
    input.profile !== 'darwin-league-sample-profile-vitest-v1',
    'Start requires a current profile. Use validation-enroll for the legacy profile.',
    400
  );
  if (input.profile !== workspaceProfile) projectValidationTarget(input.profile);
  normalizeProjectGoal({
    version: input.profile === workspaceProfile ? 3 : 2,
    repository: input.repository,
    base: '0'.repeat(64),
    expectedGeneration: 1,
    policyDigest: '0'.repeat(64),
    recipeId: '0'.repeat(64),
    objective: input.objective,
    executionSelection: selection,
    maxAttempts: input.maxAttempts,
    maxActiveSeconds: input.maxActiveSeconds
  });
  return Object.fromEntries(keys.map((k) => [k, input[k]]));
}

async function receipt(rpc, id) {
  try {
    const result = await rpc('operation', { id });
    need(result.receipt, 'The previous operation is still pending. Retry the same command.');
    return result.receipt;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

// Read the retained lock, rather than a potentially changed owner working file. Cache archives
// are revalidated even when an enrollment receipt survived an installation upgrade.
export async function prepareStartCache(recipe, dataDir, rpc, prepare = prepareTools) {
  const path = 'frontend/package-lock.json';
  const pin = recipe.pins.find((p) => p.path === path);
  need(pin, 'The recipe lacks its pinned package lock.');
  let total = null,
    offset = 0;
  const chunks = [];
  do {
    const file = await rpc('native.file', {
      repository: recipe.input.repository,
      name: 'mainline',
      revisionId: recipe.input.base,
      path,
      offset,
      limit: 65536
    });
    need(
      file.repository === recipe.input.repository &&
        file.revisionId === recipe.input.base &&
        file.name === 'mainline' &&
        file.path === path &&
        file.fileId === pin.fileId &&
        file.mode === '100644' &&
        file.offset === offset &&
        Number.isSafeInteger(file.total) &&
        file.total > 0 &&
        file.total <= 2 * 1024 * 1024 &&
        (total === null || total === file.total) &&
        typeof file.base64 === 'string',
      'The retained package lock differs from its pinned source.'
    );
    const bytes = Buffer.from(file.base64, 'base64');
    need(
      bytes.toString('base64') === file.base64 &&
        bytes.length > 0 &&
        bytes.length <= 65536 &&
        offset + bytes.length <= file.total,
      'The retained package lock is incomplete.'
    );
    chunks.push(bytes);
    offset += bytes.length;
    total = file.total;
  } while (offset < total);
  const lock = Buffer.concat(chunks);
  need(sum(lock) === pin.digest, 'The retained package lock digest differs.');
  await prepare(dataDir, lock);
}

export async function startProject(raw, operationId, { rpc, prepareCache }) {
  const input = normalizeProjectStart(raw);
  need(
    typeof operationId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(operationId),
    'Supply a valid operation ID.',
    400
  );
  const target = input.profile === workspaceProfile ? null : projectValidationTarget(input.profile);
  // The auxiliary receipt is bound to the full intent. The public operation ID remains the
  // daemon's single idempotent model admission, including concurrent or uncertain retries.
  const enrollmentId = 'project-start-' + hashRecord([operationId, input]);
  const prior = await receipt(rpc, operationId);
  let enrollment = await receipt(rpc, enrollmentId);
  if (prior) {
    const saved = prior.projectChange?.input;
    need(enrollment?.recipe && saved, 'This operation ID belongs to different inputs.');
    const expected = normalizeProjectGoal({
      ...saved,
      repository: input.repository,
      recipeId: enrollment.recipe.id,
      objective: input.objective,
      executionSelection: selection,
      maxAttempts: input.maxAttempts,
      maxActiveSeconds: input.maxActiveSeconds
    });
    need(
      same(saved, expected) &&
        prior.operationId === operationId &&
        prior.projectChange.goalId === prior.goal?.id,
      'This operation ID belongs to different inputs.'
    );
    return prior;
  }
  const { authority, mainline } = await rpc('authority.status', {});
  need(
    authority?.repository === input.repository &&
      mainline?.repository === input.repository &&
      mainline.name === 'mainline',
    'Select the active registered repository.'
  );
  const enrollmentInput = {
    repository: input.repository,
    base: mainline.revisionId,
    ...(target ? { componentPath: target.componentPath, testPath: target.testPath } : {}),
    profile: input.profile
  };
  if (!enrollment)
    enrollment = await rpc('project.validation.enroll', enrollmentInput, enrollmentId);
  const recipe = enrollment.recipe;
  need(
    enrollment.operationId === enrollmentId &&
      recipe &&
      same(recipe.input, enrollmentInput) &&
      recipe.generation === mainline.generation &&
      recipe.epoch === authority.epoch,
    'The current source changed after preparation. Inspect it and use a new operation ID.'
  );
  const goal = normalizeProjectGoal({
    version: input.profile === workspaceProfile ? 3 : 2,
    repository: input.repository,
    base: mainline.revisionId,
    expectedGeneration: mainline.generation,
    policyDigest: authority.policyDigest,
    recipeId: recipe.id,
    objective: input.objective,
    executionSelection: selection,
    maxAttempts: input.maxAttempts,
    maxActiveSeconds: input.maxActiveSeconds
  });
  await prepareCache(recipe);
  return rpc('project.develop', goal, operationId);
}
