import { createHash } from 'node:crypto';
import {
  NativeStore,
  validateNativePath,
  validateNativeId,
  validateNativeLabel
} from './native-store.mjs';
import { makeReviewRecipe } from './git-review-recipe.mjs';

export const hashRecord = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const requireReview = (ok, message, status = 409) => {
  if (!ok) throw Object.assign(new Error(message), { status });
};
const need = requireReview,
  hash = hashRecord;
export const hasSeries = (db) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='native_policy_versions'").get());
export function isPortableJs(path) {
  return (
    typeof path === 'string' &&
    /^lib\/portable\/[a-z][a-z0-9-]{0,39}\.cjs$/.test(path) &&
    !/(?:^|[/-])(?:auth[a-z]*|polic[a-z]*|permission[a-z]*|install[a-z]*|bootstrap|startup|daemon|worker|secret[a-z]*|credential[a-z]*|security|release|session|key|token|workflow[a-z]*|orchestrat[a-z]*)(?:[.-]|$)/.test(
      path
    )
  );
}
export function validateNativeReviewPath(path) {
  validateNativePath(path);
  const guide =
    /^docs\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.md$/.test(path) &&
    !/(?:^|\/)(?:agents|claude|gemini|skill|instructions|copilot-instructions)\.md$/i.test(path);
  need(
    (guide || isPortableJs(path) || /\.(?:txt|json)$/.test(path)) &&
      !path
        .split('/')
        .some(
          (component) =>
            component.startsWith('.') ||
            /^(?:auth|polic(?:y|ies)|permissions?|security|credentials?|secrets?|iam|workflows?|release)(?:$|[._-])/i.test(
              component
            )
        ),
    'Protected or unsupported native review path'
  );
  return path;
}
export function ownerReviewPath(path) {
  validateNativePath(path);
  if (/^policies\/[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(path)) return path;
  return validateNativeReviewPath(path);
}
export function pathAdmitted(a, source) {
  if (isPortableJs(source.path))
    return (
      !source.ownerPolicy &&
      typeof source.jsRecipe === 'string' &&
      /^[a-f0-9]{64}$/.test(source.jsRecipe) &&
      a.allowedPaths.includes(source.path)
    );
  if (source.jsRecipe !== undefined) return false;
  if (source.ownerPolicy !== undefined)
    return (
      source.ownerPolicy === a.policyDigest && a.ownerReviewPaths?.includes(source.path) === true
    );
  return a.allowedPaths.includes(source.path);
}
export function normalizePolicy(raw) {
  const keys = [
    'repository',
    'expectedPolicyDigest',
    'ordinaryPaths',
    'ownerReviewPaths',
    'checks'
  ];
  need(
    raw && Object.keys(raw).length === keys.length && keys.every((k) => Object.hasOwn(raw, k)),
    'Expected exact native policy replacement',
    400
  );
  validateNativeLabel(raw.repository);
  validateNativeId(raw.expectedPolicyDigest);
  need(
    Array.isArray(raw.ordinaryPaths) &&
      Array.isArray(raw.ownerReviewPaths) &&
      raw.ordinaryPaths.length + raw.ownerReviewPaths.length <= 32,
    'Choose up to 32 policy paths',
    400
  );
  const ordinaryPaths = raw.ordinaryPaths.map(validateNativeReviewPath).sort(),
    ownerReviewPaths = raw.ownerReviewPaths.map(ownerReviewPath).sort();
  const all = [...ordinaryPaths, ...ownerReviewPaths];
  need(
    new Set(all.map((s) => s.toLowerCase())).size === all.length,
    'Conflicting or duplicate native policy grants',
    400
  );
  return {
    repository: raw.repository,
    expectedPolicyDigest: raw.expectedPolicyDigest,
    ordinaryPaths,
    ownerReviewPaths,
    checks: makeReviewRecipe(raw.repository, raw.expectedPolicyDigest, raw.checks).checks
  };
}
function next(a, input, op, target, generation) {
  const version = (a.policyVersion ?? 1) + 1,
    policyDigest = hash([
      'native-policy-v1',
      a.repository,
      a.epoch,
      a.policyDigest,
      version,
      input,
      op,
      target,
      generation
    ]);
  return {
    ...a,
    allowedPaths: input.ordinaryPaths,
    checks: input.checks,
    ownerReviewPaths: input.ownerReviewPaths,
    policyVersion: version,
    policyDigest
  };
}
export function nativePolicyAt(db, baseline, requested) {
  if (!baseline || !hasSeries(db) || requested === baseline.policyDigest) return baseline;
  let current = baseline;
  for (const row of db.prepare('SELECT * FROM native_policy_versions ORDER BY version').iterate()) {
    const input = normalizePolicy(JSON.parse(row.admission)),
      saved = JSON.parse(row.record);
    need(
      input.repository === current.repository &&
        input.expectedPolicyDigest === current.policyDigest &&
        row.version === (current.policyVersion ?? 1) + 1,
      'Native policy sequence changed'
    );
    const a = next(current, input, row.operationId, row.target, row.generation);
    const receipt = db
        .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
        .get(row.operationId),
      out = receipt && JSON.parse(receipt.receipt);
    need(
      row.digest === a.policyDigest &&
        JSON.stringify(saved) === JSON.stringify(a) &&
        receipt?.digest === hash(['authority.policy', input]) &&
        out?.operationId === row.operationId &&
        JSON.stringify(out.authority) === JSON.stringify(saved),
      'Native policy version or owner receipt changed'
    );
    current = a;
    if (current.policyDigest === requested) return current;
  }
  need(!requested, 'Historical native policy digest is absent');
  return current;
}
export function replaceNativePolicy(db, a, input, op) {
  need(
    a && a.repository === input.repository && a.policyDigest === input.expectedPolicyDigest,
    'Native repository policy digest changed'
  );
  const native = new NativeStore({ db }),
    head = native.ref({ repository: a.repository, name: a.ref });
  for (const path of [...input.ordinaryPaths, ...input.ownerReviewPaths]) {
    const file = native.file({ repository: a.repository, revisionId: head.revisionId, path });
    need(
      file.mode === '100644' && file.bytes.length <= 4096,
      'Native policy grant must select a regular 4 KiB file'
    );
  }
  need((a.policyVersion ?? 1) < 64, 'Native policy history capacity reached');
  const authority = next(a, input, op, head.revisionId, head.generation);
  db.prepare('INSERT INTO native_policy_versions VALUES(?,?,?,?,?,?,?)').run(
    authority.policyVersion,
    authority.policyDigest,
    op,
    head.revisionId,
    head.generation,
    JSON.stringify(input),
    JSON.stringify(authority)
  );
  db.prepare(
    "UPDATE native_goals SET stage='superseded',detail='The owner replaced the native repository policy. Admit fresh work under the new policy.' WHERE stage NOT IN ('completed','superseded','blocked')"
  ).run();
  return { authority };
}
export function enrollReviewGoal(db, goalId, a) {
  if (hasSeries(db))
    db.prepare('INSERT INTO native_policy_enrollments VALUES(?,?)').run(goalId, a.policyDigest);
}
export function policyEnrollment(db, goalId, a) {
  if (!hasSeries(db)) return true;
  return (
    db.prepare('SELECT digest FROM native_policy_enrollments WHERE goalId=?').get(goalId)
      ?.digest === a?.policyDigest
  );
}
