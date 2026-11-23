import { isDeepStrictEqual as same } from 'node:util';
import { NativeStore, validateNativeId, validateNativeLabel } from './native-store.mjs';
import { hashRecord } from './native-policy.mjs';
import { requireCheck as need } from './project-validation-tools.mjs';
import {
  createProjectSourceScope,
  projectSourceChangedPaths
} from './project-workspace-source.mjs';
import {
  discoverProjectChecks,
  validateProjectCheck,
  projectCheckDependencies,
  prepareProjectCheck,
  runProjectWorkspaceCheck,
  verifyWorkspaceCheckResult
} from './project-workspace-checks.mjs';

export const workspaceValidationProfile = 'darwin-npm-workspace-v1';
export function normalizeWorkspaceValidation(input) {
  need(
    input &&
      !Array.isArray(input) &&
      Object.keys(input).length === 3 &&
      ['repository', 'base', 'profile'].every((key) => Object.hasOwn(input, key)) &&
      input.profile === workspaceValidationProfile,
    'Select the repository, immutable base and workspace profile.',
    400
  );
  validateNativeLabel(input.repository);
  validateNativeId(input.base);
  return { repository: input.repository, base: input.base, profile: input.profile };
}
function selection(db, input) {
  const native = new NativeStore({ db });
  const scope = createProjectSourceScope(native, {
    repository: input.repository,
    baseRevision: input.base,
    allowedRoots: ['']
  });
  const checks = discoverProjectChecks(native, scope);
  need(
    checks.length <= 8,
    'Workspace validation supports at most eight discovered repository checks.'
  );
  return { native, scope, checks };
}
export async function prepareWorkspaceValidation(db, dataDir, input) {
  const { native, scope, checks } = selection(db, input),
    prepared = [];
  for (const check of checks)
    prepared.push(await prepareProjectCheck({ native, scope, check, dataDir }));
  return { scope, checks, prepared };
}
export function workspaceValidationRecord(
  input,
  operationId,
  epoch,
  generation,
  { scope, checks, prepared }
) {
  const body = {
    version: 3,
    profile: workspaceValidationProfile,
    input,
    operationId,
    epoch,
    generation,
    scope,
    checks,
    prepared
  };
  return { id: hashRecord(body), ...body };
}
export function verifyWorkspaceRecipe(db, r, operationId) {
  const input = normalizeWorkspaceValidation(r.input),
    { native, scope, checks } = selection(db, input);
  need(
    Array.isArray(r.prepared) && r.prepared.length === checks.length,
    'Workspace prepared checks differ.'
  );
  for (let n = 0; n < checks.length; n++) {
    const p = r.prepared[n];
    need(
      p?.version === 1 &&
        p.checkId === checks[n].id &&
        p.scopeDigest === scope.digest &&
        Object.keys(p).length === 6 &&
        p.dependenciesDigest ===
          hashRecord(
            projectCheckDependencies(
              native
                .select({ repository: input.repository, revisionId: input.base })
                .read(checks[n].lockPath).bytes
            )
          ) &&
        p.toolchainDigest === hashRecord(p.toolchain),
      'Workspace toolchain preparation differs.'
    );
  }
  need(
    same(
      r,
      workspaceValidationRecord(input, operationId, r.epoch, r.generation, {
        scope,
        checks,
        prepared: r.prepared
      })
    ),
    'Workspace recipe, source scope or discovered checks differ.'
  );
  return r;
}
export async function prepareWorkspaceCache(db, dataDir, r) {
  const current = await prepareWorkspaceValidation(db, dataDir, r.input);
  need(
    same(current, { scope: r.scope, checks: r.checks, prepared: r.prepared }),
    'The enrolled workspace check cache or runtime changed.'
  );
  return { recipeId: r.id, ready: true };
}
export function workspaceCheckSubject(db, r, repository, revisionId, role) {
  need(
    repository === r.input.repository && ['author', 'reviewer'].includes(role),
    'Workspace check role or repository differs.'
  );
  validateNativeId(revisionId);
  const native = new NativeStore({ db });
  const changed = projectSourceChangedPaths(native, r.scope, revisionId);
  need(
    changed.every((path) =>
      r.checks.some((check) => check.directory === '' || path.startsWith(check.directory + '/'))
    ),
    'Changed workspace source is outside the checked package directories.'
  );
  for (const check of r.checks) validateProjectCheck(native, r.scope, check, revisionId);
  return {
    version: 3,
    profile: r.profile,
    recipeId: r.id,
    repository,
    revisionId,
    role,
    scopeDigest: r.scope.digest
  };
}
export function workspaceCheckResult(binding, checks) {
  const outcome = checks.some((item) => item.result.outcome === 'unavailable')
    ? 'unavailable'
    : checks.some((item) => item.result.outcome === 'failed')
      ? 'failed'
      : 'passed';
  const observation = {
    version: 1,
    checks: checks.map((item) => item.checkId),
    wrappersExecuted: false
  };
  const detail =
    outcome === 'unavailable' ? 'One or more repository checks could not finish.' : null;
  const body = { ...binding, checks, outcome, detail, observation };
  return { ...body, reportDigest: hashRecord(body) };
}
export async function runWorkspaceValidation(db, dataDir, r, revisionId, binding) {
  const native = new NativeStore({ db }),
    checks = [];
  for (let n = 0; n < r.checks.length; n++) {
    const check = r.checks[n];
    const result = await runProjectWorkspaceCheck({
      native,
      scope: r.scope,
      check,
      revisionId,
      dataDir,
      prepared: r.prepared[n]
    });
    checks.push({ checkId: check.id, result });
  }
  const result = workspaceCheckResult(binding, checks);
  verifyWorkspaceValidation(db, r, revisionId, result);
  return result;
}
export function verifyWorkspaceValidation(db, r, revisionId, check) {
  const binding = workspaceCheckSubject(db, r, check.repository, revisionId, check.role);
  need(
    Array.isArray(check.checks) && check.checks.length === r.checks.length,
    'Incomplete workspace repository check report.'
  );
  const native = new NativeStore({ db });
  for (let n = 0; n < r.checks.length; n++) {
    const item = check.checks[n];
    need(
      item?.checkId === r.checks[n].id && Object.keys(item).length === 2,
      'Workspace repository check selection differs.'
    );
    verifyWorkspaceCheckResult(
      native,
      r.scope,
      r.checks[n],
      revisionId,
      r.prepared[n],
      item.result
    );
  }
  need(
    same(check, workspaceCheckResult(binding, check.checks)),
    'Workspace aggregate check report differs.'
  );
  return true;
}
