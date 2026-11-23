import { NativeSearch } from './native-search.mjs';
import {
  createProjectSourceScope,
  fail,
  id,
  isEligible,
  isPermitted,
  limits,
  ordinary,
  object,
  safePath,
  validateProjectSourceScope
} from './project-workspace-scope.mjs';

export { createProjectSourceScope, validateProjectSourceScope };

const searchIndex = new NativeSearch();

function selected(native, scope, revisionId) {
  validateProjectSourceScope(scope);
  id(revisionId, 'revision');
  const revision = native.revision({ repository: scope.repository, revisionId });
  let cursor = revisionId,
    found = cursor === scope.baseRevision;
  for (let depth = 0; !found && depth < 256; depth++) {
    const item = native.revision({ repository: scope.repository, revisionId: cursor });
    cursor = item.parents[0];
    if (!cursor) break;
    found = cursor === scope.baseRevision;
  }
  if (!found) fail('Project revision is not a descendant of the captured base', 403);
  const tree = native.select({ repository: scope.repository, revisionId });
  const changedPaths = new Set(projectSourceChangedPaths(native, scope, revisionId));
  let total = 0;
  for (const entry of tree.entries) {
    if (!isPermitted(scope, entry.path)) continue;
    const bytes = tree.read(entry.path).bytes;
    const text = ordinary(bytes);
    if (text === null || !['100644', '100755'].includes(entry.mode))
      fail('Candidate contains unsupported editable source', 403);
    total += bytes.length;
    if (total > limits.totalBytes) fail('Candidate exceeds source scope capacity', 403);
    if (changedPaths.has(entry.path) && bytes.length > limits.fileBytes)
      fail('Candidate source file exceeds capacity', 403);
  }
  return { revision, tree };
}
export function listProjectSourceFiles(native, scope, input) {
  object(input, ['revisionId'], ['prefix', 'query', 'limit', 'offset']);
  const { tree } = selected(native, scope, input.revisionId);
  const limit = input.limit ?? 100,
    offset = input.offset ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    fail('Invalid project file listing bounds');
  const prefix = input.prefix ?? '',
    query = input.query?.toLocaleLowerCase('en-US') ?? '';
  if (
    typeof prefix !== 'string' ||
    prefix.length > 240 ||
    (typeof input.query !== 'undefined' &&
      (typeof input.query !== 'string' || input.query.length > 256 || !input.query.isWellFormed()))
  )
    fail('Invalid project source filter');
  if (prefix) safePath(prefix.replace(/\/$/, ''));
  return tree.entries
    .filter(
      (entry) =>
        isPermitted(scope, entry.path) &&
        (!prefix || entry.path.startsWith(prefix)) &&
        (!query || entry.path.toLocaleLowerCase('en-US').includes(query))
    )
    .slice(offset, offset + limit)
    .map((entry) => ({ path: entry.path, fileId: entry.fileId, mode: entry.mode }));
}
export function searchProjectSource(native, scope, input) {
  object(input, ['revisionId', 'query'], ['mode', 'language']);
  const { tree } = selected(native, scope, input.revisionId);
  const entries = tree.entries.filter((entry) => isPermitted(scope, entry.path));
  return searchIndex.search(
    {
      repository: scope.repository,
      revisionId: input.revisionId,
      authorization: scope.digest,
      entries,
      read: (path) => tree.read(path)
    },
    {
      mode: input.mode ?? 'text',
      query: input.query,
      ...(input.language ? { language: input.language } : {})
    }
  );
}
export function readProjectSource(native, scope, input) {
  object(input, ['revisionId', 'path']);
  safePath(input.path);
  if (!isPermitted(scope, input.path)) fail('Path is outside project source scope', 403);
  const { tree } = selected(native, scope, input.revisionId);
  const value = tree.read(input.path);
  const text = ordinary(value.bytes);
  if (text === null || !['100644', '100755'].includes(value.mode))
    fail('Source file is not editable text', 403);
  return { path: input.path, fileId: value.fileId, mode: value.mode, text };
}
export function prepareProjectSourceChange(native, scope, input) {
  object(input, ['taskId', 'role', 'revisionId', 'path', 'expectedFileId', 'operation'], ['text']);
  if (input.role !== 'author') fail('Only the author may change project source', 403);
  if (typeof input.taskId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.taskId))
    fail('Invalid author task identity');
  safePath(input.path);
  if (!isPermitted(scope, input.path)) fail('Path is outside project source scope', 403);
  const { tree, revision } = selected(native, scope, input.revisionId);
  const previous = tree.entries.find((entry) => entry.path === input.path);
  if (input.operation === 'create') {
    if (Object.hasOwn(input, 'text') === false || input.expectedFileId !== null || previous)
      fail('Create requires an absent path and null expected identity', 409);
  } else if (input.operation === 'write' || input.operation === 'delete') {
    if (!previous || input.expectedFileId !== previous.fileId)
      fail('Project source file changed since it was read', 409);
    if (input.operation === 'write' && !Object.hasOwn(input, 'text'))
      fail('Write requires source text');
    if (input.operation === 'delete' && Object.hasOwn(input, 'text'))
      fail('Delete does not accept source text');
  } else fail('Unsupported project source operation');
  let edits;
  if (input.operation === 'delete') edits = [{ path: input.path, delete: true }];
  else {
    if (
      typeof input.text !== 'string' ||
      !input.text.isWellFormed() ||
      Buffer.byteLength(input.text) > limits.fileBytes ||
      ordinary(Buffer.from(input.text)) === null
    )
      fail('Unsupported source text');
    const { fileId } = native.putFile({
      repository: scope.repository,
      bytes: Buffer.from(input.text)
    });
    edits = [{ path: input.path, mode: previous?.mode ?? '100644', fileId }];
  }
  const author = { ...actor, name: input.role };
  return {
    repository: scope.repository,
    parents: [input.revisionId],
    edits,
    author,
    committer: actor,
    message: `Project source ${input.operation}: ${input.path}`,
    provenance: { principal: 'task-service', taskId: input.taskId }
  };
}
const actor = Object.freeze({
  name: 'Lillia',
  email: 'lillia@local.invalid',
  seconds: 0,
  offset: '+0000'
});
export function projectSourceChangedPaths(native, scope, revisionId) {
  validateProjectSourceScope(scope);
  id(revisionId, 'revision');
  let cursor = revisionId;
  for (let depth = 0; cursor !== scope.baseRevision && depth < 256; depth++) {
    const revision = native.revision({ repository: scope.repository, revisionId: cursor });
    if (revision.parents.length !== 1) fail('Project source candidate must have one parent', 403);
    for (const edit of revision.edits) {
      safePath(edit.path);
      if (!isPermitted(scope, edit.path))
        fail('Candidate changed a path outside project source scope', 403);
    }
    cursor = revision.parents[0];
    if (!cursor) fail('Project source candidate is not based on captured revision', 403);
  }
  if (cursor !== scope.baseRevision) fail('Project source candidate ancestry is too deep', 403);
  const before = native.select({
    repository: scope.repository,
    revisionId: scope.baseRevision
  }).entries;
  const current = native.select({ repository: scope.repository, revisionId });
  const after = current.entries;
  const oldFiles = new Map(before.map((entry) => [entry.path, entry]));
  const newFiles = new Map(after.map((entry) => [entry.path, entry]));
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  const changed = [...paths].filter((path) => {
    const oldFile = oldFiles.get(path),
      newFile = newFiles.get(path);
    return (
      !oldFile || !newFile || oldFile.fileId !== newFile.fileId || oldFile.mode !== newFile.mode
    );
  });
  for (const path of changed) {
    if (!isPermitted(scope, path))
      fail('Candidate changed a path outside project source scope', 403);
    const entry = newFiles.get(path);
    if (!entry) continue;
    const bytes = current.read(path).bytes;
    if (!['100644', '100755'].includes(entry.mode) || ordinary(bytes) === null)
      fail('Candidate changed source to unsupported content', 403);
  }
  return changed.sort();
}
