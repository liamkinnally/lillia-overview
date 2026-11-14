import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createTemporaryStore } from '../support/database.mjs';

// These values are part of the original identity vectors, not demo metadata.
const actor = { name: 'A', email: 'a@x', seconds: 0, offset: '+0000' };
const repository = 'demo';
const entry = (path, fileId, mode = '100644') => ({ path, mode, fileId });

function fixture(t) {
  const database = createTemporaryStore();
  t.after(() => database.close());
  const spec = (edits = [], parents = [], extra = {}) => ({
    repository,
    parents,
    edits,
    author: actor,
    committer: actor,
    message: '',
    ...extra
  });
  return {
    database,
    get db() {
      return database.db;
    },
    get store() {
      return database.store;
    },
    file(bytes, scope = repository) {
      return database.store.putFile({ repository: scope, bytes: Buffer.from(bytes) }).fileId;
    },
    accept(edits = [], parents = [], extra = {}) {
      return database.transaction(() => database.store.acceptRevision(spec(edits, parents, extra)))
        .revisionId;
    },
    ref(revisionId, expectedRevision, expectedGeneration, operationId, name = 'integration') {
      return database.transaction(() =>
        database.store.advanceRef({
          repository,
          name,
          revisionId,
          expectedRevision,
          expectedGeneration,
          operationId
        })
      );
    },
    state(name = 'integration') {
      return {
        ref: database.store.ref({ repository, name }),
        events: database.db.prepare('SELECT count(*) AS count FROM native_ref_events').get().count
      };
    }
  };
}

test('original identities, binary/executable/link bytes and repository grants survive reopening', (t) => {
  const f = fixture(t);
  assert.equal(f.file(''), '56d90533fac626b9ffc4bc85d50336176a324f17d3396b9e7588a2dcf8535cff');
  assert.equal(
    f.file('hello\n'),
    '2b62a072a7970c4b30503a2e41956768122f635ea8a135cc96dcf10d737be882'
  );
  assert.equal(f.accept(), 'd19a96492241cf770acfa30b2a36a43067a1f23464b62eeda8fdf0784e8ee333');

  const bytes = Buffer.from([0, 1, 255]);
  const payload = f.file(bytes);
  const link = f.file('../tool');
  const edits = [entry('tool', payload, '100755'), entry('lib/link', link, '120000')];
  const metadata = {
    message: 'one\n\ntwo\n',
    committer: { ...actor, seconds: 1700000000, offset: '-0530' },
    provenance: { principal: 'task-service', taskId: 't1' }
  };
  const revisionId = f.accept(edits, [], metadata);
  assert.equal(f.accept([...edits].reverse(), [], metadata), revisionId);
  assert.throws(() => f.accept(edits, [], { repository: 'other' }), /grant|authorized/i);
  assert.throws(() => f.store.file({ repository: 'other', revisionId, path: 'tool' }));
  // Bytes must be committed before the transaction that accepts a revision.
  assert.throws(() => f.database.transaction(() => f.file('later')), /prior|transaction/i);

  f.database.reopen();
  assert.deepEqual(f.store.file({ repository, revisionId, path: 'tool' }).bytes, bytes);
  assert.equal(
    f.store.file({ repository, revisionId, path: 'lib/link' }).bytes.toString(),
    '../tool'
  );
  const restored = f.store.revision({ repository, revisionId });
  assert.deepEqual(restored.committer, metadata.committer);
  assert.equal(restored.message, metadata.message);
  assert.deepEqual(restored.provenance, metadata.provenance);
  assert.equal(f.file(bytes, 'other'), payload);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM native_files').get().count, 4);
});

test('first-parent deltas, stale updates, rollback and operation replay preserve reference history', (t) => {
  const f = fixture(t);
  const baseBytes = f.file('base');
  const leftBytes = f.file('left');
  const rightBytes = f.file('right');
  const root = f.accept([entry('a', baseBytes), entry('removed', baseBytes)]);
  const left = f.accept([entry('a', leftBytes)], [root]);
  const right = f.accept([entry('b', rightBytes), { path: 'removed', delete: true }], [root]);
  const merged = f.accept(
    [entry('b', rightBytes), { path: 'removed', delete: true }],
    [left, right]
  );
  assert.deepEqual(f.store.tree({ repository, revisionId: merged }).entries, [
    entry('a', leftBytes),
    entry('b', rightBytes)
  ]);
  assert.deepEqual(f.store.revision({ repository, revisionId: merged }).parents, [left, right]);

  f.ref(root, null, 0, 'init');
  f.ref(left, root, 1, 'left');
  const before = f.state();
  const rejected = [
    {
      label: 'stale target and generation',
      target: root,
      generation: 1,
      candidate: right,
      error: /generation|target/i
    },
    {
      label: 'stale target alone',
      target: root,
      generation: 2,
      candidate: merged,
      error: /generation|target/i
    },
    {
      label: 'stale generation alone',
      target: left,
      generation: 1,
      candidate: merged,
      error: /generation|target/i
    },
    {
      label: 'candidate outside first-parent ancestry',
      target: left,
      generation: 2,
      candidate: right,
      error: /first.parent|descend/i
    }
  ];
  for (const [index, scenario] of rejected.entries()) {
    assert.throws(
      () => f.ref(scenario.candidate, scenario.target, scenario.generation, `rejected-${index}`),
      scenario.error,
      scenario.label
    );
    assert.deepEqual(f.state(), before, `${scenario.label}: reference and history unchanged`);
  }

  const input = {
    repository,
    name: 'integration',
    revisionId: merged,
    expectedRevision: left,
    expectedGeneration: 2,
    operationId: 'merge'
  };
  assert.throws(
    () =>
      f.database.transaction(() => {
        f.store.advanceRef(input);
        throw new Error('fail-stop');
      }),
    /fail-stop/
  );
  assert.deepEqual(f.state(), before, 'outer rollback removes both the update and event');

  const first = f.database.transaction(() => f.store.advanceRef(input));
  const afterMerge = f.state();
  assert.equal(afterMerge.ref.revisionId, merged);
  assert.equal(afterMerge.ref.generation, 3);
  assert.equal(afterMerge.events, 3);
  f.database.reopen();
  assert.deepEqual(
    f.database.transaction(() => f.store.advanceRef(input)),
    first
  );
  assert.deepEqual(f.state(), afterMerge, 'replaying an operation creates no additional event');
  assert.throws(
    () => f.database.transaction(() => f.store.advanceRef({ ...input, revisionId: left })),
    /operation/i
  );
  assert.deepEqual(
    f.state(),
    afterMerge,
    'a conflicting replay cannot change the reference or history'
  );

  const next = f.accept([], [merged], { message: 'continued use' });
  f.ref(next, merged, 3, 'next');
  assert.equal(f.state().ref.revisionId, next);
  assert.equal(f.store.verify().events, 4);
});

test('invalid paths, malformed revisions and damaged bytes fail closed', (t) => {
  const f = fixture(t);
  const fileId = f.file('one');
  const nul = f.file(Buffer.from([0]));
  const set = (path, mode = '100644', id = fileId) => entry(path, id, mode);
  const paths = [
    ['parent traversal', '../x'],
    ['reserved Git directory', 'x/.GIT/a'],
    ['trailing dot', 'x./b'],
    ['colon', 'a:b'],
    ['non-ASCII spelling', 'café'],
    ['backslash', 'dir\\x'],
    ['reserved device name', 'nul.txt']
  ];
  for (const [label, path] of paths) {
    assert.throws(() => f.accept([set(path)]), undefined, label);
  }
  const invalidRevisions = [
    ['case-colliding directories', [set('Dir/x'), set('dir/y')]],
    ['file-directory collision', [set('x'), set('x/y')]],
    ['duplicate edit', [set('a'), set('a')]],
    ['unsupported mode', [set('x', '160000')]],
    ['NUL in symlink target', [set('x', '120000', nul)]]
  ];
  for (const [label, edits] of invalidRevisions) {
    assert.throws(() => f.accept(edits), undefined, label);
  }
  assert.throws(() => f.accept([], ['f'.repeat(64)]), undefined, 'missing parent');
  assert.throws(
    () => f.accept([], [], { author: { ...actor, offset: '+1461' } }),
    undefined,
    'invalid author offset'
  );
  const revisionId = f.accept([set('ok')]);
  assert.throws(
    () => f.accept([{ path: 'absent', delete: true }], [revisionId]),
    undefined,
    'deleting an absent file'
  );
  assert.equal(f.store.verify().revisions, 1, 'rejected revisions leave no partial records');

  f.db.prepare('UPDATE native_files SET bytes=? WHERE id=?').run(Buffer.from('tamper'), fileId);
  assert.throws(() => f.store.file({ repository, revisionId, path: 'ok' }), /digest|integrity/i);
  assert.throws(() => f.store.verify());
  assert.throws(() => f.db.prepare('DELETE FROM native_files WHERE id=?').run(nul), /FOREIGN KEY/);
});

test('caught history-insertion failures undo both existing and newly created references', (t) => {
  const f = fixture(t);
  const root = f.accept();
  const next = f.accept([], [root], { message: 'next' });
  f.ref(root, null, 0, 'seed');

  const cases = [
    { name: 'integration', expectedRevision: root, expectedGeneration: 1 },
    { name: 'new-reference', expectedRevision: null, expectedGeneration: 0 }
  ];
  for (const scenario of cases) {
    const before = f.state(scenario.name);
    const input = {
      repository,
      ...scenario,
      revisionId: next,
      operationId: `advance-${scenario.name}`
    };
    f.db.exec(
      "CREATE TRIGGER fixture_failure BEFORE INSERT ON native_ref_events BEGIN SELECT RAISE(ABORT,'fixture storage error'); END"
    );
    // Catch inside the outer transaction so it COMMITs. The store's savepoint,
    // rather than the adapter's rollback, must undo the partial reference write.
    f.database.transaction(() => {
      assert.throws(() => f.store.advanceRef(input), /fixture storage error/);
    });
    assert.deepEqual(
      f.state(scenario.name),
      before,
      `${scenario.name}: reference and event count unchanged`
    );
    f.db.exec('DROP TRIGGER fixture_failure');
    f.database.transaction(() => f.store.advanceRef(input));
    assert.equal(f.state(scenario.name).ref.revisionId, next);
    assert.equal(f.state(scenario.name).ref.generation, scenario.expectedGeneration + 1);
    assert.equal(f.state(scenario.name).events, before.events + 1);
  }
  f.database.reopen();
  assert.equal(f.store.verify().events, 3);
});

test('the temporary adapter rolls back failures, reopens retained data and removes its directory on close', (t) => {
  const f = fixture(t);
  const directory = f.database.directory;
  const root = f.accept();
  f.ref(root, null, 0, 'seed');
  const before = f.state();
  assert.ok(existsSync(directory));
  assert.throws(
    () =>
      f.database.transaction(() => {
        f.db.prepare('DELETE FROM native_refs WHERE repository=?').run(repository);
        throw new Error('adapter rollback');
      }),
    /adapter rollback/
  );
  assert.deepEqual(f.state(), before);
  let asynchronousCallbackRan = false;
  assert.throws(
    () =>
      f.database.transaction(async () => {
        asynchronousCallbackRan = true;
      }),
    /synchronous callback/
  );
  assert.equal(asynchronousCallbackRan, false, 'async callbacks must not begin work');
  assert.throws(
    () =>
      f.database.transaction(() => {
        f.db.prepare('DELETE FROM native_refs WHERE repository=?').run(repository);
        return Promise.resolve();
      }),
    /synchronous result/
  );
  assert.deepEqual(f.state(), before, 'a returned promise cannot commit partial work');
  f.database.reopen();
  assert.deepEqual(f.state(), before);
  const next = f.accept([], [root], { message: 'after reopen' });
  f.ref(next, root, 1, 'after-reopen');
  assert.equal(f.store.verify().events, 2);
  f.database.close();
  assert.equal(
    existsSync(directory),
    false,
    'close removes database, journal and temporary directory'
  );
  f.database.close(); // t.after also closes: cleanup must be safe to repeat.
});
