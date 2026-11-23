import { readFileSync } from 'node:fs';
import {
  componentPath as sampleComponent,
  testPath as sampleTest,
  profile as sampleProfile,
  baseFiles
} from './project-validation-profile.mjs';
import { requireCheck, sum, toolchainDigest } from './project-validation-tools.mjs';

export const playerSearchProfile = 'darwin-league-player-search-vitest-v1';
const playerSearchComponent = 'frontend/src/components/player-search-form.tsx';
const playerSearchTest = 'frontend/src/components/player-search-form.test.tsx';
const playerSearchFiles = Object.freeze({
  'frontend/package-lock.json': baseFiles['frontend/package-lock.json'],
  'frontend/package.json': baseFiles['frontend/package.json'],
  'frontend/tsconfig.json': baseFiles['frontend/tsconfig.json'],
  'frontend/vitest.config.mts': baseFiles['frontend/vitest.config.mts'],
  'frontend/src/components/game-asset-icon.tsx':
    baseFiles['frontend/src/components/game-asset-icon.tsx'],
  'frontend/src/lib/game-assets/types.ts': baseFiles['frontend/src/lib/game-assets/types.ts'],
  'frontend/src/lib/game-assets/use-game-assets.ts':
    baseFiles['frontend/src/lib/game-assets/use-game-assets.ts'],
  'frontend/src/lib/player-lookup/regions.ts':
    '0c43f3bae0056dafc1a8b51a7d2e7e498cf181dd15d415249c92e7a3ee2c1510',
  'frontend/src/lib/player-lookup/suggestions.ts':
    '8d58dae58b3dbae2a96a8f8642d38f86fe666d04e9bc6f07013243f8c075e3c1',
  'frontend/src/test/setup.ts': baseFiles['frontend/src/test/setup.ts']
});
const sampleV1 = Object.freeze({
  profile: sampleProfile,
  componentPath: sampleComponent,
  testPath: sampleTest,
  staticFiles: baseFiles,
  runner: 'sample-v1'
});
const sampleV2 = Object.freeze({
  profile: 'darwin-league-sample-profile-vitest-v2',
  componentPath: sampleComponent,
  testPath: sampleTest,
  staticFiles: baseFiles,
  runner: 'sample-v1'
});
const playerSearch = Object.freeze({
  profile: playerSearchProfile,
  componentPath: playerSearchComponent,
  testPath: playerSearchTest,
  staticFiles: playerSearchFiles,
  runner: 'player-search-v1'
});
export function projectValidationTarget(profile) {
  const selected =
    profile === undefined || profile === sampleProfile
      ? sampleV1
      : profile === sampleV2.profile
        ? sampleV2
        : profile === playerSearchProfile
          ? playerSearch
          : null;
  requireCheck(selected, 'Select a supported project validation profile.', 400);
  return selected;
}
export function projectValidationToolchainDigest(profile) {
  const target = projectValidationTarget(profile);
  if (target.runner === 'sample-v1') return toolchainDigest;
  const runnerDigest = sum(
    readFileSync(new URL('./project-validation-search-runner.mjs', import.meta.url))
  );
  return sum(
    JSON.stringify({
      toolchainDigest,
      profile: target.profile,
      componentPath: target.componentPath,
      testPath: target.testPath,
      staticFiles: target.staticFiles,
      runnerDigest
    })
  );
}
