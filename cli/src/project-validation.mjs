import {
  workspaceValidationProfile,
  normalizeWorkspaceValidation,
  prepareWorkspaceValidation,
  workspaceValidationRecord,
  verifyWorkspaceRecipe,
  prepareWorkspaceCache,
  workspaceCheckSubject,
  runWorkspaceValidation,
  verifyWorkspaceValidation
} from './project-workspace-validation.mjs';
import { isDeepStrictEqual as same } from 'node:util';
import { NativeStore, validateNativeId, validateNativeLabel } from './native-store.mjs';
import { NativeAuthority } from './native-authority.mjs';
import { hashRecord } from './native-policy.mjs';
import { baseFiles } from './project-validation-profile.mjs';
import {
  projectValidationTarget,
  projectValidationToolchainDigest,
  playerSearchProfile
} from './project-validation-targets.mjs';
import { requireCheck as need, sum, prepareTools } from './project-validation-tools.mjs';
import { runProjectCheck } from './project-validation-runner.mjs';
import { runPlayerSearchCheck } from './project-validation-search-runner.mjs';
import {
  isBoundedProjectText,
  projectValidationPins,
  projectValidationProfileV2,
  projectValidationRecipeRecord
} from './project-validation-recipes.mjs';

export {
  projectValidationPins,
  projectValidationProfileV2,
  projectValidationRecipeRecord
} from './project-validation-recipes.mjs';

export const projectValidationTables = ['project_validation_recipes'];
export function installProjectValidation(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS project_validation_recipes(id TEXT PRIMARY KEY,operationId TEXT UNIQUE NOT NULL,record TEXT NOT NULL)'
  );
}
export function normalizeProjectValidation(input) {
  if (input?.profile === workspaceValidationProfile) return normalizeWorkspaceValidation(input);
  const keys = ['repository', 'base', 'componentPath', 'testPath'];
  const hasProfile = input && Object.hasOwn(input, 'profile');
  const target = projectValidationTarget(input?.profile);
  if (hasProfile) keys.push('profile');
  need(
    input &&
      Object.keys(input).length === keys.length &&
      keys.every((k) => Object.hasOwn(input, k)) &&
      input.componentPath === target.componentPath &&
      input.testPath === target.testPath,
    'Select the fixed browser component and its corresponding test.',
    400
  );
  need(
    !hasProfile ||
      input.profile === projectValidationProfileV2 ||
      input.profile === playerSearchProfile,
    'Select a supported project validation profile.',
    400
  );
  validateNativeLabel(input.repository);
  validateNativeId(input.base);
  return {
    repository: input.repository,
    base: input.base,
    componentPath: target.componentPath,
    testPath: target.testPath,
    ...(hasProfile ? { profile: input.profile } : {})
  };
}
function baseSelection(native, input) {
  const selected = native.select({ repository: input.repository, revisionId: input.base });
  const target = projectValidationTarget(input.profile);
  return {
    selected,
    pins: projectValidationPins(selected, input, {
      baseFiles:
        target.runner === 'player-search-v1'
          ? { ...target.staticFiles, [target.componentPath]: null, [target.testPath]: null }
          : baseFiles,
      componentPath: target.componentPath,
      testPath: target.testPath
    })
  };
}
function retained(db, id) {
  const row = db.prepare('SELECT * FROM project_validation_recipes WHERE id=?').get(id);
  need(row, 'Unknown project validation recipe.', 404);
  const r = JSON.parse(row.record),
    input = normalizeProjectValidation(r.input),
    native = new NativeStore({ db });
  const workspace = input.profile === workspaceValidationProfile;
  const pins = workspace ? null : baseSelection(native, input).pins;
  if (workspace) verifyWorkspaceRecipe(db, r, row.operationId);
  const origin = db
    .prepare(
      "SELECT revisionId FROM native_ref_events WHERE repository=? AND name='mainline' AND generation=?"
    )
    .get(input.repository, r.generation);
  const authority = db.prepare('SELECT epoch FROM native_authority WHERE slot=1').get();
  const receipt = db
    .prepare('SELECT * FROM command_receipts WHERE operationId=?')
    .get(row.operationId);
  need(
    authority?.epoch === r.epoch &&
      origin?.revisionId === input.base &&
      r.id === id &&
      (workspace ||
        same(
          r,
          projectValidationRecipeRecord(input, row.operationId, r.epoch, r.generation, pins)
        )) &&
      receipt?.digest === hashRecord(['project.validation.enroll', input]) &&
      same(JSON.parse(receipt.receipt), { operationId: row.operationId, recipe: r }),
    'Project check recipe, native base or owner enrollment receipt differs.'
  );
  return r;
}
export function projectCheckInputs(base, selected, target = projectValidationTarget()) {
  need(base.length === selected.length, 'Project validation requires the exact enrolled file set.');
  for (let n = 0; n < base.length; n++) {
    const a = base[n],
      b = selected[n];
    need(
      a.path === b.path &&
        a.mode === b.mode &&
        ([target.componentPath, target.testPath].includes(a.path)
          ? b.mode === '100644'
          : a.fileId === b.fileId),
      'Only the enrolled regular component and its test may differ from the approved base.'
    );
  }
}
function checkSubject(db, r, repository, revisionId, role) {
  need(
    repository === r.input.repository && ['author', 'reviewer'].includes(role),
    'The selected project check role or repository differs.'
  );
  validateNativeId(revisionId);
  const target = projectValidationTarget(r.profile);
  const native = new NativeStore({ db });
  const base = native.select({ repository, revisionId: r.input.base }),
    selected = native.select({ repository, revisionId });
  if (revisionId !== r.input.base) {
    // A generated candidate starts from the enrolled native base. Root equality and parentage bind the whole tree.
    let cursor = revisionId;
    while (cursor && cursor !== r.input.base)
      cursor = native.revision({ repository, revisionId: cursor }).parents[0];
    need(cursor === r.input.base, 'Project check revision is outside the enrolled ancestry.');
  }
  projectCheckInputs(base.entries, selected.entries, target);
  const files = r.pins.map((p) => selected.read(p.path));
  for (const f of files)
    if ([target.componentPath, target.testPath].includes(f.path)) {
      const boundedText = f.bytes.length > 0 && f.bytes.length <= 65536;
      if (r.version >= 2) {
        need(
          boundedText && isBoundedProjectText(f.bytes),
          'The selected component and test must be bounded UTF-8 text.'
        );
      } else need(boundedText, 'The selected component or test exceeds 64 KiB.');
    }
  const binding = {
    version: r.version,
    profile: r.profile,
    recipeId: r.id,
    repository,
    revisionId,
    role,
    componentFileId: selected.read(target.componentPath).fileId,
    testFileId: selected.read(target.testPath).fileId,
    toolchainDigest: projectValidationToolchainDigest(r.profile)
  };
  return { binding, files, target };
}
const hex = (x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
export function verifyProjectCheck(db, recipeId, revisionId, check) {
  const r = retained(db, recipeId);
  if (r.profile === workspaceValidationProfile)
    return verifyWorkspaceValidation(db, r, revisionId, check);
  const { binding, target } = checkSubject(db, r, check.repository, revisionId, check.role);
  const { outcome, checks, reportDigest, detail, observation, ...subject } = check;
  need(
    same(binding, subject) &&
      Array.isArray(checks) &&
      checks.length <= 32 &&
      ['passed', 'failed', 'unavailable'].includes(outcome),
    'Historical project check subject or result differs.'
  );
  if (outcome === 'unavailable')
    need(
      observation === null &&
        !checks.length &&
        reportDigest === null &&
        typeof detail === 'string' &&
        detail.length > 0 &&
        detail.length <= 500,
      'Invalid unavailable project check.'
    );
  else {
    const failed = checks.filter((c) => c?.assertionFailure).length;
    need(
      observation &&
        hex(observation.stdoutDigest) &&
        same(observation, {
          exitCode: failed ? 1 : 0,
          stdoutDigest: observation.stdoutDigest,
          testPath: target.testPath,
          suites: 1,
          cases: checks.length,
          passed: checks.length - failed,
          failed
        }) &&
        reportDigest === sum(JSON.stringify([observation, checks, outcome])),
      'Project process observation differs from its retained report digest.'
    );
    need(
      checks.length > 0 &&
        hex(reportDigest) &&
        detail === null &&
        new Set(checks.map((c) => c.title)).size === checks.length &&
        checks.every(
          (c) =>
            typeof c.title === 'string' &&
            c.title.trim() &&
            c.title.length <= 300 &&
            Object.keys(c).length === 4 &&
            ((c.status === 'passed' && c.assertionFailure === false && c.detail === null) ||
              (c.status === 'failed' &&
                c.assertionFailure === true &&
                typeof c.detail === 'string' &&
                c.detail.length > 0 &&
                c.detail.length <= 500))
        ) &&
        (outcome === 'failed') === checks.some((c) => c.assertionFailure),
      'Invalid completed project check assertions.'
    );
  }
  return true;
}
export class ProjectValidation {
  #prepared = new WeakSet();
  #running = false;
  constructor({ store, dataDir }) {
    this.db = store.db;
    this.dataDir = dataDir;
    this.authority = new NativeAuthority(store);
  }
  async prepare(raw) {
    const input = normalizeProjectValidation(raw),
      { authority, mainline } = this.authority.status();
    need(
      authority?.repository === input.repository && mainline?.revisionId === input.base,
      'Select the active registered repository and its exact protected head.'
    );
    if (input.profile === workspaceValidationProfile) {
      const extra = await prepareWorkspaceValidation(this.db, this.dataDir, input);
      const freeze = (value) => {
        if (value && typeof value === 'object') {
          Object.values(value).forEach(freeze);
          Object.freeze(value);
        }
        return value;
      };
      const p = freeze({
        input,
        epoch: authority.epoch,
        generation: mainline.generation,
        ...extra
      });
      this.#prepared.add(p);
      return p;
    }
    const { pins, selected } = baseSelection(new NativeStore({ db: this.db }), input);
    await prepareTools(this.dataDir, selected.read('frontend/package-lock.json').bytes);
    const p = {
      input: Object.freeze(input),
      epoch: authority.epoch,
      generation: mainline.generation,
      pins: Object.freeze(pins.map(Object.freeze))
    };
    this.#prepared.add(p);
    return Object.freeze(p);
  }
  enroll(p, operationId) {
    need(
      this.db.isTransaction && this.#prepared.has(p),
      'Project enrollment requires a verified owner preparation and writer transaction.'
    );
    const { authority, mainline } = this.authority.status();
    need(
      authority?.epoch === p.epoch &&
        authority.repository === p.input.repository &&
        mainline.revisionId === p.input.base &&
        mainline.generation === p.generation,
      'The registered native target changed before project enrollment.'
    );
    need(
      this.db.prepare('SELECT count(*) n FROM project_validation_recipes').get().n < 64,
      'Project check enrollment limit reached.'
    );
    const recipe =
      p.input.profile === workspaceValidationProfile
        ? workspaceValidationRecord(p.input, operationId, p.epoch, p.generation, p)
        : projectValidationRecipeRecord(p.input, operationId, p.epoch, p.generation, p.pins);
    this.db
      .prepare('INSERT INTO project_validation_recipes VALUES(?,?,?)')
      .run(recipe.id, operationId, JSON.stringify(recipe));
    return { recipe };
  }
  get(id) {
    return retained(this.db, id);
  }
  async prepareCache(recipe) {
    const retainedRecipe = this.get(recipe.id);
    need(same(recipe, retainedRecipe), 'The selected recipe differs from its retained enrollment.');
    if (recipe.profile === workspaceValidationProfile)
      return prepareWorkspaceCache(this.db, this.dataDir, recipe);
    const selected = new NativeStore({ db: this.db }).select({
      repository: recipe.input.repository,
      revisionId: recipe.input.base
    });
    await prepareTools(this.dataDir, selected.read('frontend/package-lock.json').bytes);
    return { recipeId: recipe.id, ready: true };
  }
  recipes(input) {
    const keys = ['repository', 'base', 'expectedGeneration', 'policyDigest'];
    need(
      input &&
        !Array.isArray(input) &&
        Object.keys(input).length === keys.length &&
        keys.every((key) => Object.hasOwn(input, key)) &&
        Number.isSafeInteger(input.expectedGeneration) &&
        input.expectedGeneration >= 1 &&
        typeof input.policyDigest === 'string' &&
        /^[0-9a-f]{64}$/.test(input.policyDigest),
      'Select the exact registered repository, base, generation and policy.',
      400
    );
    validateNativeLabel(input.repository);
    validateNativeId(input.base);
    const { authority, mainline } = this.authority.status();
    need(
      authority?.repository === input.repository &&
        authority.policyDigest === input.policyDigest &&
        mainline?.revisionId === input.base &&
        mainline.generation === input.expectedGeneration,
      'The selected project base, generation or policy changed.'
    );
    const rows = this.db
      .prepare('SELECT id FROM project_validation_recipes ORDER BY rowid LIMIT 65')
      .all();
    need(rows.length <= 64, 'Project check enrollment limit exceeded.');
    // Verify retained owner receipts before projecting any stored enrollment fields.
    return {
      recipes: rows
        .map(({ id }) => this.get(id))
        .filter(
          (recipe) =>
            recipe.epoch === authority.epoch &&
            recipe.generation === input.expectedGeneration &&
            recipe.input.repository === input.repository &&
            recipe.input.base === input.base
        )
    };
  }
  async check({ recipeId, repository, revisionId, role }) {
    const r = this.get(recipeId);
    if (r.profile === workspaceValidationProfile) {
      const binding = workspaceCheckSubject(this.db, r, repository, revisionId, role);
      const active = () => {
        const { authority, mainline } = this.authority.status();
        need(
          authority?.epoch === r.epoch &&
            mainline?.revisionId === r.input.base &&
            mainline.generation === r.generation,
          'Protected workspace base changed before or during verification.'
        );
      };
      active();
      need(!this.#running, 'The project validation slot is occupied.');
      this.#running = true;
      try {
        const result = await runWorkspaceValidation(this.db, this.dataDir, r, revisionId, binding);
        active();
        return result;
      } finally {
        this.#running = false;
      }
    }
    const { binding, files, target } = checkSubject(this.db, r, repository, revisionId, role);
    const { authority, mainline } = this.authority.status();
    need(
      authority?.epoch === r.epoch &&
        mainline?.revisionId === r.input.base &&
        mainline.generation === r.generation,
      'Protected base changed before the project check.'
    );
    need(!this.#running, 'The project validation slot is occupied.');
    this.#running = true;
    try {
      const result = await (
        target.runner === 'player-search-v1' ? runPlayerSearchCheck : runProjectCheck
      )({ dataDir: this.dataDir, files });
      const final = this.authority.status();
      need(
        final.authority?.epoch === r.epoch &&
          final.mainline?.revisionId === r.input.base &&
          final.mainline.generation === r.generation,
        'The project target changed during verification.'
      );
      return { ...binding, ...result };
    } catch (error) {
      return {
        ...binding,
        outcome: 'unavailable',
        checks: [],
        observation: null,
        detail:
          error.status === 409
            ? error.message.slice(0, 500)
            : 'The isolated test toolchain is unavailable.',
        reportDigest: null
      };
    } finally {
      this.#running = false;
    }
  }
}
export function verifyProjectValidation(db) {
  let recipes = 0;
  for (const { id } of db.prepare('SELECT id FROM project_validation_recipes').iterate()) {
    retained(db, id);
    recipes++;
  }
  need(
    !db
      .prepare(
        "SELECT 1 FROM command_receipts c LEFT JOIN project_validation_recipes r ON r.operationId=c.operationId WHERE json_extract(c.receipt,'$.recipe.profile') IN (?,?,?,?) AND r.id IS NULL LIMIT 1"
      )
      .get(
        'darwin-league-sample-profile-vitest-v1',
        projectValidationProfileV2,
        playerSearchProfile,
        workspaceValidationProfile
      ),
    'Missing project check enrollment for owner receipt.'
  );
  return { recipes };
}
