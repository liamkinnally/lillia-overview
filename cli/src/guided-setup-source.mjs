import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { codexProjectProfileScope } from './effective-config.mjs';
import { nativeFileId } from './native-store.mjs';
import { hostToolchain } from './project-validation-tools.mjs';
import { discoverProjectChecks } from './project-workspace-check-catalog.mjs';
import { createProjectSourceScope, isEligible } from './project-workspace-scope.mjs';

const bundledCodex =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

function requireSetup(ok, message) {
  if (!ok) throw new Error(message);
}

export function git(root, args, maxBuffer = 4 * 1024 * 1024, input) {
  return execFileSync(
    '/usr/bin/git',
    [
      '--no-replace-objects',
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-C',
      root,
      ...args
    ],
    {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        LANG: 'C'
      },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      input,
      maxBuffer,
      timeout: 15000
    }
  );
}

export function currentHead(root) {
  const head = git(root, ['rev-parse', '--verify', 'HEAD']).toString().trim();
  requireSetup(/^[a-f0-9]{40}$/.test(head), 'Use a SHA-1 Git repository with a committed HEAD.');
  requireSetup(
    !git(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none'
    ]).length,
    'Commit or set aside staged, unstaged and untracked files before setup.'
  );
  return head;
}

// Discover commands from immutable Git blobs with the same catalog the native workspace uses.
// Only package metadata enters this preview. The daemon constructs the full source scope at start.
export function previewChecks(root, head, repository) {
  const listing = git(root, ['ls-tree', '-r', '-l', '-z', head]);
  const blobs = new Map(),
    entries = [];
  for (const record of listing.toString('utf8').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t'),
      path = record.slice(tab + 1);
    if (!/(?:^|\/)package(?:-lock)?\.json$/.test(path) || !isEligible(path, [''], [])) continue;
    const [mode, type, oid, bytes] = record.slice(0, tab).trim().split(/\s+/);
    requireSetup(
      type === 'blob' && Number(bytes) <= 4 * 1024 * 1024,
      'Package metadata exceeds the import limit.'
    );
    const content = git(root, ['cat-file', 'blob', oid], 4 * 1024 * 1024 + 1);
    const entry = { path, mode, fileId: nativeFileId(content) };
    entries.push(entry);
    blobs.set(path, { ...entry, bytes: content });
  }
  const native = {
    select: () => ({
      entries,
      read(path) {
        requireSetup(
          blobs.has(path),
          'Commit a version 3 package-lock.json beside ' +
            JSON.stringify(path.replace(/package-lock\.json$/, 'package.json')) +
            '.'
        );
        return blobs.get(path);
      }
    })
  };
  const revision = createHash('sha256').update(head).digest('hex');
  const scope = createProjectSourceScope(native, {
    repository,
    baseRevision: revision,
    allowedRoots: ['']
  });
  const checks = discoverProjectChecks(native, scope);
  requireSetup(
    checks.length <= 8,
    'Workspace validation supports at most eight discovered repository checks.'
  );
  return checks;
}

export async function qualifiedCodex() {
  await hostToolchain();
  const binary = existsSync(bundledCodex) ? bundledCodex : 'codex';
  const output = execFileSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  const version = /^codex-cli (\S+)$/.exec(output)?.[1];
  try {
    codexProjectProfileScope('gpt-6.2-astra', 'author', version, 5);
  } catch {
    throw new Error(
      'The installed Codex version is outside the qualified project profile: ' + output
    );
  }
  return version;
}
