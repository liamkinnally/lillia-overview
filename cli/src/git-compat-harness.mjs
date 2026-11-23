import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { release } from 'node:os';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { nativeFileId, validateNativePath } from './native-store.mjs';

const exec = promisify(execFile),
  git = '/Library/Developer/CommandLineTools/usr/bin/git';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const harnessProfile = 'darwin25.3-authorized-git-fixture-v1';
const sb = `(version 1)(deny default)(import "dyld-support.sb")(allow sysctl-read)
(allow process-exec (literal (param "runtime")))
(allow file-read* file-map-executable (literal (param "runtime")) (subpath "/usr/lib"))
(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (subpath (param "checkout")))
(allow file-write-data (literal "/dev/null"))
(allow file-read-metadata (literal "/") (literal (param "parent")))`;
const program = `const fs=require('node:fs'),net=require('node:net'),crypto=require('node:crypto'),cp=require('node:child_process');
const [path,commit,neighbor,unix]=process.argv.slice(1),bytes=fs.readFileSync(path);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
let value=bytes.toString('utf8');if(path.endsWith('.json'))value=JSON.parse(value);
const artifact=Buffer.from(JSON.stringify({format:'git-fixture-json-v1',commit,path,value}));
function denied(fn){try{fn();return false;}catch(e){return e.code==='EPERM'||e.code==='EACCES';}}
const siblingDenied=denied(()=>fs.readFileSync(neighbor)),writeDenied=denied(()=>fs.appendFileSync(path,'!'));
const childDenied=['EPERM','EACCES'].includes(cp.spawnSync(process.execPath,['--version']).error?.code);
const blocked=arg=>new Promise(resolve=>{const socket=net.connect(arg);socket.once('connect',()=>{socket.destroy();resolve(false);});
socket.once('error',e=>resolve(['EPERM','EACCES'].includes(e.code)));});
Promise.all([blocked({port:9,host:'127.0.0.1'}),blocked({path:unix})]).then(([networkDenied,socketDenied])=>{
if(!networkDenied||!socketDenied||!siblingDenied||!writeDenied||!childDenied)process.exit(8);
console.log(JSON.stringify({sourceDigest:sha(bytes),artifact:artifact.toString('base64'),siblingDenied,writeDenied,childDenied,networkDenied,socketDenied}));});`;
function need(ok, msg) {
  if (!ok) throw Object.assign(new Error(msg), { status: 409 });
}
const env = {
  PATH: '/usr/bin:/bin',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0'
};
export const gitReadCommands = ['status', 'diff', 'log', 'show'];
export function gitReadSet(operations) {
  if (
    !Array.isArray(operations) ||
    !operations.length ||
    operations.length > 4 ||
    new Set(operations).size !== operations.length ||
    operations.some((op) => !gitReadCommands.includes(op))
  )
    throw Object.assign(Error('Select unique status, diff, log or show operations.'), {
      status: 400
    });
  return gitReadCommands.filter((op) => operations.includes(op));
}
const gitHash = (type, body) =>
  createHash('sha1')
    .update(type + ' ' + body.length + '\0')
    .update(body)
    .digest();
function gitSubject({ sourceRevision, path, bytes }) {
  validateNativePath(path);
  need(
    /^[a-f0-9]{64}$/.test(sourceRevision) &&
      bytes.length <= 4096 &&
      /\.(txt|json)$/.test(path) &&
      !path.split('/').some((x) => x.startsWith('.')),
    'Unsupported Git projection subject'
  );
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    need(false, 'Projection requires UTF-8 text');
  }
  need(!text.includes('\0'), 'Projection requires a text file');
  return text;
}
export function expectedGitReads({ sourceRevision, path, bytes, operations }) {
  const text = gitSubject({ sourceRevision, path, bytes }),
    ops = gitReadSet(operations),
    subject = 'Authorized native file ' + sourceRevision;
  let id = gitHash('blob', bytes),
    mode = '100644';
  for (const part of path.split('/').reverse()) {
    id = gitHash('tree', Buffer.concat([Buffer.from(mode + ' ' + part + '\0'), id]));
    mode = '40000';
  }
  const actor = 'Scoped projection <projection@localhost.invalid> 1 +0000';
  const commit = gitHash(
    'commit',
    Buffer.from(
      'tree ' +
        id.toString('hex') +
        '\nauthor ' +
        actor +
        '\ncommitter ' +
        actor +
        '\n\n' +
        subject +
        '\n'
    )
  ).toString('hex');
  const values = {
    status: { porcelain: '' },
    diff: { patch: '' },
    log: { commit, subject },
    show: { path, text }
  };
  return {
    profile: 'darwin-confined-git-reads-v1',
    gitVersion: 'git version 2.39.5 (Apple Git-154)',
    sourceRevision,
    path,
    fileId: nativeFileId(bytes),
    policyDigest: sha(sb),
    results: Object.fromEntries(ops.map((k) => [k, values[k]]))
  };
}
export async function runGitReads(input) {
  const operations = gitReadSet(input.operations);
  gitSubject(input);
  return projection(input, operations);
}
export async function runCompatibilityHarness(input) {
  return projection(input, null);
}
async function projection({ sourceRevision, path, bytes }, operations) {
  validateNativePath(path);
  need(
    process.platform === 'darwin' && process.arch === 'arm64' && release() === '25.3.0',
    'Unsupported Git compatibility worker host'
  );
  need(
    process.version === 'v24.22.2' &&
      bytes.length <= 4096 &&
      /\.(txt|json)$/.test(path) &&
      !path.split('/').some((x) => x.startsWith('.')),
    'Unsupported Git fixture source or runtime'
  );
  need(
    sha(await readFile('/System/Library/Sandbox/Profiles/dyld-support.sb')) ===
      '06215a5d32689aefe395c29710e182eb54ba22162f50df8b4842290f8a19bf1c',
    'The Git worker loader policy has changed'
  );
  // This scratch repository is synthesized from one authorized immutable file.
  // It has no parent commit, hooks, alternate object store, remotes or credentials.
  const root = await realpath(await mkdtemp('/private/tmp/lillia-git-role-')),
    checkout = join(root, 'view'),
    neighbor = join(root, 'outside-fixture');
  const socket = join(root, 'private.sock'),
    server = operations ? null : createServer((c) => c.destroy());
  const options = {
    env,
    cwd: checkout,
    encoding: 'buffer',
    timeout: 3000,
    killSignal: 'SIGKILL',
    maxBuffer: 32768
  };
  const gitArgs = [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.attributesFile=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'protocol.allow=never'
  ];
  const confined = async (runtime, args) =>
    (
      await exec(
        '/usr/bin/sandbox-exec',
        [
          '-D',
          'runtime=' + runtime,
          '-D',
          'checkout=' + checkout,
          '-D',
          'parent=' + root,
          '-p',
          sb,
          runtime,
          ...args
        ],
        options
      )
    ).stdout;
  try {
    if (server)
      await new Promise((resolve, reject) => server.once('error', reject).listen(socket, resolve));
    await mkdir(checkout, { mode: 0o700 });
    await mkdir(dirname(join(checkout, path)), { recursive: true, mode: 0o700 });
    if (server) await writeFile(neighbor, 'deny', { mode: 0o600 });
    await writeFile(join(checkout, path), bytes, { mode: 0o600 });
    await exec(git, [...gitArgs, 'init', '-q', '--template=', '--initial-branch=scoped'], options);
    await exec(git, [...gitArgs, 'add', '--', path], options);
    await exec(
      git,
      [
        ...gitArgs,
        '-c',
        'user.name=Scoped projection',
        '-c',
        'user.email=projection@localhost.invalid',
        'commit',
        '-qm',
        'Authorized native file ' + sourceRevision
      ],
      { ...options, env: { ...env, GIT_AUTHOR_DATE: '@1 +0000', GIT_COMMITTER_DATE: '@1 +0000' } }
    );
    const read = (args) => confined(git, [...gitArgs, ...args]);
    const gitVersion = (await read(['--version'])).toString().trim();
    need(gitVersion === 'git version 2.39.5 (Apple Git-154)', 'Unsupported worker Git build');
    if (operations) {
      const expected = expectedGitReads({ sourceRevision, path, bytes, operations }),
        results = {};
      for (const operation of operations) {
        if (operation === 'status')
          results.status = { porcelain: (await read(['status', '--porcelain=v1'])).toString() };
        if (operation === 'diff')
          results.diff = { patch: (await read(['diff', '--no-ext-diff'])).toString() };
        if (operation === 'log') {
          const [commit, subject] = (await read(['log', '-1', '--format=%H%n%s']))
            .toString()
            .trimEnd()
            .split('\n');
          results.log = { commit, subject };
        }
        if (operation === 'show')
          results.show = { path, text: (await read(['show', 'HEAD:' + path])).toString('utf8') };
      }
      need(
        JSON.stringify(results) === JSON.stringify(expected.results),
        'Confined Git command output differs from its exact projection.'
      );
      return { ...expected, results };
    }
    const gitId = (await read(['log', '-1', '--format=%H'])).toString().trim();
    need(
      /^[a-f0-9]{40}$/.test(gitId) &&
        !(await read(['status', '--porcelain=v1'])).length &&
        !(await read(['diff', '--no-ext-diff'])).length &&
        (await read(['show', gitId + ':' + path])).equals(bytes),
      'Confined Git view differs from its exact grant'
    );
    const runtime = await realpath(process.execPath);
    const out = JSON.parse(
      (
        await confined(runtime, [
          '--openssl-config=/dev/null',
          '--jitless',
          '--no-addons',
          '--no-global-search-paths',
          '-e',
          program,
          path,
          gitId,
          neighbor,
          socket
        ])
      ).toString()
    );
    const value = path.endsWith('.json') ? JSON.parse(bytes.toString()) : bytes.toString();
    const built = Buffer.from(
      JSON.stringify({ format: 'git-fixture-json-v1', commit: gitId, path, value })
    );
    need(
      out.sourceDigest === sha(bytes) &&
        out.artifact === built.toString('base64') &&
        out.siblingDenied &&
        out.writeDenied &&
        out.childDenied &&
        out.networkDenied &&
        out.socketDenied,
      'Worker artifact or enforced boundary probe failed'
    );
    return {
      profile: harnessProfile,
      gitVersion,
      nodeVersion: process.version,
      policyDigest: sha(sb),
      scriptDigest: sha(program),
      gitId,
      history: 'one authorized file, one synthetic root commit',
      sourceRevision,
      path,
      fileId: nativeFileId(bytes),
      sourceDigest: sha(bytes),
      artifactFormat: 'git-fixture-json-v1',
      artifactDigest: sha(built),
      artifactBytes: built.length,
      artifactBase64: built.toString('base64'),
      checks: ['status', 'diff', 'log', 'show', 'fixture-build'],
      denied: [
        'sibling-read',
        'source-write',
        'subprocess',
        'loopback-network',
        'private-unix-socket'
      ]
    };
  } catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error('The fixed isolated Git fixture could not complete'), {
      status: 409,
      cause: error
    });
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { force: true, recursive: true });
  }
}
