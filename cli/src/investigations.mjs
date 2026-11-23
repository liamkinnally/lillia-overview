import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { GitProject } from './git-project.mjs';
import { ResearchCatalog } from './research.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const gitOid = (text) =>
  createHash('sha1')
    .update('blob ' + Buffer.byteLength(text) + '\0')
    .update(text)
    .digest('hex');
const claim =
  'Git update-ref accepts a matching expected object ID and rejects the previous ID after the ref moves.';
const ref = 'refs/scion/experiment';
const names = [
  'question',
  'revision',
  'path',
  'sourceStart',
  'sourceEnd',
  'version',
  'recordId',
  'documentId',
  'startLine',
  'endLine',
  'hypothesis'
];
function check(ok, message, status = 400) {
  if (!ok) throw Object.assign(new Error(message), { status });
}
function text(value, max) {
  return typeof value === 'string' && value.length <= max && value.trim().length > 0;
}
function range(start, end) {
  check(
    Number.isSafeInteger(start) &&
      start >= 1 &&
      start <= 1000000 &&
      Number.isSafeInteger(end) &&
      end >= start &&
      end - start < 64,
    'Choose 1–64 inclusive source lines.'
  );
}
function normalize(input) {
  check(
    input &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      Object.keys(input).every((k) => names.includes(k)),
    'Unexpected investigation input field.'
  );
  check(
    text(input.question, 1000) && (input.hypothesis === undefined || text(input.hypothesis, 1000)),
    'Supply a bounded question and optional hypothesis.'
  );
  check(
    typeof input.version === 'string' &&
      /^[a-f0-9]{64}$/.test(input.version) &&
      typeof input.revision === 'string' &&
      /^[a-f0-9]{40}$/.test(input.revision),
    'Pin both catalog and source revisions.'
  );
  for (const k of ['path', 'recordId', 'documentId']) check(text(input[k], 1024), 'Invalid ' + k);
  range(input.sourceStart, input.sourceEnd);
  range(input.startLine, input.endLine);
  return Object.fromEntries(names.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
}
export function installInvestigations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS investigation_runs(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,revision TEXT NOT NULL REFERENCES git_revisions(revision),
    version TEXT NOT NULL REFERENCES research_versions(version),recordId TEXT NOT NULL,documentId TEXT NOT NULL,
    digest TEXT NOT NULL,record TEXT NOT NULL)`);
}
function material(db, input) {
  const {
    revision,
    path,
    sourceStart,
    sourceEnd,
    version,
    recordId,
    documentId,
    startLine,
    endLine
  } = input;
  const sourceFile = new GitProject({ db }, {}).file({ revision, path, limit: 262144 });
  check(
    ['100644', '100755'].includes(sourceFile.mode) && sourceFile.nextOffset === null,
    'Choose a regular source file within 256 KiB.'
  );
  let code;
  try {
    code = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(sourceFile.base64, 'base64')
    );
  } catch {
    check(false, 'Choose a UTF-8 source file.');
  }
  check(!code.includes('\0'), 'Choose ordinary source text.');
  const lines = code.match(/[^\n]*\n|[^\n]+$/g) || [];
  check(lines.length >= sourceEnd, 'Selected source lines exceed the file.');
  const excerpt = lines.slice(sourceStart - 1, sourceEnd).join('');
  const catalog = new ResearchCatalog({ db });
  const entry = catalog.record({ id: recordId, version });
  const linked = entry.evidence.find((e) => e.document?.id === documentId);
  check(linked, 'Selected document is not linked from the pinned catalog record.', 409);
  const blob = db
    .prepare('SELECT bytes FROM research_blobs WHERE digest=? AND length(bytes)<=4194304')
    .get(linked.document.sha256);
  check(
    blob && sha(blob.bytes) === linked.document.sha256,
    'Pinned document content failed its digest check.',
    409
  );
  const passage = catalog.passage({ id: documentId, version, startLine, endLine });
  check(
    Buffer.byteLength(excerpt) <= 8192 && Buffer.byteLength(passage.text) <= 8192,
    'Each selected excerpt must fit within 8 KiB.'
  );
  return {
    source: {
      revision,
      path,
      oid: sourceFile.oid,
      sourceStart,
      sourceEnd,
      text: excerpt,
      digest: sha(excerpt)
    },
    catalog: {
      version,
      recordId,
      documentId,
      snapshotId: passage.snapshot.id,
      sourceId: passage.source.id,
      documentDigest: passage.document.sha256,
      startLine,
      endLine,
      text: passage.text,
      digest: sha(passage.text)
    }
  };
}
function fixtureInputs(pins) {
  return { first: 'source\n' + pins.source.text, next: 'passage\n' + pins.catalog.text };
}
const steps = [
  'init --bare --template= --object-format=sha1',
  'hash-object -w --stdin (source and passage fixtures)',
  'update-ref REF FIRST ZERO',
  'update-ref REF NEXT FIRST',
  'rev-parse REF',
  'update-ref REF FIRST FIRST',
  'rev-parse REF'
];
function run(pins) {
  const root = mkdtempSync(join(tmpdir(), 'scion-ref-observation-'));
  const git = (args, input) =>
    spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', ...args], {
      cwd: root,
      env: {
        PATH: '/usr/bin:/bin',
        LC_ALL: 'C',
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ALLOW_PROTOCOL: '',
        GIT_TERMINAL_PROMPT: '0'
      },
      input,
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 16384
    });
  function required(args, input) {
    const result = git(args, input);
    if (result.error || result.status !== 0)
      throw Error('The fixed Git command ' + args[0] + ' did not complete successfully.');
    return result.stdout.trim();
  }
  let gitVersion = null;
  try {
    gitVersion = required(['--version']);
    required(['init', '--quiet', '--bare', '--template=', '--object-format=sha1']);
    const fixture = fixtureInputs(pins),
      first = required(['hash-object', '-w', '--stdin'], fixture.first),
      next = required(['hash-object', '-w', '--stdin'], fixture.next);
    check(
      first === gitOid(fixture.first) && next === gitOid(fixture.next),
      'Fixture identity differs from its expected Git blob.'
    );
    required(['update-ref', ref, first, '0'.repeat(40)]);
    const match = git(['update-ref', ref, next, first]),
      afterMatch = required(['rev-parse', '--verify', ref]);
    const stale = git(['update-ref', ref, first, first]),
      afterStale = required(['rev-parse', '--verify', ref]);
    if (match.error || stale.error || match.status === null || stale.status === null)
      throw Error('The fixed Git compare-and-swap test did not finish.');
    return {
      gitVersion,
      first,
      next,
      matchStatus: match.status,
      afterMatch,
      staleStatus: stale.status,
      afterStale,
      staleDiagnostic: (stale.stderr || '').trim().slice(0, 1024)
    };
  } catch (error) {
    return { gitVersion, unavailable: error.message };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function classify(o) {
  if (o.unavailable || o.matchStatus !== 0 || o.afterMatch !== o.next) return 'unknown';
  if (
    o.staleStatus !== 0 &&
    o.afterStale === o.next &&
    o.staleDiagnostic.includes('is at ' + o.next + ' but expected ' + o.first)
  )
    return 'reproduced';
  if (o.staleStatus === 0 && o.afterStale === o.first) return 'contradicted';
  return 'unknown';
}
function conclusions(outcome, optional) {
  const hypotheses = [{ text: claim, state: outcome }];
  if (optional !== undefined) hypotheses.push({ text: optional, state: 'untested' });
  return {
    hypotheses,
    decision:
      outcome === 'reproduced'
        ? 'Use an expected old object ID when updating the local integration ref.'
        : 'Defer the ref-update decision until the expected-old-value behavior is verified.',
    limitation:
      'The experiment exercises one serial stale write to a disposable local ref. It does not test crash durability, remote concurrency, or execute the selected source.'
  };
}
function verify(db, row) {
  check(sha(row.record) === row.digest, 'Investigation record digest mismatch.', 409);
  const r = JSON.parse(row.record),
    input = normalize(r.input);
  check(
    [
      ['id', r.id],
      ['revision', input.revision],
      ['version', input.version],
      ['recordId', input.recordId],
      ['documentId', input.documentId]
    ].every(([k, v]) => row[k] === v),
    'Investigation source index mismatch.',
    409
  );
  const pins = material(db, input);
  check(
    isDeepStrictEqual(r.source, pins.source) &&
      isDeepStrictEqual(r.catalog, pins.catalog) &&
      r.method === 'git-ref-cas-v1' &&
      isDeepStrictEqual(r.steps, steps),
    'Investigation method or material failed closure.',
    409
  );
  const o = r.observation,
    fixture = fixtureInputs(pins);
  check(
    o &&
      (o.unavailable ||
        (text(o.gitVersion, 200) &&
          o.first === gitOid(fixture.first) &&
          o.next === gitOid(fixture.next) &&
          Number.isInteger(o.matchStatus) &&
          Number.isInteger(o.staleStatus))),
    'Investigation observation lost its fixture identity.',
    409
  );
  const outcome = classify(o),
    expected = conclusions(outcome, input.hypothesis);
  check(
    outcome === r.outcome &&
      isDeepStrictEqual(r.hypotheses, expected.hypotheses) &&
      r.decision === expected.decision &&
      r.limitation === expected.limitation,
    'Investigation decision differs from the observed result.',
    409
  );
  return r;
}
export function verifyInvestigations(db) {
  for (const row of db.prepare('SELECT * FROM investigation_runs ORDER BY seq').iterate())
    verify(db, row);
}
export class Investigations {
  #prepared = new WeakMap();
  constructor(store) {
    this.db = store.db;
  }
  prepare(raw) {
    const input = normalize(raw),
      pins = material(this.db, input),
      observation = run(pins),
      outcome = classify(observation);
    const r = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      method: 'git-ref-cas-v1',
      input,
      ...pins,
      steps,
      observation,
      outcome,
      ...conclusions(outcome, input.hypothesis)
    };
    const token = Object.freeze({ id: r.id });
    this.#prepared.set(token, JSON.stringify(r));
    return token;
  }
  record(token) {
    const body = this.#prepared.get(token);
    check(
      this.db.isTransaction && body,
      'A prepared investigation and receipt transaction are required.',
      409
    );
    const r = JSON.parse(body),
      { revision, version, recordId, documentId } = r.input;
    verify(this.db, {
      id: r.id,
      revision,
      version,
      recordId,
      documentId,
      digest: sha(body),
      record: body
    });
    this.db
      .prepare(
        'INSERT INTO investigation_runs(id,revision,version,recordId,documentId,digest,record) VALUES(?,?,?,?,?,?,?)'
      )
      .run(r.id, revision, version, recordId, documentId, sha(body), body);
    return r;
  }
  show({ id }) {
    check(text(id, 128), 'Invalid investigation ID.');
    const row = this.db.prepare('SELECT * FROM investigation_runs WHERE id=?').get(id);
    check(row, 'Investigation not found.', 404);
    return verify(this.db, row);
  }
  list({ after = 0, limit = 20 } = {}) {
    check(
      Number.isSafeInteger(after) &&
        after >= 0 &&
        Number.isSafeInteger(limit) &&
        limit >= 1 &&
        limit <= 100,
      'Invalid investigation page.'
    );
    const rows = this.db
      .prepare(
        `SELECT seq,id,revision,version,recordId,documentId,digest,
      json_extract(record,'$.input.question') AS question,json_extract(record,'$.outcome') AS outcome FROM investigation_runs WHERE seq>? ORDER BY seq LIMIT ?`
      )
      .all(after, limit + 1);
    return { runs: rows.slice(0, limit), cursor: rows.length > limit ? rows[limit - 1].seq : null };
  }
}
