import { createHash } from 'node:crypto';
import { get } from 'node:https';
import { isDeepStrictEqual } from 'node:util';
import { ResearchCatalog } from './research.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hash = (value) => sha(JSON.stringify(value));
const docLimit = 256 * 1024;
const id = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const key = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,95}$/i.test(value);
const kinds = [
  'observation',
  'experiment',
  'decision',
  'limitation',
  'correction',
  'contradiction'
];
const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((k) => Object.hasOwn(value, k));
function need(ok, message, status = 409) {
  if (!ok) throw Object.assign(new Error(message), { status });
}
function range({ documentId, startLine, endLine }) {
  need(
    id(documentId) &&
      Number.isSafeInteger(startLine) &&
      startLine >= 1 &&
      Number.isSafeInteger(endLine) &&
      endLine >= startLine &&
      endLine - startLine < 100,
    'Select a document and 1–100 inclusive lines.',
    400
  );
  return { documentId, startLine, endLine };
}
export function normalizeLibraryCommand(name, input) {
  if (name === 'research.fetch') {
    need(
      exact(input, ['version', 'sourceId', 'commit', 'path']) &&
        id(input.version) &&
        key(input.sourceId) &&
        typeof input.commit === 'string' &&
        /^[0-9a-f]{40}$/.test(input.commit) &&
        typeof input.path === 'string' &&
        input.path.length <= 512 &&
        input.path
          .split('/')
          .every(
            (p) =>
              /^[a-zA-Z0-9_. -]{1,128}$/.test(p) &&
              p !== '.' &&
              p !== '..' &&
              p.toLowerCase() !== '.git'
          ),
      'Select one catalog source, full public Git commit and portable relative path.',
      400
    );
    const { version, sourceId, commit, path } = input;
    return { version, sourceId, commit, path };
  }
  need(
    name === 'research.note' &&
      exact(input, ['key', 'previous', 'classification', 'body', 'citations']) &&
      key(input.key) &&
      (input.previous === null || id(input.previous)) &&
      kinds.includes(input.classification) &&
      typeof input.body === 'string' &&
      input.body.trim() &&
      input.body.isWellFormed() &&
      Buffer.byteLength(input.body) <= 5000 &&
      !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.body) &&
      Array.isArray(input.citations) &&
      input.citations.length >= 1 &&
      input.citations.length <= 8,
    'Supply a note, its expected predecessor, classification and 1–8 cited passages.',
    400
  );
  const citations = input.citations.map((c) => {
    need(
      exact(c, ['documentId', 'startLine', 'endLine', 'digest']) && id(c.digest),
      'Supply the displayed passage digest.',
      400
    );
    return { ...range(c), digest: c.digest };
  });
  need(new Set(citations.map(hash)).size === citations.length, 'Duplicate passage citation.', 400);
  return {
    key: input.key,
    previous: input.previous,
    classification: input.classification,
    body: input.body,
    citations
  };
}
function origin(db, input) {
  const src = new ResearchCatalog({ db }).entity(input.version, 'source', input.sourceId);
  const parts =
    typeof src.url === 'string' &&
    /^https:\/\/github\.com\/([a-zA-Z0-9-]{1,39})\/([a-zA-Z0-9_.-]{1,100})\/?$/.exec(src.url);
  need(
    src.type === 'repository' && parts && !['.', '..'].includes(parts[2]),
    'This catalog source has no supported public GitHub origin.'
  );
  return new URL(
    'https://raw.githubusercontent.com/' +
      parts[1] +
      '/' +
      parts[2] +
      '/' +
      input.commit +
      '/' +
      input.path.split('/').map(encodeURIComponent).join('/')
  );
}
function catalogPin(db, input) {
  const rows = db
    .prepare(
      `SELECT d.id,json_extract(d.data,'$.sha256') AS digest FROM research_entities d
    JOIN research_entities s ON s.version=d.version AND s.kind='snapshot' AND s.id=json_extract(d.data,'$.snapshot_id')
    WHERE d.version=? AND d.kind='document' AND json_extract(s.data,'$.source_id')=? AND json_extract(s.data,'$.commit')=?
    AND json_extract(d.data,'$.path')=? ORDER BY d.id LIMIT 2`
    )
    .all(input.version, input.sourceId, input.commit, input.path);
  need(
    rows.length < 2 && (!rows.length || id(rows[0].digest)),
    'Catalog document pin is ambiguous or invalid.'
  );
  return rows[0] ? { documentId: rows[0].id, digest: rows[0].digest } : null;
}
async function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    // Only the internally derived public endpoint receives this credential-free GET.
    const req = get(
      url,
      {
        agent: false,
        rejectUnauthorized: true,
        headers: {
          accept: 'text/plain',
          'accept-encoding': 'identity',
          'user-agent': 'Lillia-research/1'
        }
      },
      (res) => {
        if (
          res.statusCode !== 200 ||
          (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') ||
          Number(res.headers['content-length'] ?? 0) > docLimit
        ) {
          res.destroy();
          return reject(
            Object.assign(Error('Public source unavailable or outside the document size limit.'), {
              status: 409
            })
          );
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > docLimit) req.destroy(Error('Document exceeds the size limit.'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    const timer = setTimeout(() => req.destroy(Error('Public source retrieval timed out.')), 12000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () =>
      reject(Object.assign(Error('Pinned public source could not be retrieved.'), { status: 409 }))
    );
  });
}
function validateText(bytes) {
  need(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= docLimit && !bytes.includes(0),
    'Select a nonempty UTF-8 document of at most 256 KiB.'
  );
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw Object.assign(Error('Public document is not UTF-8 text.'), { status: 409 });
  }
}
export const libraryTables = ['research_library_documents', 'research_library_notes'];
export function installResearchLibrary(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS research_library_documents(id TEXT PRIMARY KEY,version TEXT NOT NULL REFERENCES research_versions(version),record TEXT NOT NULL,bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS research_library_notes(id TEXT PRIMARY KEY,name TEXT NOT NULL,previous TEXT REFERENCES research_library_notes(id),record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS research_notes_name ON research_library_notes(name);`);
}
export class ResearchLibrary {
  #prepared = new WeakMap();
  #busy = false;
  constructor({ db }, { retrieve = fetchRaw } = {}) {
    this.db = db;
    this.retrieve = retrieve;
  }
  #document(documentId) {
    need(id(documentId), 'Supply a document ID.', 400);
    const row = this.db
      .prepare('SELECT record,bytes FROM research_library_documents WHERE id=?')
      .get(documentId);
    need(row, 'Research document not found.', 404);
    const doc = JSON.parse(row.record);
    need(
      doc.id === documentId && doc.sha256 === sha(row.bytes),
      'Retained document digest changed.'
    );
    return { doc, bytes: Buffer.from(row.bytes) };
  }
  passage(raw) {
    const { documentId, startLine, endLine } = range(raw),
      { doc, bytes } = this.#document(documentId);
    const source = validateText(bytes),
      lines = source.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
    let text = endLine <= lines.length ? lines.slice(startLine - 1, endLine).join('') : null;
    if (raw.expectedDigest !== undefined) {
      need(id(raw.expectedDigest), 'Invalid citation digest.', 400);
      if (text === null || sha(text) !== raw.expectedDigest) {
        // Early note receipts counted LF only. Use those boundaries solely to resolve an exact retained byte digest.
        const old = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        text = endLine <= old.length ? old.slice(startLine - 1, endLine).join('') : null;
        need(text !== null && sha(text) === raw.expectedDigest, 'Cited passage digest differs.');
      }
    }
    need(text !== null, 'Passage is outside the pinned document.', 400);
    need(Buffer.byteLength(text) <= 32768, 'Passage exceeds 32 KiB.', 400);
    return { document: doc, startLine, endLine, text, digest: sha(text) };
  }
  note({ id: noteId }) {
    need(id(noteId), 'Supply a note revision.', 400);
    const row = this.db.prepare('SELECT record FROM research_library_notes WHERE id=?').get(noteId);
    need(row, 'Research note not found.', 404);
    return { note: JSON.parse(row.record) };
  }
  list({ after = 0, limit = 32, kind = 'documents' } = {}) {
    need(
      ['notes', 'documents'].includes(kind) &&
        Number.isSafeInteger(after) &&
        after >= 0 &&
        Number.isSafeInteger(limit) &&
        limit >= 1 &&
        limit <= 100,
      'Invalid library pagination.',
      400
    );
    const rows = this.db
      .prepare(
        'SELECT rowid AS cursor,record FROM research_library_' +
          kind +
          ' WHERE rowid>? ORDER BY rowid LIMIT ?'
      )
      .all(after, limit + 1);
    const items = rows.slice(0, limit).map((r) => {
      const item = JSON.parse(r.record);
      return kind === 'documents'
        ? item
        : {
            id: item.id,
            key: item.key,
            previous: item.previous,
            classification: item.classification,
            at: item.at
          };
    });
    return { kind, items, next: rows.length > limit ? rows[limit - 1].cursor : null };
  }
  #checkNote(input) {
    const latest = this.db
      .prepare('SELECT id FROM research_library_notes WHERE name=? ORDER BY rowid DESC LIMIT 1')
      .get(input.key);
    need(
      (latest?.id ?? null) === input.previous,
      'The note head changed; select the current previous revision.'
    );
    for (const c of input.citations)
      need(this.passage(c).digest === c.digest, 'Cited passage digest differs.');
  }
  async prepare(name, raw) {
    const input = normalizeLibraryCommand(name, raw),
      token = Object.freeze({ name });
    if (name === 'research.note') {
      this.#checkNote(input);
      this.#prepared.set(token, { input });
      return token;
    }
    need(!this.#busy, 'A public research retrieval is already in progress.');
    const url = origin(this.db, input);
    this.#busy = true;
    try {
      const bytes = await this.retrieve(url);
      validateText(bytes);
      this.#prepared.set(token, { input, url: url.href, bytes: Buffer.from(bytes) });
      return token;
    } finally {
      this.#busy = false;
    }
  }
  apply(token, operationId) {
    const p = this.#prepared.get(token);
    need(
      this.db.isTransaction && p,
      'Library publication requires a prepared owner receipt transaction.'
    );
    const { input } = p,
      at = new Date().toISOString();
    if (token.name === 'research.note') {
      this.#checkNote(input);
      need(
        this.db.prepare('SELECT count(*) n FROM research_library_notes').get().n < 2048,
        'Research note retention limit reached.'
      );
      const note = {
        id: hash(['research.note', operationId, input]),
        ...input,
        lineMap: 'universal-v1',
        principal: 'local-owner',
        operationId,
        at
      };
      this.db
        .prepare('INSERT INTO research_library_notes VALUES(?,?,?,?)')
        .run(note.id, input.key, input.previous, JSON.stringify(note));
      return { note };
    }
    const url = origin(this.db, input).href;
    need(url === p.url, 'Public repository mapping changed.');
    const documentId = hash(['research.fetch', input]),
      existing = this.db
        .prepare('SELECT id FROM research_library_documents WHERE id=?')
        .get(documentId);
    if (existing) {
      const { doc, bytes } = this.#document(documentId);
      need(bytes.equals(p.bytes) && doc.url === url, 'Immutable public document bytes differ.');
      return { document: doc };
    }
    const size = this.db
      .prepare(
        'SELECT count(*) n,coalesce(sum(length(bytes)),0) bytes FROM research_library_documents'
      )
      .get();
    need(
      size.n < 512 && size.bytes + p.bytes.length <= 32 * 1024 * 1024,
      'Public source retention capacity reached.'
    );
    const checksum = sha(p.bytes),
      pin = catalogPin(this.db, input);
    need(
      !pin || pin.digest === checksum,
      'Retrieved bytes differ from the existing catalog snapshot.'
    );
    const document = {
      id: documentId,
      ...input,
      url,
      sha256: checksum,
      catalogPin: pin,
      bytes: p.bytes.length,
      operationId,
      at
    };
    this.db
      .prepare('INSERT INTO research_library_documents VALUES(?,?,?,?)')
      .run(documentId, input.version, JSON.stringify(document), p.bytes);
    return { document };
  }
}
export function verifyResearchLibrary(db) {
  const lib = new ResearchLibrary({ db }),
    heads = new Map();
  let documents = 0,
    notes = 0;
  const receipt = (op, name, input, want) => {
    const row = db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(op);
    need(
      row?.digest === hash([name, input]) &&
        isDeepStrictEqual(JSON.parse(row.receipt), { operationId: op, ...want }),
      'Research library owner receipt differs.'
    );
  };
  for (const row of db
    .prepare('SELECT * FROM research_library_documents ORDER BY rowid')
    .iterate()) {
    const d = JSON.parse(row.record),
      { version, sourceId, commit, path } = d,
      input = normalizeLibraryCommand('research.fetch', { version, sourceId, commit, path });
    validateText(Buffer.from(row.bytes));
    need(
      row.version === version &&
        row.id === d.id &&
        hash(['research.fetch', input]) === d.id &&
        d.url === origin(db, input).href &&
        isDeepStrictEqual(d.catalogPin, catalogPin(db, input)) &&
        (!d.catalogPin || d.catalogPin.digest === d.sha256) &&
        d.bytes === row.bytes.length &&
        d.sha256 === sha(row.bytes),
      'Historical public research document bytes or origin differ.'
    );
    receipt(d.operationId, 'research.fetch', input, { document: d });
    documents++;
  }
  for (const row of db.prepare('SELECT * FROM research_library_notes ORDER BY rowid').iterate()) {
    const n = JSON.parse(row.record),
      { key, previous, classification, body, citations } = n,
      input = normalizeLibraryCommand('research.note', {
        key,
        previous,
        classification,
        body,
        citations
      });
    need(
      (heads.get(key) ?? null) === n.previous &&
        row.previous === previous &&
        row.name === key &&
        n.id === row.id &&
        n.principal === 'local-owner' &&
        n.id === hash(['research.note', n.operationId, input]),
      'Research note head, author or predecessor differs.'
    );
    for (const c of citations)
      need(
        lib.passage(n.lineMap === undefined ? { ...c, expectedDigest: c.digest } : c).digest ===
          c.digest,
        'Retained citation differs.'
      );
    receipt(n.operationId, 'research.note', input, { note: n });
    heads.set(key, n.id);
    notes++;
  }
  for (const { operationId, digest, receipt: raw } of db
    .prepare(
      "SELECT * FROM command_receipts WHERE json_type(receipt,'$.document.url')='text' OR json_type(receipt,'$.note.citations')='array'"
    )
    .iterate()) {
    const r = JSON.parse(raw),
      d = r.document;
    if (d) {
      const row = db.prepare('SELECT record FROM research_library_documents WHERE id=?').get(d.id);
      need(
        row &&
          isDeepStrictEqual(d, JSON.parse(row.record)) &&
          digest ===
            hash([
              'research.fetch',
              normalizeLibraryCommand('research.fetch', {
                version: d.version,
                sourceId: d.sourceId,
                commit: d.commit,
                path: d.path
              })
            ]),
        'Acknowledged public document is missing or changed.'
      );
    } else {
      const row = db.prepare('SELECT record FROM research_library_notes WHERE id=?').get(r.note.id);
      need(
        row &&
          isDeepStrictEqual(JSON.parse(row.record), r.note) &&
          r.note.operationId === operationId,
        'Acknowledged research note is missing or changed.'
      );
    }
  }
  return { documents, notes };
}
