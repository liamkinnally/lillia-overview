import { join } from 'node:path';
import { guidedContext } from './guided-cli.mjs';
import { setupProject } from './guided-setup.mjs';
import { loadJson } from './guided-setup-preferences.mjs';
import { previewChecks } from './guided-setup-source.mjs';
import { registeredSource } from './session-project-source.mjs';
import { findProject, rememberProject } from './session-project-location.mjs';

export { readProjectFile } from './session-project-source.mjs';
export {
  currentProject,
  findProject,
  lastProject,
  rememberProject
} from './session-project-location.mjs';

export async function openProject(root, { ask, write }) {
  const selected = await findProject(root);
  const answer = await ask(
    'Open project ' +
      selected +
      ' and let the main agent read eligible text from its registered commit? [y/N] '
  );
  if (!/^(y|yes)$/i.test(answer.trim())) return null;
  const ctx = await guidedContext(selected);
  const config = await setupProject({ ...ctx, ask, write });
  if (!config) return null;
  // The registered Git commit can differ from the owner's working tree and later native revisions.
  const { head } = await loadJson(join(ctx.stateDir, 'setup-intent.json'));
  const source = registeredSource(ctx.workspaceRoot, head);
  const checks = previewChecks(ctx.workspaceRoot, head, config.repository);
  const context = [
    'Project ' + ctx.workspaceRoot,
    'Originally registered Git commit ' + head,
    'Checks at registration',
    ...checks.map(({ directory, command }) => (directory || '.') + '    ' + command.join(' ')),
    'Available text files at that commit (up to 48, 16 KiB each)',
    ...source.paths
  ].join('\n');
  await rememberProject(ctx.workspaceRoot);
  return { ...ctx, config, context, source };
}
