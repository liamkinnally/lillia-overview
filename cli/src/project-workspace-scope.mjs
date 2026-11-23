import { createHash } from 'node:crypto';
import { validateNativePath } from './native-store.mjs';

export const limits = Object.freeze({
  files: 4096,
  totalBytes: 16 * 1024 * 1024,
  fileBytes: 256 * 1024
});
const protectedComponents = new Set([
  '.git',
  '.codex',
  '.agents',
  '.aws',
  '.git-credentials',
  '.gnupg',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.ssh',
  'node_modules'
]);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeIndexes = new WeakMap();
export function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
export function object(value, required, optional = []) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    fail('Invalid project source request');
  }
}
export function id(value, name) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`Invalid ${name}`);
  return value;
}
export function safePath(path) {
  try {
    validateNativePath(path);
  } catch {
    fail('Unsafe project source path', 403);
  }
  if (
    path
      .split('/')
      .some(
        (part) => protectedComponents.has(part.toLowerCase()) || /^\.env(?:$|[._-]|rc$)/i.test(part)
      )
  ) {
    fail('Protected project source path', 403);
  }
  return path;
}
function safeRoot(path) {
  if (path === '') return path;
  return safePath(path);
}
function within(path, root) {
  return root === '' || path === root || path.startsWith(root + '/');
}
export function ordinary(bytes) {
  if (bytes.length > limits.fileBytes || bytes.includes(0)) return null;
  let value;
  try {
    value = decoder.decode(bytes);
  } catch {
    return null;
  }
  if (
    [...value].some((char) => {
      const n = char.codePointAt(0);
      return (n < 32 && ![9, 10, 13].includes(n)) || (n >= 0x7f && n <= 0x9f);
    })
  )
    return null;
  return value;
}
function frozen(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function scopePayload(scope) {
  const { digest: _digest, ...payload } = scope;
  return payload;
}
export function validateProjectSourceScope(scope) {
  object(scope, [
    'version',
    'repository',
    'baseRevision',
    'allowedRoots',
    'protectedPaths',
    'files',
    'excludedPaths',
    'digest'
  ]);
  if (
    scope.version !== 1 ||
    typeof scope.repository !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(scope.repository)
  )
    fail('Unsupported project source scope', 409);
  id(scope.baseRevision, 'base revision');
  if (
    !Array.isArray(scope.allowedRoots) ||
    !Array.isArray(scope.protectedPaths) ||
    !Array.isArray(scope.files) ||
    !Array.isArray(scope.excludedPaths)
  )
    fail('Malformed project source scope', 409);
  if (
    scope.allowedRoots.some(
      (root, index) => safeRoot(root) !== root || (index && scope.allowedRoots[index - 1] >= root)
    )
  )
    fail('Malformed project source roots', 409);
  if (
    scope.protectedPaths.some(
      (path, index) => safePath(path) !== path || (index && scope.protectedPaths[index - 1] >= path)
    )
  )
    fail('Malformed protected paths', 409);
  if (
    scope.files.length > limits.files ||
    scope.allowedRoots.length > 128 ||
    scope.protectedPaths.length > limits.files ||
    scope.excludedPaths.length > 8192
  )
    fail('Project source inventory capacity exceeded', 409);
  let total = 0,
    previous = '';
  for (const file of scope.files) {
    object(file, ['path', 'fileId', 'mode', 'bytes']);
    safePath(file.path);
    id(file.fileId, 'file identity');
    if (
      !['100644', '100755'].includes(file.mode) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > limits.fileBytes ||
      file.path <= previous ||
      !scope.allowedRoots.some((root) => within(file.path, root)) ||
      scope.protectedPaths.includes(file.path)
    )
      fail('Malformed project source inventory', 409);
    previous = file.path;
    total += file.bytes;
  }
  if (total > limits.totalBytes) fail('Project source byte capacity exceeded', 409);
  previous = '';
  for (const item of scope.excludedPaths) {
    object(item, ['path', 'reason']);
    if (
      typeof item.path !== 'string' ||
      item.path <= previous ||
      !['protected', 'non-text', 'capacity'].includes(item.reason)
    )
      fail('Malformed excluded path inventory', 409);
    previous = item.path;
  }
  if (id(scope.digest, 'scope digest') !== digest(scopePayload(scope)))
    fail('Project source scope was modified', 409);
  scopeIndexes.set(scope, {
    files: new Set(scope.files.map((file) => file.path)),
    excluded: new Set(scope.excludedPaths.map((file) => file.path))
  });
  return scope;
}
export function isEligible(path, roots, protectedPaths) {
  return (
    roots.some((root) => within(path, root)) &&
    !protectedPaths.includes(path) &&
    !path
      .split('/')
      .some(
        (part) => protectedComponents.has(part.toLowerCase()) || /^\.env(?:$|[._-]|rc$)/i.test(part)
      )
  );
}
export function isPermitted(scope, path) {
  if (!isEligible(path, scope.allowedRoots, scope.protectedPaths)) return false;
  const indexes = scopeIndexes.get(scope);
  const files = indexes?.files ?? new Set(scope.files.map((file) => file.path));
  const excluded = indexes?.excluded ?? new Set(scope.excludedPaths.map((file) => file.path));
  return files.has(path) || !excluded.has(path);
}
function deepFreezeScope(scope) {
  scope.digest = digest(scopePayload(scope));
  return frozen(scope);
}
export function createProjectSourceScope(native, input) {
  object(input, ['repository', 'baseRevision', 'allowedRoots'], ['protectedPaths']);
  const repository = input.repository,
    baseRevision = id(input.baseRevision, 'base revision');
  if (typeof repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(repository))
    fail('Invalid repository');
  if (
    !Array.isArray(input.allowedRoots) ||
    !input.allowedRoots.length ||
    input.allowedRoots.length > 128
  )
    fail('At least one bounded project root is required');
  const allowedRoots = [...input.allowedRoots].map(safeRoot).sort();
  if (
    new Set(allowedRoots).size !== allowedRoots.length ||
    allowedRoots.some((root, i) => i && within(root, allowedRoots[i - 1]))
  )
    fail('Project roots overlap');
  if (
    input.protectedPaths !== undefined &&
    (!Array.isArray(input.protectedPaths) || input.protectedPaths.length > limits.files)
  )
    fail('Invalid protected path set');
  const protectedPaths = [...(input.protectedPaths ?? [])].map(safePath).sort();
  if (new Set(protectedPaths).size !== protectedPaths.length) fail('Duplicate protected path');
  const tree = native.select({ repository, revisionId: baseRevision });
  const files = [],
    excludedPaths = [];
  let total = 0;
  for (const entry of tree.entries) {
    if (!allowedRoots.some((root) => within(entry.path, root))) continue;
    if (!isEligible(entry.path, allowedRoots, protectedPaths)) {
      excludedPaths.push({ path: entry.path, reason: 'protected' });
      continue;
    }
    if (!['100644', '100755'].includes(entry.mode)) {
      excludedPaths.push({ path: entry.path, reason: 'non-text' });
      continue;
    }
    const bytes = tree.read(entry.path).bytes;
    if (bytes.length > limits.fileBytes) {
      excludedPaths.push({ path: entry.path, reason: 'capacity' });
      continue;
    }
    if (ordinary(bytes) === null) {
      excludedPaths.push({ path: entry.path, reason: 'non-text' });
      continue;
    }
    if (files.length >= limits.files || total + bytes.length > limits.totalBytes) {
      excludedPaths.push({ path: entry.path, reason: 'capacity' });
      continue;
    }
    files.push({ path: entry.path, fileId: entry.fileId, mode: entry.mode, bytes: bytes.length });
    total += bytes.length;
  }
  return deepFreezeScope({
    version: 1,
    repository,
    baseRevision,
    allowedRoots,
    protectedPaths,
    files,
    excludedPaths
  });
}
