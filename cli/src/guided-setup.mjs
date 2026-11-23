import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadJson, record, readPreferences, savePreferences } from './guided-setup-preferences.mjs';
import { currentHead, previewChecks, qualifiedCodex } from './guided-setup-source.mjs';

const repository = 'project';
const seed = 'seed';
const configKeys = [
  'version',
  'workspaceRoot',
  'repository',
  'outputDir',
  'maxAttempts',
  'maxActiveSeconds'
];

function requireSetup(ok, message) {
  if (!ok) throw new Error(message);
}

function inside(parent, path) {
  const part = relative(parent, path);
  return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part));
}

// Resolve the existing ancestor before appending missing directories. This also catches a link
// to the source tree when the output folder itself does not exist yet.
async function resolvedDirectory(path) {
  let current = path;
  const missing = [];
  for (;;) {
    const stats = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stats) {
      const target = await realpath(current);
      requireSetup((await lstat(target)).isDirectory(), 'Choose a directory for project output.');
      return join(target, ...missing.reverse());
    }
    missing.push(basename(current));
    current = dirname(current);
  }
}

async function outputPath(root, value) {
  const path = await resolvedDirectory(resolve(root, value));
  requireSetup(!inside(root, path), 'Choose an output directory outside the project.');
  return path;
}

function integer(value, min, max, name) {
  requireSetup(
    /^\d+$/.test(String(value)) &&
      Number.isSafeInteger(Number(value)) &&
      Number(value) >= min &&
      Number(value) <= max,
    name + ' must be an integer from ' + min + ' to ' + max + '.'
  );
  return Number(value);
}

function intentFor(config, head) {
  const key = createHash('sha256')
    .update(JSON.stringify([head, ...configKeys.map((k) => config[k])]))
    .digest('hex');
  const operations = Object.fromEntries(
    ['register', 'init', 'import', 'activate'].map((k) => [k, 'setup-' + key + '-' + k])
  );
  return { version: 1, config, head, operations };
}

function validateIntent(intent, root) {
  const c = intent?.config;
  requireSetup(
    c &&
      Object.keys(c).length === configKeys.length &&
      configKeys.every((k) => Object.hasOwn(c, k)) &&
      c.version === 1 &&
      c.workspaceRoot === root &&
      c.repository === repository &&
      isAbsolute(c.outputDir) &&
      /^[a-f0-9]{40}$/.test(intent.head) &&
      isDeepStrictEqual(intent, intentFor(c, intent.head)),
    'Saved setup belongs to a different workspace or has invalid inputs.'
  );
  validatePreferences(c);
}

function validatePreferences(c) {
  requireSetup(
    typeof c.outputDir === 'string' &&
      isAbsolute(c.outputDir) &&
      resolve(c.outputDir) === c.outputDir &&
      !inside(c.workspaceRoot, c.outputDir),
    'Saved output directory must be outside the project.'
  );
  requireSetup(
    integer(c.maxAttempts, 2, 8, 'Attempts') === c.maxAttempts &&
      integer(c.maxActiveSeconds, 1, 1800, 'Active seconds') === c.maxActiveSeconds,
    'Invalid saved limits.'
  );
}

async function confirmPreferences(root, defaults, ask, write, prompt) {
  const input = async (label, value) => (await ask(`${label} [${value}] `)).trim() || String(value);
  const outputDir = await outputPath(root, await input('Output directory', defaults.outputDir));
  const maxAttempts = integer(
    await input('Maximum attempts per run', defaults.maxAttempts),
    2,
    8,
    'Attempts'
  );
  const maxActiveSeconds = integer(
    await input('Active seconds per run', defaults.maxActiveSeconds),
    1,
    1800,
    'Active seconds'
  );
  write(
    `Output ${outputDir}\nRun allowance ${maxAttempts} attempts, ${maxActiveSeconds} active seconds.`
  );
  const answer = await ask(prompt + ' [y/N] ');
  if (!/^(y|yes)$/i.test(answer.trim())) {
    write('Setup cancelled.');
    return null;
  }
  return { outputDir, maxAttempts, maxActiveSeconds };
}

async function installSource(intent, command) {
  const { config, head, operations } = intent;
  const repo = config.repository;
  const status = await command(['daemon', 'drain-status']);
  requireSetup(
    status.mode === 'open',
    'Project admission is closed. Inspect the named drain before continuing setup.'
  );
  const mutation = (args, id) => command([...args, '--operation-id', id]);
  const { capture } = await mutation(['project', 'register', head], operations.register);
  requireSetup(
    capture?.revision === head && !capture.inventory?.dirty,
    'The registered capture differs from the clean approved Git commit.'
  );
  await mutation(['native', 'init', repo], operations.init);
  const { draft, bridge } = await mutation(
    ['bridge', 'import', repo, head, seed],
    operations.import
  );
  requireSetup(
    draft?.repository === repo &&
      draft.name === seed &&
      /^[a-f0-9]{64}$/.test(draft.revisionId) &&
      Number.isSafeInteger(draft.generation) &&
      draft.generation >= 1 &&
      bridge?.gitId === head,
    'The imported native draft differs from the approved Git commit.'
  );
  const { authority } = await mutation(
    ['authority', 'activate', repo, seed, draft.revisionId, String(draft.generation)],
    operations.activate
  );
  requireSetup(
    authority?.repository === repo && authority.seed === draft.revisionId,
    'The active source differs from the approved native draft.'
  );
}

async function readSetupState(stateDir, workspaceRoot, editing = false) {
  const root = await realpath(workspaceRoot);
  requireSetup(
    !inside(root, await realpath(stateDir)),
    'Keep private setup state outside the project.'
  );
  const readyPath = join(stateDir, 'project.json'),
    intentPath = join(stateDir, 'setup-intent.json');
  const saved = await loadJson(readyPath);
  const intent = await loadJson(intentPath);
  let preferences;
  if (intent !== undefined) validateIntent(intent, root);
  if (saved !== undefined) {
    requireSetup(
      intent && isDeepStrictEqual(saved, intent.config),
      'Project configuration differs from the saved setup.'
    );
    preferences = await readPreferences(stateDir, intent, validatePreferences);
  }
  const effective = preferences?.config ?? intent?.config;
  if (effective && !editing) {
    requireSetup(
      effective.outputDir === (await outputPath(root, effective.outputDir)),
      'Saved output directory changed.'
    );
  }
  return { root, saved: preferences?.config, intent, readyPath, intentPath, preferences };
}

export async function loadGuidedConfig(stateDir, workspaceRoot) {
  const { saved } = await readSetupState(stateDir, workspaceRoot);
  requireSetup(saved !== undefined, 'Run lillia setup first.');
  return saved;
}

export async function setupProject({ workspaceRoot, stateDir, ask, write, command, edit = false }) {
  const state = await readSetupState(stateDir, workspaceRoot, edit);
  const { root, saved, readyPath, intentPath } = state;
  let { intent } = state;
  if (edit) {
    requireSetup(saved !== undefined, 'Run lillia setup first.');
    write('Edit settings for ' + root + '. Initial Git commit ' + intent.head + '.');
    const update = await confirmPreferences(
      root,
      saved,
      ask,
      write,
      'Save these settings for future runs?'
    );
    if (!update) return null;
    const updated = { ...saved, ...update };
    await savePreferences(state.preferences, updated);
    write('Saved project settings.');
    return updated;
  }
  if (saved !== undefined) {
    write('Already set up for ' + root + '. Initial Git commit ' + intent.head + '.');
    return saved;
  }
  requireSetup(
    (await lstat(join(root, '.git'))).isDirectory(),
    'Run setup from a Git repository with a standard .git directory.'
  );
  const head = currentHead(root);
  requireSetup(
    !intent || intent.head === head,
    'HEAD changed after setup was approved. Return to the approved commit ' +
      intent?.head +
      ' to retry.'
  );
  const checks = previewChecks(root, head, repository),
    version = await qualifiedCodex();
  write('Project ' + root + '\nCommitted Git source ' + head);
  write(
    'Both agents can read eligible text throughout the project. The author can create, edit and delete eligible files in the checked packages. Package manifests, locks and verification wrappers stay pinned.'
  );
  const directories = [...new Set(checks.map((check) => check.directory || '. (repository root)'))];
  write('Editable package directories\n' + directories.join('\n'));
  for (const check of checks) write((check.directory || '.') + '    ' + check.command.join(' '));
  write(
    'Author and independent reviewer use Codex ' +
      version +
      ', Astra 6.2, high reasoning. Setup registers source. A project run starts the provider sessions.'
  );
  if (!intent) {
    const defaults = {
      outputDir: join(dirname(root), basename(root) + '-lillia-output'),
      maxAttempts: 2,
      maxActiveSeconds: 1500
    };
    const selection = await confirmPreferences(
      root,
      defaults,
      ask,
      write,
      'Register this commit and authorize the source shown above?'
    );
    if (!selection) return null;
    const config = { version: 1, workspaceRoot: root, repository, ...selection };
    intent = intentFor(config, head);
    await record(intentPath, intent);
  } else {
    const { outputDir, maxAttempts, maxActiveSeconds } = intent.config;
    write(
      `Continuing the approved setup. Output ${outputDir}\nRun allowance ${maxAttempts} attempts, ${maxActiveSeconds} active seconds.`
    );
  }
  requireSetup(currentHead(root) === head, 'HEAD changed after setup was approved.');
  await installSource(intent, command);
  await record(readyPath, intent.config);
  write('Registered ' + head + ' for ' + root + '.');
  return intent.config;
}
