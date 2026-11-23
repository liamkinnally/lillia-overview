import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export async function loadJson(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 8192) throw Error('Invalid setup record at ' + path);
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

// A setup retry after process loss must see a complete original choice or no choice. A second
// invocation can reuse the same intent, but cannot replace it with another source or allowance.
export async function record(path, value) {
  const tmp = path + '.' + randomUUID();
  const file = await open(tmp, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(tmp, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!isDeepStrictEqual(value, await loadJson(path))) {
        throw Error('Another setup already saved different choices. Reopen setup to review them.');
      }
    }
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(tmp);
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function transition(setup, previous, config) {
  const { outputDir, maxAttempts, maxActiveSeconds } = config;
  const body = { version: 1, setup, previous, outputDir, maxAttempts, maxActiveSeconds };
  return { ...body, digest: digest(body) };
}

export async function readPreferences(stateDir, intent, validate) {
  const setup = intent.operations.activate;
  let previous = digest(['preferences', setup]),
    config = intent.config;
  for (;;) {
    const path = join(stateDir, 'settings-' + previous + '.json');
    const saved = await loadJson(path);
    if (saved === undefined) return { setup, previous, config, path };
    if (!saved || !isDeepStrictEqual(saved, transition(setup, previous, saved))) {
      throw Error('Saved preferences differ from the approved project or previous settings.');
    }
    config = {
      ...intent.config,
      outputDir: saved.outputDir,
      maxAttempts: saved.maxAttempts,
      maxActiveSeconds: saved.maxActiveSeconds
    };
    validate(config);
    previous = saved.digest;
  }
}

// Only one confirmed successor can be published for the settings the owner just reviewed.
export async function savePreferences(state, config) {
  await record(state.path, transition(state.setup, state.previous, config));
}
