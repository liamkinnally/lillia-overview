import { createHash } from 'node:crypto';
import { NativeStore, validateNativeId, validateNativeLabel } from './native-store.mjs';
import {
  hashRecord,
  requireReview as need,
  isPortableJs,
  nativePolicyAt
} from './native-policy.mjs';
import {
  portableProfile,
  validateJsCases,
  validateJsModule,
  runJsModule
} from './native-js-worker.mjs';

export const nativeJavascriptTables = ['native_js_recipes', 'native_js_runs'];
const bytesDigest = (b) => createHash('sha256').update(b).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const live = new WeakMap(),
  scheduling = new WeakMap();
export function installNativeJavascript(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS native_js_recipes(id TEXT PRIMARY KEY,operationId TEXT UNIQUE NOT NULL,record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS native_js_runs(id TEXT PRIMARY KEY,submissionId TEXT NOT NULL REFERENCES native_submissions(id),recipeId TEXT NOT NULL REFERENCES native_js_recipes(id),record TEXT NOT NULL);`);
}
export function normalizeJsEnrollment(raw) {
  const keys = [
    'repository',
    'expectedPolicyDigest',
    'base',
    'expectedGeneration',
    'path',
    'exportName',
    'cases'
  ];
  need(
    raw && Object.keys(raw).length === keys.length && keys.every((k) => Object.hasOwn(raw, k)),
    'Expected exact JavaScript enrollment fields',
    400
  );
  validateNativeLabel(raw.repository);
  validateNativeId(raw.base);
  validateNativeId(raw.expectedPolicyDigest);
  need(
    isPortableJs(raw.path) &&
      Number.isSafeInteger(raw.expectedGeneration) &&
      raw.expectedGeneration >= 1,
    'Invalid portable module path or mainline generation',
    400
  );
  return {
    repository: raw.repository,
    expectedPolicyDigest: raw.expectedPolicyDigest,
    base: raw.base,
    expectedGeneration: raw.expectedGeneration,
    path: raw.path,
    ...validateJsCases(raw.exportName, raw.cases)
  };
}
function recipeRecord(input, op, epoch) {
  return {
    id: hashRecord([portableProfile, input, op, epoch]),
    profile: portableProfile,
    input,
    operationId: op,
    epoch
  };
}
function recipe(db, id) {
  const row = db.prepare('SELECT * FROM native_js_recipes WHERE id=?').get(id);
  need(row, 'Unknown owner JavaScript recipe', 404);
  const r = JSON.parse(row.record),
    input = normalizeJsEnrollment(r.input);
  const receipt = db
    .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
    .get(row.operationId);
  need(
    id === r.id &&
      same(r, recipeRecord(input, row.operationId, r.epoch)) &&
      receipt?.digest === hashRecord(['js.enroll', input]) &&
      same(JSON.parse(receipt.receipt), { operationId: row.operationId, recipe: r }),
    'JavaScript recipe or original owner intent changed'
  );
  return r;
}
export function jsGrant(db, subject, authority) {
  if (!isPortableJs(subject.path)) {
    need(!subject.jsRecipe, 'A JavaScript recipe only applies to a portable module');
    return null;
  }
  const grant = recipe(db, subject.jsRecipe);
  need(
    grant.input.repository === authority.repository &&
      grant.epoch === authority.epoch &&
      grant.input.expectedPolicyDigest === authority.policyDigest &&
      grant.input.path === subject.path &&
      !subject.ownerPolicy &&
      authority.allowedPaths.includes(subject.path),
    'JavaScript recipe is outside its admitted policy or source'
  );
  const native = new NativeStore({ db });
  let cursor = subject.base;
  while (cursor && cursor !== grant.input.base)
    cursor = native.revision({ repository: authority.repository, revisionId: cursor }).parents[0];
  need(cursor === grant.input.base, 'JavaScript author base is outside enrollment ancestry');
  return {
    id: grant.id,
    profile: grant.profile,
    exportName: grant.input.exportName,
    cases: grant.input.cases,
    contract:
      'Export module.exports.NAME = function (scalarParams) { ... }; Use scalar arithmetic, comparisons, boolean operators, optional const locals, if (condition) return value; and one final return. No other functions, property reads, imports or loops.'
  };
}
function summary(run) {
  return {
    runId: run.id,
    recipeId: run.recipeId,
    sourceFileId: run.sourceFileId,
    artifactDigest: run.artifactDigest,
    toolchainDigest: run.toolchainDigest,
    state: run.state,
    failures: run.failures,
    ...(run.diagnostic ? { diagnostic: run.diagnostic } : {})
  };
}
export function jsHistoric(db, r, id) {
  const row = db.prepare('SELECT * FROM native_js_runs WHERE id=?').get(id);
  need(row, 'No retained isolated JavaScript validation');
  const run = JSON.parse(row.record),
    { id: runId, ...body } = run,
    grant = recipe(db, row.recipeId);
  const src = new NativeStore({ db }).file({
    repository: r.repository,
    revisionId: r.commit,
    path: r.path
  });
  need(
    runId === id &&
      id === hashRecord(body) &&
      body.submissionId === r.id &&
      row.submissionId === r.id &&
      row.recipeId === r.jsRecipe &&
      run.recipeId === r.jsRecipe &&
      run.sourceDigest === bytesDigest(src.bytes) &&
      run.sourceFileId === src.fileId &&
      src.mode === '100644' &&
      src.fileId === r.newFileId,
    'JavaScript validation source changed'
  );
  if (run.diagnostic) {
    let reason;
    try {
      const p = validateJsModule(src.bytes, grant.input.exportName);
      need(
        p.parameters.length === grant.input.cases[0].args.length,
        'The export arity differs from the owner cases'
      );
    } catch (e) {
      reason = e.message;
    }
    need(
      reason === run.diagnostic &&
        run.state === 'failed' &&
        run.artifactDigest === null &&
        run.toolchainDigest === null &&
        run.cachedData === null &&
        same(run.failures, []) &&
        same(run.outputs, []),
      'Invalid source diagnostic changed'
    );
  } else {
    const { parameters } = validateJsModule(src.bytes, grant.input.exportName);
    need(
      parameters.length === grant.input.cases[0].args.length,
      'Archived JavaScript signature or arity changed'
    );
    const artifact = Buffer.from(run.cachedData, 'base64');
    need(
      artifact.length > 0 &&
        artifact.length <= 32768 &&
        artifact.toString('base64') === run.cachedData &&
        run.artifactDigest === bytesDigest(artifact) &&
        [
          'emptyEnvironment',
          'readDenied',
          'writeDenied',
          'forkDenied',
          'networkDenied',
          'socketDenied'
        ].every((k) => run.confinement?.[k] === true) &&
        run.toolchain?.profile === portableProfile &&
        run.toolchainDigest === hashRecord(run.toolchain) &&
        ['runtimeDigest', 'runnerDigest', 'policyDigest', 'loaderDigest'].every((k) =>
          /^[a-f0-9]{64}$/.test(run.toolchain[k])
        ) &&
        run.outputs.length === grant.input.cases.length &&
        run.outputs.every(
          (v) => v === null || typeof v === 'boolean' || (Number.isFinite(v) && Math.abs(v) <= 1e12)
        ) &&
        Number.isSafeInteger(run.peakRSSKiB) &&
        run.peakRSSKiB > 0 &&
        run.peakRSSKiB <= 131072,
      'JavaScript artifact, toolchain or vector output changed'
    );
    const failures = grant.input.cases.flatMap((c, i) =>
      c.expected === run.outputs[i] ? [] : [i]
    );
    need(
      same(failures, run.failures) && run.state === (failures.length ? 'failed' : 'passed'),
      'JavaScript case outcome changed'
    );
  }
  return { evidence: summary(run), run };
}
export function jsLive(store, r) {
  const id = live.get(store)?.get(r.id);
  need(id, 'A fresh isolated JavaScript validation is required for this daemon');
  return jsHistoric(store.db, r, id);
}
export function appendJsFailures(failures, evidence) {
  if (evidence.state === 'failed')
    failures.push({
      reason: evidence.diagnostic ?? 'JavaScript owner vectors failed',
      cases: evidence.failures
    });
}
export class NativeJavascript {
  constructor(store, { authority }) {
    this.store = store;
    this.db = store.db;
    this.authority = authority;
    this.native = new NativeStore(store);
  }
  enroll(raw, operationId) {
    need(this.db.isTransaction, 'JavaScript enrollment requires owner writer transaction');
    const input = normalizeJsEnrollment(raw),
      a = this.authority();
    need(
      a &&
        input.repository === a.repository &&
        input.expectedPolicyDigest === a.policyDigest &&
        a.allowedPaths.includes(input.path),
      'JavaScript enrollment exceeds current policy'
    );
    const head = this.native.ref({ repository: a.repository, name: a.ref }),
      file = this.native.file({
        repository: a.repository,
        revisionId: input.base,
        path: input.path
      });
    need(
      head.revisionId === input.base &&
        head.generation === input.expectedGeneration &&
        file.mode === '100644' &&
        file.bytes.length <= 4096,
      'JavaScript enrollment source or generation changed'
    );
    need(
      this.db.prepare('SELECT count(*) n FROM native_js_recipes').get().n < 128,
      'JavaScript enrollment capacity reached'
    );
    const result = recipeRecord(input, operationId, a.epoch);
    this.db
      .prepare('INSERT INTO native_js_recipes VALUES(?,?,?)')
      .run(result.id, operationId, JSON.stringify(result));
    return { recipe: result };
  }
  list() {
    const a = this.authority();
    if (!a) return { recipes: [] };
    const rows = this.db
      .prepare(
        "SELECT id FROM native_js_recipes WHERE json_extract(record,'$.epoch')=? AND json_extract(record,'$.input.expectedPolicyDigest')=? ORDER BY rowid DESC LIMIT 128"
      )
      .all(a.epoch, a.policyDigest);
    const recipes = rows
      .map((row) => recipe(this.db, row.id))
      .filter((g) => g.input.repository === a.repository && a.allowedPaths.includes(g.input.path))
      .map((g) => ({
        id: g.id,
        path: g.input.path,
        exportName: g.input.exportName,
        caseCount: g.input.cases.length
      }));
    return { recipes };
  }
  show({ id }) {
    validateNativeId(id);
    return { recipe: recipe(this.db, id) };
  }
  async ensure(submissionId) {
    if (!scheduling.has(this.store))
      scheduling.set(this.store, { tail: Promise.resolve(), pending: new Map() });
    const slot = scheduling.get(this.store);
    if (slot.pending.has(submissionId)) return slot.pending.get(submissionId);
    need(slot.pending.size < 8, 'Isolated JavaScript validation queue is full', 503);
    const job = slot.tail.then(() => this.#execute(submissionId));
    slot.pending.set(submissionId, job);
    slot.tail = job.catch(() => {});
    try {
      return await job;
    } finally {
      slot.pending.delete(submissionId);
    }
  }
  async #execute(submissionId) {
    const raw = this.db
      .prepare('SELECT record FROM native_submissions WHERE id=?')
      .get(submissionId);
    need(raw, 'Unknown native submission');
    const r = JSON.parse(raw.record);
    if (!r.jsRecipe) return null;
    const grant = jsGrant(this.db, r, this.authority()),
      source = this.native.file({
        repository: r.repository,
        revisionId: r.commit,
        path: r.path
      }).bytes;
    if (live.get(this.store)?.has(r.id)) return jsLive(this.store, r).evidence;
    let result;
    try {
      result = await runJsModule({ source, exportName: grant.exportName, cases: grant.cases });
    } catch (e) {
      if (e.status !== 400) throw e;
      result = {
        state: 'failed',
        outputs: [],
        failures: [],
        cachedData: null,
        artifactDigest: null,
        sourceDigest: bytesDigest(source),
        toolchainDigest: null,
        diagnostic: e.message
      };
    }
    const body = { submissionId: r.id, sourceFileId: r.newFileId, recipeId: grant.id, ...result },
      id = hashRecord(body),
      run = { id, ...body };
    this.store.transaction(() => {
      jsGrant(this.db, r, this.authority());
      if (!this.db.prepare('SELECT 1 FROM native_js_runs WHERE id=?').get(id)) {
        need(
          this.db.prepare('SELECT count(*) n FROM native_js_runs').get().n < 1024,
          'JavaScript validation retention capacity reached'
        );
        this.db
          .prepare('INSERT INTO native_js_runs VALUES(?,?,?,?)')
          .run(id, r.id, grant.id, JSON.stringify(run));
      }
      jsHistoric(this.db, r, id);
    });
    if (!live.has(this.store)) live.set(this.store, new Map());
    live.get(this.store).set(r.id, id);
    return summary(run);
  }
}
export function verifyNativeJavascript(db) {
  const baseline = db.prepare('SELECT record FROM native_authority WHERE slot=1').get();
  let recipes = 0,
    runs = 0;
  for (const row of db.prepare('SELECT id FROM native_js_recipes').iterate()) {
    const g = recipe(db, row.id),
      i = g.input,
      a = baseline && nativePolicyAt(db, JSON.parse(baseline.record), i.expectedPolicyDigest);
    const e = db
      .prepare(
        "SELECT revisionId FROM native_ref_events WHERE repository=? AND name='mainline' AND generation=?"
      )
      .get(i.repository, i.expectedGeneration);
    const f = new NativeStore({ db }).file({
      repository: i.repository,
      revisionId: i.base,
      path: i.path
    });
    need(
      a?.epoch === g.epoch &&
        a.repository === i.repository &&
        a.policyDigest === i.expectedPolicyDigest &&
        a.allowedPaths.includes(i.path) &&
        e?.revisionId === i.base &&
        f.mode === '100644' &&
        f.bytes.length <= 4096,
      'JavaScript enrollment lost owner policy or mainline'
    );
    recipes++;
  }
  for (const row of db.prepare('SELECT id,submissionId FROM native_js_runs').iterate()) {
    const r = JSON.parse(
      db.prepare('SELECT record FROM native_submissions WHERE id=?').get(row.submissionId).record
    );
    jsHistoric(db, r, row.id);
    runs++;
  }
  need(
    !db
      .prepare(
        "SELECT 1 FROM command_receipts c LEFT JOIN native_js_recipes j ON j.operationId=c.operationId WHERE json_type(c.receipt,'$.recipe.input.exportName')='text' AND j.id IS NULL LIMIT 1"
      )
      .get(),
    'Owner JavaScript enrollment lost its projection'
  );
  return { recipes, runs };
}
