import { hashRecord } from './native-policy.mjs';
import { componentPath, testPath, baseFiles } from './project-validation-profile.mjs';
import { requireCheck as need, sum } from './project-validation-tools.mjs';
import {
  playerSearchProfile,
  projectValidationTarget,
  projectValidationToolchainDigest
} from './project-validation-targets.mjs';

export const projectValidationProfileV2 = 'darwin-league-sample-profile-vitest-v2';
const projectTextDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function isBoundedProjectText(bytes) {
  if (!bytes.length || bytes.length > 65536 || bytes.includes(0)) return false;
  try {
    projectTextDecoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function projectValidationPins(selected, input, options = {}) {
  const targetProfile = projectValidationTarget(input.profile),
    files =
      options.baseFiles ??
      (targetProfile.runner === 'player-search-v1'
        ? {
            ...targetProfile.staticFiles,
            [targetProfile.componentPath]: null,
            [targetProfile.testPath]: null
          }
        : baseFiles),
    editableComponent = options.componentPath ?? targetProfile.componentPath,
    editableTest = options.testPath ?? targetProfile.testPath,
    profileV2 = options.profileV2 ?? projectValidationProfileV2,
    pins = [],
    dynamicTargets = input.profile === profileV2 || input.profile === playerSearchProfile;
  need(
    input.profile === undefined ||
      input.profile === profileV2 ||
      input.profile === playerSearchProfile,
    'Select a supported project validation profile.',
    400
  );
  for (const [path, digest] of Object.entries(files)) {
    const f = selected.read(path);
    need(
      f.mode === '100644',
      'Native base contains an unsupported project validation file: ' + path
    );
    const actual = sum(f.bytes),
      target = path === editableComponent || path === editableTest;
    // V2 snapshots its selected starting implementation while freezing every test input.
    if (!dynamicTargets || !target)
      need(actual === digest, 'Native base differs from the enrolled browser check input: ' + path);
    else
      need(
        isBoundedProjectText(f.bytes),
        'The enrolled component and test must be bounded UTF-8 text.'
      );
    pins.push({ path, fileId: f.fileId, digest: actual });
  }
  return pins;
}

export function projectValidationRecipeRecord(input, operationId, epoch, generation, pins) {
  const v2 = input.profile === projectValidationProfileV2,
    search = input.profile === playerSearchProfile;
  const target = projectValidationTarget(input.profile);
  need(
    input.profile === undefined || v2 || search,
    'Select a supported project validation profile.',
    400
  );
  const body = {
    version: search ? 3 : v2 ? 2 : 1,
    profile: target.profile,
    input,
    operationId,
    epoch,
    generation,
    pins,
    toolchainDigest: projectValidationToolchainDigest(input.profile)
  };
  return { id: hashRecord(body), ...body };
}
