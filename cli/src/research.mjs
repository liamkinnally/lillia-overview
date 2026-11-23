import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const MiB = 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const states = new Set(['documented', 'located_in_code', 'reproduced', 'inferred', 'unknown']);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
function check(condition, message) {
  if (!condition) throw problem(message);
}
function count(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function text(value, max = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function safePath(value) {
  check(
    text(value, 2048) &&
      !/[\\\x00-\x1f\x7f:]/.test(value) &&
      value.split('/').every((p) => p && p !== '.' && p !== '..'),
    'Invalid relative capture path'
  );
  return value;
}
function indexed(array, field, max, label) {
  check(Array.isArray(array) && array.length <= max, 'Invalid ' + label + ' inventory');
  const map = new Map();
  for (const item of array) {
    const key = item?.[field];
    check(text(key, 2048) && !map.has(key), 'Invalid or duplicate ' + label + ' identity');
    map.set(key, item);
  }
  return map;
}
function checkEvidenceIdentity(e, doc, snapshot) {
  if (e.snapshot_id != null)
    check(
      snapshot && e.snapshot_id === snapshot.id,
      'Evidence snapshot differs from its captured identity'
    );
  if (e.source_id != null && snapshot)
    check(e.source_id === snapshot.source_id, 'Evidence source differs from its captured identity');
  if (doc?.source_id != null)
    check(doc.source_id === snapshot?.source_id, 'Document source differs from its snapshot');
}
function parse(bytes) {
  try {
    return JSON.parse(utf8.decode(bytes));
  } catch {
    throw problem('Expected a UTF-8 JSON capture');
  }
}

// Darwin's O_NOFOLLOW_ANY rejects a symlink in any component atomically. Linux
// resolves one child at a time relative to pinned, no-follow directory handles.
async function openCaptured(root, relative) {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  if (process.platform === 'darwin')
    return open(path.join(root, relative), constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000);
  if (process.platform !== 'linux') throw problem('Safe capture import requires macOS or Linux');
  let directory = await open('/', flags | constants.O_DIRECTORY);
  try {
    const components = [...root.split('/').filter(Boolean), ...relative.split('/')];
    for (const part of components.slice(0, -1)) {
      const child = await open(
        '/proc/self/fd/' + directory.fd + '/' + part,
        flags | constants.O_DIRECTORY
      );
      await directory.close();
      directory = child;
    }
    return await open('/proc/self/fd/' + directory.fd + '/' + components.at(-1), flags);
  } finally {
    await directory.close();
  }
}

async function readBounded(root, relative, cap, expected) {
  safePath(relative);
  const handle = await openCaptured(root, relative);
  try {
    const info = await handle.stat();
    check(
      info.isFile() && info.nlink === 1 && count(info.size, 0, cap),
      'Unsafe capture file type or size'
    );
    if (expected) check(info.size === expected.bytes, 'Capture size mismatch: ' + relative);
    const buffer = Buffer.alloc(info.size + 1);
    let pos = 0;
    while (pos < buffer.length) {
      const { bytesRead } = await handle.read(buffer, pos, buffer.length - pos, pos);
      if (!bytesRead) break;
      pos += bytesRead;
    }
    check(pos === info.size, 'Capture size changed during import');
    const bytes = buffer.subarray(0, pos);
    if (expected) check(digest(bytes) === expected.sha256, 'Capture digest mismatch: ' + relative);
    return bytes;
  } finally {
    await handle.close();
  }
}

export function installResearch(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_versions(version TEXT PRIMARY KEY,summary TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_blobs(digest TEXT PRIMARY KEY,bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS research_entities(
      version TEXT NOT NULL REFERENCES research_versions(version),kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,
      PRIMARY KEY(version,kind,id));
    CREATE TABLE IF NOT EXISTS research_pins(kind TEXT NOT NULL,id TEXT NOT NULL,pin TEXT NOT NULL,PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS research_relations(version TEXT NOT NULL REFERENCES research_versions(version),
      src TEXT NOT NULL,dst TEXT NOT NULL,relation TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(version,src,dst,relation));
    CREATE VIRTUAL TABLE IF NOT EXISTS research_search USING fts5(version UNINDEXED,id,title,summary,body,keywords);
  `);
}

function indexRecord(statement, version, r) {
  statement.run(
    version,
    r.id,
    r.title,
    r.summary,
    r.body ?? '',
    [...(r.tags ?? []), ...(r.stages ?? [])].join(' ')
  );
}

export class ResearchCatalog {
  #prepared = new WeakMap();
  constructor(store) {
    this.db = store.db;
  }

  async prepareImport(directory) {
    check(text(directory) && path.isAbsolute(directory), 'Supply an absolute capture directory');
    try {
      const selected = path.resolve(directory);
      check((await lstat(selected)).isDirectory(), 'Select a real directory as the capture root');
      return await this.#verify(await realpath(selected));
    } catch (error) {
      if (error.status) throw error;
      throw problem('Cannot verify captured input: ' + (error.code ?? 'invalid format'));
    }
  }

  async #verify(root) {
    const rawManifest = await readBounded(root, 'PACK_MANIFEST.json', 2 * MiB);
    const manifest = parse(rawManifest);
    check(manifest?.format === 1, 'Unsupported pack manifest version');
    const files = indexed(manifest.files, 'path', 4096, 'manifest');
    for (const f of files.values()) {
      safePath(f.path);
      check(
        count(f.bytes, 0, Number.MAX_SAFE_INTEGER) && /^[a-f0-9]{64}$/.test(f.sha256),
        'Invalid manifest digest or size'
      );
    }
    const blobs = new Map();
    const manifestDigest = digest(rawManifest);
    blobs.set(manifestDigest, rawManifest);
    let total = rawManifest.length;
    const capture = async (relative) => {
      const f = files.get(relative);
      check(
        f && count(f.bytes, 0, 4 * MiB) && total + f.bytes <= 48 * MiB,
        'Missing manifest entry or capture byte limit exceeded'
      );
      const bytes = await readBounded(root, relative, 4 * MiB, f);
      total += bytes.length;
      blobs.set(f.sha256, bytes);
      return bytes;
    };
    const catalogBytes = await capture('data/catalog.json');
    const catalogDigest = digest(catalogBytes);
    const data = parse(catalogBytes);
    check(
      data?.schema_version === 1 && text(data.project?.id, 256),
      'Unsupported research catalog schema'
    );
    const sources = indexed(data.sources, 'id', 256, 'source');
    const snapshots = indexed(data.snapshots, 'id', 256, 'snapshot');
    const documents = indexed(data.documents, 'id', 2048, 'document');
    const records = indexed(data.records, 'id', 4096, 'record');
    const captureFiles = new Map();
    const pins = [];
    for (const s of snapshots.values()) {
      check(sources.has(s.source_id), 'Unknown snapshot source');
      if (s.commit == null) {
        check(!s.manifest_path, 'Unexpected non-Git snapshot manifest');
        continue;
      }
      check(
        /^[a-f0-9]{40}$/.test(s.commit) && /^[a-zA-Z0-9._-]+$/.test(s.source_id),
        'Invalid commit or source identity'
      );
      const prefix = 'sources/' + s.source_id + '/' + s.commit + '/';
      check(s.manifest_path === prefix + 'metadata.json', 'Unexpected snapshot manifest path');
      const metadata = parse(await capture(s.manifest_path));
      check(
        metadata.repository_url === sources.get(s.source_id).url &&
          metadata.commit === s.commit &&
          (!s.tree || s.tree === metadata.tree),
        'Capture manifest snapshot mismatch'
      );
      captureFiles.set(s.id, indexed(metadata.files, 'path', 2048, 'snapshot file'));
    }
    const paths = new Set(),
      snapshotPins = new Map([...snapshots.keys()].map((key) => [key, []]));
    for (const d of documents.values()) {
      const s = snapshots.get(d.snapshot_id),
        f = files.get(d.local_path);
      safePath(d.path);
      safePath(d.local_path);
      check(
        s && f && f.sha256 === d.sha256 && f.bytes === d.size && !paths.has(d.local_path),
        'Document manifest size, identity or digest mismatch'
      );
      check(
        d.source_id == null || d.source_id === s.source_id,
        'Document source differs from its snapshot'
      );
      paths.add(d.local_path);
      if (s.commit) {
        const entry = captureFiles.get(s.id).get(d.path);
        check(
          d.local_path === 'sources/' + s.source_id + '/' + s.commit + '/files/' + d.path &&
            entry &&
            entry.sha256 === d.sha256 &&
            (entry.size ?? entry.byte_size) === d.size &&
            (entry.immutable_url ?? entry.source_url) === d.url &&
            (entry.blob_sha ?? entry.git_blob_sha) === d.blob_sha &&
            /^[a-f0-9]{40}$/.test(d.blob_sha),
          'Document differs from pinned Git capture manifest'
        );
        captureFiles.get(s.id).delete(d.path);
      } else check(/^goal\/[^/]+$/.test(d.local_path), 'Expected a captured goal document');
      const bytes = await capture(d.local_path);
      if (d.blob_sha)
        check(
          createHash('sha1')
            .update('blob ' + bytes.length + '\0')
            .update(bytes)
            .digest('hex') === d.blob_sha,
          'Git blob digest mismatch'
        );
      check(
        ['utf-8', 'binary'].includes(d.content_encoding ?? 'utf-8'),
        'Unsupported document encoding'
      );
      if (d.content_encoding !== 'binary') utf8.decode(bytes);
      const pin = JSON.stringify([d.snapshot_id, d.path, d.sha256, d.blob_sha ?? null]);
      pins.push(['document', d.id, pin]);
      snapshotPins.get(s.id).push([d.id, d.path, d.sha256]);
    }
    for (const [id, items] of snapshotPins) {
      const s = snapshots.get(id);
      check(!captureFiles.get(id)?.size, 'Catalog is missing snapshot manifest documents');
      items.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      pins.push([
        'snapshot',
        id,
        digest(JSON.stringify([s.source_id, s.commit ?? null, s.tree ?? null, items]))
      ]);
    }
    for (const r of records.values()) {
      check(
        text(r.title) &&
          text(r.kind, 128) &&
          text(r.summary, 65536) &&
          text(r.status, 128) &&
          states.has(r.evidence_state),
        'Invalid catalog claim or evidence state'
      );
      check(
        (r.body === undefined || typeof r.body === 'string') &&
          [r.tags ?? [], r.stages ?? []].every(
            (a) => Array.isArray(a) && a.every((x) => text(x, 256))
          ),
        'Invalid claim search fields'
      );
      check(Array.isArray(r.evidence) && r.evidence.length <= 128, 'Invalid evidence inventory');
      for (const e of r.evidence) {
        const doc = documents.get(e?.document_id);
        check(
          e && (e.document_id != null ? doc : sources.has(e.source_id)),
          'Dangling evidence reference'
        );
        const snapshot = snapshots.get(doc?.snapshot_id ?? e.snapshot_id);
        if (e.source_id != null)
          check(sources.has(e.source_id), 'Dangling evidence source reference');
        checkEvidenceIdentity(e, doc, snapshot);
      }
    }
    check(
      Array.isArray(data.relations) && data.relations.length <= 16384,
      'Invalid relation inventory'
    );
    const relations = new Set();
    for (const edge of data.relations) {
      const key = JSON.stringify([edge?.from_id, edge?.to_id, edge?.relation]);
      check(
        records.has(edge?.from_id) &&
          records.has(edge?.to_id) &&
          text(edge.relation, 128) &&
          !relations.has(key),
        'Invalid relation reference'
      );
      relations.add(key);
    }
    const version = digest('research-v1\0' + manifestDigest + '\0' + catalogDigest);
    const summary = Object.freeze({
      version,
      manifestDigest,
      catalogDigest,
      projectId: data.project.id,
      sources: sources.size,
      snapshots: snapshots.size,
      documents: documents.size,
      records: records.size,
      relations: relations.size
    });
    this.#prepared.set(summary, { blobs, pins, data });
    return summary;
  }

  importVerified(bundle) {
    const verified = this.#prepared.get(bundle);
    check(
      verified && this.db.isTransaction,
      'Import requires a verified bundle inside the writer transaction'
    );
    if (this.db.prepare('SELECT 1 FROM research_versions WHERE version=?').get(bundle.version))
      return bundle;
    const prior = this.db.prepare('SELECT pin FROM research_pins WHERE kind=? AND id=?');
    const addPin = this.db.prepare('INSERT OR IGNORE INTO research_pins VALUES(?,?,?)');
    for (const [kind, id, pin] of verified.pins) {
      const previous = prior.get(kind, id);
      if (previous && previous.pin !== pin)
        throw problem(
          'Previously imported ' + kind + ' has a different immutable identity: ' + id,
          409
        );
      addPin.run(kind, id, pin);
    }
    const addBlob = this.db.prepare('INSERT OR IGNORE INTO research_blobs VALUES(?,?)');
    for (const [key, bytes] of verified.blobs) addBlob.run(key, bytes);
    const v = bundle.version;
    this.db.prepare('INSERT INTO research_versions VALUES(?,?)').run(v, JSON.stringify(bundle));
    const entity = this.db.prepare('INSERT INTO research_entities VALUES(?,?,?,?)');
    const search = this.db.prepare('INSERT INTO research_search VALUES(?,?,?,?,?,?)');
    for (const kind of ['source', 'snapshot', 'document', 'record']) {
      for (const row of verified.data[kind + 's']) {
        entity.run(v, kind, row.id, JSON.stringify(row));
        if (kind === 'record') indexRecord(search, v, row);
      }
    }
    const link = this.db.prepare('INSERT INTO research_relations VALUES(?,?,?,?,?)');
    for (const row of verified.data.relations)
      link.run(v, row.from_id, row.to_id, row.relation, JSON.stringify(row));
    return bundle;
  }

  versions({ limit = 20 } = {}) {
    check(count(limit, 1, 100), 'Invalid catalog page size');
    return {
      versions: this.db
        .prepare('SELECT summary FROM research_versions ORDER BY rowid DESC LIMIT ?')
        .all(limit)
        .map((r) => JSON.parse(r.summary))
    };
  }

  resolve(version) {
    if (version === undefined)
      return (
        this.db.prepare('SELECT version FROM research_versions ORDER BY rowid DESC LIMIT 1').get()
          ?.version ?? null
      );
    check(typeof version === 'string' && /^[0-9a-f]{64}$/.test(version), 'Invalid catalog version');
    if (!this.db.prepare('SELECT 1 FROM research_versions WHERE version=?').get(version))
      throw problem('Catalog version not found', 404);
    return version;
  }

  entity(version, kind, id) {
    check(text(id, 2048), 'Expected an entity ID');
    const row = this.db
      .prepare('SELECT data FROM research_entities WHERE version=? AND kind=? AND id=?')
      .get(version, kind, id);
    if (!row) throw problem('Research ' + kind + ' not found', 404);
    return JSON.parse(row.data);
  }

  find({ query = '', limit = 20, version } = {}) {
    check(
      count(limit, 1, 100) && typeof query === 'string' && query.length <= 512,
      'Invalid research query'
    );
    version = this.resolve(version);
    let rows;
    if (query.trim()) {
      const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
      check(terms.length > 0 && terms.length <= 32, 'Use 1–32 words in a research query');
      rows = this.db
        .prepare(
          'SELECT id FROM research_search WHERE version=? AND research_search MATCH ? ORDER BY rank,id LIMIT ?'
        )
        .all(version, terms.map((word) => '"' + word + '"').join(' AND '), limit);
    } else
      rows = this.db
        .prepare(
          "SELECT id FROM research_entities WHERE version=? AND kind='record' ORDER BY id LIMIT ?"
        )
        .all(version, limit);
    return {
      version,
      records: rows.map(({ id }) => {
        const { title, kind, evidence_state, status, summary } = this.entity(version, 'record', id);
        return { id, title, kind, evidence_state, status, summary };
      })
    };
  }

  record({ id, version }) {
    version = this.resolve(version);
    const record = this.entity(version, 'record', id);
    const evidence = record.evidence.map((e) => {
      const document =
        e.document_id == null ? null : this.entity(version, 'document', e.document_id);
      const snapshotId = document?.snapshot_id ?? e.snapshot_id;
      const snapshot = snapshotId == null ? null : this.entity(version, 'snapshot', snapshotId);
      checkEvidenceIdentity(e, document, snapshot);
      const source = this.entity(version, 'source', snapshot?.source_id ?? e.source_id);
      return { ...e, ...(document && { document }), ...(snapshot && { snapshot }), source };
    });
    const relations = this.db
      .prepare(
        'SELECT data FROM research_relations WHERE version=? AND (src=? OR dst=?) ORDER BY src,dst,relation'
      )
      .all(version, id, id)
      .map((r) => JSON.parse(r.data));
    return { version, record, evidence, relations };
  }

  passage({ id, version, startLine = 1, endLine = startLine }) {
    check(
      count(startLine, 1, Number.MAX_SAFE_INTEGER) && count(endLine, startLine, startLine + 199),
      'Request 1–200 inclusive lines'
    );
    version = this.resolve(version);
    const document = this.entity(version, 'document', id);
    check(document.content_encoding !== 'binary', 'Binary capture has no text passages');
    const snapshot = this.entity(version, 'snapshot', document.snapshot_id);
    const source = this.entity(version, 'source', snapshot.source_id);
    const { bytes } = this.db
      .prepare('SELECT bytes FROM research_blobs WHERE digest=?')
      .get(document.sha256);
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
    let begin = 0;
    for (let i = 1; i < startLine; i++) {
      const nl = buffer.indexOf(10, begin);
      check(nl >= 0, 'Passage begins outside the document');
      begin = nl + 1;
    }
    let end = begin;
    for (let line = startLine; line <= endLine; line++) {
      check(end < buffer.length, 'Passage exceeds the document');
      const nl = buffer.indexOf(10, end);
      end = nl < 0 ? buffer.length : nl + 1;
    }
    check(end - begin <= 65536, 'Passage exceeds 64 KiB');
    return {
      version,
      document,
      snapshot,
      source,
      startLine,
      endLine,
      text: utf8.decode(buffer.subarray(begin, end))
    };
  }

  rebuildIndex() {
    const own = !this.db.isTransaction;
    if (own) this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM research_search');
      const add = this.db.prepare('INSERT INTO research_search VALUES(?,?,?,?,?,?)');
      let records = 0;
      for (const row of this.db
        .prepare("SELECT version,data FROM research_entities WHERE kind='record'")
        .iterate()) {
        indexRecord(add, row.version, JSON.parse(row.data));
        records++;
      }
      if (own) this.db.exec('COMMIT');
      return { records };
    } catch (error) {
      if (own) this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
