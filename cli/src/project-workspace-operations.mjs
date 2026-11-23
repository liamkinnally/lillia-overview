import { isDeepStrictEqual as same } from 'node:util';
import { nativeFileId } from './native-store.mjs';
import { requireProject as need } from './project-source.mjs';
import {
  listProjectSourceFiles,
  searchProjectSource,
  readProjectSource,
  prepareProjectSourceChange,
  projectSourceChangedPaths
} from './project-workspace-source.mjs';
import { workspaceProjectArguments } from './project-workspace-tools.mjs';

export const workspaceProfile = 'darwin-npm-workspace-v1';
export const workspaceMutation = (tool) => ['write_file', 'delete_file'].includes(tool);

export function assertWorkspaceEditable(recipe, path) {
  const pins = recipe.checks.flatMap((check) => [
    check.manifestPath,
    check.lockPath,
    ...check.coverage.repositoryWrappers.map((p) => p.path)
  ]);
  need(
    !pins.includes(path),
    'Project tooling is pinned. Enroll a new tooling revision first.',
    403
  );
  need(
    recipe.checks.some((check) => !check.directory || path.startsWith(check.directory + '/')),
    'This path is outside the enrolled package check coverage.',
    403
  );
}

export function workspaceObservation(native, recipe, subject, tool, args) {
  workspaceProjectArguments(subject.role, tool, args);
  const { scope } = recipe,
    revisionId = subject.revisionId;
  if (tool === 'list_files') {
    const files = listProjectSourceFiles(native, scope, { revisionId, ...args });
    return {
      revisionId,
      files,
      offset: args.offset ?? 0,
      checks: recipe.checks.map(({ id, command, directory, coverage }) => ({
        id,
        command,
        directory,
        coverage
      }))
    };
  }
  if (tool === 'search') {
    const { offset = 0, limit = 100, ...query } = args;
    const found = searchProjectSource(native, scope, { revisionId, ...query });
    return {
      ...found,
      revisionId,
      total: found.results.length,
      offset,
      results: found.results.slice(offset, offset + limit)
    };
  }
  if (tool === 'read_file') {
    const at = args.at === 'base' ? scope.baseRevision : revisionId;
    return {
      revisionId: at,
      ...readProjectSource(native, scope, { revisionId: at, path: args.path })
    };
  }
  if (tool === 'changed_files') {
    const paths = projectSourceChangedPaths(native, scope, revisionId);
    const entries = (at) =>
      new Map(
        native
          .select({ repository: scope.repository, revisionId: at })
          .entries.map((e) => [e.path, e])
      );
    const base = entries(scope.baseRevision),
      candidate = entries(revisionId);
    return {
      revisionId,
      baseRevision: scope.baseRevision,
      paths,
      files: paths.map((path) => ({
        path,
        before: base.get(path) ?? null,
        after: candidate.get(path) ?? null
      }))
    };
  }
  need(false, 'This operation does not produce a read-only observation.', 403);
}

export function prepareWorkspaceEdit(native, recipe, subject, taskId, tool, args) {
  workspaceProjectArguments(subject.role, tool, args);
  need(workspaceMutation(tool), 'Unknown workspace mutation.', 403);
  assertWorkspaceEditable(recipe, args.path);
  return prepareProjectSourceChange(native, recipe.scope, {
    taskId,
    role: subject.role,
    revisionId: subject.revisionId,
    ...args,
    operation: tool === 'delete_file' ? 'delete' : args.expectedFileId === null ? 'create' : 'write'
  });
}

export function workspaceEditResult(edit, revisionId) {
  return { path: edit.edits[0].path, fileId: edit.edits[0].fileId ?? null, revisionId };
}

// Replay source changes without writing blobs or accepting a new revision during verification.
export function verifyWorkspaceEdit(native, recipe, row) {
  const args = JSON.parse(row.args);
  workspaceProjectArguments(row.role, row.tool, args);
  need(
    row.role === 'author' && workspaceMutation(row.tool),
    'Only the author may change workspace source.'
  );
  assertWorkspaceEditable(recipe, args.path);
  const repository = recipe.scope.repository;
  const before = native
    .select({ repository, revisionId: row.revisionBefore })
    .entries.find((e) => e.path === args.path);
  need(
    (before?.fileId ?? null) === args.expectedFileId,
    'Workspace edit lost its expected source identity.'
  );
  const deletion = row.tool === 'delete_file';
  need(!deletion || before, 'Workspace deletion must name an existing source file.');
  const edit = deletion
    ? { path: args.path, delete: true }
    : {
        path: args.path,
        mode: before?.mode ?? '100644',
        fileId: nativeFileId(Buffer.from(args.text))
      };
  const rev = native.revision({ repository, revisionId: row.revisionAfter });
  const actor = { name: 'Lillia', email: 'lillia@local.invalid', seconds: 0, offset: '+0000' };
  need(
    same(rev.parents, [row.revisionBefore]) &&
      same(rev.edits, [edit]) &&
      same(rev.author, { ...actor, name: 'author' }) &&
      same(rev.committer, actor) &&
      rev.message ===
        `Project source ${deletion ? 'delete' : before ? 'write' : 'create'}: ${args.path}` &&
      same(rev.provenance, { principal: 'task-service', taskId: row.taskId }),
    'Workspace revision lineage differs from its authorized file change.'
  );
  projectSourceChangedPaths(native, recipe.scope, row.revisionAfter);
  return workspaceEditResult({ edits: [edit] }, row.revisionAfter);
}
