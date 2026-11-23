import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inspectIssue, progressText, runIssue } from './guided-run.mjs';
import { findProject, guidedHome, privateDirectory } from './session-project-location.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
export const guidedHelp = `In a small, trusted macOS npm project:
  lillia setup                 Review settings before saving. Starts no model work.
  lillia setup --edit          Change the saved output directory and run limits.
  lillia run "issue"           Start or recover a coding task.
  lillia progress [goal]       Read its status and review.
  lillia result [goal]         Export an approved change as a Git patch.`;

export async function guidedContext(expectedRoot) {
  let workspaceRoot;
  try {
    workspaceRoot = await findProject(expectedRoot ?? '.');
  } catch {
    throw Error('Open the Git project you want to work on and run lillia setup.');
  }
  if (expectedRoot !== undefined && workspaceRoot !== expectedRoot)
    throw Error('The selected Git project root changed. Confirm its new location.');
  const homePath = await guidedHome(workspaceRoot);
  const key = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 20);
  const stateDir = await privateDirectory(join(homePath, key));
  const dataDir = join(stateDir, 'data');
  if (Buffer.byteLength(join(dataDir, 'daemon.sock')) > 103)
    throw Error(
      'Choose a shorter private directory with LILLIA_CLI_HOME so the local socket path fits.'
    );
  const command = async (args) => {
    try {
      const { stdout } = await exec(process.execPath, [cli, '--json', ...args], {
        cwd: workspaceRoot,
        env: { ...process.env, LILLIA_WORKSPACE_ROOT: workspaceRoot, LILLIA_DATA_DIR: dataDir },
        maxBuffer: 32 * 1024 * 1024
      });
      return JSON.parse(stdout).result;
    } catch (error) {
      throw Object.assign(new Error(error.stderr?.trim() || error.message), {
        exitCode: typeof error.code === 'number' ? error.code : 1
      });
    }
  };
  return { workspaceRoot, stateDir, command };
}

export async function runGuidedCli(args) {
  const [action, ...values] = args;
  if (values.length === 1 && ['--help', '-h'].includes(values[0])) return console.log(guidedHelp);
  const edit = action === 'setup' && values.length === 1 && values[0] === '--edit';
  if (
    (action === 'setup' && values.length && !edit) ||
    (action === 'run' && values.length !== 1) ||
    (['progress', 'result'].includes(action) && values.length > 1)
  )
    throw Error(guidedHelp);
  const ctx = await guidedContext();
  if (action === 'setup') {
    const { setupProject } = await import('./guided-setup.mjs');
    const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const answers = reader[Symbol.asyncIterator]();
    const ask = async (message) => {
      process.stdout.write(message + ' ');
      const { value, done } = await answers.next();
      if (done) throw Error('Input closed before confirmation. Reopen lillia setup.');
      return value;
    };
    try {
      const config = await setupProject({
        ...ctx,
        ask,
        edit,
        write: (message) => console.log(message)
      });
      if (config) console.log('Ready. Start a task with lillia run "your issue".');
    } finally {
      reader.close();
    }
    return;
  }
  const { loadGuidedConfig } = await import('./guided-setup.mjs');
  const config = await loadGuidedConfig(ctx.stateDir, ctx.workspaceRoot);
  const selected = { ...ctx, config };
  if (action === 'run') return console.log(await runIssue(selected, values[0]));
  const goal = await inspectIssue(selected, values[0]);
  if (action === 'progress') return console.log(progressText(goal));
  const { deliverResult } = await import('./guided-result.mjs');
  console.log(await deliverResult({ goal, config, command: ctx.command }));
}
