import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  symlink,
  readdir,
  realpath
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { nativeFileId } from '../src/native-store.mjs';
import { deliverResult } from '../src/guided-result.mjs';

const base = '1'.repeat(64),
  candidate = '2'.repeat(64),
  goalId = 'goal-01',
  repository = 'demo';
async function fixture(t, patched = 'first\npatched\n') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'guided-result-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'work'),
    outputDir = join(root, 'exports');
  await mkdir(workspaceRoot);
  const input = {
    repository,
    base,
    version: 3,
    expectedGeneration: 2,
    policyDigest: 'policy',
    recipeId: 'recipe',
    objective: 'Update the example'
  };
  const authorFinal = {
    decision: 'submit',
    revisionId: candidate,
    evidence: { attemptId: 'a', taskId: 'author' }
  };
  const reviewerFinal = {
    decision: 'approve',
    revisionId: candidate,
    evidence: { attemptId: 'r', taskId: 'reviewer' }
  };
  const flow = {
    goalId,
    operationId: 'start-op',
    input,
    epoch: 'epoch',
    policyDigest: 'policy',
    authorTaskId: 'author',
    reviewerTaskId: 'reviewer',
    stage: 'completed',
    candidate,
    authorFinal,
    reviewerFinal
  };
  const criterion = { id: 'criterion', verifier: 'reviewed-project-change', evidence: [candidate] };
  const landing = {
    version: 1,
    goalId,
    operationId: 'project-land-' + goalId,
    repository,
    expectedTarget: base,
    candidate,
    expectedGeneration: 2,
    generation: 3,
    epoch: 'epoch',
    recipeId: 'recipe',
    policyDigest: 'policy',
    authorAttemptId: 'a',
    reviewerAttemptId: 'r'
  };
  const goal = {
    goal: { id: goalId, state: 'completed', version: 2, criteria: [criterion] },
    projectChange: flow,
    completion: {
      goalId,
      version: 2,
      policy: 'reviewed-project-v1',
      criteria: [criterion],
      evidence: [{ criterionId: 'criterion', landing }]
    }
  };
  const admission = {
    receipt: {
      operationId: 'start-op',
      goal: { id: goalId },
      projectChange: {
        ...structuredClone(flow),
        stage: 'author',
        candidate: base,
        reviewerTaskId: null,
        authorFinal: null,
        reviewerFinal: null
      }
    }
  };
  const changed = [
    ['src/a b.txt', 'first\nold\n', patched, '100644', '100644'],
    ['gone.txt', 'remove me', null, '100644', null],
    ['new file.txt', null, 'no trailing newline', null, '100644'],
    ['run.sh', 'exit 0\n', 'exit 0\n', '100644', '100755'],
    ['empty.txt', null, '', null, '100644']
  ];
  const files = new Map();
  const changes = [];
  for (const [path, before, after, oldMode, newMode] of changed) {
    const entry = (value, mode, revision) => {
      if (value === null) return null;
      const bytes = Buffer.from(value),
        fileId = nativeFileId(bytes);
      files.set(revision + path, { bytes, mode, fileId });
      return { path, mode, fileId };
    };
    changes.push({
      path,
      kind: before === null ? 'add' : after === null ? 'delete' : 'modify',
      before: entry(before, oldMode, base),
      after: entry(after, newMode, candidate)
    });
    if (before !== null) {
      const full = join(workspaceRoot, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, before);
    }
  }
  const command = async (args) => {
    if (args[0] === 'operation') {
      assert.deepEqual(args, ['operation', 'show', 'start-op']);
      return admission;
    }
    const [family, verb, repo, name, revisionId, ref, ...rest] = args;
    assert.equal(family, 'native');
    assert.equal(repo, repository);
    assert.equal(name, 'mainline');
    if (verb === 'diff') {
      assert.equal(revisionId, candidate);
      assert.equal(ref, base);
      const second = rest.includes('--cursor');
      return {
        repository: repo,
        name,
        revisionId,
        base,
        changes: second ? changes.slice(2) : changes.slice(0, 2),
        cursor: second ? null : 'second'
      };
    }
    assert.equal(verb, 'file');
    const { bytes, mode, fileId } = files.get(revisionId + ref);
    const n = rest.indexOf('--offset'),
      offset = n === -1 ? 0 : Number(rest[n + 1]),
      end = Math.min(offset + 6, bytes.length);
    return {
      repository: repo,
      name,
      revisionId,
      path: ref,
      mode,
      fileId,
      base64: bytes.subarray(offset, end).toString('base64'),
      offset,
      total: bytes.length,
      nextOffset: end === bytes.length ? null : end
    };
  };
  return {
    config: { workspaceRoot, repository, outputDir },
    goal,
    command,
    changes,
    admission,
    landing,
    patch: join(outputDir, goalId + '.patch'),
    root
  };
}

test('exports reviewed bytes, additions, deletions and modes as a reproducible Git patch', async (t) => {
  const f = await fixture(t),
    { workspaceRoot } = f.config;
  assert.ok((await deliverResult(f)).includes(f.patch));
  execFileSync('/usr/bin/git', ['apply', '--check', f.patch], { cwd: workspaceRoot });
  assert.equal(await readFile(join(workspaceRoot, 'src/a b.txt'), 'utf8'), 'first\nold\n');
  const original = await stat(f.patch);
  await deliverResult(f);
  assert.equal((await stat(f.patch)).ino, original.ino);
  execFileSync('/usr/bin/git', ['apply', f.patch], { cwd: workspaceRoot });
  assert.equal(await readFile(join(workspaceRoot, 'new file.txt'), 'utf8'), 'no trailing newline');
  assert.equal((await stat(join(workspaceRoot, 'run.sh'))).mode & 0o111, 0o111);
  assert.equal((await stat(join(workspaceRoot, 'empty.txt'))).size, 0);
  await assert.rejects(stat(join(workspaceRoot, 'gone.txt')), { code: 'ENOENT' });
});
test('rejected and unfinished goals explain their state without exporting', async (t) => {
  const f = await fixture(t);
  f.command = () => assert.fail('unexpected content read');
  f.goal.projectChange.stage = 'blocked';
  f.goal.goal.state = 'blocked';
  f.goal.completion = null;
  Object.assign(f.goal.projectChange.reviewerFinal, {
    decision: 'reject',
    note: 'The count is wrong.'
  });
  assert.match(await deliverResult(f), /The count is wrong/);
  f.goal.goal.state = 'active';
  f.goal.projectChange.stage = 'author';
  f.goal.projectChange.reviewerFinal = null;
  assert.match(await deliverResult(f), /author|progress|ready|review/i);
  await assert.rejects(stat(f.config.outputDir), { code: 'ENOENT' });
});
test('rejects mismatched landing, admission, returned source identity, and unsafe output', async (t) => {
  const f = await fixture(t);
  f.landing.expectedTarget = candidate;
  await assert.rejects(deliverResult(f));
  f.landing.expectedTarget = base;
  f.admission.receipt.projectChange.input.base = candidate;
  await assert.rejects(deliverResult(f));
  f.admission.receipt.projectChange.input.base = base;
  const command = f.command;
  f.command = async (args) => {
    const res = await command(args);
    return args[1] === 'file' ? { ...res, fileId: '0'.repeat(64) } : res;
  };
  await assert.rejects(deliverResult(f));
  f.command = command;
  await mkdir(f.config.outputDir, { recursive: true });
  await writeFile(f.patch, 'existing');
  await assert.rejects(deliverResult(f));
  assert.equal(await readFile(f.patch, 'utf8'), 'existing');
  await rm(f.patch);
  const outside = join(f.root, 'outside');
  await writeFile(outside, 'untouched');
  await symlink(outside, f.patch);
  await assert.rejects(deliverResult(f));
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
  await rm(f.patch);
  await rm(f.config.outputDir, { recursive: true });
  await symlink(f.config.workspaceRoot, f.config.outputDir);
  await assert.rejects(deliverResult(f));
  assert.ok(!(await readdir(f.config.workspaceRoot)).includes(goalId + '.patch'));
});

test('concurrent exports agree on one complete patch', async (t) => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([deliverResult(f), deliverResult(f)]);
  assert.equal(first, second);
  assert.deepEqual(await readdir(f.config.outputDir), [goalId + '.patch']);
  execFileSync('/usr/bin/git', ['apply', '--check', f.patch], { cwd: f.config.workspaceRoot });
});

test('refuses unsafe paths and corrupt bytes before publishing', async (t) => {
  const f = await fixture(t);
  const command = f.command;
  f.command = async (args) => {
    const page = await command(args);
    if (args[1] !== 'file' || !page.base64) return page;
    const bytes = Buffer.from(page.base64, 'base64');
    bytes[0] ^= 1;
    return { ...page, base64: bytes.toString('base64') };
  };
  await assert.rejects(deliverResult(f), /Retained bytes/);
  f.command = command;
  f.changes[0].path = '../outside';
  await assert.rejects(deliverResult(f), /path/);
  f.changes[0].path = f.changes[0].after.path;
  f.config.outputDir = join(f.config.workspaceRoot, 'exports');
  await assert.rejects(deliverResult(f), /working tree/);
  await assert.rejects(stat(f.config.outputDir), { code: 'ENOENT' });
});

test('rechecks the current working tree on every export and preserves the exact reviewed patch', async (t) => {
  const f = await fixture(t);
  const cwd = f.config.workspaceRoot;
  execFileSync('/usr/bin/git', ['init', '--quiet', '--template='], { cwd });
  const first = await deliverResult(f);
  assert.match(first, /applies to the current working tree/i);
  assert.match(first, /git apply --whitespace=nowarn -- /);
  const reviewed = await readFile(f.patch);
  const file = join(cwd, 'src/a b.txt');
  await writeFile(file, 'first\nworking copy changed\n');
  const second = await deliverResult(f);
  assert.match(second, /does not apply to the current working tree/i);
  assert.ok(second.includes(base));
  assert.match(second, /earlier reviewed patches/i);
  assert.equal(await readFile(file, 'utf8'), 'first\nworking copy changed\n');
  assert.ok(second.includes(f.patch));
  assert.deepEqual(await readFile(f.patch), reviewed);
  await writeFile(file, 'first\nold\n');
  assert.match(await deliverResult(f), /applies to the current working tree/i);
});

test('previews the verified change without writing an output directory', async (t) => {
  const f = await fixture(t);
  const preview = await deliverResult({ ...f, previewOnly: true });
  assert.match(preview, /diff --git/);
  assert.match(preview, /\+patched/);
  await assert.rejects(stat(f.config.outputDir), {code: 'ENOENT'});
});

test('a long preview never ends partway through a multi-byte character', async (t) => {
  // Two-byte characters with both alignments guarantee one run lands the cut inside a character.
  for (const pad of ['', 'x']) {
    const f = await fixture(t, 'first\n' + pad + 'é'.repeat(4000) + '\n');
    const preview = await deliverResult({ ...f, previewOnly: true });
    assert.match(preview, /Preview ends here/);
    assert.ok(!preview.includes('\uFFFD'), 'preview contains a replacement character');
  }
});
