import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createTemporaryStore } from './support/database.mjs';
import { repository, actor, baseFiles, candidateFiles } from './fixtures/change.mjs';

const database = createTemporaryStore();
const target = { repository, name: 'integration' };
const short = (id) => id.slice(0, 12);

// File bytes commit first. The subsequent revision transaction can refer only
// to retained bytes; accepting a revision does not advance the integration ref.
function retainRevision(files, parents, message) {
  const edits = files.map(({ path, text }) => ({
    path,
    mode: '100644',
    fileId: database.store.putFile({ repository, bytes: Buffer.from(text) }).fileId
  }));
  return database.transaction(() =>
    database.store.acceptRevision({
      repository,
      parents,
      edits,
      author: actor,
      committer: actor,
      message
    })
  ).revisionId;
}

try {
  console.log('Lillia source storage example');
  console.log('Synthetic source revisions; no agents or review gate are run.\n');

  const base = retainRevision(baseFiles, [], 'Initial queue example');
  database.transaction(() =>
    database.store.advanceRef({
      ...target,
      expectedRevision: null,
      expectedGeneration: 0,
      revisionId: base,
      operationId: 'initialize'
    })
  );

  const candidate = retainRevision(candidateFiles, [base], 'Reject an empty queue');
  assert.equal(database.store.ref(target).revisionId, base);
  console.log(`1. Retained base ${short(base)} and candidate ${short(candidate)}.`);
  console.log('   Creating the candidate left the integration reference unchanged.');

  const update = {
    ...target,
    expectedRevision: base,
    expectedGeneration: 1,
    revisionId: candidate,
    operationId: 'accept-candidate'
  };
  const first = database.transaction(() => database.store.advanceRef(update));
  const retry = database.transaction(() => database.store.advanceRef(update));
  assert.deepEqual(retry, first);
  assert.equal(database.store.verify().events, 2);
  console.log('2. Advanced to the candidate once; repeating the same operation reused its event.');

  assert.throws(
    () =>
      database.transaction(() =>
        database.store.advanceRef({
          ...update,
          operationId: 'stale-request'
        })
      ),
    /target or generation changed/
  );
  assert.equal(database.store.ref(target).revisionId, candidate);
  assert.equal(database.store.verify().events, 2);
  console.log('3. Rejected a new request based on the old target and generation.');

  database.reopen();
  assert.equal(database.store.ref(target).revisionId, candidate);
  for (const [revisionId, files] of [
    [base, baseFiles],
    [candidate, candidateFiles]
  ]) {
    for (const { path, text } of files) {
      assert.equal(database.store.file({ repository, revisionId, path }).bytes.toString(), text);
    }
  }
  console.log('4. Reopened SQLite and read both revisions back with their original bytes.');

  const followUp = retainRevision(
    [{ path: 'README.md', text: 'Synthetic queue example.\n' }],
    [candidate],
    'Describe the example'
  );
  const before = database.store.ref(target);
  database.db.exec(`
    CREATE TRIGGER example_history_failure BEFORE INSERT ON native_ref_events
    BEGIN SELECT RAISE(ABORT, 'injected history failure'); END;
  `);
  // Catch inside the outer transaction: the store's own savepoint must undo
  // the reference update even though the outer transaction will commit.
  database.transaction(() => {
    assert.throws(
      () =>
        database.store.advanceRef({
          ...target,
          expectedRevision: candidate,
          expectedGeneration: 2,
          revisionId: followUp,
          operationId: 'follow-up'
        }),
      /injected history failure/
    );
  });
  database.db.exec('DROP TRIGGER example_history_failure');
  assert.deepEqual(database.store.ref(target), before);
  assert.equal(database.store.verify().events, 2);
  console.log('5. Injected a history-write failure; the reference and history stayed unchanged.');

  const verified = database.store.verify();
  console.log(
    `\nVerified ${verified.files} files, ${verified.revisions} revisions, ${verified.events} events.`
  );
} finally {
  database.close();
}

assert.equal(existsSync(database.directory), false);
console.log('Closed and removed the temporary database.');
