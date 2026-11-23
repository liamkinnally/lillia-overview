import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile, statfs, symlink, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { checkHash, requireCheck } from './project-workspace-check-catalog.mjs';
import { unpackCheckArchives, checkRuntimeTreeDigest } from './project-workspace-check-cache.mjs';

export const workspaceCheckPolicy = `(version 1)
(deny default)
(import "dyld-support.sb")
(allow sysctl-read)
(allow process-fork)
(allow signal (target self) (target children))
(allow process-exec (literal (param "node")) (literal "/bin/bash") (literal "/usr/bin/env") (subpath (param "inputs")))
(allow file-read* (subpath (param "inputs")) (subpath (param "scratch")) (subpath (param "npm"))
 (literal (param "node")) (literal "/bin/bash") (literal "/usr/bin/env") (literal "/dev/null") (literal "/dev/urandom"))
(allow file-read-metadata (literal "/") (literal "/private") (literal "/private/tmp") (subpath (param "base")))
(allow file-map-executable (literal (param "node")) (literal "/bin/bash") (literal "/usr/bin/env")
 (subpath (param "inputs")) (subpath "/usr/lib"))
(allow file-write* (subpath (param "scratch")))
(allow file-write-data (literal "/dev/null"))
`;
const launch = String.raw`import os,resource,sys
for which,soft,hard in [(resource.RLIMIT_CORE,0,0),(resource.RLIMIT_CPU,120,125),(resource.RLIMIT_FSIZE,536870912,536870912),(resource.RLIMIT_NOFILE,4096,4096)]:
 resource.setrlimit(which,(soft,hard))
os.execve('/usr/bin/sandbox-exec',sys.argv[1:],os.environ)
`;
export function executeCheckProcess(
  args,
  { cwd, env = {}, input = '', timeout = 120000, maxOutput = 1024 * 1024 }
) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-S', ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    });
    const stdout = [],
      stderr = [];
    let outputBytes = 0,
      stopped = false,
      settled = false;
    function kill() {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
    }
    function finish(code, signal, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      if (error) reject(error);
      else
        resolve({
          code,
          signal,
          stopped,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr)
        });
    }
    function stop() {
      stopped = true;
      finish(null, 'SIGKILL');
    }
    const timer = setTimeout(stop, timeout);
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr]
    ])
      stream.on('data', (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutput) {
          stop();
        } else chunks.push(chunk);
      });
    child.once('error', (error) => {
      finish(null, null, error);
    });
    child.once('close', (code, signal) => {
      finish(code, signal);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
function vitestOptions(check, files) {
  if (!/^vitest(?: run)?$/.test(check.scriptText.trim())) return null;
  const prefix = check.directory ? check.directory + '/' : '';
  const config = [
    'vitest.config.mts',
    'vitest.config.ts',
    'vitest.config.mjs',
    'vitest.config.js',
    'vite.config.mts',
    'vite.config.ts',
    'vite.config.mjs',
    'vite.config.js'
  ].find((name) => files.some((file) => file.path === prefix + name));
  return {
    config,
    args: [
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--pool=threads',
      '--no-cache',
      '--reporter=dot',
      '--configLoader=native'
    ]
  };
}

export function projectCheckCommand(check, files) {
  const args = [...check.command];
  const vitest = vitestOptions(check, files);
  if (vitest) {
    args.push('--', ...vitest.args);
    if (vitest.config) args.push('--config', '.project-check.config.mts');
  }
  return args;
}

export async function linkCheckDependencies(scratch, root) {
  await symlink(join(root, 'node_modules'), join(scratch, 'node_modules'));
}

export async function executeProjectCheck({ snapshot, dependencies, cache, toolchain }) {
  const space = await statfs('/private/tmp', { bigint: true });
  requireCheck(
    space.bavail * space.bsize >= 5n * 1024n ** 3n,
    'Insufficient temporary disk space for a repository check.'
  );
  const base = await mkdtemp('/private/tmp/lillia-project-check-');
  const inputs = join(base, 'source'),
    scratch = join(base, 'scratch');
  const check = snapshot.check,
    root = join(inputs, check.directory);
  try {
    await mkdir(inputs);
    await mkdir(scratch);
    const npmDirectory = join(base, 'tooling', 'npm');
    await cp(toolchain.npmDirectory, npmDirectory, {
      recursive: true,
      force: false,
      errorOnExist: true
    });
    requireCheck(
      (await checkRuntimeTreeDigest(npmDirectory)) === toolchain.npmDigest,
      'The private npm runtime differs from its enrolled bytes.'
    );
    for (const file of snapshot.files) {
      const out = join(inputs, file.path);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, file.bytes, {
        flag: 'wx',
        mode: file.mode === '100755' ? 0o500 : 0o400
      });
    }
    const unpacked = await executeCheckProcess(['-c', unpackCheckArchives, cache.directory], {
      cwd: root,
      input: JSON.stringify(dependencies),
      timeout: 90000,
      maxOutput: 8192
    });
    requireCheck(
      unpacked.code === 0 && !unpacked.stopped,
      'Pinned project dependencies could not be verified and unpacked.'
    );
    const args = check.command.slice(1);
    const vitest = vitestOptions(check, snapshot.files);
    if (vitest) {
      args.push('--', ...vitest.args);
      if (vitest.config) {
        const generated = '.project-check.config.mts';
        requireCheck(
          !snapshot.files.some(
            (file) => file.path === (check.directory ? check.directory + '/' : '') + generated
          ),
          'The reserved check configuration path exists in project source.'
        );
        const content =
          'import original from ' +
          JSON.stringify('./' + vitest.config) +
          ';\n' +
          'import {mergeConfig} from "vitest/config";\nexport default mergeConfig(original,{server:{host:"127.0.0.1",watch:null}});\n';
        await writeFile(join(root, generated), content, { flag: 'wx', mode: 0o400 });
        args.push('--config', generated);
      }
    }
    // npm/Vite caches live in disposable scratch, never beside retained input bytes.
    for (const name of ['.vite', '.vite-temp', '.cache']) {
      const destination = join(scratch, name);
      await mkdir(destination);
      await mkdir(join(root, 'node_modules'), { recursive: true });
      await symlink(destination, join(root, 'node_modules', name));
    }
    await linkCheckDependencies(scratch, root);
    for (const name of ['.next', 'coverage', 'dist', 'build', '.cache']) {
      const relative = (check.directory ? check.directory + '/' : '') + name;
      requireCheck(
        !snapshot.files.some(
          (file) => file.path === relative || file.path.startsWith(relative + '/')
        ),
        'A reserved check output directory contains retained source.'
      );
      const destination = join(scratch, 'output-' + name);
      await mkdir(destination);
      await symlink(destination, join(root, name));
    }
    if (dependencies.some((item) => item.path === 'node_modules/next')) {
      for (const name of ['next-env.d.ts', 'tsconfig.tsbuildinfo']) {
        const relative = (check.directory ? check.directory + '/' : '') + name;
        if (snapshot.files.some((file) => file.path === relative)) continue;
        const destination = join(scratch, name);
        await writeFile(destination, '', { flag: 'wx', mode: 0o600 });
        await symlink(destination, join(root, name));
      }
    }
    const params = { base, inputs, scratch, node: process.execPath, npm: npmDirectory };
    const command = [
      process.execPath,
      '--openssl-config=/dev/null',
      '--no-global-search-paths',
      '--max-old-space-size=768',
      join(npmDirectory, 'bin', 'npm-cli.js'),
      ...args
    ];
    const launched = [
      '/usr/bin/sandbox-exec',
      ...Object.entries(params).flatMap(([name, value]) => ['-D', name + '=' + value]),
      '-p',
      workspaceCheckPolicy,
      ...command
    ];
    const env = {
      HOME: scratch,
      TMPDIR: scratch,
      PATH: dirname(process.execPath) + ':/usr/bin:/bin',
      CI: '1',
      NO_COLOR: '1',
      TZ: 'UTC',
      GOMAXPROCS: '2',
      UV_THREADPOOL_SIZE: '2',
      DEBUG_PRINT_LIMIT: '800',
      NODE_OPTIONS: '--max-old-space-size=768 --no-global-search-paths',
      OPENSSL_CONF: '/dev/null',
      NPM_CONFIG_USERCONFIG: join(scratch, 'user.npmrc'),
      NPM_CONFIG_GLOBALCONFIG: join(scratch, 'global.npmrc'),
      NPM_CONFIG_CACHE: join(scratch, 'npm'),
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      NPM_CONFIG_AUDIT: 'false',
      NPM_CONFIG_FUND: 'false',
      NPM_CONFIG_OFFLINE: 'true'
    };
    env.NPM_CONFIG_SCRIPT_SHELL = '/bin/bash';
    await writeFile(env.NPM_CONFIG_USERCONFIG, '', { flag: 'wx', mode: 0o400 });
    await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '', { flag: 'wx', mode: 0o400 });
    env.NEXT_TELEMETRY_DISABLED = '1';
    env.RIOT_PUBLIC_LOOKUP_ENABLED = 'false';
    const started = performance.now();
    const result = await executeCheckProcess(['-c', launch, ...launched], { cwd: root, env });
    for (const file of snapshot.files)
      requireCheck(
        checkHash(await readFile(join(inputs, file.path))) === checkHash(file.bytes),
        'Repository input bytes changed during the check.'
      );
    const outcome =
      result.stopped || result.signal || !Number.isInteger(result.code)
        ? 'unavailable'
        : result.code === 0
          ? 'passed'
          : 'failed';
    const observation = {
      version: 1,
      repository: snapshot.repository,
      revisionId: snapshot.revisionId,
      scopeDigest: snapshot.scopeDigest,
      checkId: check.id,
      inputDigest: snapshot.inputDigest,
      toolchainDigest: checkHash(JSON.stringify(toolchain)),
      dependenciesDigest: cache.dependenciesDigest,
      command: ['npm', ...args],
      directory: check.directory,
      exitCode: result.code,
      signal: result.signal,
      stopped: result.stopped,
      stdoutDigest: checkHash(result.stdout),
      stderrDigest: checkHash(result.stderr),
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
      elapsedMs: Math.round(performance.now() - started)
    };
    const report = {
      outcome,
      observation,
      stdout: result.stdout.subarray(-16384).toString('utf8'),
      stderr: result.stderr.subarray(-16384).toString('utf8'),
      outputTruncated: result.stdout.length > 16384 || result.stderr.length > 16384,
      detail:
        outcome === 'unavailable'
          ? 'The repository check exceeded its bound or did not finish normally.'
          : null
    };
    return { ...report, reportDigest: checkHash(JSON.stringify(report)) };
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
