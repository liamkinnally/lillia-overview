import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { constants, openSync, closeSync, fstatSync, lstatSync, readlinkSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { generationWorker } from './worktree-generations.mjs';
import { homedir } from 'node:os';
import { GitProject } from './git-project.mjs';

const profile = 'darwin-cow-single-regular-file-v1';
const safeOpen = constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000; // Darwin O_NOFOLLOW_ANY
const digest = (value) => createHash('sha256').update(value).digest('hex');
function requireState(condition, message, status = 409) {
  if (!condition) throw Object.assign(new Error(message), { status });
}
function selected(input, prepare = false) {
  requireState(
    input &&
      typeof input === 'object' &&
      Object.keys(input).every((k) =>
        ['base', 'paths', ...(prepare ? ['expectedPreviewDigest'] : [])].includes(k)
      ) &&
      /^[0-9a-f]{40}$/.test(input.base),
    'Supply a registered base and single selected path',
    400
  );
  requireState(
    Array.isArray(input.paths) && input.paths.length >= 1 && input.paths.length <= 8,
    'Select one to eight regular files',
    400
  );
  for (const file of input.paths)
    requireState(
      typeof file === 'string' &&
        file.length <= 240 &&
        file
          .split('/')
          .every(
            (s) =>
              /^[A-Za-z0-9_.][A-Za-z0-9_. -]*$/.test(s) &&
              s !== '.' &&
              s !== '..' &&
              !s.endsWith('.') &&
              !s.endsWith(' ') &&
              s.toLowerCase() !== '.git'
          ),
      'Unsupported selected path',
      400
    );
  if (prepare)
    requireState(
      /^[0-9a-f]{64}$/.test(input.expectedPreviewDigest),
      'Supply an exact preview digest',
      400
    );
  const files = [...input.paths].sort();
  requireState(
    new Set(files.map((f) => f.toLowerCase())).size === files.length,
    'Select distinct regular paths',
    400
  );
  return files;
}
function stamp(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    bytes: Number(stat.size),
    modeBits: Number(stat.mode),
    links: Number(stat.nlink),
    modifiedNs: String(stat.mtimeNs),
    changedNs: String(stat.ctimeNs)
  };
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function current(path, optional = false) {
  let fd;
  try {
    fd = openSync(path, safeOpen);
    return stamp(fstatSync(fd, { bigint: true }));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    requireState(false, 'Selected working path or control file changed or cannot be opened safely');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function ignoreGuard(root) {
  const home = homedir(),
    xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
  requireState(isAbsolute(xdg), 'Untracked capture requires an absolute global ignore directory');
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    LC_ALL: 'C',
    GIT_OPTIONAL_LOCKS: '0'
  };
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'])
    if (process.env[key]) env[key] = process.env[key];
  // Inspect only ignore-related policy using Git's installed config discovery.
  // Includes and custom excludes cannot be guarded by the default ignore path.
  const keys = '^(include|includeif\\..*)\\.path$|^core\\.(excludesfile|ignorecase)$';
  const policy = spawnSync(
    '/usr/bin/git',
    ['config', '--no-includes', '--null', '--get-regexp', keys],
    {
      cwd: root,
      env,
      timeout: 1500,
      killSignal: 'SIGKILL',
      maxBuffer: 16384
    }
  );
  requireState(
    !policy.error && [0, 1].includes(policy.status),
    'The effective Git ignore policy could not be verified'
  );
  const values = policy.stdout.toString('utf8').split('\0').filter(Boolean);
  requireState(
    values.every((entry) => entry.startsWith('core.ignorecase\n')),
    'Included or custom Git ignore-policy configuration cannot be captured'
  );
  return [digest(policy.stdout), xdg, current(join(xdg, 'git', 'ignore'), true)];
}
function guards(root, file, branch, untracked) {
  const parts = file.split('/'),
    controls = [
      '.git/HEAD',
      '.git/index',
      '.git/config',
      '.git/packed-refs',
      '.git/info/exclude',
      '.gitignore'
    ];
  if (branch) controls.push('.git/refs/heads/' + branch);
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    current(join(root, dir));
    try {
      lstatSync(join(root, dir, '.git'));
      requireState(false, 'Nested repository paths cannot be captured');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    controls.push(dir + '/.gitignore');
  }
  const git = current(join(root, '.git'));
  return [
    current(join(root, file)),
    [git.device, git.inode],
    ...controls.map((p) => current(join(root, p), true)),
    untracked ? ignoreGuard(root) : null
  ];
}
const cloneProgram = [
  'import ctypes,sys',
  'lib=ctypes.CDLL("/usr/lib/libSystem.B.dylib",use_errno=True)',
  'rc=lib.fclonefileat(3,4,b"snapshot",2)',
  'sys.exit(0 if rc==0 else 1)'
].join('\n');
async function cloneBytes(root, file, dataDir, expected) {
  const scratch = await mkdtemp(join(dataDir, 'working-clone-'));
  let source, parent, clone;
  try {
    source = await open(join(root, file), safeOpen);
    parent = await open(scratch, safeOpen | constants.O_DIRECTORY);
    const stat = await source.stat({ bigint: true });
    requireState(
      stat.isFile() && stat.nlink === 1n && stat.size <= 1048576n && same(stamp(stat), expected),
      'Select a stable regular file with one link and at most 1 MiB'
    );
    requireState(
      stat.dev === (await parent.stat({ bigint: true })).dev,
      'Same-volume filesystem cloning is required'
    );
    await new Promise((ok, fail) => {
      const child = spawn('/usr/bin/python3', ['-I', '-S', '-B', '-c', cloneProgram], {
        env: { PATH: '/usr/bin:/bin' },
        cwd: scratch,
        stdio: ['ignore', 'ignore', 'ignore', source.fd, parent.fd],
        timeout: 5000,
        killSignal: 'SIGKILL'
      });
      const reject = () =>
        fail(
          Object.assign(
            new Error('The service requires Darwin fclonefileat on a clone-capable volume'),
            { status: 409 }
          )
        );
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? ok() : reject()));
    });
    clone = await open(join(scratch, 'snapshot'), safeOpen);
    const cloned = await clone.stat({ bigint: true });
    requireState(
      cloned.isFile() &&
        cloned.size === stat.size &&
        (cloned.mode & 0o777n) === (stat.mode & 0o777n),
      'Clone metadata changed during capture'
    );
    const bytes = await clone.readFile();
    requireState(
      same(expected, stamp(await source.stat({ bigint: true }))) &&
        same(expected, current(join(root, file))),
      'Working file changed during capture'
    );
    return bytes;
  } finally {
    await Promise.all([source?.close(), parent?.close(), clone?.close()]);
    await rm(scratch, { recursive: true, force: true });
  }
}
function systemConfigPath(root) {
  const settings = {
    cwd: root,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    timeout: 1500,
    maxBuffer: 65536,
    encoding: 'utf8'
  };
  const r = spawnSync(
    '/usr/bin/git',
    ['config', '--system', '--no-includes', '--show-origin', '--name-only', '--null', '--list'],
    settings
  );
  requireState(!r.error, 'Cannot identify the installed Git system configuration');
  let origin;
  if (r.status === 0) {
    const fields = r.stdout.split('\0');
    fields.pop();
    const origins = new Set(fields.filter((_, i) => i % 2 === 0));
    requireState(origins.size === 1, 'Cannot identify the installed Git system configuration');
    const value = [...origins][0];
    requireState(value.startsWith('file:/'), 'Unsupported Git system config origin');
    origin = value.slice(5);
  } else {
    const match =
      /(?:^|\n)fatal: unable to read config file '([^'\n]+)': No such file or directory\n?$/.exec(
        r.stderr
      );
    requireState(match, 'Cannot identify the installed Git system configuration');
    origin = match[1];
  }
  if (origin.startsWith('/etc/')) {
    requireState(
      readlinkSync('/etc') === 'private/etc',
      'Unrecognized macOS system configuration root'
    );
    origin = '/private' + origin;
  }
  return origin;
}
function generationPaths(root, files, branch, untracked) {
  const paths = new Set();
  function watch(p) {
    requireState(isAbsolute(p), 'A control dependency has no stable absolute path');
    while (!paths.has(p)) {
      paths.add(p);
      const parent = dirname(p);
      if (parent === p) break;
      p = parent;
    }
  }
  for (const p of [
    '.git/config',
    '.git/index',
    '.git/HEAD',
    '.git/packed-refs',
    '.git/info/exclude',
    '.git/info/attributes',
    '.git/objects/info/alternates',
    '.git/objects/info/http-alternates',
    '.git/info/grafts',
    '.git/shallow',
    '.git/commondir',
    '.git/info/sparse-checkout',
    '.git/config.worktree'
  ])
    watch(join(root, p));
  if (branch) watch(join(root, '.git/refs/heads', branch));
  for (const f of files) {
    const full = join(root, f);
    watch(full);
    for (let dir = dirname(full); ; dir = dirname(dir)) {
      watch(join(dir, '.gitignore'));
      watch(join(dir, '.gitattributes'));
      watch(join(dir, '.git'));
      if (dir === root) break;
    }
  }
  if (untracked) {
    const home = homedir(),
      xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
    watch(join(xdg, 'git', 'ignore'));
    const global = process.env.GIT_CONFIG_GLOBAL;
    if (!global) {
      watch(join(xdg, 'git', 'config'));
      watch(join(home, '.gitconfig'));
    } else if (global !== '/dev/null') watch(global);
    if (!process.env.GIT_CONFIG_NOSYSTEM || process.env.GIT_CONFIG_NOSYSTEM === '0') {
      const system = process.env.GIT_CONFIG_SYSTEM ?? systemConfigPath(root);
      if (system !== '/dev/null') watch(system);
    } else
      requireState(
        process.env.GIT_CONFIG_NOSYSTEM === '1',
        'Unrecognized Git system config selection'
      );
  }
  requireState(paths.size <= 256, 'Capture depends on too many control paths');
  return [...paths].sort();
}
async function whileMetadataStable(files, observe) {
  const child = spawn('/usr/bin/python3', ['-I', '-S', '-B', '-c', generationWorker, 'watch'], {
    env: { PATH: '/usr/bin:/bin' },
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 120000,
    killSignal: 'SIGKILL'
  });
  const ended = new Promise((resolve) => {
    child.once('close', (code) => resolve(code));
    child.once('error', () => resolve(-1));
  });
  const ready = new Promise((resolve) => {
    let body = '';
    child.stdout.on('data', (data) => {
      body += data.toString();
      if (body.length > 32768) return resolve(null);
      if (body.endsWith('\n')) {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      }
    });
  });
  child.stdin.on('error', () => {});
  try {
    child.stdin.write(JSON.stringify(files) + '\n');
    const identities = await Promise.race([ready, ended.then(() => null)]);
    requireState(
      Array.isArray(identities) && identities.length === files.length,
      'Kernel metadata watch is unavailable for this selection'
    );
    const result = await observe(identities);
    child.stdin.end('finish\n');
    requireState(
      (await ended) === 0,
      'A selected file or its metadata changed during the common interval. Retry.'
    );
    return result;
  } finally {
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await ended;
  }
}
function generations(paths) {
  const p = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', generationWorker], {
    input: JSON.stringify(paths),
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
    timeout: 4000,
    maxBuffer: 256 * 1024,
    killSignal: 'SIGKILL'
  });
  requireState(
    p.status === 0 && !p.error,
    'Capture requires stable nonzero Darwin generations, safe paths and unmapped files'
  );
  const all = JSON.parse(p.stdout);
  // Pinned vnode watches protect the binding of existing ancestors. A missing
  // control has no vnode, so keep its nearest existing parent's namespace generation.
  const missingParents = new Set();
  for (const path of paths) {
    if (all[path] !== null) continue;
    let parent = dirname(path);
    while (all[parent] === null) parent = dirname(parent);
    missingParents.add(parent);
  }
  for (const [path, row] of Object.entries(all))
    if (row && (row[3] & 0o170000) === 0o040000 && !missingParents.has(path)) row[2] = null;
  return all;
}
export function installWorktreeCapture(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS worktree_captures(id TEXT PRIMARY KEY,base TEXT NOT NULL REFERENCES git_revisions(revision),revision TEXT NOT NULL REFERENCES git_revisions(revision),project TEXT NOT NULL,record TEXT NOT NULL)'
  );
}
export class WorktreeCapture {
  #prepared = new WeakMap();
  constructor(store, options) {
    this.db = store.db;
    this.dataDir = options.dataDir;
    this.project = new GitProject(store, options);
  }
  async #observe(base, file) {
    requireState(process.platform === 'darwin', 'Working capture requires macOS clone support');
    const inspect = () => this.project.inspectWorkingPath(base, file);
    const { root, stageBytes, ...first } = await inspect();
    const before = guards(root, file, first.branch, !first.stage);
    const bytes = await cloneBytes(root, file, this.dataDir, before[0]);
    const { root: again, stageBytes: ignored, ...second } = await inspect();
    requireState(
      root === again &&
        same(first, second) &&
        same(before, guards(root, file, first.branch, !first.stage)),
      'Working file, HEAD or index changed during capture'
    );
    const working = {
      ...before[0],
      sha256: digest(bytes),
      mode: before[0].modeBits & 0o100 ? '100755' : '100644'
    };
    const record = { version: 1, profile, ...first, path: file, working };
    const previewDigest = digest(JSON.stringify(record));
    return { preview: { ...record, previewDigest }, root, stageBytes, bytes, before };
  }
  async #many(base, files) {
    const first = await this.project.inspectWorkingPath(base, files[0]),
      { root, branch, projectId, indexDigest } = first;
    // The initial lookup is only for locating controls. Bind every real inspection inside the common interval.
    const paths = generationPaths(root, files, branch, true);
    return whileMetadataStable(paths, async (identities) => {
      const before = generations(paths);
      requireState(
        paths.every((p, i) => same(before[p]?.slice(0, 2) ?? null, identities[i])),
        'Selected identities changed while arming metadata watches'
      );
      const captures = [];
      for (const file of files) {
        const observed = await this.#observe(base, file);
        requireState(
          observed.root === root &&
            observed.preview.branch === branch &&
            observed.preview.projectId === projectId &&
            observed.preview.indexDigest === indexDigest,
          'Working project, index or branch changed'
        );
        captures.push(observed);
      }
      requireState(
        same(before, generations(paths)),
        'A selected file or capture control changed during the common interval. Retry.'
      );
      const fields = captures.map(({ preview: { path, status, working, stage, baseEntry } }) => ({
        path,
        status,
        working,
        stage,
        baseEntry
      }));
      const guardDigest = digest(JSON.stringify(before));
      const body = {
        version: 2,
        profile: 'darwin-generation-set-v1',
        base,
        projectId,
        branch,
        indexDigest,
        guardDigest,
        files: fields
      };
      return {
        preview: { ...body, previewDigest: digest(JSON.stringify(body)) },
        captures,
        paths,
        before
      };
    });
  }
  async preview(input) {
    const files = selected(input);
    return (
      files.length === 1
        ? await this.#observe(input.base, files[0])
        : await this.#many(input.base, files)
    ).preview;
  }
  async prepare(input) {
    const files = selected(input, true),
      multi = files.length > 1;
    const observed = multi
        ? await this.#many(input.base, files)
        : await this.#observe(input.base, files[0]),
      p = observed.preview;
    requireState(
      p.previewDigest === input.expectedPreviewDigest,
      'The selected preview changed. Obtain a new preview.'
    );
    const items = multi ? observed.captures : [observed];
    const built = await this.project.prepareWorkingRevision({
      base: p.base,
      projectId: p.projectId,
      files: items.map((x) => ({
        file: x.preview.path,
        mode: x.preview.working.mode,
        bytes: x.bytes
      })),
      previewDigest: p.previewDigest,
      date: '@' + String(BigInt(items[0].preview.working.modifiedNs) / 1000000000n) + ' +0000'
    });
    const token = Object.freeze({ id: 'worktree-capture-v' + p.version + '-' + p.previewDigest });
    this.#prepared.set(token, { ...observed, built });
    return token;
  }
  accept(token) {
    const data = this.#prepared.get(token);
    requireState(
      data && this.db.isTransaction,
      'Capture acceptance requires a verified selection and writer transaction'
    );
    const { preview: p, root, before, built } = data;
    const multi = p.version === 2;
    requireState(
      multi
        ? same(before, generations(data.paths))
        : same(before, guards(root, p.path, p.branch, !p.stage)),
      'Working selection changed before acceptance. Obtain a new preview.'
    );
    const prior = this.db.prepare('SELECT record FROM worktree_captures WHERE id=?').get(token.id);
    if (prior) return JSON.parse(prior.record);
    const retain = (oid, content) => {
      const actual = createHash('sha1')
        .update('blob ' + content.length + '\0')
        .update(content)
        .digest('hex');
      requireState(actual === oid, 'Captured Git blob identity does not match its bytes');
      const priorBlob = this.db.prepare('SELECT bytes FROM git_blobs WHERE oid=?').get(oid);
      if (priorBlob)
        requireState(
          Buffer.from(priorBlob.bytes).equals(content),
          'Retained Git blob identity conflict'
        );
      else this.db.prepare('INSERT INTO git_blobs VALUES(?,?)').run(oid, content);
    };
    const items = multi ? data.captures : [data];
    for (const [i, item] of items.entries()) {
      retain(built.oids[i], item.bytes);
      if (item.preview.stage) retain(item.preview.stage.oid, item.stageBytes);
    }
    if (built.revision !== p.base) {
      this.db
        .prepare('INSERT INTO git_revisions VALUES(?,?,?,?)')
        .run(built.revision, p.projectId, built.ref, built.bundle);
      this.db
        .prepare('INSERT INTO git_paths SELECT ?,path,mode,oid FROM git_paths WHERE revision=?')
        .run(built.revision, p.base);
      const put = this.db.prepare('INSERT OR REPLACE INTO git_paths VALUES(?,?,?,?)');
      for (const [i, item] of items.entries())
        put.run(built.revision, item.preview.path, item.preview.working.mode, built.oids[i]);
    }
    const record = {
      ...p,
      id: token.id,
      revision: built.revision,
      retentionRef: built.ref,
      ...(multi ? { workingOids: built.oids } : { workingOid: built.oid })
    };
    this.db
      .prepare('INSERT INTO worktree_captures VALUES(?,?,?,?,?)')
      .run(token.id, p.base, built.revision, p.projectId, JSON.stringify(record));
    return record;
  }
  view({ id }) {
    requireState(
      typeof id === 'string' && /^worktree-capture-v[12]-[a-f0-9]{64}$/.test(id),
      'Invalid worktree capture ID',
      400
    );
    const row = this.db.prepare('SELECT record FROM worktree_captures WHERE id=?').get(id);
    requireState(row, 'Working capture has not been retained', 404);
    return JSON.parse(row.record);
  }
}
