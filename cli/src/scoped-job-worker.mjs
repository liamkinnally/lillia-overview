import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { release } from 'node:os';
import { jobSocketPath, safeJobLocation } from './job-client.mjs';
import { validateJobPacket } from './job-capabilities.mjs';

const perl = '/usr/bin/perl5.34';
const failure = (message, status = 409) => Object.assign(new Error(message), { status });
export const jobWorkerProfile = 'darwin-seatbelt-job-v1';
export const jobSeatbeltProfile = [
  '(version 1)',
  '(deny default)',
  '(import "dyld-support.sb")',
  '(allow process-exec (literal "/usr/bin/perl5.34"))',
  '(allow sysctl-read)',
  '(allow file-read* file-write-data (literal "/dev/null"))',
  '(allow file-read* file-map-executable (subpath "/usr/lib") (subpath "/System/Library/Perl") (literal "/usr/bin/perl5.34"))',
  '(allow file-read-data file-read-metadata (literal (param "credential")))',
  '(allow network-outbound (literal (param "jobSocket")))'
].join('\n');

// HTTP/1.0 requests a close-delimited response. The fixed child accepts no executable instructions.
const program = String.raw`
BEGIN { @INC=('/System/Library/Perl/5.34/darwin-thread-multi-2level','/System/Library/Perl/5.34'); }
use strict; use warnings; use Fcntl; use Socket; use JSON::PP;
binmode STDIN; binmode STDOUT; alarm 5;
my ($socket,$credential,$identity)=@ARGV;
my ($file)=$credential=~/\A(\/[^\x00\r\n]+)\z/;my ($sock)=$socket=~/\A(\/[^\x00\r\n]+)\z/;exit 10 unless $file && $sock;
sysopen(my $fh,$file,O_RDONLY|O_NONBLOCK|0x20000000) or exit 11;
my @st=stat($fh);exit 11 unless @st && "$st[0]:$st[1]" eq $identity && ($st[2]&0177777)==0100600 && $st[3]==1 && $st[4]==$< && $st[7]==44;
my $n=sysread($fh,my $token,45);exit 11 unless defined $n && $n==44 && $token=~/\A([a-zA-Z0-9_-]{43})\n\z/;
my $secret=$1;close($fh) or exit 11;my $json='';while(length($json)<=16384){my $k=sysread(STDIN,my $part,2048);defined $k or exit 10;last unless $k;$json.=$part;}
exit 10 if length($json)>16384 || index($json,$secret)>=0;my $body=decode_json($json);exit 10 unless ref($body) eq 'HASH' && !exists $body->{secret};
$body->{secret}=$secret;my $bytes=encode_json($body);
socket(my $s,AF_UNIX,SOCK_STREAM,0) or exit 12;connect($s,sockaddr_un($sock)) or exit 12;binmode $s;
my $req="POST /v1/job HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ".length($bytes)."\r\n\r\n".$bytes;
my $at=0;while($at<length($req)){my $k=syswrite($s,$req,length($req)-$at,$at);defined $k && $k>0 or exit 13;$at+=$k;}
my $res='';while(length($res)<=70000){my $k=sysread($s,my $chunk,4096);defined $k or exit 13;last unless $k;$res.=$chunk;}
exit 13 unless length($res)<=70000;my ($headers,$out)=split(/\r\n\r\n/,$res,2);exit 13 unless defined $out && length($headers)<=4096 && length($out)<=65536 && index($out,$secret)<0;
my ($status)=$headers=~/\AHTTP\/1\.[01] ([0-9]{3}) /;exit 13 unless defined $status;
exit 14 if $status==403;exit 15 if $status==409;exit 13 unless $status==200;
exit 13 if $headers=~/\r\nTransfer-Encoding:/i;my ($len)=$headers=~/\r\nContent-Length: ([0-9]+)/i;exit 13 if defined $len && length($out)!=$len;
print STDOUT $out or exit 13;
`;
export async function runRestrictedJob({ dataDir, credentialFile, packet }) {
  validateJobPacket(packet, { withSecret: false });
  if (
    packet.backend !== 'native' ||
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    release() !== '25.3.0'
  )
    throw failure('Unsupported native job isolation profile.');
  const credential = await safeJobLocation(credentialFile),
    socket = await safeJobLocation(jobSocketPath(dataDir));
  const st = await lstat(credential, { bigint: true }),
    ss = await lstat(socket);
  if (
    !ss.isSocket() ||
    ss.uid !== process.getuid() ||
    ss.mode & 0o077 ||
    !st.isFile() ||
    st.uid !== BigInt(process.getuid()) ||
    st.nlink !== 1n ||
    (st.mode & 0o777n) !== 0o600n ||
    st.size !== 44n
  )
    throw failure('Private worker file or endpoint unavailable.');
  if (
    createHash('sha256')
      .update(await readFile('/System/Library/Sandbox/Profiles/dyld-support.sb'))
      .digest('hex') !== '06215a5d32689aefe395c29710e182eb54ba22162f50df8b4842290f8a19bf1c'
  )
    throw failure('The installed macOS loader profile changed.');
  const body = JSON.stringify(packet);
  if (Buffer.byteLength(body) > 16384)
    throw failure('Job packet exceeds its bounded worker profile.', 400);
  const args = [
    '-D',
    'credential=' + credential,
    '-D',
    'jobSocket=' + socket,
    '-p',
    jobSeatbeltProfile,
    perl,
    '-f',
    '-T',
    '-e',
    program,
    '--',
    socket,
    credential,
    String(st.dev) + ':' + String(st.ino)
  ];
  return new Promise((resolve, reject) => {
    const proc = execFile(
      '/usr/bin/sandbox-exec',
      args,
      {
        cwd: '/',
        shell: false,
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
        timeout: 6500,
        killSignal: 'SIGKILL',
        maxBuffer: 65536
      },
      (error, stdout) => {
        if (error)
          return reject(
            failure(
              error.code === 14
                ? 'Native job access denied.'
                : error.code === 15
                  ? 'Native job conflicts with its scope.'
                  : 'Restricted job outcome unconfirmed. For observations replay the same operation ID.',
              error.code === 14 ? 403 : error.code === 15 ? 409 : 503
            )
          );
        try {
          const reply = JSON.parse(stdout);
          if (reply.version !== 1 || !Object.hasOwn(reply, 'result')) throw Error();
          resolve({ version: 1, result: reply.result });
        } catch {
          reject(failure('Invalid restricted job response.', 503));
        }
      }
    );
    proc.stdin.on('error', () => {});
    proc.stdin.end(body);
  });
}
