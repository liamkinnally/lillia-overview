// Read-only owner projection. Status describes retained evidence; publishing always rechecks eligibility.
const statuses = [
  'landed',
  'superseded',
  'historical-policy',
  'paused',
  'cancelled',
  'rejected',
  'failed-check',
  'blocked',
  'blocked-finding',
  'awaiting-dependency',
  'awaiting-review',
  'awaiting-owner',
  'checked',
  'needs-recheck',
  'approved'
];
const filterNames = ['author', 'task', 'repository', 'dependency', 'owner', 'status'];
function invalid() {
  throw Object.assign(new Error('Invalid native review inbox filter, cursor or page size.'), {
    status: 400
  });
}
export function reviewInbox(db, authority, input = {}) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => ![...filterNames, 'after', 'limit'].includes(k))
  )
    invalid();
  const { after = 0, limit = 32 } = input;
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    invalid();
  const params = { after, limit: limit + 1 };
  for (const k of filterNames) {
    const v = input[k];
    if (
      v !== undefined &&
      (typeof v !== 'string' ||
        !v.trim() ||
        v.length > 256 ||
        v !== v.trim() ||
        /[\u0000-\u001f\u007f]/u.test(v))
    )
      invalid();
    params[k] = v ?? null;
  }
  if (params.status && !statuses.includes(params.status)) invalid();
  if (!authority || (params.repository && params.repository !== authority.repository))
    return { submissions: [], next: null };
  Object.assign(params, {
    repository: authority.repository,
    epoch: authority.epoch,
    policy: authority.policyDigest
  });
  const rows = db
    .prepare(
      `WITH subjects AS (
    SELECT s.rowid AS cursor,s.id,s.record,json_extract(s.record,'$.goalId') AS goalId,
      json_extract(s.record,'$.path') AS path,json_extract(s.record,'$.repository') AS repository,
      json_extract(s.record,'$.author.taskId') AS authorTask,json_extract(s.record,'$.author.provider') AS authorProvider,
      coalesce(json_extract(s.record,'$.origin.principal'),'task:'||json_extract(s.record,'$.author.taskId')) AS authorPrincipal,
      CASE WHEN json_extract(s.record,'$.ownerPolicy') IS NULL THEN 'none'
        WHEN json_extract(s.record,'$.origin.principal')='local-owner' THEN 'distinct-human' ELSE 'local-owner' END AS owner,
      json_extract(s.record,'$.policyDigest') AS policyDigest
    FROM native_submissions s WHERE s.rowid>$after AND json_extract(s.record,'$.repository')=$repository
      AND json_extract(s.record,'$.epoch')=$epoch
  ), attributed AS (
    SELECT s.*,v.ordinal AS version,rr.taskId AS reviewerTask,
      g.state AS goalState,f.stage,f.revisionId AS flowRevision,
      CASE WHEN f.goalId IS NOT NULL THEN 'local-owner' END AS initiatorPrincipal,
      (SELECT json_extract(d.record,'$.decision') FROM native_reviews d WHERE d.revisionId=s.id
        ORDER BY (json_extract(d.record,'$.decision')='reject') DESC,d.rowid DESC LIMIT 1) AS decision,
      c.record AS lastCheck,head.revisionId AS protectedHead,head.generation AS protectedGeneration
    FROM subjects s LEFT JOIN native_refs head ON head.repository=s.repository AND head.name='mainline'
      LEFT JOIN native_checks c ON c.rowid=(SELECT cr.rowid FROM native_checks cr WHERE cr.revisionId=s.id ORDER BY cr.rowid DESC LIMIT 1)
      JOIN native_series_versions v ON v.revisionId=s.id
      LEFT JOIN native_roles ar ON ar.taskId=s.authorTask AND ar.goalId=s.goalId AND ar.role='author'
      LEFT JOIN native_roles rr ON rr.goalId=ar.goalId AND rr.cycle=ar.cycle AND rr.role='reviewer'
      LEFT JOIN native_goals f ON f.goalId=s.goalId LEFT JOIN goals g ON g.id=s.goalId
    WHERE ($author IS NULL OR $author=s.authorPrincipal OR ($author=s.authorProvider AND s.authorPrincipal='task:'||s.authorTask))
      AND ($task IS NULL OR $task IN (s.authorTask,rr.taskId))
      AND ($owner IS NULL OR $owner=s.owner)
      AND ($dependency IS NULL OR EXISTS(SELECT 1 FROM json_each(s.record,'$.requires') WHERE value=$dependency))
  ), classified AS (
    SELECT a.*,CASE
      WHEN EXISTS(SELECT 1 FROM native_landings l WHERE l.revisionId=a.id) THEN 'landed'
      WHEN EXISTS(SELECT 1 FROM native_series_versions newer WHERE newer.goalId=a.goalId AND newer.ordinal>a.version) OR stage='superseded' THEN 'superseded'
      WHEN policyDigest<>$policy THEN 'historical-policy'
      WHEN goalState IN ('paused','cancelled') THEN goalState
      WHEN decision='reject' OR EXISTS(SELECT 1 FROM native_review_actions x WHERE x.revisionId=a.id AND x.kind='review.owner' AND json_extract(x.record,'$.decision')='reject') THEN 'rejected'
      WHEN json_extract(lastCheck,'$.state')='failed' THEN 'failed-check'
      WHEN stage='blocked' AND flowRevision=a.id THEN 'blocked'
      WHEN EXISTS(SELECT 1 FROM native_review_actions x JOIN native_series_versions p ON p.revisionId=x.revisionId
        WHERE p.goalId=a.goalId AND p.ordinal<=a.version AND x.kind='review.comment' AND json_extract(x.record,'$.kind')='blocking'
        AND NOT EXISTS(SELECT 1 FROM native_review_actions y JOIN native_series_versions q ON q.revisionId=y.revisionId
          WHERE q.goalId=a.goalId AND q.ordinal<=a.version AND y.kind='review.resolve' AND json_extract(y.record,'$.findingId')=json_extract(x.record,'$.id'))) THEN 'blocked-finding'
      WHEN decision IS NULL THEN 'awaiting-review'
      WHEN owner='distinct-human' OR (owner='local-owner' AND NOT EXISTS(SELECT 1 FROM native_review_actions x WHERE x.revisionId=a.id
        AND x.kind='review.owner' AND json_extract(x.record,'$.decision')='approve')) THEN 'awaiting-owner'
      WHEN EXISTS(SELECT 1 FROM json_each(a.record,'$.requires') dep WHERE NOT EXISTS(SELECT 1 FROM native_landings l WHERE l.revisionId=dep.value)) THEN 'awaiting-dependency'
      WHEN json_extract(lastCheck,'$.state')='passed' THEN CASE WHEN protectedHead=json_extract(lastCheck,'$.expectedTarget')
        AND protectedGeneration=json_extract(lastCheck,'$.expectedGeneration') THEN 'checked' ELSE 'needs-recheck' END ELSE 'approved' END AS status
    FROM attributed a
  ) SELECT cursor,id,path,goalId,repository,version,policyDigest,authorTask,authorProvider,authorPrincipal,initiatorPrincipal,reviewerTask,owner,status,
      coalesce(json_extract(record,'$.requires'),'[]') AS dependencies
    FROM classified WHERE ($status IS NULL OR status=$status) ORDER BY cursor LIMIT $limit`
    )
    .all(params);
  const submissions = rows
    .slice(0, limit)
    .map((r) => ({ ...r, dependencies: JSON.parse(r.dependencies) }));
  return { submissions, next: rows.length > limit ? submissions.at(-1).cursor : null };
}
