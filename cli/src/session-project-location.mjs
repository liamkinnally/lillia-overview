import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const hintName = 'last-project.json';
const hiddenPathCharacters = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
function inside(root, path) {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part));
}

export async function findProject(input, { cwd = process.cwd(), home = homedir() } = {}) {
  if (typeof input !== 'string' || !input.trim() || hiddenPathCharacters.test(input))
    throw Error('Enter a Git project directory.');
  const path =
    input === '~'
      ? home
      : input.startsWith('~/')
        ? join(home, input.slice(2))
        : resolve(cwd, input);
  let root, directory;
  try {
    directory = await realpath(path);
    // Ambient Git variables can point at a different checkout than the one the owner selected.
    const { stdout } = await exec(
      '/usr/bin/git',
      ['-C', directory, 'rev-parse', '--show-toplevel'],
      {
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_OPTIONAL_LOCKS: '0'
        },
        timeout: 5000,
        maxBuffer: 32768
      }
    );
    root = await realpath(stdout.replace(/\n$/, ''));
  } catch {
    throw Error('Choose an existing directory inside a Git project.');
  }
  if (!inside(root, directory) || hiddenPathCharacters.test(root))
    throw Error(
      'The Git project root must contain the selected directory and have a printable path.'
    );
  const personalHome = await realpath(home);
  if (inside(root, personalHome))
    throw Error('Choose a project below or outside your home directory.');
  return root;
}

export async function currentProject(cwd = process.cwd()) {
  try {
    return await findProject('.', { cwd });
  } catch {
    return null;
  }
}

export async function privateDirectory(path, create = true) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (!st.isDirectory() || st.uid !== process.getuid() || st.mode & 0o077)
    throw Error('A private directory owned by your account is required: ' + path);
  return realpath(path);
}

async function intendedDirectory(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    return resolve(await intendedDirectory(parent), relative(parent, path));
  }
}

export async function guidedHome(root, create = true) {
  const path = resolve(
    process.env.LILLIA_CLI_HOME || join(homedir(), '.local', 'share', 'lillia-cli')
  );
  if (root && (inside(root, path) || inside(root, await intendedDirectory(path))))
    throw Error('Choose a private LILLIA_CLI_HOME outside the project.');
  const result = await privateDirectory(path, create);
  if (root && inside(root, result))
    throw Error('The private settings directory resolves inside the project.');
  return result;
}

export async function lastProject() {
  try {
    const home = await guidedHome(null, false);
    const file = await open(
      join(home, hintName),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const st = await file.stat();
      if (
        !st.isFile() ||
        st.uid !== process.getuid() ||
        st.mode & 0o077 ||
        st.size > 8192 ||
        st.nlink !== 1
      )
        return null;
      const { version, workspaceRoot } = JSON.parse(await file.readFile('utf8'));
      if (version !== 1 || typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot))
        return null;
      return (await findProject(workspaceRoot)) === workspaceRoot ? workspaceRoot : null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

export async function rememberProject(root) {
  if ((await findProject(root)) !== root) throw Error('Choose the canonical Git project root.');
  const home = await guidedHome(root);
  const temp = join(home, '.' + hintName + '-' + randomUUID());
  const file = await open(temp, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify({ version: 1, workspaceRoot: root }) + '\n');
    } finally {
      await file.close();
    }
    await rename(temp, join(home, hintName));
  } finally {
    await rm(temp, { force: true });
  }
}
