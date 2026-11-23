import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateNativePath } from './native-store.mjs';
import {
  validateProjectSourceScope,
  projectSourceChangedPaths
} from './project-workspace-source.mjs';

export const checkHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function requireCheck(ok, message, status = 409) {
  if (!ok) throw Object.assign(new Error(message), { status });
}
const priority = ['verify', 'test', 'check', 'typecheck', 'lint', 'build'];
const blocked = new Set([
  '.git',
  '.codex',
  '.agents',
  '.aws',
  '.npmrc',
  '.pypirc',
  '.ssh',
  '.gnupg',
  '.netrc',
  '.git-credentials',
  'node_modules'
]);
const inside = (root, path) => root === '' || root === path || path.startsWith(root + '/');
function admitted(scope, path) {
  validateNativePath(path);
  return (
    scope.allowedRoots.some((root) => inside(root, path)) &&
    !scope.protectedPaths.some((root) => inside(root, path)) &&
    !path
      .split('/')
      .some((part) => blocked.has(part.toLowerCase()) || /^\.env(?:$|[._-]|rc$)/i.test(part))
  );
}
function jsonFile(selected, path, max) {
  const file = selected.read(path);
  requireCheck(
    file.mode === '100644' && file.bytes.length > 0 && file.bytes.length <= max,
    'The retained package manifest or lock is not a bounded regular file.'
  );
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
  } catch {
    requireCheck(false, 'The retained package manifest or lock is invalid JSON.');
  }
  requireCheck(
    value && typeof value === 'object' && !Array.isArray(value),
    'Invalid package metadata.'
  );
  return { ...file, value };
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// These are repository-level choices, derived from retained metadata. A worker can select
// their IDs; neither a shell command nor an owner filesystem path is a tool argument.
export function discoverProjectChecks(native, scope) {
  validateProjectSourceScope(scope);
  const selected = native.select({ repository: scope.repository, revisionId: scope.baseRevision });
  const checks = [];
  const wrappers = selected.entries
    .filter(
      (entry) =>
        /(?:^|\/)scripts\/verify(?:\.[a-z]+)?$/.test(entry.path) && admitted(scope, entry.path)
    )
    .map(({ path, fileId }) => ({ path, fileId }));
  for (const entry of selected.entries) {
    if (!/(?:^|\/)package\.json$/.test(entry.path) || !admitted(scope, entry.path)) continue;
    const directory = entry.path.slice(0, -'package.json'.length).replace(/\/$/, '');
    if (
      directory
        .split('/')
        .some((part) =>
          ['dist', 'build', 'coverage', '.next', 'fixtures', '__fixtures__'].includes(part)
        )
    )
      continue;
    const manifest = jsonFile(selected, entry.path, 256 * 1024);
    const scripts = manifest.value.scripts;
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) continue;
    const names = priority.filter((name) => Object.hasOwn(scripts, name));
    if (!names.length) continue;
    const lockPath = (directory ? directory + '/' : '') + 'package-lock.json';
    requireCheck(
      admitted(scope, lockPath),
      'The package lock is outside the admitted project scope.'
    );
    const lock = jsonFile(selected, lockPath, 4 * 1024 * 1024);
    requireCheck(
      lock.value.lockfileVersion === 3 && lock.value.packages?.[''],
      'Project checks currently require a complete npm lockfile version 3.'
    );
    for (const script of names) {
      requireCheck(
        typeof scripts[script] === 'string' &&
          scripts[script].trim() &&
          Buffer.byteLength(scripts[script]) <= 4096 &&
          !scripts[script].includes('\0'),
        'The repository check script is empty or exceeds its bound.'
      );
      const executionAdapter =
        scripts[script].trim() === 'next build' &&
        (manifest.value.dependencies?.next || manifest.value.devDependencies?.next) &&
        lock.value.packages['node_modules/next']?.version === '16.4.5'
          ? {
              name: 'next-webpack-v1',
              dependencyVersion: '16.4.5',
              defaultCompilerQualified: false
            }
          : null;
      const body = {
        version: 1,
        profile: 'darwin-npm-project-v1',
        repository: scope.repository,
        baseRevision: scope.baseRevision,
        scopeDigest: scope.digest,
        directory,
        script,
        command: ['npm', 'run', script, ...(executionAdapter ? ['--', '--webpack'] : [])],
        executionAdapter,
        scriptText: scripts[script],
        manifestPath: entry.path,
        manifestFileId: manifest.fileId,
        lockPath,
        lockFileId: lock.fileId,
        coverage: {
          kind: 'package-script',
          directory,
          repositoryWrappers: wrappers,
          wrappersExecuted: false
        },
        executionLimits: {
          network: 'denied',
          sourceWrites: 'denied',
          ownerReads: 'denied',
          timeoutMs: 120000,
          fileDescriptorLimit: 4096,
          processCleanup: 'parent-and-process-group',
          detachedDescendantsContained: false
        },
        lifecycleScripts: Object.fromEntries(
          ['pre' + script, 'post' + script]
            .filter((name) => Object.hasOwn(scripts, name))
            .map((name) => [name, scripts[name]])
        )
      };
      checks.push(freeze({ ...body, id: checkHash(JSON.stringify(body)) }));
      requireCheck(checks.length <= 64, 'The project has too many discovered repository checks.');
    }
  }
  requireCheck(
    checks.length,
    'No supported npm repository check was found in the admitted source.'
  );
  return Object.freeze(checks);
}

export function validateProjectCheck(native, scope, check, revisionId) {
  const original = discoverProjectChecks(native, scope).find((item) => item.id === check?.id);
  requireCheck(
    original && isDeepStrictEqual(original, check),
    'The selected check differs from its enrolled repository command.'
  );
  projectSourceChangedPaths(native, scope, revisionId);
  const selected = native.select({ repository: scope.repository, revisionId });
  for (const [path, fileId] of [
    [check.manifestPath, check.manifestFileId],
    [check.lockPath, check.lockFileId]
  ]) {
    requireCheck(
      selected.read(path).fileId === fileId,
      'The pinned package manifest or lock changed; enroll the new project tooling first.'
    );
  }
  for (const wrapper of check.coverage.repositoryWrappers)
    requireCheck(
      selected.read(wrapper.path).fileId === wrapper.fileId,
      'A pinned repository verification wrapper changed; enroll the new project tooling first.'
    );
  const files = [];
  let bytes = 0;
  for (const entry of selected.entries) {
    if (!admitted(scope, entry.path)) continue;
    requireCheck(entry.mode !== '120000', 'Project checks cannot materialize symbolic links.');
    requireCheck(['100644', '100755'].includes(entry.mode), 'Unsupported project input mode.');
    const file = selected.read(entry.path);
    bytes += file.bytes.length;
    requireCheck(
      file.bytes.length <= 4 * 1024 * 1024 && bytes <= 128 * 1024 * 1024 && files.length < 8192,
      'The check snapshot exceeds its materialization bound.'
    );
    files.push({ path: entry.path, mode: entry.mode, fileId: entry.fileId, bytes: file.bytes });
  }
  return {
    repository: scope.repository,
    revisionId,
    scopeDigest: scope.digest,
    check,
    files,
    inputDigest: checkHash(
      JSON.stringify(files.map(({ path, mode, fileId }) => ({ path, mode, fileId })))
    )
  };
}
