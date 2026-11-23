import { isDeepStrictEqual } from 'node:util';
import {
  discoverProjectChecks,
  validateProjectCheck,
  checkHash,
  requireCheck
} from './project-workspace-check-catalog.mjs';
import {
  projectCheckDependencies,
  prepareCheckArchives,
  workspaceCheckToolchain
} from './project-workspace-check-cache.mjs';
import { executeProjectCheck, projectCheckCommand } from './project-workspace-check-runner.mjs';

export { discoverProjectChecks, validateProjectCheck } from './project-workspace-check-catalog.mjs';
export { projectCheckDependencies } from './project-workspace-check-cache.mjs';

export async function prepareProjectCheck({ native, scope, check, dataDir }) {
  const snapshot = validateProjectCheck(native, scope, check, scope.baseRevision);
  const dependencies = projectCheckDependencies(
    snapshot.files.find((file) => file.path === check.lockPath).bytes
  );
  const toolchain = await workspaceCheckToolchain();
  const cache = await prepareCheckArchives(dataDir, dependencies);
  return {
    version: 1,
    checkId: check.id,
    scopeDigest: scope.digest,
    dependenciesDigest: cache.dependenciesDigest,
    toolchain,
    toolchainDigest: checkHash(JSON.stringify(toolchain))
  };
}

export async function runProjectWorkspaceCheck({
  native,
  scope,
  check,
  revisionId,
  dataDir,
  prepared
}) {
  const snapshot = validateProjectCheck(native, scope, check, revisionId);
  const dependencies = projectCheckDependencies(
    snapshot.files.find((file) => file.path === check.lockPath).bytes
  );
  requireCheck(
    prepared?.version === 1 &&
      prepared.checkId === check.id &&
      prepared.scopeDigest === scope.digest &&
      prepared.dependenciesDigest === checkHash(JSON.stringify(dependencies)) &&
      prepared.toolchainDigest === checkHash(JSON.stringify(prepared.toolchain)),
    'The repository check has no matching prepared toolchain.'
  );
  const toolchain = await workspaceCheckToolchain();
  requireCheck(
    isDeepStrictEqual(toolchain, prepared.toolchain),
    'The enrolled repository check runtime changed.'
  );
  const cache = await prepareCheckArchives(dataDir, dependencies);
  return executeProjectCheck({ snapshot, dependencies, cache, toolchain });
}

export function verifyWorkspaceCheckResult(native, scope, check, revisionId, prepared, result) {
  const snapshot = validateProjectCheck(native, scope, check, revisionId);
  const dependencies = projectCheckDependencies(
    snapshot.files.find((file) => file.path === check.lockPath).bytes
  );
  requireCheck(
    prepared?.version === 1 &&
      prepared.checkId === check.id &&
      prepared.scopeDigest === scope.digest &&
      prepared.dependenciesDigest === checkHash(JSON.stringify(dependencies)) &&
      prepared.toolchainDigest === checkHash(JSON.stringify(prepared.toolchain)),
    'Invalid retained check preparation.'
  );
  requireCheck(
    result && typeof result === 'object' && !Array.isArray(result),
    'Missing repository check result.'
  );
  const { reportDigest, ...body } = result;
  requireCheck(
    reportDigest === checkHash(JSON.stringify(body)),
    'The repository check result changed.'
  );
  const o = result.observation;
  const expected = {
    version: 1,
    repository: scope.repository,
    revisionId,
    scopeDigest: scope.digest,
    checkId: check.id,
    inputDigest: snapshot.inputDigest,
    toolchainDigest: prepared.toolchainDigest,
    dependenciesDigest: prepared.dependenciesDigest,
    command: projectCheckCommand(check, snapshot.files),
    directory: check.directory
  };
  requireCheck(
    o && Object.entries(expected).every(([key, value]) => isDeepStrictEqual(o[key], value)),
    'The repository check result is not bound to its candidate and command.'
  );
  requireCheck(
    ((Number.isInteger(o.exitCode) && o.exitCode >= 0) || o.exitCode === null) &&
      (typeof o.signal === 'string' || o.signal === null) &&
      typeof o.stopped === 'boolean' &&
      Number.isInteger(o.elapsedMs) &&
      o.elapsedMs >= 0 &&
      ['stdout', 'stderr'].every(
        (name) =>
          typeof result[name] === 'string' &&
          Buffer.byteLength(result[name]) <= 65536 &&
          /^[a-f0-9]{64}$/.test(o[name + 'Digest']) &&
          Number.isInteger(o[name + 'Bytes']) &&
          o[name + 'Bytes'] >= 0 &&
          o[name + 'Bytes'] <= 1024 * 1024
      ),
    'Invalid repository check result fields.'
  );
  const outcome =
    o.stopped || o.signal || !Number.isInteger(o.exitCode)
      ? 'unavailable'
      : o.exitCode === 0
        ? 'passed'
        : 'failed';
  requireCheck(
    result.outcome === outcome &&
      result.outputTruncated === (o.stdoutBytes > 16384 || o.stderrBytes > 16384) &&
      result.detail ===
        (outcome === 'unavailable'
          ? 'The repository check exceeded its bound or did not finish normally.'
          : null),
    'The repository check outcome disagrees with its execution result.'
  );
  return result;
}
