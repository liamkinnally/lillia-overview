import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

const MiB = 1024 * 1024;
const maxTreeBytes = 24 * MiB;
const objectId = /^[a-f0-9]{40}$/;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const hash = (data) => createHash('sha256').update(data).digest('hex');
const issue = (message, status = 409) => Object.assign(new Error(message), { status });
function need(condition, message, status = 409) {
  if (!condition) throw issue(message, status);
}
function safePath(p) {
  need(
    typeof p === 'string' &&
      p.length &&
      p.length <= 8192 &&
      !p.includes('\0') &&
      p.split('/').every((s) => s && s !== '.' && s !== '..' && s.toLowerCase() !== '.git'),
    'Unsupported repository pathname'
  );
  return p;
}
function decode(buffer) {
  try {
    return decoder.decode(buffer);
  } catch {
    throw issue('Non-UTF-8 pathnames or control metadata are unsupported');
  }
}
function nulRows(bytes) {
  if (!bytes.length) return [];
  need(bytes.at(-1) === 0, 'Truncated Git record');
  return decode(bytes.subarray(0, -1)).split('\0');
}
async function maybeStat(p) {
  try {
    return await lstat(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function readControl(file, max, optional = false) {
  // Darwin checks every ancestor atomically. The initial supported registration host is macOS.
  let fd;
  try {
    fd = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000);
    const stat = await fd.stat();
    need(
      stat.isFile() && stat.nlink === 1 && stat.size <= max,
      'Unsupported Git control file type or size'
    );
    const bytes = Buffer.alloc(stat.size + 1);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await fd.read(bytes, position, bytes.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    need(position === stat.size, 'Repository changed during capture. Retry registration.');
    return bytes.subarray(0, position);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error.status) throw error;
    throw issue('Unable to safely read Git control data (' + (error.code ?? 'read error') + ').');
  } finally {
    await fd?.close();
  }
}

async function headAt(gitDir) {
  const head = decode(await readControl(path.join(gitDir, 'HEAD'), 8192)).replace(/\r?\n$/, '');
  if (objectId.test(head)) return { branch: null, revision: head };
  need(
    head.startsWith('ref: refs/heads/'),
    'Unborn HEAD or non-branch symbolic reference is unsupported'
  );
  const ref = head.slice(5);
  safePath(ref);
  need(
    !/[\x00-\x20~^:?*\[\\]/.test(ref) &&
      !ref.includes('..') &&
      !ref.includes('@{') &&
      !ref.endsWith('.') &&
      ref.split('/').every((s) => !s.startsWith('.') && !s.endsWith('.lock')),
    'Invalid branch reference'
  );
  const loose = await readControl(path.join(gitDir, ref), 128, true);
  let revision = loose && decode(loose).trimEnd();
  if (!loose) {
    const packed = await readControl(path.join(gitDir, 'packed-refs'), 2 * MiB, true);
    const line =
      packed &&
      decode(packed)
        .split('\n')
        .find((line) => line.slice(41) === ref);
    revision = line?.slice(0, 40);
  }
  need(objectId.test(revision ?? ''), 'The registered root must have a committed SHA-1 HEAD');
  return { branch: ref.slice('refs/heads/'.length), revision };
}

function invoke(dir, work, args, { input, limit = 2 * MiB, date } = {}) {
  return new Promise((ok, fail) => {
    const env = {
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: '',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_ALLOC_LIMIT: '64m',
      GIT_DIR: dir
    };
    if (work) env.GIT_WORK_TREE = work;
    if (date)
      Object.assign(env, {
        GIT_AUTHOR_NAME: 'Working copy capture',
        GIT_AUTHOR_EMAIL: 'capture@localhost.invalid',
        GIT_COMMITTER_NAME: 'Local capture service',
        GIT_COMMITTER_EMAIL: 'capture@localhost.invalid',
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date
      });
    const safe = [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'core.attributesFile=/dev/null',
      '-c',
      'core.excludesFile=/dev/null',
      '-c',
      'gc.auto=0'
    ];
    const child = execFile(
      '/usr/bin/git',
      [...safe, ...args],
      {
        env,
        cwd: dir,
        encoding: 'buffer',
        timeout: 15000,
        killSignal: 'SIGKILL',
        maxBuffer: limit
      },
      (err, stdout) => {
        if (err)
          return fail(
            issue(
              'Git ' +
                args[0] +
                ' failed or exceeded the bounded capture limits. Check repository integrity and supported format.'
            )
          );
        ok(stdout);
      }
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function copyObjects(gitDir, privateDir) {
  let bytes = 0,
    files = 0;
  async function visit(relative) {
    const src = path.join(gitDir, 'objects', relative);
    need(
      (await lstat(src)).isDirectory() && (await realpath(src)) === src,
      'Symlinked object directories are unsupported'
    );
    for await (const e of await opendir(src)) {
      need(++files <= 8192, 'Object inventory exceeds 8,192 entries');
      const name = e.name;
      if (!relative) {
        if (/^[a-f0-9]{2}$/.test(name) || name === 'pack') {
          need(e.isDirectory(), 'Invalid Git object directory');
          await mkdir(path.join(privateDir, 'objects', name), { recursive: true });
          await visit(name);
        } else need(name === 'info' && e.isDirectory(), 'Unsupported Git object storage');
        continue;
      }
      if (relative === 'pack') {
        need(!name.endsWith('.promisor'), 'Partial clones are unsupported');
        if (!/^pack-[a-f0-9]{40}\.(idx|pack)$/.test(name)) continue;
      } else need(/^[a-f0-9]{38}$/.test(name), 'Unsupported loose object entry');
      need(e.isFile(), 'Symlinks in the Git object store are unsupported');
      const data = await readControl(path.join(src, name), Math.min(32 * MiB, 64 * MiB - bytes));
      bytes += data.length;
      await writeFile(path.join(privateDir, 'objects', relative, name), data, { flag: 'wx' });
    }
  }
  await visit('');
}

async function inventory(gitDir, root, head) {
  const opts = { limit: 4 * MiB };
  const staged = nulRows(await invoke(gitDir, null, ['ls-files', '--stage', '-v', '-z'], opts));
  need(staged.length <= 8192, 'Index exceeds 8,192 entries');
  for (const item of staged) {
    const tab = item.indexOf('\t');
    need(tab > 0, 'Malformed Git index');
    safePath(item.slice(tab + 1));
    // ls-files -v lowercases assume-unchanged entries. S marks
    // skip-worktree, including lowercase s when both flags are present.
    const tag = item[0];
    need(
      tag !== 'S' && tag !== 's',
      'Working-tree status is unknown: skip-worktree index entries are unsupported.'
    );
    need(
      !/[a-z]/.test(tag),
      'Working-tree status is unknown: assume-unchanged index entries are unsupported.'
    );
  }
  const rows = nulRows(
    await invoke(
      gitDir,
      root,
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--no-renames',
        '--ignored=matching',
        '--untracked-files=all',
        '--ignore-submodules=all'
      ],
      opts
    )
  );
  need(rows.length <= 8192, 'Status exceeds 8,192 entries');
  const entries = [];
  for (const row of rows) {
    need(row[2] === ' ' && row.length > 3, 'Malformed Git inventory');
    const name = safePath(row.slice(3).replace(/\/$/, ''));
    const directory = row.endsWith('/');
    const nested = directory && Boolean(await maybeStat(path.join(root, name, '.git')));
    entries.push({ path: name, index: row[0], worktree: row[1], directory, nested });
  }
  return {
    ...head,
    entries,
    dirty: entries.some((row) => row.index !== '!'),
    scope: 'committed-HEAD',
    limitations: [
      'Working-tree status is a live scan. The retained revision excludes dirty, untracked and ignored bytes.',
      'Git uses built-in transformations and repository ignore files. User/global configuration, external filters, and custom diff drivers are disabled.',
      'Ignored directories may be grouped. Nested repositories and submodule working trees are not traversed.'
    ]
  };
}

async function checkUntrackedIgnore(dir, root, config, file) {
  const raw = path.join(dir, 'owner-config-for-inspection');
  await writeFile(raw, config);
  // Never execute commands against the owner's Git directory. The config builtin
  // checks include/exclude directives without following includes from the repository.
  const env = {
    HOME: homedir(),
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C',
    GIT_DIR: dir,
    GIT_WORK_TREE: root,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ALLOW_PROTOCOL: ''
  };
  if (process.env.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'])
    if (process.env[key]) env[key] = process.env[key];
  const matches = (args) =>
    new Promise((ok, fail) => {
      execFile(
        '/usr/bin/git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.untrackedCache=false',
          ...args
        ],
        { cwd: root, env, timeout: 5000, maxBuffer: MiB },
        (error) => {
          if (!error || error.code === 1) ok(!error);
          else fail(issue('The effective Git ignore rules could not be verified'));
        }
      );
    });
  const includes = '^(include|includeif\\..*)\\.path$';
  need(
    !(await matches([
      'config',
      '--file',
      raw,
      '--no-includes',
      '--name-only',
      '--get-regexp',
      includes + '|^core\\.excludesfile$'
    ])),
    'Repository includes or custom excludes require an explicit ignore-policy capture'
  );
  need(
    !(await matches([
      'config',
      '--no-includes',
      '--name-only',
      '--get-regexp',
      includes + '|^core\\.excludesfile$'
    ])),
    'Conditional, included or custom ignore-policy configuration prevents verified untracked capture'
  );
  need(
    !(await matches(['check-ignore', '--no-index', '--', file])),
    'The selected untracked file is ignored'
  );
}

function textBlob(bytes) {
  if (bytes.includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}
function lines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function installGitProject(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS git_revisions(revision TEXT PRIMARY KEY,project TEXT NOT NULL,retentionRef TEXT NOT NULL,bundle BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS git_blobs(oid TEXT PRIMARY KEY,bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS git_paths(revision TEXT NOT NULL REFERENCES git_revisions(revision),path TEXT NOT NULL,mode TEXT NOT NULL,oid TEXT NOT NULL,
      PRIMARY KEY(revision,path));
    CREATE TABLE IF NOT EXISTS git_captures(id TEXT PRIMARY KEY,revision TEXT NOT NULL REFERENCES git_revisions(revision),metadata TEXT NOT NULL);
  `);
}

export class GitProject {
  #prepared = new WeakMap();
  constructor(store, { dataDir, workspaceRoot }) {
    this.db = store.db;
    this.dataDir = dataDir;
    this.workspaceRoot = workspaceRoot;
  }

  prepareRegistration() {
    return this.#inspect();
  }

  inspectWorkingPath(base, file) {
    this.#checkRevision(base);
    safePath(file);
    return this.#inspect({ base, file });
  }

  async #inspect(selection) {
    need(process.platform === 'darwin', 'Read-only Git registration currently supports macOS');
    const root = await realpath(this.workspaceRoot),
      data = await realpath(this.dataDir);
    need(
      root !== data && !root.startsWith(data + '/') && !data.startsWith(root + '/'),
      'Use a private data directory outside the registered project'
    );
    const privateInfo = await lstat(data);
    need(
      privateInfo.uid === process.getuid() && (privateInfo.mode & 0o077) === 0,
      'Use an owner-private data directory'
    );
    const origin = path.join(root, '.git'),
      identity = await maybeStat(origin);
    need(
      identity?.isDirectory(),
      'Expected a .git directory; linked worktrees and non-repository roots are unsupported.'
    );
    for (const rel of [
      'objects/info/alternates',
      'objects/info/http-alternates',
      'info/grafts',
      'shallow',
      'commondir',
      'info/sparse-checkout',
      'config.worktree'
    ]) {
      need(!(await maybeStat(path.join(origin, rel))), 'Unsupported Git layout: ' + rel);
    }
    const config = decode(await readControl(path.join(origin, 'config'), MiB));
    need(
      !/^\s*\[extensions(?:\s|\])/im.test(config),
      'Git repository format extensions are unsupported'
    );
    const head = await headAt(origin);
    const index = await readControl(path.join(origin, 'index'), 4 * MiB, true);
    const projectId = 'git-project-v1-' + hash(JSON.stringify([root, identity.dev, identity.ino]));
    async function verifyOwner() {
      const currentIdentity = await lstat(origin);
      need(
        currentIdentity.dev === identity.dev && currentIdentity.ino === identity.ino,
        'Repository directory changed during registration'
      );
      const checkHead = await headAt(origin),
        checkIndex = await readControl(path.join(origin, 'index'), 4 * MiB, true);
      need(
        head.branch === checkHead.branch &&
          head.revision === checkHead.revision &&
          (index === null ? checkIndex === null : checkIndex && index.equals(checkIndex)),
        'Owner HEAD or index changed during inventory. Retry registration.'
      );
    }
    const temp = await mkdtemp(path.join(data, 'git-inspect-'));
    try {
      await invoke(temp, null, ['init', '--bare', '--template=', '--object-format=sha1', temp]);
      await copyObjects(origin, temp);
      await writeFile(path.join(temp, 'HEAD'), head.revision + '\n');
      if (index) await writeFile(path.join(temp, 'index'), index);
      const exclude = await readControl(path.join(origin, 'info/exclude'), MiB, true);
      if (exclude) {
        await mkdir(path.join(temp, 'info'), { recursive: true });
        await writeFile(path.join(temp, 'info/exclude'), exclude);
      }
      const type = decode(await invoke(temp, null, ['cat-file', '-t', head.revision])).trim();
      need(type === 'commit', 'HEAD is not a commit');
      const state = await inventory(temp, root, head);
      state.indexDigest = index ? hash(index) : null;
      if (selection) {
        const { file, base } = selection;
        need(
          head.revision === base &&
            this.db
              .prepare(
                'SELECT 1 FROM git_captures c JOIN git_revisions r ON r.revision=c.revision WHERE c.revision=? AND r.project=?'
              )
              .get(base, projectId),
          'Select the exact currently registered owner HEAD'
        );
        const rows = nulRows(
          await invoke(temp, null, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', file])
        );
        const stages = rows
          .filter((row) => row.slice(row.indexOf('\t') + 1) === file)
          .map((row) => row.slice(0, row.indexOf('\t')).split(' '));
        need(
          stages.length <= 1 &&
            stages.every(
              ([mode, oid, stage]) =>
                ['100644', '100755'].includes(mode) && objectId.test(oid) && stage === '0'
            ),
          'Unmerged, symlink and gitlink index entries cannot be captured'
        );
        const status = state.entries.filter((e) => e.path === file);
        need(
          !state.entries.some(
            (e) =>
              (e.index === '!' || e.nested) && (e.path === file || file.startsWith(e.path + '/'))
          ),
          'Ignored and nested repository paths cannot be captured'
        );
        const baseEntry = this.db
          .prepare('SELECT mode,oid FROM git_paths WHERE revision=? AND path=?')
          .get(base, file);
        need(
          !baseEntry || ['100644', '100755'].includes(baseEntry.mode),
          'Symlink and gitlink base entries are outside this capture profile'
        );
        if (!stages.length) {
          need(
            status.some((e) => e.index === '?'),
            'Unindexed selection is not a verified nonignored working file'
          );
          await checkUntrackedIgnore(temp, root, config, file);
        }
        let stage = null,
          stageBytes = null;
        if (stages.length) {
          const [mode, oid] = stages[0];
          stageBytes = await invoke(temp, null, ['cat-file', 'blob', oid], { limit: MiB });
          stage = { mode, oid, sha256: hash(stageBytes), bytes: stageBytes.length };
        }
        await verifyOwner();
        return {
          root,
          projectId,
          base,
          branch: head.branch,
          indexDigest: state.indexDigest,
          baseEntry: baseEntry ? { ...baseEntry } : null,
          stage,
          stageBytes,
          status
        };
      }
      const ref = 'refs/scion/retained/' + head.revision;
      await invoke(temp, null, ['update-ref', ref, head.revision, '0'.repeat(40)]);
      await invoke(
        temp,
        null,
        ['fsck', '--full', '--strict', '--no-dangling', '--no-reflogs', head.revision],
        { limit: MiB }
      );
      const pack = await invoke(temp, null, ['pack-objects', '--revs', '--stdout', '--threads=1'], {
        input: head.revision + '\n',
        limit: 32 * MiB
      });
      const bundle = Buffer.concat([
        Buffer.from('# v2 git bundle\n' + head.revision + ' ' + ref + '\n\n'),
        pack
      ]);
      const tree = nulRows(
        await invoke(temp, null, ['ls-tree', '--full-tree', '-rz', head.revision], {
          limit: 4 * MiB
        })
      );
      need(tree.length <= 8192, 'Committed tree exceeds 8,192 paths');
      const entries = tree.map((row) => {
        const tab = row.indexOf('\t'),
          [mode, type, oid] = row.slice(0, tab).split(' ');
        need(
          tab > 0 &&
            objectId.test(oid) &&
            ((['100644', '100755', '120000'].includes(mode) && type === 'blob') ||
              (mode === '160000' && type === 'commit')),
          'Unsupported committed tree entry'
        );
        return { path: safePath(row.slice(tab + 1)), mode, oid };
      });
      const ids = [...new Set(entries.filter((e) => e.mode !== '160000').map((e) => e.oid))],
        blobs = new Map();
      if (ids.length) {
        const raw = await invoke(temp, null, ['cat-file', '--batch'], {
          input: ids.join('\n') + '\n',
          limit: maxTreeBytes
        });
        let at = 0;
        for (const id of ids) {
          const end = raw.indexOf(10, at);
          need(end >= at, 'Incomplete blob batch');
          const [oid, kind, sizeText] = raw.toString('ascii', at, end).split(' '),
            size = Number(sizeText);
          need(
            oid === id &&
              kind === 'blob' &&
              Number.isSafeInteger(size) &&
              size >= 0 &&
              size <= 4 * MiB &&
              raw[end + 1 + size] === 10,
            'Invalid or oversized committed blob (4 MiB limit)'
          );
          blobs.set(id, raw.subarray(end + 1, end + 1 + size));
          at = end + size + 2;
        }
        need(at === raw.length, 'Unexpected blob batch trailer');
      }
      const logicalBytes = entries.reduce((sum, e) => sum + (blobs.get(e.oid)?.length ?? 0), 0);
      need(logicalBytes <= maxTreeBytes, 'Logical committed tree exceeds the 24 MiB scan limit');
      await verifyOwner();
      const captureId = 'git-capture-v1-' + hash(JSON.stringify([projectId, state]));
      const token = Object.freeze({ projectId, captureId, revision: head.revision });
      this.#prepared.set(token, { state, ref, bundle, entries, blobs });
      return token;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  async prepareWorkingRevision({
    base,
    projectId,
    file,
    mode,
    bytes,
    files = [{ file, mode, bytes }],
    previewDigest,
    date
  }) {
    this.#checkRevision(base);
    need(
      files.length >= 1 && files.length <= 8 && /^[a-f0-9]{64}$/.test(previewDigest),
      'Unsupported working selection'
    );
    const source = this.db
      .prepare('SELECT project,retentionRef,bundle FROM git_revisions WHERE revision=?')
      .get(base);
    need(source.project === projectId, 'Working source belongs to another project');
    const entries = this.db
      .prepare(
        'SELECT p.path,p.mode,p.oid,length(b.bytes) AS size FROM git_paths p LEFT JOIN git_blobs b ON b.oid=p.oid WHERE p.revision=?'
      )
      .all(base);
    const selected = new Set(files.map((x) => x.file));
    const allPaths = new Set([...entries.map((x) => x.path), ...selected]);
    need(
      selected.size === files.length && allPaths.size <= 8192,
      'Working snapshot exceeds project capacity'
    );
    let total = entries.reduce((n, e) => n + (selected.has(e.path) ? 0 : (e.size ?? 0)), 0);
    for (const item of files) {
      safePath(item.file);
      need(
        Buffer.isBuffer(item.bytes) &&
          item.bytes.length <= MiB &&
          ['100644', '100755'].includes(item.mode),
        'Unsupported capture bytes or mode'
      );
      const key = item.file.toLowerCase();
      need(
        ![...allPaths].some(
          (p) =>
            p !== item.file &&
            (p.toLowerCase() === key ||
              p.toLowerCase().startsWith(key + '/') ||
              key.startsWith(p.toLowerCase() + '/'))
        ),
        'The selected path collides with a retained file, gitlink or directory'
      );
      total += item.bytes.length;
    }
    need(total <= maxTreeBytes, 'Working snapshot exceeds project capacity');
    const dir = await mkdtemp(path.join(this.dataDir, 'git-working-'));
    try {
      await invoke(dir, null, ['init', '--bare', '--template=', '--object-format=sha1', dir]);
      await writeFile(path.join(dir, 'base.bundle'), source.bundle);
      const loaded = decode(
        await invoke(dir, null, ['bundle', 'unbundle', path.join(dir, 'base.bundle')])
      ).trim();
      need(loaded === base + ' ' + source.retentionRef, 'Retained source bundle binding changed');
      await invoke(dir, null, ['read-tree', base]);
      const oids = [],
        changed = [];
      for (const item of files) {
        const oid = decode(
          await invoke(dir, null, ['hash-object', '-w', '--stdin'], { input: item.bytes })
        ).trim();
        oids.push(oid);
        const old = entries.find((e) => e.path === item.file);
        if (old?.mode === item.mode && old.oid === oid) continue;
        changed.push(item.file);
        await invoke(dir, null, [
          'update-index',
          '--add',
          '--cacheinfo',
          item.mode,
          oid,
          item.file
        ]);
      }
      const oid = oids[0];
      if (!changed.length) return { revision: base, oid, oids, ref: source.retentionRef };
      const tree = decode(await invoke(dir, null, ['write-tree'])).trim();
      const actual = nulRows(
        await invoke(dir, null, [
          'diff-tree',
          '--no-commit-id',
          '--no-renames',
          '--name-only',
          '-r',
          '-z',
          base,
          tree
        ])
      );
      need(
        actual.length === changed.length && actual.every((p) => changed.includes(p)),
        'Working snapshot changes paths outside its verified selection'
      );
      const revision = decode(
        await invoke(dir, null, ['commit-tree', tree, '-p', base], {
          date,
          input: 'Capture selected working file ' + previewDigest + '\n'
        })
      ).trim();
      const ref = 'refs/scion/retained/' + revision;
      await invoke(dir, null, ['update-ref', ref, revision, '0'.repeat(40)]);
      await invoke(dir, null, [
        'fsck',
        '--full',
        '--strict',
        '--no-dangling',
        '--no-reflogs',
        revision
      ]);
      const pack = await invoke(dir, null, ['pack-objects', '--revs', '--stdout', '--threads=1'], {
        input: revision + '\n',
        limit: 32 * MiB
      });
      return {
        revision,
        ref,
        oid,
        oids,
        bundle: Buffer.concat([
          Buffer.from('# v2 git bundle\n' + revision + ' ' + ref + '\n\n'),
          pack
        ])
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  register(token) {
    const captured = this.#prepared.get(token);
    need(
      captured && this.db.isTransaction,
      'Registration requires a prepared capture and a writer transaction'
    );
    const { state, ref, bundle, entries, blobs } = captured;
    const prior = this.db
      .prepare('SELECT metadata FROM git_captures WHERE id=?')
      .get(token.captureId);
    if (prior) return JSON.parse(prior.metadata);
    const registered = this.db.prepare('SELECT project FROM git_revisions LIMIT 1').get();
    need(
      !registered || registered.project === token.projectId,
      'The registered Git directory was replaced. Use a separate data directory.'
    );
    const existing = this.db
      .prepare('SELECT project FROM git_revisions WHERE revision=?')
      .get(token.revision);
    if (existing)
      need(existing.project === token.projectId, 'Revision belongs to a different registered root');
    else {
      this.db
        .prepare('INSERT INTO git_revisions VALUES(?,?,?,?)')
        .run(token.revision, token.projectId, ref, bundle);
      const addBlob = this.db.prepare('INSERT OR IGNORE INTO git_blobs VALUES(?,?)');
      for (const [id, bytes] of blobs) addBlob.run(id, bytes);
      const addPath = this.db.prepare('INSERT INTO git_paths VALUES(?,?,?,?)');
      for (const e of entries) addPath.run(token.revision, e.path, e.mode, e.oid);
    }
    const result = {
      ...token,
      retentionRef: ref,
      inventory: state,
      paths: entries.length,
      submodules: entries.filter((e) => e.mode === '160000').map((e) => e.path),
      symlinks: entries.filter((e) => e.mode === '120000').map((e) => e.path),
      nonTextPaths: entries
        .filter((e) => e.mode.startsWith('100') && textBlob(blobs.get(e.oid)) === null)
        .map((e) => e.path)
    };
    this.db
      .prepare('INSERT INTO git_captures VALUES(?,?,?)')
      .run(token.captureId, token.revision, JSON.stringify(result));
    return result;
  }

  capture({ captureId }) {
    need(
      typeof captureId === 'string' && /^git-capture-v1-[a-f0-9]{64}$/.test(captureId),
      'Invalid capture identity',
      400
    );
    const row = this.db.prepare('SELECT metadata FROM git_captures WHERE id=?').get(captureId);
    need(row, 'Capture has not been retained', 404);
    return JSON.parse(row.metadata);
  }

  status({ limit = 20 } = {}) {
    need(
      Number.isInteger(limit) && limit >= 1 && limit <= 100,
      'Expected a page size from 1 to 100',
      400
    );
    const captures = this.db
      .prepare('SELECT metadata FROM git_captures ORDER BY rowid DESC LIMIT ?')
      .all(limit)
      .map((row) => {
        const { projectId, captureId, revision, retentionRef, inventory, paths } = JSON.parse(
          row.metadata
        );
        return {
          projectId,
          captureId,
          revision,
          retentionRef,
          branch: inventory.branch,
          dirty: inventory.dirty,
          paths
        };
      });
    return { captures };
  }

  #checkRevision(revision) {
    need(
      typeof revision === 'string' && objectId.test(revision),
      'Expected a retained immutable SHA-1 revision',
      400
    );
    need(
      this.db.prepare('SELECT 1 FROM git_revisions WHERE revision=?').get(revision),
      'Revision has not been retained',
      404
    );
  }

  search({ revision, query, mode = 'text', limit = 20, after = 0 }) {
    this.#checkRevision(revision);
    need(
      ['path', 'text'].includes(mode) &&
        typeof query === 'string' &&
        query.length > 0 &&
        query.length <= 1024 &&
        Number.isInteger(limit) &&
        limit > 0 &&
        limit <= 100 &&
        Number.isSafeInteger(after) &&
        after >= 0,
      'Invalid bounded literal search',
      400
    );
    const results = [];
    let seen = 0,
      more = false;
    const rows = this.db
      .prepare('SELECT path,mode,oid FROM git_paths WHERE revision=? ORDER BY path')
      .iterate(revision);
    const getBlob = this.db.prepare('SELECT bytes FROM git_blobs WHERE oid=?');
    const add = (row) => {
      if (++seen <= after) return true;
      if (results.length === limit) {
        more = true;
        return false;
      }
      results.push({ ...row, revision, startLine: row.line, endLine: row.line });
      return true;
    };
    for (const e of rows) {
      if (mode === 'path') {
        if (e.path.includes(query) && !add({ ...e, line: null })) break;
        continue;
      }
      if (e.mode !== '100644' && e.mode !== '100755') continue;
      const content = textBlob(getBlob.get(e.oid).bytes);
      if (content === null) continue;
      let start = 0,
        line = 1;
      while (start < content.length) {
        const newline = content.indexOf('\n', start),
          end = newline < 0 ? content.length : newline;
        const body = content.slice(start, end),
          at = body.indexOf(query);
        if (at >= 0 && !add({ ...e, line, snippet: body.slice(Math.max(0, at - 100), at + 240) }))
          break;
        start = end + 1;
        line++;
      }
      if (more) break;
    }
    return {
      revision,
      indexGeneration: revision,
      mode,
      scope: mode === 'text' ? 'UTF-8 regular files' : 'all committed paths',
      results,
      cursor: more ? after + results.length : null
    };
  }

  file({ revision, path: file, offset = 0, limit = 65536 }) {
    this.#checkRevision(revision);
    safePath(file);
    need(
      Number.isSafeInteger(offset) &&
        offset >= 0 &&
        Number.isSafeInteger(limit) &&
        limit >= 1 &&
        limit <= 262144,
      'Invalid byte range',
      400
    );
    const row = this.db
      .prepare(
        `SELECT p.mode,p.oid,b.bytes FROM git_paths p LEFT JOIN git_blobs b ON b.oid=p.oid
      WHERE p.revision=? AND p.path=?`
      )
      .get(revision, file);
    need(row, 'No retained file at this revision and path', 404);
    need(row.mode !== '160000', 'A gitlink identifies a separate repository');
    need(row.bytes != null, 'The retained file object is missing');
    const bytes = Buffer.from(row.bytes);
    const oid = createHash('sha1')
      .update('blob ' + bytes.length + '\0')
      .update(bytes)
      .digest('hex');
    need(oid === row.oid, 'The retained file failed its Git object identity check');
    need(offset <= bytes.length, 'Offset exceeds the retained file size', 400);
    const end = Math.min(offset + limit, bytes.length);
    return {
      revision,
      path: file,
      mode: row.mode,
      oid,
      size: bytes.length,
      offset,
      base64: bytes.subarray(offset, end).toString('base64'),
      nextOffset: end < bytes.length ? end : null
    };
  }

  diff({ base, revision, path: file, limit = 100 }) {
    this.#checkRevision(base);
    this.#checkRevision(revision);
    if (file !== undefined) safePath(file);
    need(Number.isInteger(limit) && limit > 0 && limit <= 200, 'Invalid diff limit', 400);
    const rows = this.db.prepare(
      `SELECT path,mode,oid FROM git_paths WHERE revision=? AND (? IS NULL OR path=?)`
    );
    const tree = (id) =>
      new Map(rows.all(id, file ?? null, file ?? null).map((row) => [row.path, row]));
    const before = tree(base),
      after = tree(revision),
      changes = [];
    let truncated = false;
    for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const previous = before.get(name) ?? null,
        next = after.get(name) ?? null;
      if (previous?.oid === next?.oid && previous?.mode === next?.mode) continue;
      if (changes.length === limit) {
        truncated = true;
        break;
      }
      const change = {
        path: name,
        kind: !previous ? 'added' : !next ? 'deleted' : 'modified',
        previous,
        next
      };
      if (file !== undefined) change.hunk = this.#hunk(previous, next);
      changes.push(change);
    }
    return { base, revision, changes, truncated, renameDetection: false };
  }

  #hunk(previous, next) {
    if ([previous, next].some((x) => x?.mode === '160000')) return { kind: 'submodule' };
    const content = (e) =>
      e
        ? textBlob(this.db.prepare('SELECT bytes FROM git_blobs WHERE oid=?').get(e.oid).bytes)
        : '';
    const a = content(previous),
      b = content(next);
    if (a === null || b === null) return { kind: 'binary' };
    if (Buffer.byteLength(a) + Buffer.byteLength(b) > 256 * 1024)
      return { kind: 'oversize', limitBytes: 256 * 1024 };
    const old = lines(a),
      fresh = lines(b);
    let lead = 0,
      tail = 0;
    while (lead < old.length && lead < fresh.length && old[lead] === fresh[lead]) lead++;
    while (
      tail < old.length - lead &&
      tail < fresh.length - lead &&
      old[old.length - 1 - tail] === fresh[fresh.length - 1 - tail]
    )
      tail++;
    const removed = old.slice(lead, old.length - tail),
      added = fresh.slice(lead, fresh.length - tail);
    return {
      kind: 'text',
      startLine: lead + 1,
      removed: removed.slice(0, 100),
      added: added.slice(0, 100),
      removedLines: removed.length,
      addedLines: added.length,
      truncated: removed.length > 100 || added.length > 100
    };
  }
}
