const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status });
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ids = (list) =>
  Array.isArray(list) &&
  list.length <= 16 &&
  new Set(list).size === list.length &&
  list.every((id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id));
export function installReviewDependencies(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS review_dependencies(version TEXT NOT NULL REFERENCES review_versions(id),
    position INTEGER NOT NULL,prerequisite TEXT NOT NULL REFERENCES review_versions(id),PRIMARY KEY(version,position),UNIQUE(version,prerequisite))`);
}
function read(db, id) {
  const row = db
    .prepare(
      'SELECT v.id,v.changeId,v.commitId,v.record,c.latest FROM review_versions v JOIN review_changes c ON c.id=v.changeId WHERE v.id=?'
    )
    .get(id);
  if (!row) fail('Prerequisite revision not found.');
  const r = JSON.parse(row.record);
  if (r.id !== row.id || r.changeId !== row.changeId || r.commit !== row.commitId)
    fail('Prerequisite revision identity differs from its retained subject.');
  return { r, latest: row.latest };
}
function storedPins(db, r) {
  const pins = db
    .prepare(
      'SELECT position,prerequisite FROM review_dependencies WHERE version=? ORDER BY position'
    )
    .all(r.id);
  if (
    pins.some((p, i) => p.position !== i) ||
    !equal(
      pins.map((p) => p.prerequisite),
      r.requires ?? []
    )
  )
    fail('Prerequisite edge list differs from the immutable revision.');
}
function closure(db, subject, { historical = false } = {}) {
  if (!ids(subject.requires ?? []))
    fail('Supply at most 16 distinct immutable prerequisite revision IDs.', 400);
  const result = new Map();
  let obsolete = null,
    visits = 0;
  function walk(current, ancestors, paths) {
    for (const id of current.requires ?? []) {
      if (++visits > 256 || ancestors.size > 16)
        fail('Prerequisite graph exceeds the bounded review closure.');
      const { r, latest } = read(db, id);
      if (r.project !== subject.project) fail('Prerequisite belongs to a different repository.');
      if (ancestors.has(r.changeId) || r.edits.some((edit) => paths.has(edit.path)))
        fail('Prerequisite cycle or overlapping path in the logical change ancestry.');
      if (!historical && latest !== id)
        obsolete =
          'Prerequisite revision was superseded. Submit a fresh dependent revision against the current prerequisite.';
      storedPins(db, r);
      walk(
        r,
        new Set([...ancestors, r.changeId]),
        new Set([...paths, ...r.edits.map((e) => e.path)])
      );
      result.set(r.id, r);
    }
  }
  walk(subject, new Set([subject.changeId]), new Set(subject.edits.map((e) => e.path)));
  return { revisions: [...result.values()], obsolete };
}
export function submissionPins(db, revision, requested) {
  const previous = revision.previous ? read(db, revision.previous).r : null;
  const requires = requested === undefined ? (previous?.requires ?? []) : requested;
  if (!ids(requires)) fail('Supply at most 16 distinct immutable prerequisite revision IDs.', 400);
  const changes = requires.map((id) => read(db, id).r.changeId);
  if (new Set(changes).size !== changes.length)
    fail('Select only one revision of each prerequisite change.');
  if (requires.length) {
    const { obsolete } = closure(db, { ...revision, requires });
    if (obsolete) fail(obsolete);
    return [...requires];
  }
}
export function persistReviewDependencies(db, r) {
  if (!r.requires?.length) return;
  const put = db.prepare('INSERT INTO review_dependencies VALUES(?,?,?)');
  r.requires.forEach((id, i) => put.run(r.id, i, id));
}
function sameSelectedFiles(db, r, target) {
  const file = db.prepare('SELECT mode,oid FROM git_paths WHERE revision=? AND path=?');
  return r.edits.every((edit) =>
    equal(file.get(r.commit, edit.path) ?? null, file.get(target, edit.path) ?? null)
  );
}
export function reviewDependencyState(db, r, main, { historical = false } = {}) {
  if (!r.requires?.length) {
    if (
      db
        .prepare("SELECT 1 FROM sqlite_schema WHERE name='review_dependencies' AND type='table'")
        .get()
    )
      storedPins(db, r);
    return { state: 'ready', required: [], landings: [] };
  }
  storedPins(db, r);
  const { revisions, obsolete } = closure(db, r, { historical });
  if (obsolete) return { state: 'obsolete', reason: obsolete, required: r.requires, landings: [] };
  const landings = [];
  let waiting = false;
  for (const dep of revisions) {
    const ref = db
      .prepare('SELECT generation,record FROM review_landings WHERE version=?')
      .get(dep.id);
    if (!ref || ref.generation > main.generation) {
      waiting = true;
      continue;
    }
    const l = JSON.parse(ref.record);
    if (
      l.revisionId !== dep.id ||
      l.generation !== ref.generation ||
      (l.submitted ?? l.target) !== dep.commit
    )
      fail('Prerequisite landing identity is inconsistent.');
    if (!sameSelectedFiles(db, dep, main.target))
      return {
        state: 'obsolete',
        reason:
          'Prerequisite bytes or modes changed after landing. Submit a fresh dependent revision.',
        required: r.requires,
        landings
      };
    landings.push({
      revisionId: dep.id,
      changeId: dep.changeId,
      commit: dep.commit,
      generation: l.generation,
      target: l.target,
      checkId: l.checkId,
      approvalId: l.approvalId
    });
  }
  return {
    state: waiting ? 'waiting' : 'ready',
    ...(waiting
      ? {
          reason: 'Every exact prerequisite must land before checking or publishing this revision.'
        }
      : {}),
    required: r.requires,
    landings
  };
}
export function requiredLandingEvidence(db, r, main, options) {
  const state = reviewDependencyState(db, r, main, options);
  if (state.state !== 'ready') fail(state.reason);
  return state.landings;
}
export function verifyReviewDependencies(db) {
  for (const row of db.prepare('SELECT record FROM review_versions').iterate()) {
    const r = JSON.parse(row.record);
    storedPins(db, r);
    closure(db, r, { historical: true });
    for (const c of db.prepare('SELECT record FROM review_checks WHERE version=?').iterate(r.id)) {
      const check = JSON.parse(c.record),
        proof = requiredLandingEvidence(
          db,
          r,
          { generation: check.generation, target: check.target },
          { historical: true }
        );
      if (!equal(check.prerequisites ?? [], proof))
        fail('Historical prerequisite check evidence differs from its exact landing closure.');
    }
    const entry = db.prepare('SELECT record FROM review_landings WHERE version=?').get(r.id);
    if (entry) {
      const l = JSON.parse(entry.record),
        proof = requiredLandingEvidence(
          db,
          r,
          { generation: l.generation - 1, target: l.previous },
          { historical: true }
        );
      if (!equal(l.prerequisites ?? [], proof))
        fail('Historical publication lost its prerequisite landing evidence.');
    }
  }
}
