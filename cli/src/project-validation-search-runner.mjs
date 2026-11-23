import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, statfs } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import {
  dependencySet,
  extractProgram,
  requireCheck,
  sum,
  cacheDirectory,
  hostToolchain
} from './project-validation-tools.mjs';
import { runnerConfig, seatbelt } from './project-validation-profile.mjs';
import { parseCheck } from './project-validation-runner.mjs';
import { projectValidationTarget, playerSearchProfile } from './project-validation-targets.mjs';

const python = '/usr/bin/python3';
const launch = String.raw`import os,resource,sys
for which,soft,hard in [(resource.RLIMIT_CORE,0,0),(resource.RLIMIT_CPU,24,26),(resource.RLIMIT_FSIZE,0,0),(resource.RLIMIT_NOFILE,256,256)]:
 resource.setrlimit(which,(soft,hard))
os.execve('/usr/bin/sandbox-exec',sys.argv[1:],os.environ)
`;
function execute(args, { cwd, env = {}, input = '', timeout, maxOutput }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-S', ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    });
    let bytes = 0,
      stopped = false;
    const out = [],
      err = [];
    function kill() {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    const timer = setTimeout(() => {
      stopped = true;
      kill();
    }, timeout);
    for (const [stream, chunks] of [
      [child.stdout, out],
      [child.stderr, err]
    ])
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxOutput) {
          stopped = true;
          kill();
        } else chunks.push(chunk);
      });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      kill();
      resolve({ code, stopped, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function runPlayerSearchCheck({ dataDir, files }) {
  const target = projectValidationTarget(playerSearchProfile);
  await hostToolchain();
  const stats = await statfs('/private/tmp', { bigint: true });
  requireCheck(
    stats.bavail * stats.bsize >= 3n * 1024n ** 3n,
    'Insufficient headroom for isolated component testing.'
  );
  const dir = await mkdtemp('/private/tmp/lillia-search-component-'),
    root = join(dir, 'frontend'),
    scratch = join(dir, 'scratch');
  try {
    await mkdir(root);
    await mkdir(scratch);
    for (const { path, bytes } of files) {
      const file = join(dir, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes, { flag: 'wx', mode: 0o400 });
    }
    await writeFile(join(root, 'isolated.config.mts'), runnerConfig, { flag: 'wx', mode: 0o400 });
    const lock = files.find((file) => file.path === 'frontend/package-lock.json')?.bytes;
    requireCheck(lock, 'The player-search package lock is unavailable.');
    const deps = dependencySet(lock);
    const prepared = await execute(['-c', extractProgram, cacheDirectory(dataDir)], {
      cwd: root,
      input: JSON.stringify(deps),
      timeout: 45000,
      maxOutput: 8192
    });
    requireCheck(
      prepared.code === 0 && !prepared.stopped,
      'Pinned dependencies could not be verified and unpacked. Re-enroll the local toolchain cache.'
    );
    const exe = process.execPath,
      esbuild = join(root, 'node_modules/@esbuild/darwin-arm64/bin/esbuild');
    const params = {
      base: dir,
      node: exe,
      inputs: root,
      scratch,
      esbuild,
      rollup: join(root, 'node_modules/@rollup/rollup-darwin-arm64/rollup.darwin-arm64.node')
    };
    const args = [
      '/usr/bin/sandbox-exec',
      ...Object.entries(params).flatMap(([key, value]) => ['-D', key + '=' + value]),
      '-p',
      seatbelt,
      exe,
      '--openssl-config=/dev/null',
      '--no-global-search-paths',
      '--max-old-space-size=384',
      join(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      'isolated.config.mts',
      target.testPath.slice(9),
      '--configLoader',
      'native',
      '--no-cache',
      '--pool=threads',
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--reporter=json'
    ];
    const env = {
      HOME: scratch,
      TMPDIR: scratch,
      ESBUILD_BINARY_PATH: esbuild,
      CI: '1',
      NO_COLOR: '1',
      TZ: 'UTC',
      GOMAXPROCS: '2',
      UV_THREADPOOL_SIZE: '2',
      DEBUG_PRINT_LIMIT: '800'
    };
    const result = parseCheck(
      await execute(['-c', launch, ...args], {
        cwd: root,
        env,
        timeout: 35000,
        maxOutput: 65536
      }),
      join(dir, target.testPath)
    );
    if (result.observation) {
      result.observation.testPath = target.testPath;
      result.reportDigest = sum(
        JSON.stringify([result.observation, result.checks, result.outcome])
      );
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
