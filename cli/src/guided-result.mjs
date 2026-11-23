import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual as same, stripVTControlCharacters } from 'node:util';
import { nativeFileId } from './native-store.mjs';
import { id, limits, safePath } from './project-workspace-scope.mjs';

function need(value, message) {
  if (!value) throw new Error(message);
}

function reviewedLanding({ goal, projectChange: flow, completion }, config) {
  const { input, candidate, authorFinal, reviewerFinal } = flow;
  const { landing, criterionId } = completion?.evidence?.[0] ?? {};
  const criterion = completion?.criteria?.find((c) => c.id === criterionId);
  need(
    completion?.policy === 'reviewed-project-v1' &&
      completion.goalId === goal.id &&
      completion.version === goal.version &&
      completion.evidence.length === 1 &&
      criterion?.verifier === 'reviewed-project-change' &&
      same(criterion.evidence, [candidate]) &&
      same(goal.criteria, completion.criteria) &&
      authorFinal?.decision === 'submit' &&
      reviewerFinal?.decision === 'approve' &&
      authorFinal.revisionId === candidate &&
      reviewerFinal.revisionId === candidate &&
      authorFinal.evidence.taskId === flow.authorTaskId &&
      reviewerFinal.evidence.taskId === flow.reviewerTaskId &&
      flow.authorTaskId !== flow.reviewerTaskId &&
      landing?.version === 1 &&
      landing.goalId === goal.id &&
      landing.operationId === 'project-land-' + goal.id &&
      landing.epoch === flow.epoch &&
      landing.repository === config.repository &&
      landing.repository === input.repository &&
      landing.expectedTarget === input.base &&
      landing.candidate === candidate &&
      candidate !== input.base &&
      landing.expectedGeneration === input.expectedGeneration &&
      Number.isSafeInteger(input.expectedGeneration) &&
      landing.generation === input.expectedGeneration + 1 &&
      landing.recipeId === input.recipeId &&
      landing.policyDigest === input.policyDigest &&
      landing.policyDigest === flow.policyDigest &&
      landing.authorAttemptId === authorFinal.evidence.attemptId &&
      landing.reviewerAttemptId === reviewerFinal.evidence.attemptId &&
      landing.authorAttemptId !== landing.reviewerAttemptId,
    'The completion record does not match the submitted, reviewed and landed revision.'
  );
  id(candidate, 'candidate revision');
  id(input.base, 'base revision');
  return landing;
}

async function changedFiles(command, { repository, expectedTarget: base, candidate }) {
  const entries = new Map(),
    cursors = new Set();
  let cursor = null;
  do {
    const args = ['native', 'diff', repository, 'mainline', candidate, base];
    if (cursor) args.push('--cursor', cursor);
    const page = await command(args);
    need(
      page.repository === repository &&
        page.name === 'mainline' &&
        page.revisionId === candidate &&
        page.base === base &&
        Array.isArray(page.changes),
      'Changed files belong to another revision.'
    );
    for (const change of page.changes) {
      const path = safePath(change.path);
      need(!entries.has(path) && entries.size < limits.files * 2, 'Invalid changed file list.');
      const { before, after } = change;
      need(
        (before || after) &&
          change.kind === (before && after ? 'modify' : before ? 'delete' : 'add'),
        'Invalid change kind.'
      );
      for (const entry of [before, after]) {
        if (entry === null) continue;
        need(
          entry?.path === path && ['100644', '100755'].includes(entry.mode),
          'Unexpected reviewed file path or mode.'
        );
        id(entry.fileId, 'file identity');
      }
      entries.set(path, change);
    }
    cursor = page.cursor;
    need(
      cursor === null ||
        (typeof cursor === 'string' &&
          cursor.length &&
          page.changes.length &&
          !cursors.has(cursor)),
      'Invalid changed file cursor.'
    );
    cursors.add(cursor);
  } while (cursor);
  need(entries.size > 0, 'The reviewed revision has no changed files.');
  return entries.values();
}

async function readBytes(command, repository, revisionId, entry) {
  let offset = 0,
    total;
  const chunks = [];
  for (;;) {
    const args = [
      'native',
      'file',
      repository,
      'mainline',
      revisionId,
      entry.path,
      '--limit',
      '65536'
    ];
    if (offset) args.push('--offset', String(offset));
    const page = await command(args);
    need(
      page.repository === repository &&
        page.name === 'mainline' &&
        page.revisionId === revisionId &&
        page.path === entry.path &&
        page.fileId === entry.fileId &&
        page.mode === entry.mode &&
        page.offset === offset &&
        Number.isSafeInteger(page.total) &&
        page.total >= 0 &&
        page.total <= limits.fileBytes &&
        (total === undefined || total === page.total),
      'Reviewed file identity changed.'
    );
    total = page.total;
    const bytes = Buffer.from(page.base64, 'base64');
    need(bytes.toString('base64') === page.base64, 'Invalid retained file bytes.');
    chunks.push(bytes);
    offset += bytes.length;
    if (page.nextOffset === null) break;
    need(
      bytes.length && offset < total && page.nextOffset === offset,
      'Invalid retained file offset.'
    );
  }
  const bytes = Buffer.concat(chunks);
  need(
    bytes.length === total && nativeFileId(bytes) === entry.fileId,
    'Retained bytes differ from the reviewed file.'
  );
  return bytes;
}

function git(directory, args, input, workspace) {
  return execFileSync('/usr/bin/git', args, {
    cwd: workspace ?? directory,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30000,
    maxBuffer: 128 * 1024 * 1024,
    env: {
      PATH: '/usr/bin:/bin',
      LC_ALL: 'C',
      GIT_DIR: directory,
      ...(workspace ? { GIT_WORK_TREE: workspace } : {}),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0'
    }
  });
}

async function exportPatch(command, landing, config, previewOnly) {
  const changes = await changedFiles(command, landing);
  const before = [],
    after = [];
  let total = 0;
  for (const change of changes) {
    for (const [entry, revision, parts] of [
      [change.before, landing.expectedTarget, before],
      [change.after, landing.candidate, after]
    ]) {
      if (!entry) continue;
      const bytes = await readBytes(command, landing.repository, revision, entry);
      total += bytes.length;
      need(total <= 2 * limits.totalBytes, 'Changed files exceed the workspace source limit.');
      // Native paths exclude newlines and quotes, so each path occupies exactly one import line.
      parts.push(
        Buffer.from('M ' + entry.mode + ' inline ' + entry.path + '\ndata ' + bytes.length + '\n'),
        bytes,
        Buffer.from('\n')
      );
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'lillia-patch-'));
  try {
    git(directory, ['init', '--bare', '--quiet', '--template=', '--object-format=sha1', directory]);
    const commits = [];
    for (const [name, parts] of [
      ['base', before],
      ['candidate', after]
    ]) {
      commits.push(
        Buffer.from(
          'commit refs/heads/' + name + '\ncommitter Source <source@localhost> 0 +0000\ndata 0\n\n'
        ),
        ...parts,
        Buffer.from('\n')
      );
    }
    git(directory, ['fast-import', '--quiet'], Buffer.concat(commits));
    const patch = git(directory, [
      'diff-tree',
      '--no-commit-id',
      '-r',
      '-p',
      '--full-index',
      '--no-renames',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--text',
      'refs/heads/base',
      'refs/heads/candidate'
    ]);
    need(patch.length, 'Git found no difference between the reviewed files.');
    if (previewOnly) {
      const limit = 6000;
      return (
        stripVTControlCharacters(patch.subarray(0, limit).toString('utf8')) +
        (patch.length > limit
          ? '\n… Preview ends here. Save the patch to see the full change.'
          : '')
      );
    }
    const path = await publish(config, landing.goalId, patch);
    const saved = 'Reviewed patch saved to ' + path + '\n';
    // The scratch Git directory supplies the configuration and index. Only the working files
    // come from the project. Check the same bounded bytes that were published.
    try {
      git(directory, ['apply', '--check', '--whitespace=nowarn', '-'], patch, config.workspaceRoot);
    } catch (error) {
      if (error.status === 1) {
        return (
          saved +
          'This patch does not apply to the current working tree. ' +
          'Use a checkout matching native base ' +
          landing.expectedTarget +
          ', or apply any earlier reviewed patches in order, then run lillia result again.'
        );
      }
      return (
        saved +
        'Git could not check the current working tree. Check the saved patch against native base ' +
        landing.expectedTarget +
        ' before applying it.'
      );
    }
    const quoted = "'" + path.replaceAll("'", "'\"'\"'") + "'";
    return (
      saved +
      'This patch applies to the current working tree. To apply it from the project root, run\n' +
      'git apply --whitespace=nowarn -- ' +
      quoted
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function outputDirectory(config) {
  const output = config.outputDir;
  need(isAbsolute(output) && resolve(output) === output, 'Select an absolute output directory.');
  const workspace = await stat(await realpath(config.workspaceRoot));
  const ancestors = [];
  for (let p = output; ; p = dirname(p)) {
    ancestors.unshift(p);
    if (p === dirname(p)) break;
  }
  for (const path of ancestors) {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      info = await lstat(path);
    }
    need(info.isDirectory(), 'Output must use directories without symbolic links.');
    need(
      info.dev !== workspace.dev || info.ino !== workspace.ino,
      'Choose an output directory outside the working tree.'
    );
  }
  return output;
}

async function publish(config, goalId, bytes) {
  const directory = await outputDirectory(config);
  const path = join(directory, goalId + '.patch'),
    temporary = join(directory, '.patch-' + randomUUID());
  const temp = await open(temporary, 'wx', 0o600);
  try {
    await temp.writeFile(bytes);
    await temp.sync();
    // link publishes the complete file atomically and refuses to replace an existing destination.
    await outputDirectory(config);
    try {
      await link(temporary, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        const info = await file.stat();
        need(
          info.isFile() && info.size === bytes.length && (await file.readFile()).equals(bytes),
          'A different file already exists at ' + path + '.'
        );
      } finally {
        await file.close();
      }
    }
  } finally {
    await temp.close();
    await rm(temporary, { force: true });
  }
  return path;
}

export async function deliverResult({ goal: view, config, command, previewOnly = false }) {
  const { goal, projectChange: flow } = view;
  need(
    goal &&
      flow &&
      typeof goal.id === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(goal.id) &&
      flow.goalId === goal.id &&
      flow.input.repository === config.repository,
    'Select a reviewed goal from this project.'
  );
  if (goal.state !== 'completed' || flow.stage !== 'completed') {
    if (
      goal.state === 'blocked' &&
      flow.stage === 'blocked' &&
      flow.reviewerFinal?.decision === 'reject' &&
      flow.authorFinal?.decision === 'submit' &&
      flow.authorFinal.revisionId === flow.candidate &&
      flow.reviewerFinal.revisionId === flow.candidate
    ) {
      return (
        'Review rejected the change. ' + stripVTControlCharacters(flow.reviewerFinal.note ?? '')
      );
    }
    return 'No reviewed patch is ready. The goal is ' + goal.state + ' (' + flow.stage + ').';
  }
  const landing = reviewedLanding(view, config);
  const { receipt } = await command(['operation', 'show', flow.operationId]);
  const original = receipt?.projectChange;
  need(
    receipt?.goal?.id === goal.id &&
      receipt.operationId === flow.operationId &&
      original?.goalId === goal.id &&
      original.operationId === flow.operationId &&
      original.epoch === flow.epoch &&
      original.authorTaskId === flow.authorTaskId &&
      same(original.input, flow.input),
    'The saved admission belongs to different project work.'
  );
  return exportPatch(command, landing, config, previewOnly);
}
