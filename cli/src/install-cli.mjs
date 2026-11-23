import { parseArgs, inspect } from 'node:util';
import path from 'node:path';
import {
  releaseManifest,
  initializeInstallation,
  installationStatus,
  stageInstallation,
  checkpointInstallation,
  activateInstallation,
  abandonInstallation
} from './install-supervisor.mjs';

export const installHelp = `install manifest SOURCE
install init ROOT WORKSPACE SOURCE DIGEST --operation-id ID
install status ROOT
install stage ROOT SOURCE DIGEST --operation-id ID
install checkpoint ROOT BUILD GENERATION CUTOFF DESTINATION --operation-id ID
install activate ROOT BUILD GENERATION CUTOFF ARCHIVE --operation-id ID
install abandon ROOT ORIGINAL_OPERATION GENERATION --operation-id ID`;
const usage = () => {
  throw Object.assign(Error('Invalid installation command. See install --help.'), { exitCode: 2 });
};
const generation = (s) => {
  const n = Number(s);
  if (!/^[1-9]\d*$/.test(s) || !Number.isSafeInteger(n)) usage();
  return n;
};
export function runInstallCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        'operation-id': { type: 'string' }
      }
    });
  } catch {
    usage();
  }
  const {
    values: f,
    positionals: [verb, ...args]
  } = parsed;
  if (f.help) {
    console.log(installHelp);
    return;
  }
  const count = {
    manifest: 1,
    init: 4,
    status: 1,
    stage: 3,
    checkpoint: 5,
    activate: 5,
    abandon: 3
  };
  if (
    !Object.hasOwn(count, verb) ||
    args.length !== count[verb] ||
    ['status', 'manifest'].includes(verb) === Boolean(f['operation-id'])
  )
    usage();
  const id = f['operation-id'],
    root = path.resolve(args[0]);
  let result;
  if (verb === 'manifest') result = releaseManifest({ source: root });
  if (verb === 'init')
    result = initializeInstallation(
      {
        root,
        workspaceRoot: path.resolve(args[1]),
        source: path.resolve(args[2]),
        expectedDigest: args[3]
      },
      id
    );
  if (verb === 'status') result = installationStatus({ root });
  if (verb === 'stage')
    result = stageInstallation(
      { root, source: path.resolve(args[1]), expectedDigest: args[2] },
      id
    );
  if (verb === 'activate')
    result = activateInstallation(
      {
        root,
        build: args[1],
        expectedGeneration: generation(args[2]),
        cutoff: args[3],
        archive: path.resolve(args[4])
      },
      id
    );
  if (verb === 'checkpoint')
    result = checkpointInstallation(
      {
        root,
        build: args[1],
        expectedGeneration: generation(args[2]),
        cutoff: args[3],
        destination: path.resolve(args[4])
      },
      id
    );
  if (verb === 'abandon')
    result = abandonInstallation(
      { root, originalOperationId: args[1], expectedGeneration: generation(args[2]) },
      id
    );
  console.log(
    f.json
      ? JSON.stringify({ version: 1, result })
      : inspect(result, { depth: null, compact: false })
  );
}
