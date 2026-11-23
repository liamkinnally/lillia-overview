import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { release } from 'node:os';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const digest = (b) => createHash('sha256').update(b).digest('hex');
const runtime = '/usr/bin/perl5.34';
export const fileWorkerProfile = 'darwin-seatbelt-file-v1';
const dyldProfile = '/System/Library/Sandbox/Profiles/dyld-support.sb';
const dyldDigest = '06215a5d32689aefe395c29710e182eb54ba22162f50df8b4842290f8a19bf1c';
const conflict = (message) => Object.assign(new Error(message), { status: 409 });
function need(x, message) {
  if (!x) throw conflict(message);
}

// File authority enters through a sandbox-exec parameter, never through
// interpolation into Seatbelt source. The write grant is existing-file data only.
export function workspaceSeatbeltProfile(write) {
  need(typeof write === 'boolean', 'Invalid workspace worker profile');
  return [
    '(version 1)',
    '(deny default)',
    '(import "dyld-support.sb")',
    '(allow process-exec (literal "/usr/bin/perl5.34"))',
    '(allow sysctl-read)',
    '(allow file-read* file-write-data (literal "/dev/null"))',
    '(allow file-read* file-map-executable (subpath "/usr/lib") (subpath "/System/Library/Perl") (literal "/usr/bin/perl5.34"))',
    '(allow file-read-metadata file-read-data (literal (param "selected")))',
    ...(write ? ['(allow file-write-data (literal (param "selected")))'] : [])
  ].join('\n');
}
const program = String.raw`
BEGIN { @INC=('/System/Library/Perl/5.34/darwin-thread-multi-2level','/System/Library/Perl/5.34'); }
use strict; use warnings; use Fcntl; use Digest::SHA qw(sha256_hex); use IO::Handle;
binmode STDIN; binmode STDOUT;
my ($op,$raw,$identity,$expected)=@ARGV;
my ($file)=$raw=~/\A(\/[^\x00\r\n]+)\z/; exit 31 unless defined $file;
my $write=$op eq 'write'; exit 31 unless $write || $op eq 'validate' || $op eq 'read';
sysopen(my $fd,$file,($write ? O_RDWR : O_RDONLY)|O_NONBLOCK|0x20000000) or exit 32;
binmode $fd;
my @st=stat($fd);
exit 32 unless @st && "$st[0]:$st[1]" eq $identity && $st[3]==1 && $st[4]==$< &&
  ($st[2]&0177777)==0100600 && $st[7]<=4096;
sub read_file {
  my ($handle)=@_;my $value='';defined sysseek($handle,0,0) or exit 33;
  while(length($value)<=4096) {my $n=sysread($handle,my $chunk,4097-length($value));defined $n or exit 33;last unless $n;$value.=$chunk;}
  exit 33 if length($value)>4096;return $value;
}
my $value=read_file($fd);exit 34 unless sha256_hex($value) eq $expected;
if($write){
  my $new='';
  while(length($new)<=4096){my $n=sysread(STDIN,my $chunk,4097-length($new));defined $n or exit 35;last unless $n;$new.=$chunk;}
  exit 35 if length($new)>4096;
  defined sysseek($fd,0,0) or exit 35;my $offset=0;
  while($offset<length($new)){my $n=syswrite($fd,$new,length($new)-$offset,$offset);defined $n && $n>0 or exit 35;$offset+=$n;}
  my ($size)=length($new)=~/\A([0-9]{1,4})\z/;defined $size or exit 35;truncate($fd,$size) or exit 35;$fd->sync or exit 35;
  $value=read_file($fd);exit 35 unless $value eq $new;
}
close($fd) or exit 35;
print STDOUT ($op eq 'read' ? $value : sha256_hex($value)) or exit 36;
`;
function execute(args, cwd, input) {
  return new Promise((ok, fail) => {
    const child = execFile(
      '/usr/bin/sandbox-exec',
      args,
      {
        cwd,
        encoding: 'buffer',
        shell: false,
        timeout: 3500,
        killSignal: 'SIGKILL',
        maxBuffer: 8192,
        env: { LC_ALL: 'C', LANG: 'C', PATH: '/usr/bin:/bin' }
      },
      (err, stdout) => {
        if (!err) return ok(stdout);
        const messages = {
          32: 'Lease file identity, mode or read permission changed',
          33: 'Workspace file read failed',
          34: 'Workspace digest changed',
          35: 'Workspace write did not verify'
        };
        const error = conflict(
          messages[err.code] ??
            'The macOS isolated worker could not complete under its required profile'
        );
        if (input !== undefined && ![31, 32, 34].includes(err.code)) error.uncertain = true;
        fail(error);
      }
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
// Internal worker primitive. The lease coordinator owns the exclusive generation,
// authenticates proposed bytes and fences uncertain results before reuse.
export async function runIsolatedFile(grant, op) {
  need(
    process.platform === 'darwin' && process.arch === 'arm64' && release() === '25.3.0',
    'Unsupported Darwin worker profile'
  );
  need(
    grant &&
      typeof grant.dataDir === 'string' &&
      isAbsolute(grant.dataDir) &&
      typeof grant.workspaceId === 'string' &&
      /^[a-f0-9-]{36}$/.test(grant.workspaceId) &&
      typeof grant.path === 'string' &&
      grant.path.length <= 240 &&
      grant.path.split('/').every((s) => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(s)) &&
      /^[a-f0-9]{64}$/.test(grant.expectedDigest),
    'Invalid isolated workspace file grant'
  );
  need(
    op &&
      ['read', 'validate', 'write'].includes(op.kind) &&
      Object.keys(op).every((k) => k === 'kind' || (k === 'bytes' && op.kind === 'write')),
    'Unknown isolated worker operation'
  );
  grant = structuredClone(grant);
  const write = op.kind === 'write';
  op = { ...op };
  need(
    !write || (Buffer.isBuffer(op.bytes) && op.bytes.length <= 4096),
    'Supply at most 4 KiB of authenticated file data'
  );
  const input = write ? Buffer.from(op.bytes) : undefined;
  const data = await realpath(grant.dataDir),
    home = join(data, 'agent-workspaces'),
    cwd = join(home, grant.workspaceId),
    parts = grant.path.split('/');
  const dirs = [data, home, cwd];
  let parent = cwd;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    dirs.push(parent);
  }
  const identity = [];
  for (const dir of dirs) {
    const s = await lstat(dir, { bigint: true });
    need(
      s.isDirectory() &&
        (s.mode & 0o077n) === 0n &&
        s.uid === BigInt(process.getuid()) &&
        (await realpath(dir)) === dir,
      'Invalid private workspace directory'
    );
    if (dir !== data && dir !== home) identity.push(String(s.dev) + ':' + String(s.ino));
  }
  const file = join(cwd, grant.path),
    s = await lstat(file, { bigint: true });
  need(
    s.isFile() &&
      s.nlink === 1n &&
      s.uid === BigInt(process.getuid()) &&
      s.size <= 4096n &&
      (s.mode & 0o777n) === 0o600n,
    'Invalid isolated workspace regular file'
  );
  identity.push(String(s.dev) + ':' + String(s.ino));
  need(
    Array.isArray(grant.identity) && JSON.stringify(identity) === JSON.stringify(grant.identity),
    'Isolated workspace identity changed'
  );
  need(
    digest(await readFile(dyldProfile)) === dyldDigest,
    'The verified macOS loader profile changed'
  );
  const args = [
    '-D',
    'selected=' + file,
    '-p',
    workspaceSeatbeltProfile(write),
    runtime,
    '-f',
    '-T',
    '-e',
    program,
    '--',
    op.kind,
    file,
    identity.at(-1),
    grant.expectedDigest
  ];
  const output = await execute(args, cwd, input);
  const actual = op.kind === 'read' ? digest(output) : output.toString('ascii'),
    expected = write ? digest(input) : grant.expectedDigest;
  if (actual !== expected || output.length > (op.kind === 'read' ? 4096 : 64)) {
    const error = conflict('Isolated workspace worker returned unverified data');
    if (write) error.uncertain = true;
    throw error;
  }
  return {
    profile: fileWorkerProfile,
    digest: actual,
    ...(op.kind === 'read' ? { bytes: output } : {})
  };
}
