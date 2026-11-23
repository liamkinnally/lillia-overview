import { installSubtreeScope, verifySubtreeScope } from './subtree-scope-schema.mjs';
import { verifyScopeDeliveryClaims } from './subtree-scope-claim-schema.mjs';
import { installThreadMailStore } from './thread-mail-store.mjs';
import { installMailOwner } from './thread-mail-owner-schema.mjs';
import { installMailDelivery } from './thread-mail-delivery-schema.mjs';
import { verifyMailDelivery } from './thread-mail-delivery-recovery.mjs';
import { verifyMailOwner } from './thread-mail-owner-recovery.mjs';
import { installThreadMailAuthority, verifyThreadMailAuthority } from './thread-mail-authority.mjs';
import { verifyThreadMailStore } from './thread-mail-recovery.mjs';
import {
  constants as F,
  mkdtempSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  fstatSync,
  readdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  renameSync,
  rmSync,
  chmodSync,
  existsSync
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { release } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GoalStore, schemaVersion, applicationId } from './goal-store.mjs';
import { installReviewSeries } from './native-series.mjs';
import { installResearchLibrary } from './research-library.mjs';
import { installNativeJavascript } from './native-javascript.mjs';
import { installProjectValidation } from './project-validation.mjs';
import { installProjectChanges } from './project-development.mjs';
import { installTaskHandoffs } from './task-handoff.mjs';
import { installHarnessGit } from './harness-git.mjs';
import { installGitCutover } from './git-cutover.mjs';
import { installNativeObjectivePlanning } from './native-objective-planning.mjs';
import { isPortableJs } from './native-policy.mjs';
import { installNativeRelease } from './native-release.mjs';
import { installProjectChat } from './project-chat.mjs';
import { installChatOrigins, verifyChatOrigins } from './project-chat-origins.mjs';
import { installAttachmentPins, verifyAttachmentPins } from './project-chat-attachment-pins.mjs';
import { installChatBranches } from './project-chat-branches.mjs';
import { verifyChatBranches } from './project-chat-branch-recovery.mjs';
import { installBranchThreads, verifyBranchThreads } from './project-chat-branch-threads.mjs';
import { installBranchRuntime, verifyBranchRuntime } from './project-chat-branch-runtime.mjs';
import { installExecutionPins, verifyExecutionPins } from './execution-pins.mjs';
import {
  installChatContexts,
  verifyChatContexts,
  installChatSelections,
  verifyChatSelections
} from './project-chat-contexts.mjs';
import { installProjectChatThreads, verifyProjectChatThreads } from './project-chat-threads.mjs';
import {
  upgradeProjectChatThreads,
  verifyUpgradedProjectChatThreads
} from './project-chat-thread-upgrade.mjs';
import { installNativeJobCapabilities } from './native-job-capabilities.mjs';
import { installGitCompatibility } from './git-compatibility.mjs';
import { installNativeQueue } from './native-queue.mjs';
import { ServiceDrain } from './service-drain.mjs';
import {
  ensureInstallation as need,
  privateFile,
  privateRoot,
  installationRegistryId
} from './installation-gate.mjs';
import { comparePredecessor } from './predecessor-proof.mjs';
import { restoreBackup, verifiedInspection } from './recovery.mjs';
import { stoppedCheckpoint } from './install-checkpoint.mjs';

export function checkpointInstallation(input, operationId) {
  return stoppedCheckpoint(input, operationId, { registry, active, verifiedBuild, clean });
}

const hash = (b) => createHash('sha256').update(b).digest('hex'),
  intent = (name, input) => hash(JSON.stringify([name, input]));
const validId = (s) => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(s),
  sha = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const bound = 16 * 1024 * 1024;
const dirIdentity = (p) => {
  const s = lstatSync(p, { bigint: true });
  return { device: String(s.dev), inode: String(s.ino) };
};
function syncDir(dir) {
  const fd = openSync(dir, F.O_DIRECTORY | F.O_RDONLY | F.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function durable(file, bytes, mode = 0o600) {
  const fd = openSync(file, F.O_CREAT | F.O_EXCL | F.O_WRONLY | F.O_NOFOLLOW, mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
const additive = new Map([
  [34, installNativeRelease],
  [35, installProjectChat],
  [36, installNativeJobCapabilities],
  [37, installNativeQueue],
  [38, installGitCompatibility],
  [39, installReviewSeries],
  [40, installResearchLibrary],
  [41, installNativeJavascript],
  [42, installGitCutover],
  [43, installNativeObjectivePlanning],
  [44, installHarnessGit],
  [45, installTaskHandoffs],
  [
    46,
    (db) => {
      installProjectValidation(db);
      installProjectChanges(db);
    }
  ],
  [
    47,
    (db) => {
      installProjectChatThreads(db);
      verifyProjectChatThreads(db);
    }
  ],
  [
    48,
    (db) => {
      upgradeProjectChatThreads(db);
      verifyUpgradedProjectChatThreads(db);
    }
  ],
  [
    49,
    (db) => {
      installChatOrigins(db);
      verifyChatOrigins(db);
    }
  ],
  [
    50,
    (db) => {
      installChatContexts(db);
      verifyChatContexts(db);
    }
  ],
  [
    51,
    (db) => {
      installChatSelections(db);
      verifyChatSelections(db);
    }
  ],
  [
    52,
    (db) => {
      installAttachmentPins(db);
      verifyAttachmentPins(db);
    }
  ],
  [
    53,
    (db) => {
      installChatBranches(db);
      verifyChatBranches(db);
    }
  ],
  [
    54,
    (db) => {
      installBranchThreads(db);
      verifyBranchThreads(db);
    }
  ],
  [
    55,
    (db) => {
      installBranchRuntime(db);
      verifyBranchRuntime(db);
    }
  ],
  [
    56,
    (db) => {
      installExecutionPins(db);
      // Pin verification reads the schema gate, matching GoalStore's migration order.
      db.exec('PRAGMA user_version=56');
      verifyExecutionPins(db);
    }
  ],
  [
    57,
    (db) => {
      installThreadMailStore(db);
      installThreadMailAuthority(db);
      installMailOwner(db);
      installMailDelivery(db);
      verifyThreadMailStore(db);
      verifyThreadMailAuthority(db);
      verifyMailOwner(db);
      verifyMailDelivery(db);
    }
  ],
  [
    58,
    (db) => {
      installSubtreeScope(db);
      verifySubtreeScope(db);
      verifyScopeDeliveryClaims(db);
    }
  ]
]);
const allowedSchema = (v) =>
  Number.isInteger(v) && v >= 33 && v <= schemaVersion && (v === 33 || additive.has(v));
function schemaStamp(db) {
  return hash(
    JSON.stringify(
      db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name"
        )
        .all()
    )
  );
}
const quoted = (name) => '"' + name.replaceAll('"', '""') + '"';
function legacyState(db, names) {
  const result = new Map();
  for (const name of names) {
    const info = db.prepare('PRAGMA table_info(' + quoted(name) + ')').all();
    const order =
      info
        .filter((c) => c.pk)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => quoted(c.name))
        .join(',') || 'rowid';
    const sum = createHash('sha256');
    sum.update(JSON.stringify(info));
    for (const row of db
      .prepare('SELECT rowid AS _managed_rowid_,* FROM ' + quoted(name) + ' ORDER BY ' + order)
      .iterate()) {
      sum.update('R');
      for (const v of Object.values(row)) {
        const b = v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(String(v));
        sum.update(typeof v + ':' + (v === null ? 'N' : b.length) + ':');
        sum.update(b);
      }
    }
    result.set(name, sum.digest('hex'));
  }
  return result;
}
function copyDatabase(from, to) {
  const program =
    "const {DatabaseSync,backup}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true,allowExtension:false});backup(db,process.argv[2]).then(()=>db.close(),()=>{process.exitCode=1;db.close()});";
  const r = spawnSync(process.execPath, ['--no-addons', '-e', program, from, to], {
    env: {},
    stdio: 'ignore',
    timeout: 60000
  });
  need(r.status === 0, 'SQLite online backup could not create a candidate database.');
  chmodSync(to, 0o600);
}
function copySet(source) {
  need(
    path.isAbsolute(source) && realpathSync(source) === source,
    'Select the canonical reviewed artifact directory.'
  );
  const files = new Map();
  let total = 0;
  const add = (name) => {
    const bytes = privateFile(path.join(source, name), 2 * 1024 * 1024);
    total += bytes.length;
    need(total <= bound && files.size < 256, 'Installation artifact exceeds bounds.');
    files.set(name, bytes);
  };
  add('package.json');
  function walk(rel) {
    const target = path.join(source, rel),
      st = lstatSync(target);
    need(
      st.isDirectory() && realpathSync(target) === target,
      'Linked source directory is unsupported.'
    );
    for (const d of readdirSync(target, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, 'en')
    )) {
      if (d.name === '.DS_Store') continue;
      need(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(d.name), 'Unexpected artifact filename.');
      const name = rel + '/' + d.name;
      if (d.isDirectory()) {
        need(name.split('/').length <= 8, 'Deep installation tree.');
        walk(name);
      } else {
        need(
          d.isFile() && (/\.(?:mjs|json)$/.test(d.name) || isPortableJs(name.slice('src/'.length))),
          'Installation source must contain only regular modules or JSON resources.'
        );
        add(name);
      }
    }
  }
  walk('src');
  for (const mod of [
    'platform',
    'goal-store',
    'cli',
    'daemon',
    'session-profile',
    'installation-gate'
  ])
    need(files.has('src/' + mod + '.mjs'), 'Missing required installation component.');
  const metadata = JSON.parse(files.get('package.json'));
  const match = /^export const schemaVersion\s*=\s*(\d+);$/m.exec(
    files.get('src/goal-store.mjs').toString()
  );
  need(match && metadata.type === 'module', 'Unsupported release metadata.');
  const contents = [...files]
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = {
    format: 1,
    version: metadata.version,
    schema: Number(match[1]),
    wireVersion: 1,
    runtime: process.version,
    files: contents
  };
  return { files, manifest: { ...manifest, digest: hash(JSON.stringify(manifest)) } };
}
export function releaseManifest({ source }) {
  return copySet(source).manifest;
}
function registry(root) {
  privateRoot(root);
  const p = path.join(root, 'registry.sqlite'),
    s = lstatSync(p);
  need(
    s.isFile() && s.nlink === 1 && s.uid === process.getuid() && !(s.mode & 0o077),
    'Unsafe installation registry.'
  );
  const db = new DatabaseSync(p, { allowExtension: false });
  db.exec(
    'PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;PRAGMA busy_timeout=0'
  );
  need(
    db.prepare('PRAGMA application_id').get().application_id === installationRegistryId,
    'Unrecognized installation registry.'
  );
  return db;
}
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const v = fn();
    db.exec('COMMIT');
    return v;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
function active(db, root) {
  const r = db
    .prepare(
      'SELECT c.generation,c.workspaceRoot,p.* FROM control c JOIN pairs p ON p.id=c.active WHERE c.slot=1'
    )
    .get();
  need(r, 'No active installation pair.');
  return {
    generation: r.generation,
    workspaceRoot: r.workspaceRoot,
    pair: r.id,
    build: r.build,
    cutoff: r.cutoff,
    dataDirectory: path.join(root, 'pairs', r.id),
    buildDirectory: path.join(root, 'builds', r.build)
  };
}
function verifiedBuild(root, build) {
  need(sha(build), 'Invalid release digest.', 400);
  const dir = path.join(root, 'builds', build);
  const m = releaseManifest({ source: dir });
  need(m.digest === build, 'Installed application digest differs from owner approval.');
  return { dir, manifest: m };
}
function copyBuild(root, source, expectedDigest) {
  const reviewed = copySet(source);
  need(
    sha(expectedDigest) && reviewed.manifest.digest === expectedDigest,
    'Release digest differs from the owner-approved artifact.'
  );
  need(
    allowedSchema(reviewed.manifest.schema),
    'Release schema is outside the trusted supervisor migration matrix.'
  );
  const dest = path.join(root, 'builds', expectedDigest);
  if (existsSync(dest)) return verifiedBuild(root, expectedDigest);
  const temp = mkdtempSync(path.join(root, 'builds', '.preparing-'));
  try {
    const dirs = new Set([temp]);
    for (const item of reviewed.manifest.files) {
      const target = path.join(temp, item.path),
        parent = path.dirname(target);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      for (let dir = parent; !dirs.has(dir); dir = path.dirname(dir)) dirs.add(dir);
      durable(target, reviewed.files.get(item.path), 0o400);
    }
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      syncDir(d);
    }
    renameSync(temp, dest);
    syncDir(path.dirname(dest));
  } catch (error) {
    try {
      chmodSync(temp, 0o700);
      rmSync(temp, { recursive: true, force: true });
    } catch {}
    throw error;
  }
  return verifiedBuild(root, expectedDigest);
}
const dyldProfile = '/System/Library/Sandbox/Profiles/dyld-support.sb';
const profile = `(version 1)(deny default)(import "dyld-support.sb")
(allow process-exec (literal (param "node")))(allow sysctl-read)
(allow file-read* file-map-executable (literal (param "node"))(subpath "/usr/lib"))
(allow file-read* (literal "/dev/null")(literal "/dev/urandom"))
(allow file-read* file-write* (subpath (param "trial")))`;
const health = `(async()=>{
  const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net'),url=require('node:url');
  const [build,trial,sentinel,socket]=process.argv.slice(1);
  function denied(fn){try{fn();return false;}catch(e){return e.code==='EPERM'||e.code==='EACCES';}}
  const outside=denied(()=>fs.readFileSync(sentinel));
  const child=cp.spawnSync(process.execPath,['-e','process.exit(0)']).error?.code;
  const network=await new Promise(resolve=>{const s=net.connect(9,'127.0.0.1');s.once('error',e=>resolve(e.code));s.once('connect',()=>{s.destroy();resolve('connected');});});
  const unix=await new Promise(resolve=>{const s=net.connect(socket);s.once('error',e=>resolve(e.code));s.once('connect',()=>{s.destroy();resolve('connected');});});
  if(!outside||child!=='EPERM'||network!=='EPERM'||unix!=='EPERM')process.exit(20);
  const app=await (await import(url.pathToFileURL(build+'/src/platform.mjs'))).openPlatform({
    workspaceRoot:trial+'/work',dataDir:trial+'/data',resourceSample:()=>({diskAvailable:2**36,totalMemory:2**34,memoryPercent:90}),
    adapterFactory:()=>({runtimeInfo:{status:'offline'},active:new Map(),approvals:new Map(),start(){},kick(){},close(){}})
  });
  const status=await app.query('status');await app.close();
  console.log(JSON.stringify({protocol:1,schema:status.schemaVersion,hostFileDenied:outside,childDenied:child,networkDenied:network,unixSocketDenied:unix}));
})().catch(()=>{process.exitCode=21;});`;
function smoke(root, build) {
  need(
    process.platform === 'darwin' &&
      process.arch === 'arm64' &&
      release() === '25.3.0' &&
      process.version === 'v24.22.2',
    'Unverified host profile for isolated candidate startup.'
  );
  need(
    hash(readFileSync(dyldProfile)) ===
      '06215a5d32689aefe395c29710e182eb54ba22162f50df8b4842290f8a19bf1c',
    'Verified host loader profile changed.'
  );
  const trial = mkdtempSync(path.join(root, 'trials', 'probe-')),
    outside = path.join(root, 'trials', 'sentinel-' + randomUUID());
  mkdirSync(path.join(trial, 'work'), { mode: 0o700 });
  mkdirSync(path.join(trial, 'data'), { mode: 0o700 });
  durable(outside, 'synthetic denied fixture');
  const socket = path.join(root, 'trials', 's-' + randomUUID().slice(0, 8) + '.sock');
  const server = spawn(
    process.execPath,
    [
      '--no-addons',
      '-e',
      "const s=require('node:net').createServer(c=>c.destroy());s.listen(process.argv[1]);setTimeout(()=>s.close(),10000).unref();",
      socket
    ],
    { env: {}, stdio: 'ignore' }
  );
  try {
    const until = Date.now() + 1500,
      gate = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(socket) && Date.now() < until) Atomics.wait(gate, 0, 0, 10);
    need(
      existsSync(socket) && lstatSync(socket).isSocket(),
      'The synthetic host socket probe is unavailable.'
    );
    const node = realpathSync(process.execPath),
      parents = new Set();
    const moduleDirectories = build.manifest.files.map((f) =>
      path.dirname(path.join(build.dir, f.path))
    );
    for (const start of [trial, node, ...moduleDirectories]) {
      for (let dir = start; dir !== path.dirname(dir) && !parents.has(dir); dir = path.dirname(dir))
        parents.add(dir);
    }
    const loc = (f) => '(literal ' + JSON.stringify(f) + ')';
    const rules =
      profile +
      '(allow file-read* ' +
      build.manifest.files.map((f) => loc(path.join(build.dir, f.path))).join(' ') +
      ')' +
      '(allow file-read-metadata ' +
      [...parents].map((d) => '(literal ' + JSON.stringify(d) + ')').join(' ') +
      ')';
    const r = spawnSync(
      '/usr/bin/sandbox-exec',
      [
        '-D',
        'node=' + node,
        '-D',
        'build=' + build.dir,
        '-D',
        'trial=' + trial,
        '-p',
        rules,
        node,
        '--openssl-config=/dev/null',
        '--jitless',
        '--no-addons',
        '--no-global-search-paths',
        '--max-old-space-size=128',
        '-e',
        health,
        build.dir,
        trial,
        outside,
        socket
      ],
      {
        cwd: trial,
        env: {},
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 6000,
        maxBuffer: 65536
      }
    );
    need(
      r.status === 0,
      'Isolated candidate startup or migration failed; prior pair remains active.'
    );
    const result = JSON.parse(r.stdout);
    need(
      result.protocol === 1 &&
        result.schema === build.manifest.schema &&
        result.hostFileDenied &&
        result.childDenied === 'EPERM' &&
        result.networkDenied === 'EPERM' &&
        result.unixSocketDenied === 'EPERM',
      'Candidate compatibility or isolation evidence differs.'
    );
    const trialDir = path.join(trial, 'data'),
      trialDb = path.join(trialDir, 'platform.sqlite');
    for (const dir of [trial, trialDir])
      need(
        realpathSync(dir) === dir && lstatSync(dir).isDirectory(),
        'Candidate trial data directory changed.'
      );
    const st = lstatSync(trialDb);
    need(
      st.isFile() &&
        st.nlink === 1 &&
        st.uid === process.getuid() &&
        st.size > 0 &&
        st.size <= 128 * 1024 * 1024,
      'Candidate trial database is not a bounded private file.'
    );
    for (const suffix of ['-wal', '-journal']) {
      const side = lstatSync(trialDb + suffix, { throwIfNoEntry: false });
      need(
        !side || (side.isFile() && side.nlink === 1 && side.size === 0),
        'Candidate trial database has unclosed writes.'
      );
    }
    const uri = new URL('file://localhost');
    uri.pathname = trialDb;
    uri.search = 'immutable=1';
    const validated = new DatabaseSync(uri.href, { readOnly: true, allowExtension: false });
    let schemaDigest;
    try {
      validated.exec('PRAGMA trusted_schema=OFF;PRAGMA query_only=ON');
      need(
        validated.prepare('PRAGMA application_id').get().application_id === applicationId &&
          validated.prepare('PRAGMA user_version').get().user_version === result.schema,
        'Candidate trial database failed independent validation.'
      );
      schemaDigest = schemaStamp(validated);
    } finally {
      validated.close();
    }
    return { ...result, schemaDigest, runtime: process.version, platform: 'darwin-arm64-25.3.0' };
  } finally {
    server.kill('SIGTERM');
    rmSync(socket, { force: true });
    rmSync(outside, { force: true });
    rmSync(trial, { recursive: true, force: true });
  }
}
function receipt(db, id, name, input) {
  need(validId(id), 'Stable installation operation ID required.', 400);
  const pending = db.prepare('SELECT digest FROM upgrades WHERE id=?').get(id);
  if (pending)
    need(
      pending.digest === intent(name, input),
      'Installation operation ID belongs to another pending intent.'
    );
  const prior = db.prepare('SELECT * FROM operations WHERE id=?').get(id);
  if (prior) {
    need(
      prior.digest === intent(name, input),
      'Installation operation ID belongs to different inputs.'
    );
    return JSON.parse(prior.receipt);
  }
  return null;
}
function record(db, id, name, input, result) {
  db.prepare('INSERT INTO operations VALUES(?,?,?)').run(
    id,
    intent(name, input),
    JSON.stringify(result)
  );
  return result;
}
function pairRecord(db, directory, id, build, cutoff) {
  const { device, inode } = dirIdentity(directory),
    dbInode = dirIdentity(path.join(directory, 'platform.sqlite')).inode;
  db.prepare('INSERT INTO pairs VALUES(?,?,?,?,?,?)').run(
    id,
    build,
    device,
    inode,
    dbInode,
    cutoff
  );
}
export function initializeInstallation(
  { root, workspaceRoot, source, expectedDigest },
  operationId
) {
  need(
    path.isAbsolute(root) &&
      path.dirname(root) === realpathSync(path.dirname(root)) &&
      path.normalize(root) === root &&
      validId(operationId),
    'Choose a new absolute managed root and operation ID.'
  );
  need(
    Buffer.byteLength(path.join(root, 'pairs', 'x'.repeat(36), 'daemon.sock')) <= 103,
    'Managed root is too long for its Unix sockets.'
  );
  workspaceRoot = realpathSync(workspaceRoot);
  need(
    lstatSync(workspaceRoot).isDirectory() &&
      ![workspaceRoot, realpathSync(source)].some((p) => root === p || root.startsWith(p + '/')),
    'Managed root must be separate from source and working project.'
  );
  const input = { root, workspaceRoot, source, expectedDigest };
  if (existsSync(root)) {
    const db = registry(root);
    try {
      const old = receipt(db, operationId, 'init', input);
      need(old, 'Initialization requires a fresh managed directory.');
      return old;
    } finally {
      db.close();
    }
  }
  need(
    releaseManifest({ source }).digest === expectedDigest,
    'Release digest differs from owner approval.'
  );
  mkdirSync(root, { mode: 0o700 });
  for (const name of ['builds', 'pairs', 'trials', 'evidence'])
    mkdirSync(path.join(root, name), { mode: 0o700 });
  const dbPath = path.join(root, 'registry.sqlite');
  durable(dbPath, Buffer.alloc(0));
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA synchronous=FULL;PRAGMA application_id=${installationRegistryId};
      CREATE TABLE control(slot INTEGER PRIMARY KEY CHECK(slot=1),active TEXT NOT NULL,generation INTEGER NOT NULL,workspaceRoot TEXT NOT NULL);
      CREATE TABLE pairs(id TEXT PRIMARY KEY,build TEXT NOT NULL,device TEXT NOT NULL,inode TEXT NOT NULL,databaseInode TEXT NOT NULL,cutoff TEXT NOT NULL);
      CREATE TABLE staged(build TEXT PRIMARY KEY,proof TEXT NOT NULL,manifest TEXT NOT NULL);CREATE TABLE operations(id TEXT PRIMARY KEY,digest TEXT NOT NULL,receipt TEXT NOT NULL);
      CREATE TABLE upgrades(id TEXT PRIMARY KEY,digest TEXT NOT NULL,oldPair TEXT NOT NULL,newPair TEXT NOT NULL,phase TEXT NOT NULL);`);
    const build = copyBuild(root, source, expectedDigest),
      id = randomUUID(),
      dir = path.join(root, 'pairs', id);
    mkdirSync(dir, { mode: 0o700 });
    const proof = smoke(root, build);
    const store = new GoalStore(path.join(dir, 'platform.sqlite')),
      cutoff = 'initial-' + id;
    try {
      store.initialize(workspaceRoot, build.manifest.schema);
      need(
        schemaStamp(store.db) === proof.schemaDigest,
        'Candidate bootstrap differs from trusted installer schema.'
      );
      need(
        store.db.prepare('PRAGMA user_version').get().user_version === build.manifest.schema,
        'Bootstrap schema differs from approved build.'
      );
      store.db
        .prepare("UPDATE settings SET value=? WHERE key='platform.workspace'")
        .run(workspaceRoot);
      store.db.prepare('INSERT INTO settings VALUES(?,?)').run('platform.managedPair', id);
      const args = { expectedGeneration: 0 };
      store.accept(cutoff, intent('daemon.drain', args), () => ({
        drain: new ServiceDrain(store).begin(args, cutoff)
      }));
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      store.close();
    }
    durable(path.join(dir, 'MANAGED.json'), JSON.stringify({ pair: id, build: expectedDigest }));
    syncDir(dir);
    syncDir(path.dirname(dir));
    const result = tx(db, () => {
      db.prepare('INSERT INTO staged VALUES(?,?,?)').run(
        expectedDigest,
        JSON.stringify(proof),
        JSON.stringify(build.manifest)
      );
      pairRecord(db, dir, id, expectedDigest, cutoff);
      db.prepare('INSERT INTO control VALUES(1,?,1,?)').run(id, workspaceRoot);
      return record(db, operationId, 'init', input, { active: active(db, root), proof });
    });
    syncDir(root);
    syncDir(path.dirname(root));
    return result;
  } finally {
    db.close();
  }
}
export function installationStatus({ root }) {
  const db = registry(root);
  try {
    return {
      active: active(db, root),
      staged: db
        .prepare('SELECT build FROM staged ORDER BY rowid')
        .all()
        .map((r) => r.build),
      upgrades: db
        .prepare('SELECT id,oldPair,newPair,phase FROM upgrades ORDER BY rowid DESC LIMIT 40')
        .all()
        .map((r) => ({ ...r }))
    };
  } finally {
    db.close();
  }
}
export function stageInstallation({ root, source, expectedDigest }, operationId) {
  const db = registry(root),
    input = { source, expectedDigest };
  try {
    return tx(db, () => {
      const prior = receipt(db, operationId, 'stage', input);
      if (prior) return prior;
      const built = copyBuild(root, source, expectedDigest),
        proof = smoke(root, built);
      db.prepare('INSERT OR REPLACE INTO staged VALUES(?,?,?)').run(
        expectedDigest,
        JSON.stringify(proof),
        JSON.stringify(built.manifest)
      );
      return record(db, operationId, 'stage', input, { build: expectedDigest, proof });
    });
  } finally {
    db.close();
  }
}
function snapshotHash(file) {
  const st = lstatSync(file);
  need(
    st.isFile() && st.nlink === 1 && st.uid === process.getuid() && st.size <= 256 * 1024 * 1024,
    'Unsupported predecessor database.'
  );
  return hash(privateFile(file, 256 * 1024 * 1024));
}
function clean(file) {
  for (const ext of ['-wal', '-journal'])
    need(
      !existsSync(file + ext) || lstatSync(file + ext).size === 0,
      'Stop and checkpoint the predecessor before activation.'
    );
}
export function activateInstallation(
  { root, build, expectedGeneration, cutoff, archive },
  operationId,
  { interrupt } = {}
) {
  need(
    sha(build) &&
      Number.isSafeInteger(expectedGeneration) &&
      expectedGeneration > 0 &&
      validId(cutoff) &&
      validId(operationId),
    'Invalid installation activation input.',
    400
  );
  const db = registry(root),
    input = { build, expectedGeneration, cutoff, archive };
  let lock;
  try {
    const prior = receipt(db, operationId, 'activate', input);
    if (prior) return prior;
    const old = active(db, root);
    need(
      old.generation === expectedGeneration && old.build !== build,
      'Activation generation or build does not match the active pair.'
    );
    const binary = verifiedBuild(root, build);
    need(
      db.prepare('SELECT 1 FROM staged WHERE build=?').get(build),
      'Candidate lacks a reviewed isolated startup.'
    );
    verifiedBuild(root, old.build);
    const oldFile = path.join(old.dataDirectory, 'platform.sqlite'),
      lockFile = path.join(old.dataDirectory, 'daemon.lock.sqlite');
    privateRoot(old.dataDirectory);
    clean(oldFile);
    const initial = snapshotHash(oldFile),
      restore = path.join(root, 'evidence', 'inspection-' + hash(operationId));
    const opDigest = intent('activate', input),
      pending = db.prepare('SELECT * FROM upgrades WHERE id=?').get(operationId);
    if (pending)
      need(
        pending.digest === opDigest &&
          pending.oldPair === old.pair &&
          pending.phase === 'preparing',
        'Pending upgrade belongs to another request.'
      );
    const pair = pending?.newPair ?? randomUUID(),
      newDir = path.join(root, 'pairs', pair);
    if (!pending)
      tx(db, () => {
        need(
          active(db, root).pair === old.pair &&
            !db.prepare("SELECT 1 FROM upgrades WHERE phase='preparing'").get(),
          'Another prepared activation owns the installation.'
        );
        db.prepare("INSERT INTO upgrades VALUES(?,?,?,?,'preparing')").run(
          operationId,
          opDigest,
          old.pair,
          pair
        );
      });
    if (!existsSync(restore)) restoreBackup({ source: archive, destination: restore });
    const restored = verifiedInspection(restore).manifest,
      archiveManifest = JSON.parse(
        privateFile(path.join(privateRoot(archive), 'manifest.json'), 16 * 1024 * 1024)
      );
    need(
      archiveManifest.database.sha256 === restored.sourceSha256 &&
        archiveManifest.operationId === restored.operationId,
      'Activation requires the exact verified recovery point.'
    );
    const comparison = comparePredecessor({
      restoredDirectory: restore,
      predecessorDirectory: old.dataDirectory
    });
    need(
      comparison.state === 'records-match' && comparison.backupReceiptConfirmed,
      'Verified backup differs from the stopped predecessor: ' + comparison.state
    );
    const st = lstatSync(lockFile);
    need(
      st.isFile() && st.uid === process.getuid() && st.nlink === 1,
      'Missing physical predecessor writer lock.'
    );
    lock = new DatabaseSync(lockFile, { allowExtension: false });
    lock.exec('PRAGMA busy_timeout=0;BEGIN EXCLUSIVE');
    clean(oldFile);
    need(snapshotHash(oldFile) === initial, 'Predecessor changed after verification.');
    interrupt?.('prepared');
    const original = new DatabaseSync(oldFile, { readOnly: true, allowExtension: false });
    let migration;
    try {
      const s = new ServiceDrain({ db: original }).view();
      need(
        s.cutoff === cutoff &&
          s.phase === 'quiescent' &&
          original.prepare('PRAGMA application_id').get().application_id === applicationId &&
          allowedSchema(binary.manifest.schema),
        'Named drain, schema and candidate compatibility are required.'
      );
      const from = original.prepare('PRAGMA user_version').get().user_version,
        to = binary.manifest.schema;
      need(
        from === verifiedBuild(root, old.build).manifest.schema &&
          from <= to &&
          Array.from({ length: to - from }, (_, i) => from + i + 1).every((v) => additive.has(v)),
        'No trusted forward migration contract exists for this pair.'
      );
      need(
        !original
          .prepare(
            "SELECT 1 FROM agent_workspaces WHERE state NOT IN ('sealed','reviewed','released') LIMIT 1"
          )
          .get(),
        'A retained mutable workspace lacks a clean handoff.'
      );
      need(
        original.prepare("SELECT value FROM settings WHERE key='platform.managedPair'").get()
          ?.value === old.pair,
        'Predecessor database binding changed.'
      );
      // An interrupted unpublished copy is owned only by this operation. Rebuild it from the exact fenced predecessor.
      if (existsSync(newDir)) {
        privateRoot(newDir);
        need(
          !db.prepare('SELECT 1 FROM pairs WHERE id=?').get(pair),
          'An acknowledged installation pair cannot be rebuilt.'
        );
        for (const item of readdirSync(newDir))
          need(
            [
              'platform.sqlite',
              'platform.sqlite-wal',
              'platform.sqlite-shm',
              'platform.sqlite-journal',
              'MANAGED.json'
            ].includes(item) && lstatSync(path.join(newDir, item)).isFile(),
            'Unexpected pending pair content.'
          );
        rmSync(newDir, { recursive: true });
      }
      mkdirSync(newDir, { mode: 0o700 });
      const target = path.join(newDir, 'platform.sqlite');
      copyDatabase(oldFile, target);
      const names = original
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'research_search*' ORDER BY name"
        )
        .all()
        .map((r) => r.name);
      const before = legacyState(original, names);
      const next = new DatabaseSync(target, { allowExtension: false });
      try {
        need(
          next.prepare('PRAGMA integrity_check').get().integrity_check === 'ok' &&
            !next.prepare('PRAGMA foreign_key_check').get(),
          'Candidate data validation failed.'
        );
        next.exec('PRAGMA synchronous=FULL;BEGIN IMMEDIATE');
        for (let v = from + 1; v <= to; v++) {
          additive.get(v)(next);
          next.exec('PRAGMA user_version=' + v);
        }
        const after = legacyState(next, names);
        need(
          [...before].every(([name, d]) => after.get(name) === d),
          'Migration changed existing canonical data or its row identity.'
        );
        const proof = JSON.parse(
          db.prepare('SELECT proof FROM staged WHERE build=?').get(build).proof
        );
        need(
          schemaStamp(next) === proof.schemaDigest &&
            next.prepare('PRAGMA integrity_check').get().integrity_check === 'ok' &&
            !next.prepare('PRAGMA foreign_key_check').get(),
          'Migrated schema differs from the independently initialized candidate or its integrity contract.'
        );
        migration = { from, to, legacyTablesPreserved: true };
        next.prepare("UPDATE settings SET value=? WHERE key='platform.managedPair'").run(pair);
        next.prepare("DELETE FROM settings WHERE key GLOB 'job.auth.*'").run();
        next.exec('COMMIT;PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        next.close();
      }
      durable(path.join(newDir, 'MANAGED.json'), JSON.stringify({ pair, build }));
      syncDir(newDir);
      syncDir(path.dirname(newDir));
    } finally {
      original.close();
    }
    interrupt?.('before-activation');
    verifiedBuild(root, build);
    clean(oldFile);
    need(snapshotHash(oldFile) === initial, 'Predecessor changed before activation.');
    const result = tx(db, () => {
      need(active(db, root).pair === old.pair, 'A newer installation is already active.');
      pairRecord(db, newDir, pair, build, cutoff);
      need(
        db
          .prepare(
            'UPDATE control SET active=?,generation=generation+1 WHERE slot=1 AND active=? AND generation=?'
          )
          .run(pair, old.pair, expectedGeneration).changes === 1,
        'Installation activation target changed.'
      );
      db.prepare("UPDATE upgrades SET phase='activated' WHERE id=?").run(operationId);
      return record(db, operationId, 'activate', input, {
        active: active(db, root),
        predecessor: old.pair,
        cutoff,
        migration,
        recoveryPoint: archiveManifest.recoveryPoint,
        predecessorEvidence: comparison.state
      });
    });
    syncDir(root);
    interrupt?.('after-activation');
    return result;
  } finally {
    lock?.close();
    db.close();
  }
}

export function abandonInstallation(
  { root, originalOperationId, expectedGeneration },
  operationId
) {
  need(
    validId(originalOperationId) &&
      validId(operationId) &&
      originalOperationId !== operationId &&
      Number.isSafeInteger(expectedGeneration) &&
      expectedGeneration > 0,
    'Invalid pending installation selector.',
    400
  );
  const db = registry(root),
    input = { originalOperationId, expectedGeneration };
  try {
    return tx(db, () => {
      const prior = receipt(db, operationId, 'abandon', input);
      if (prior) return prior;
      const pending = db
          .prepare("SELECT * FROM upgrades WHERE id=? AND phase='preparing'")
          .get(originalOperationId),
        current = active(db, root);
      need(
        pending &&
          current.pair === pending.oldPair &&
          current.generation === expectedGeneration &&
          !db.prepare('SELECT 1 FROM pairs WHERE id=?').get(pending.newPair),
        'Only an unpublished candidate of the current predecessor can be abandoned.'
      );
      const abandoned = {
        originalOperationId,
        operationId,
        outcome: 'not-activated',
        predecessor: current.pair
      };
      db.prepare("UPDATE upgrades SET phase='abandoned' WHERE id=?").run(originalOperationId);
      db.prepare('INSERT INTO operations VALUES(?,?,?)').run(
        originalOperationId,
        pending.digest,
        JSON.stringify({ abandoned })
      );
      return record(db, operationId, 'abandon', input, { abandoned });
    });
  } finally {
    db.close();
  }
}
