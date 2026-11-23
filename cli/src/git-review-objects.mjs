import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const limit = 32 * 1024 * 1024;
const zero = '0'.repeat(40);
const refuse = (message) => Object.assign(new Error(message), { status: 409 });

async function inScratch(dataDir, work) {
  const parent = await lstat(dataDir);
  if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.mode & 0o077)
    throw refuse('Use a private review data directory');
  const dir = await mkdtemp(path.join(dataDir, 'git-review-'));
  function git(args, input, identity = {}) {
    const env = {
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      GIT_DIR: dir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: '',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_ALLOC_LIMIT: '64m',
      ...identity
    };
    return new Promise((ok, fail) => {
      const child = execFile(
        '/usr/bin/git',
        ['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', ...args],
        {
          env,
          cwd: dir,
          encoding: 'buffer',
          maxBuffer: limit,
          timeout: 15000,
          killSignal: 'SIGKILL'
        },
        (error, out) => {
          if (error)
            fail(
              Object.assign(
                refuse(
                  'Private Git ' +
                    args[0] +
                    ' refused this exact object or exceeded its execution limit'
                ),
                { gitExit: error.code }
              )
            );
          else ok(out);
        }
      );
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  try {
    await git(['init', '--quiet', '--bare', '--template=', '--object-format=sha1', dir]);
    async function load(bytes, oid, ref) {
      const file = path.join(dir, 'input.bundle');
      await writeFile(file, bytes);
      const output = (await git(['bundle', 'unbundle', file])).toString('utf8').trim();
      if (output !== oid + ' ' + ref)
        throw refuse('Retained Git bundle names a different revision or reference');
    }
    async function bundle(ref) {
      const out = path.join(dir, 'output.bundle');
      await git(['bundle', 'create', out, ref]);
      if ((await lstat(out)).size > limit) throw refuse('Review bundle exceeds 32 MiB');
      return readFile(out);
    }
    return await work(git, load, bundle);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function prepareMainBundle(
  dataDir,
  { target, targetBundle, targetRef, candidate, candidateBundle, candidateRef, parents }
) {
  return inScratch(dataDir, async (git, load, bundle) => {
    await load(targetBundle, target, targetRef);
    await git(['update-ref', 'refs/heads/main', target, zero]);
    if (candidate) {
      await load(candidateBundle, candidate, candidateRef);
      const observed = (await git(['show', '--no-patch', '--format=%P', candidate]))
        .toString()
        .trim();
      if ((parents ?? [target])[0] !== target || observed !== (parents ?? [target]).join(' '))
        throw refuse('Candidate is not a direct child of the reviewed target');
      await git(['update-ref', 'refs/heads/main', candidate, target]);
    }
    return bundle('refs/heads/main');
  });
}

export function writeSubmission(dataDir, { base, baseBundle, baseRef, edits, taskId, date }) {
  return inScratch(dataDir, async (git, load, bundle) => {
    await load(baseBundle, base, baseRef);
    await git(['read-tree', base]);
    for (const edit of edits) {
      if (edit.delete)
        await git(['update-index', '-z', '--index-info'], '0 ' + zero + '\t' + edit.path + '\0');
      else {
        edit.oid = (await git(['hash-object', '-w', '--stdin'], edit.bytes)).toString().trim();
        await git(['update-index', '--add', '--cacheinfo', edit.mode, edit.oid, edit.path]);
      }
    }
    const tree = (await git(['write-tree'])).toString().trim();
    const changes = (
      await git([
        'diff-tree',
        '--no-commit-id',
        '--no-renames',
        '--name-only',
        '-r',
        '-z',
        base,
        tree
      ])
    )
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .sort();
    if (JSON.stringify(changes) !== JSON.stringify(edits.map((e) => e.path).sort()))
      throw refuse('Git delta includes an empty or unapproved path change');
    const identity = {
      GIT_AUTHOR_NAME: 'Source task',
      GIT_AUTHOR_EMAIL: 'task@localhost.invalid',
      GIT_COMMITTER_NAME: 'Local review service',
      GIT_COMMITTER_EMAIL: 'review@localhost.invalid',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date
    };
    const commit = (
      await git(
        ['commit-tree', tree, '-p', base],
        Buffer.from('Retained submission for task ' + taskId + '\n'),
        identity
      )
    )
      .toString()
      .trim();
    const ref = 'refs/scion/retained/' + commit;
    await git(['update-ref', ref, commit, zero]);
    await git(['fsck', '--full', '--strict', '--no-dangling', '--no-reflogs', commit]);
    return { commit, tree, ref, bundle: await bundle(ref) };
  });
}

export function composeCandidate(
  dataDir,
  { base, target, targetBundle, submitted, submittedRef, submittedBundle, edits, revisionId, date }
) {
  return inScratch(dataDir, async (git, load, bundle) => {
    await load(targetBundle, target, 'refs/heads/main');
    await load(submittedBundle, submitted, submittedRef);
    const common = (
      await git(['merge-base', '--all', base, target]).catch((error) => {
        if (error.gitExit === 1) return Buffer.alloc(0);
        throw error;
      })
    )
      .toString()
      .trim();
    if (common !== base)
      return { conflict: 'The submitted base is not an ancestor of the current private target.' };
    await git(['read-tree', target]);
    for (const e of edits) {
      const entry = e.delete ? '0 ' + zero : e.mode + ' ' + e.oid;
      await git(['update-index', '-z', '--index-info'], entry + '\t' + e.path + '\0');
    }
    const tree = (await git(['write-tree'])).toString().trim();
    const diff = [
      'diff-tree',
      '--raw',
      '--no-commit-id',
      '--no-abbrev',
      '--no-renames',
      '-r',
      '-z'
    ];
    const reviewed = await git([...diff, base, submitted]);
    const composed = await git([...diff, target, tree]);
    if (!reviewed.equals(composed))
      return {
        conflict:
          'The target-relative Git delta differs from the reviewed old and new objects, paths or modes.'
      };
    const identity = {
      GIT_AUTHOR_NAME: 'Local integration service',
      GIT_AUTHOR_EMAIL: 'integration@localhost.invalid',
      GIT_COMMITTER_NAME: 'Local integration service',
      GIT_COMMITTER_EMAIL: 'integration@localhost.invalid',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date
    };
    const commit = (
      await git(
        ['commit-tree', tree, '-p', target, '-p', submitted],
        Buffer.from('Integrate reviewed revision ' + revisionId + '\n'),
        identity
      )
    )
      .toString()
      .trim();
    const ref = 'refs/scion/retained/' + commit;
    await git(['update-ref', ref, commit, zero]);
    await git(['fsck', '--full', '--strict', '--no-dangling', '--no-reflogs', commit]);
    return {
      commit,
      tree,
      ref,
      parents: [target, submitted],
      equivalence: 'identical-raw-file-delta-v1',
      bundle: await bundle(ref)
    };
  });
}
