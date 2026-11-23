import searchHelp from './native-search-help.json' with { type: 'json' };
import { pathAdmitted } from './native-policy.mjs';
import { NativeSearch } from './native-search.mjs';
import { createHash } from 'node:crypto';
import {
  NativeStore,
  validateNativeId as id,
  validateNativeLabel as repositoryId,
  validateNativePath as pathName
} from './native-store.mjs';
export { installNativeOperations } from './native-store.mjs';

const hash = (x) => createHash('sha256').update(x).digest('hex');
const intent = (name, input) => hash(JSON.stringify([name, input]));
const order = (o) =>
  Array.isArray(o)
    ? o.map(order)
    : o && typeof o === 'object'
      ? Object.fromEntries(
          Object.keys(o)
            .sort()
            .map((k) => [k, order(o[k])])
        )
      : o;
const actor = (seconds) => ({
  name: 'Local owner',
  email: 'owner@localhost.invalid',
  seconds,
  offset: '+0000'
});
function requireValue(v, msg, status = 409) {
  if (!v) throw Object.assign(new Error(msg), { status });
}
function fields(o, keys, required = []) {
  requireValue(
    o &&
      Object.getPrototypeOf(o) === Object.prototype &&
      Object.keys(o).every((k) => keys.includes(k)) &&
      required.every((k) => Object.hasOwn(o, k)),
    'Unsupported native operation fields',
    400
  );
}
function nameOf(s) {
  requireValue(
    typeof s === 'string' &&
      /^[a-z][a-z0-9-]{0,47}$/.test(s) &&
      !['main', 'mainline', 'release', 'integration'].includes(s),
    'Choose a named owner draft',
    400
  );
  return s;
}
const scopeName = (s) => 'draft.' + nameOf(s);
const pageSize = (n, d = 32, max = 100) => {
  const v = n === undefined ? d : n;
  requireValue(Number.isSafeInteger(v) && v > 0 && v <= max, 'Invalid native page size', 400);
  return v;
};
function pageStart(cursor, binding) {
  if (cursor === undefined) return 0;
  requireValue(
    typeof cursor === 'string' && cursor.length <= 256 && /^[A-Za-z0-9_-]+$/.test(cursor),
    'Invalid native cursor',
    400
  );
  let data;
  try {
    data = JSON.parse(Buffer.from(cursor, 'base64url'));
  } catch {}
  requireValue(
    Array.isArray(data) &&
      data.length === 2 &&
      Number.isSafeInteger(data[0]) &&
      data[0] >= 0 &&
      data[1] === hash(JSON.stringify([binding, data[0]])),
    'Cursor belongs to a different native selection'
  );
  return data[0];
}
function next(index, size, binding) {
  return index < size
    ? Buffer.from(JSON.stringify([index, hash(JSON.stringify([binding, index]))])).toString(
        'base64url'
      )
    : null;
}
function edit(e) {
  fields(e, ['path', 'mode', 'text', 'base64', 'delete'], ['path']);
  const path = pathName(e.path);
  if (Object.hasOwn(e, 'delete')) {
    fields(e, ['path', 'delete']);
    requireValue(e.delete === true, 'Invalid deletion marker', 400);
    return { path, delete: true };
  }
  const asText = Object.hasOwn(e, 'text');
  fields(e, ['path', 'mode', asText ? 'text' : 'base64'], ['mode', asText ? 'text' : 'base64']);
  requireValue(
    ['100644', '100755', '120000'].includes(e.mode),
    'Unsupported native file mode',
    400
  );
  if (asText)
    requireValue(
      typeof e.text === 'string' &&
        e.text.isWellFormed() &&
        Buffer.byteLength(e.text) <= 128 * 1024,
      'Invalid native text edit',
      400
    );
  else
    requireValue(
      typeof e.base64 === 'string' && e.base64.length <= 174764,
      'Invalid native base64 edit',
      400
    );
  const bytes = asText ? Buffer.from(e.text) : Buffer.from(e.base64, 'base64'),
    base64 = bytes.toString('base64');
  requireValue(
    bytes.length <= 128 * 1024 && (asText || base64 === e.base64),
    'Expected canonical base64 within 128 KiB',
    400
  );
  if (e.mode === '120000')
    requireValue(
      bytes.length && bytes.length <= 4096 && !bytes.includes(0),
      'Invalid native link target',
      400
    );
  return { path, mode: e.mode, base64 };
}
const commandFields = {
  'native.init': ['repository'],
  'native.draft.create': ['repository', 'name', 'sourceDraft', 'sourceRevision'],
  'native.draft.update': [
    'repository',
    'name',
    'expectedRevision',
    'expectedGeneration',
    'message',
    'edits'
  ]
};
export function normalizeNativeCommand(name, input) {
  requireValue(Object.hasOwn(commandFields, name), 'Unknown native owner command', 400);
  fields(input, commandFields[name], ['repository']);
  const repository = repositoryId(input.repository);
  if (name === 'native.init') return { repository };
  const draft = nameOf(input.name);
  if (name === 'native.draft.create') {
    const pair = Object.hasOwn(input, 'sourceDraft') || Object.hasOwn(input, 'sourceRevision');
    return order({
      repository,
      name: draft,
      ...(pair
        ? { sourceDraft: nameOf(input.sourceDraft), sourceRevision: id(input.sourceRevision) }
        : {})
    });
  }
  requireValue(
    Number.isSafeInteger(input.expectedGeneration) && input.expectedGeneration >= 1,
    'Invalid expected native generation',
    400
  );
  requireValue(
    typeof input.message === 'string' &&
      input.message.isWellFormed() &&
      input.message.trim() &&
      !input.message.includes('\0') &&
      Buffer.byteLength(input.message) <= 4096,
    'Supply a native draft message within 4 KiB',
    400
  );
  requireValue(
    Array.isArray(input.edits) && input.edits.length > 0 && input.edits.length <= 64,
    'Select 1–64 native draft edits',
    400
  );
  const edits = input.edits.map(edit).sort((a, b) => (a.path < b.path ? -1 : 1));
  requireValue(
    new Set(edits.map((e) => e.path)).size === edits.length &&
      edits.reduce((n, e) => n + (e.base64 ? Buffer.byteLength(e.base64, 'base64') : 0), 0) <=
        256 * 1024,
    'Duplicate or oversized native edit set',
    400
  );
  return order({
    repository,
    name: draft,
    message: input.message,
    expectedRevision: id(input.expectedRevision),
    expectedGeneration: input.expectedGeneration,
    edits
  });
}
function textOf(bytes) {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}
function hunk(before, after) {
  if (before?.mode === '120000' || after?.mode === '120000') return { kind: 'symlink' };
  if ((before?.bytes.length ?? 0) > 4096 || (after?.bytes.length ?? 0) > 4096)
    return { kind: 'oversize', limit: 4096 };
  const old = textOf(before?.bytes ?? Buffer.alloc(0)),
    fresh = textOf(after?.bytes ?? Buffer.alloc(0));
  if (old === null || fresh === null) return { kind: 'binary' };
  const a = old.match(/[^\n]*\n|[^\n]+$/g) ?? [],
    b = fresh.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return {
    kind: 'text',
    startLine: start + 1,
    before: a.slice(start, a.length - end),
    after: b.slice(start, b.length - end)
  };
}
const queryKeys = {
  'native.status': [],
  'native.drafts': ['repository', 'cursor', 'limit'],
  'native.ref': ['repository', 'name'],
  'native.revision': ['cursor', 'limit'],
  'native.history': ['cursor', 'limit'],
  'native.tree': ['cursor', 'limit', 'prefix'],
  'native.file': ['path', 'offset', 'limit', 'submissionId'],
  'native.search': ['cursor', 'limit', 'prefix', 'mode', 'query', 'language', 'submissionId'],
  'native.diff': ['cursor', 'limit', 'prefix', 'base', 'path']
};
const folder = (p, prefix) => !prefix || p === prefix || p.startsWith(prefix + '/');
export class NativeOperations {
  #prepared = new WeakMap();
  #search = new NativeSearch();
  constructor(store, { principal = 'local-owner', mainline, policyAt } = {}) {
    this.store = store;
    this.db = store.db;
    this.principal = principal;
    this.native = new NativeStore(store);
    this.mainline = mainline;
    this.policyAt = policyAt;
  }
  normalize(name, input) {
    return normalizeNativeCommand(name, input);
  }
  #owner() {
    requireValue(
      this.principal === 'local-owner',
      'Native draft namespace requires its authenticated local owner',
      403
    );
  }
  #workspace() {
    const key = this.db.prepare("SELECT value FROM settings WHERE key='platform.workspace'").get();
    requireValue(key?.value, 'Native workspace binding unavailable');
    return hash(key.value);
  }
  #project(repository) {
    this.#owner();
    const row = this.db
      .prepare('SELECT repository,workspaceDigest,operationId FROM native_owner WHERE slot=1')
      .get();
    requireValue(
      row && row.repository === repository && row.workspaceDigest === this.#workspace(),
      'Native repository is outside the current owner workspace grant',
      403
    );
    const receipt = this.db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(row.operationId);
    const payload = receipt && JSON.parse(receipt.receipt);
    requireValue(
      receipt?.digest === intent('native.init', { repository }) &&
        payload.operationId === row.operationId &&
        payload.project?.repository === repository &&
        payload.project.workspaceDigest === row.workspaceDigest &&
        payload.project.operationId === row.operationId,
      'Native owner initialization receipt is missing or inconsistent'
    );
    return { ...row };
  }
  #draft(repository, name) {
    if (name === 'mainline' && this.mainline) {
      const { authority, mainline } = this.mainline();
      requireValue(
        authority?.repository === repository && mainline?.generation > 0,
        'No protected native mainline in this repository',
        404
      );
      return { ...mainline, kind: 'protected-mainline', epoch: authority.epoch };
    }
    const row = this.db
      .prepare('SELECT operationId FROM native_drafts WHERE repository=? AND name=?')
      .get(repository, name);
    requireValue(row, 'Named draft is outside the retained owner grant', 404);
    const head = this.native.ref({ repository, name: scopeName(name) });
    const event = this.db
      .prepare(
        'SELECT operationId FROM native_ref_events WHERE repository=? AND name=? AND generation=?'
      )
      .get(repository, head.name, head.generation);
    const receipt =
      event &&
      this.db
        .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
        .get(event.operationId);
    const ack = receipt && JSON.parse(receipt.receipt);
    requireValue(
      ack?.draft?.name === name &&
        ack.draft.repository === repository &&
        ack.draft.revisionId === head.revisionId &&
        ack.draft.generation === head.generation &&
        ack.operationId === event.operationId &&
        ack.draft.intentDigest === receipt.digest,
      'Native draft target lacks its owner receipt'
    );
    return { repository, name, revisionId: head.revisionId, generation: head.generation };
  }
  #reachable(repository, name, revisionId) {
    const draft = this.#draft(repository, name),
      queue = [draft.revisionId],
      seen = new Set();
    while (queue.length) {
      const at = queue.pop();
      if (seen.has(at)) continue;
      seen.add(at);
      if (at === revisionId) return draft;
      requireValue(seen.size <= 1024, 'Native ancestry exceeds owner scope capacity');
      queue.push(...this.native.revision({ repository, revisionId: at }).parents);
    }
    requireValue(false, 'Revision is not reachable through the selected owner draft', 404);
  }
  checkImportDraft({ repository, name }) {
    this.#owner();
    repositoryId(repository);
    nameOf(name);
    this.#check('native.draft.create', { repository, name });
    return { repository, name };
  }
  attachImportedDraft({ repository, name, revisionId, operationId, intentDigest }) {
    requireValue(
      this.db.isTransaction,
      'Import adoption requires the owner bridge receipt transaction'
    );
    this.checkImportDraft({ repository, name });
    id(revisionId);
    id(intentDigest);
    const event = this.native.advanceRef({
      repository,
      name: scopeName(name),
      expectedRevision: null,
      expectedGeneration: 0,
      revisionId,
      operationId
    });
    this.db.prepare('INSERT INTO native_drafts VALUES(?,?,?)').run(repository, name, operationId);
    return {
      draft: {
        repository,
        name,
        revisionId,
        generation: event.generation,
        operationId,
        intentDigest,
        sourceKind: 'git-import'
      }
    };
  }
  #check(name, n) {
    if (name === 'native.init') {
      requireValue(
        !this.db.prepare('SELECT 1 FROM native_owner LIMIT 1').get(),
        'Native repository is already initialized and bound'
      );
      requireValue(
        !this.db
          .prepare('SELECT 1 FROM native_revisions WHERE repository=? LIMIT 1')
          .get(n.repository) &&
          !this.db
            .prepare('SELECT 1 FROM native_file_grants WHERE repository=? LIMIT 1')
            .get(n.repository),
        'Native namespace cannot take over an existing repository'
      );
      return;
    }
    this.#project(n.repository);
    if (name === 'native.draft.create') {
      requireValue(
        this.db
          .prepare('SELECT count(*) AS n FROM native_drafts WHERE repository=?')
          .get(n.repository).n < 256,
        'Native owner draft capacity exhausted'
      );
      requireValue(
        !this.db
          .prepare('SELECT 1 FROM native_drafts WHERE repository=? AND name=?')
          .get(n.repository, n.name) &&
          this.native.ref({ repository: n.repository, name: scopeName(n.name) }).generation === 0,
        'Native draft already exists'
      );
      if (n.sourceDraft) this.#reachable(n.repository, n.sourceDraft, n.sourceRevision);
    } else {
      const h = this.#draft(n.repository, n.name);
      requireValue(
        h.revisionId === n.expectedRevision && h.generation === n.expectedGeneration,
        'Native draft target or generation changed'
      );
    }
  }
  prepare(name, normalized, operationId) {
    this.#owner();
    requireValue(!this.db.isTransaction, 'Prepare native bytes before the receipt transaction');
    requireValue(
      typeof operationId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(operationId),
      'Invalid native operation ID',
      400
    );
    const n = this.normalize(name, normalized),
      digest = intent(name, n),
      token = Object.freeze({ name, operationId });
    const prior = this.db
      .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
      .get(operationId);
    if (prior) {
      requireValue(prior.digest === digest, 'Native operation ID belongs to a different request');
      this.#prepared.set(token, { prior: JSON.parse(prior.receipt) });
      return token;
    }
    this.store.checkIntent(operationId, digest);
    this.#check(name, n);
    const edits = n.edits?.map((e) =>
      e.delete
        ? { path: e.path, delete: true }
        : {
            path: e.path,
            mode: e.mode,
            fileId: this.native.putFile({
              repository: n.repository,
              bytes: Buffer.from(e.base64, 'base64')
            }).fileId
          }
    );
    this.#prepared.set(token, {
      name,
      n,
      digest,
      operationId,
      edits,
      seconds: Math.floor(Date.now() / 1000)
    });
    return token;
  }
  apply(token) {
    this.#owner();
    const p = this.#prepared.get(token);
    requireValue(
      this.db.isTransaction && p,
      'Native mutation requires its prepared owner receipt transaction'
    );
    if (p.prior) return p.prior;
    const { name, n, digest, operationId, edits, seconds } = p;
    this.#check(name, n);
    if (name === 'native.init') {
      const project = { repository: n.repository, workspaceDigest: this.#workspace(), operationId };
      this.db
        .prepare('INSERT INTO native_owner VALUES(1,?,?,?)')
        .run(n.repository, project.workspaceDigest, operationId);
      return { project };
    }
    const create = name === 'native.draft.create',
      person = actor(seconds);
    const revisionId =
      n.sourceRevision ??
      this.native.acceptRevision({
        repository: n.repository,
        parents: create ? [] : [n.expectedRevision],
        edits: edits ?? [],
        author: person,
        committer: person,
        message: n.message ?? 'Create draft ' + n.name,
        provenance: { principal: 'local-owner', taskId: null }
      }).revisionId;
    const event = this.native.advanceRef({
      repository: n.repository,
      name: scopeName(n.name),
      expectedRevision: n.expectedRevision ?? null,
      expectedGeneration: n.expectedGeneration ?? 0,
      revisionId,
      operationId
    });
    if (create)
      this.db
        .prepare('INSERT INTO native_drafts VALUES(?,?,?)')
        .run(n.repository, n.name, operationId);
    return {
      draft: {
        repository: n.repository,
        name: n.name,
        revisionId,
        generation: event.generation,
        operationId,
        intentDigest: digest,
        ...(n.sourceDraft ? { sourceDraft: n.sourceDraft, sourceRevision: n.sourceRevision } : {})
      }
    };
  }
  query(name, input = {}) {
    this.#owner();
    requireValue(Object.hasOwn(queryKeys, name), 'Unknown native query', 400);
    const selected = !['native.status', 'native.drafts', 'native.ref'].includes(name);
    fields(input, [...queryKeys[name], ...(selected ? ['repository', 'name', 'revisionId'] : [])]);
    if (name === 'native.status') {
      const row = this.db.prepare('SELECT repository FROM native_owner WHERE slot=1').get();
      return {
        project: row ? this.#project(row.repository) : null,
        scope: 'local-owner-drafts',
        searchHelp
      };
    }
    const repository = repositoryId(input.repository);
    this.#project(repository);
    if (name === 'native.drafts') {
      const heads = this.db
        .prepare('SELECT name FROM native_drafts WHERE repository=? ORDER BY name')
        .all(repository)
        .map((r) => this.#draft(repository, r.name));
      const binding = [name, repository, heads],
        offset = pageStart(input.cursor, binding),
        end = offset + pageSize(input.limit);
      return {
        repository,
        drafts: heads.slice(offset, end),
        cursor: next(end, heads.length, binding)
      };
    }
    const draft = input.name === 'mainline' && this.mainline ? 'mainline' : nameOf(input.name);
    if (name === 'native.ref') return { draft: this.#draft(repository, draft) };
    const revisionId = id(input.revisionId);
    let submittedPath = null;
    if (input.submissionId !== undefined) {
      const key = input.submissionId;
      requireValue(
        typeof key === 'string' &&
          /^[0-9a-f-]{36}$/.test(key) &&
          draft === 'mainline' &&
          this.mainline,
        'Select a mainline submission',
        400
      );
      const authority = this.mainline().authority;
      const row = this.db
        .prepare(
          `SELECT s.record,g.repository,g.epoch,r.role FROM native_submissions s JOIN native_goals g ON g.goalId=json_extract(s.record,'$.goalId')
        JOIN native_roles r ON r.goalId=g.goalId AND r.taskId=json_extract(s.record,'$.author.taskId') WHERE s.id=? AND s.commitId=?`
        )
        .get(key, revisionId);
      const r = row && JSON.parse(row.record),
        policy = r && (this.policyAt ? this.policyAt(r.policyDigest) : authority);
      requireValue(
        authority &&
          policy?.repository === repository &&
          policy.epoch === authority.epoch &&
          row?.role === 'author' &&
          row.epoch === authority.epoch &&
          row.repository === repository &&
          r.id === key &&
          r.commit === revisionId &&
          r.repository === repository &&
          r.epoch === authority.epoch &&
          r.policyDigest === policy.policyDigest &&
          pathAdmitted(policy, r),
        'Selected submission is outside current owner authority.',
        404
      );
      submittedPath = r.path;
      if (name === 'native.file')
        requireValue(
          input.path === submittedPath,
          'Select the changed path in this submission.',
          404
        );
    } else this.#reachable(repository, draft, revisionId);
    const subject = { repository, name: draft, revisionId };
    if (name === 'native.revision') {
      const r = this.native.revision(subject),
        binding = [name, subject],
        start = pageStart(input.cursor, binding),
        end = start + pageSize(input.limit);
      return {
        revision: { ...r, edits: r.edits.slice(start, end) },
        totalEdits: r.edits.length,
        cursor: next(end, r.edits.length, binding)
      };
    }
    if (name === 'native.file') {
      const path = pathName(input.path),
        item = this.native.file({ ...subject, path }),
        size = pageSize(input.limit, 32768, 65536),
        off = input.offset ?? 0;
      requireValue(
        Number.isSafeInteger(off) && off >= 0 && off <= item.bytes.length,
        'Invalid native byte offset',
        400
      );
      const bytes = item.bytes.subarray(off, off + size);
      return {
        ...subject,
        path,
        mode: item.mode,
        fileId: item.fileId,
        total: item.bytes.length,
        offset: off,
        base64: bytes.toString('base64'),
        nextOffset: off + bytes.length < item.bytes.length ? off + bytes.length : null
      };
    }
    const prefix = input.prefix === undefined ? null : pathName(input.prefix);
    const { cursor, limit, ...scope } = input;
    const binding = [name, order(scope)],
      start = pageStart(cursor, binding),
      size = pageSize(limit),
      end = start + size;
    if (name === 'native.history') {
      const history = [];
      let at = revisionId;
      while (at) {
        const r = this.native.revision({ repository, revisionId: at });
        history.push({
          revisionId: at,
          parents: r.parents,
          author: r.author,
          message: r.message.slice(0, 512)
        });
        at = r.parents[0];
        requireValue(history.length <= 256, 'Native history exceeded its profile bound');
      }
      return {
        ...subject,
        history: history.slice(start, end),
        cursor: next(end, history.length, binding)
      };
    }
    const snapshot = this.native.select(subject),
      entries = snapshot.entries.filter(
        (e) => (submittedPath === null || e.path === submittedPath) && folder(e.path, prefix)
      );
    if (name === 'native.tree')
      return {
        ...subject,
        entries: entries.slice(start, end),
        cursor: next(end, entries.length, binding)
      };
    if (name === 'native.search') {
      const { index, results } = this.#search.search(
        {
          ...subject,
          authorization: ['local-owner', draft, input.submissionId ?? null, prefix],
          entries,
          read: snapshot.read
        },
        input
      );
      return {
        ...subject,
        index,
        results: results.slice(start, end),
        cursor: next(end, results.length, binding)
      };
    }
    const base = id(input.base);
    this.#reachable(repository, draft, base);
    const before = this.native.select({ repository, revisionId: base }),
      old = new Map(before.entries.map((e) => [e.path, e])),
      current = new Map(entries.map((e) => [e.path, e]));
    const path = input.path === undefined ? null : pathName(input.path),
      changes = [];
    const paths = path ? [path] : [...new Set([...old.keys(), ...current.keys()])].sort();
    for (const p of paths) {
      if (!folder(p, prefix)) continue;
      const a = old.get(p),
        b = current.get(p);
      if (a?.fileId === b?.fileId && a?.mode === b?.mode) continue;
      const change = {
        path: p,
        kind: a && b ? 'modify' : a ? 'delete' : 'add',
        before: a ?? null,
        after: b ?? null
      };
      if (path) change.hunk = hunk(a ? before.read(p) : null, b ? snapshot.read(p) : null);
      changes.push(change);
    }
    return {
      ...subject,
      base,
      changes: changes.slice(start, end),
      cursor: next(end, changes.length, binding)
    };
  }
}

export function verifyNativeOwnership(db) {
  const owner = db.prepare('SELECT * FROM native_owner').get(),
    ops = new NativeOperations({ db }),
    core = new NativeStore({ db });
  const drafts = db.prepare('SELECT * FROM native_drafts ORDER BY repository,name').all();
  const initReceipts = db
    .prepare(
      "SELECT count(*) AS n FROM command_receipts WHERE json_type(receipt,'$.project.workspaceDigest')='text' AND json_type(receipt,'$.project.repository')='text'"
    )
    .get().n;
  requireValue(
    initReceipts === (owner ? 1 : 0),
    'Native owner binding is missing its unique receipt'
  );
  requireValue(
    !db
      .prepare(
        `SELECT 1 FROM command_receipts c WHERE json_type(c.receipt,'$.draft.intentDigest')='text' AND NOT EXISTS(
    SELECT 1 FROM native_drafts d JOIN native_ref_events e ON e.repository=d.repository AND e.name='draft.'||d.name
    WHERE e.operationId=c.operationId AND e.revisionId=json_extract(c.receipt,'$.draft.revisionId') AND e.generation=json_extract(c.receipt,'$.draft.generation')
      AND d.name=json_extract(c.receipt,'$.draft.name') AND d.repository=json_extract(c.receipt,'$.draft.repository')) LIMIT 1`
      )
      .get(),
    'A retained owner draft receipt is missing its named grant or event'
  );
  if (!owner) {
    requireValue(!drafts.length, 'Native drafts lack an owner binding');
    return { repositories: 0, drafts: 0 };
  }
  ops.query('native.status', {}); // Recheck the exact init receipt and installation workspace.
  requireValue(drafts.length <= 256, 'Native owner draft inventory exceeds capacity');
  for (const d of drafts) {
    requireValue(
      d.repository === owner.repository,
      'Native draft references another owner binding'
    );
    ops.query('native.ref', { repository: d.repository, name: d.name });
    const events = db
      .prepare('SELECT * FROM native_ref_events WHERE repository=? AND name=? ORDER BY generation')
      .all(d.repository, scopeName(d.name));
    requireValue(
      events[0]?.operationId === d.operationId,
      'Native owner draft grant differs from its first event'
    );
    for (const e of events) {
      const row = db
        .prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?')
        .get(e.operationId);
      const receipt = row && JSON.parse(row.receipt),
        ack = receipt?.draft;
      requireValue(
        ack?.repository === d.repository &&
          ack.name === d.name &&
          ack.operationId === e.operationId &&
          receipt.operationId === e.operationId &&
          ack.revisionId === e.revisionId &&
          ack.generation === e.generation &&
          ack.intentDigest === row.digest,
        'Native historical draft event lacks its owner receipt'
      );
      if (ack.sourceKind === 'git-import') {
        const b = receipt.bridge;
        requireValue(
          e.generation === 1 &&
            b?.direction === 'import' &&
            b.profile === 'git-sha1-v1' &&
            b.repository === d.repository &&
            b.name === d.name &&
            b.revisionId === e.revisionId &&
            /^[0-9a-f]{40}$/.test(b.gitId) &&
            db.prepare('PRAGMA user_version').get().user_version >= 30,
          'Native imported draft has no verified bridge subject'
        );
        continue;
      }
      let input, name;
      if (e.generation === 1) {
        name = 'native.draft.create';
        input = { repository: d.repository, name: d.name };
        if (ack.sourceDraft) {
          requireValue(
            ack.sourceRevision === e.revisionId &&
              drafts.some(
                (other) => other.repository === d.repository && other.name === ack.sourceDraft
              ),
            'Native owner fork names a different immutable source'
          );
          const source = db
            .prepare(
              'SELECT revisionId FROM native_ref_events WHERE repository=? AND name=? AND sequence<? ORDER BY sequence DESC LIMIT 1'
            )
            .get(d.repository, scopeName(ack.sourceDraft), e.sequence);
          requireValue(source, 'Native fork precedes its source draft');
          const pending = [source.revisionId],
            seen = new Set();
          let reaches = false;
          while (pending.length && !reaches) {
            const at = pending.pop();
            if (seen.has(at)) continue;
            seen.add(at);
            if (at === ack.sourceRevision) reaches = true;
            else
              pending.push(...core.revision({ repository: d.repository, revisionId: at }).parents);
          }
          requireValue(reaches, 'Native fork source was unreachable at acceptance');
          Object.assign(input, {
            sourceDraft: ack.sourceDraft,
            sourceRevision: ack.sourceRevision
          });
        } else {
          const r = core.revision({ repository: d.repository, revisionId: e.revisionId });
          requireValue(
            r.parents.length === 0 &&
              r.edits.length === 0 &&
              r.message === 'Create draft ' + d.name &&
              ownerMetadata(r),
            'Unexpected native draft seed'
          );
        }
      } else {
        const subject = { repository: d.repository, revisionId: e.revisionId },
          r = core.revision(subject),
          sel = core.select(subject);
        requireValue(
          r.parents.length === 1 && r.parents[0] === e.expectedRevision && ownerMetadata(r),
          'Native owner edit lineage differs from its receipt'
        );
        name = 'native.draft.update';
        input = {
          repository: d.repository,
          name: d.name,
          expectedRevision: e.expectedRevision,
          expectedGeneration: e.expectedGeneration,
          message: r.message,
          edits: r.edits.map((edit) =>
            edit.delete
              ? edit
              : {
                  path: edit.path,
                  mode: edit.mode,
                  base64: sel.read(edit.path).bytes.toString('base64')
                }
          )
        };
      }
      requireValue(
        intent(name, normalizeNativeCommand(name, input)) === row.digest,
        'Native owner operation digest differs from retained source'
      );
    }
  }
  return { repositories: 1, drafts: drafts.length };
}
function ownerMetadata(r) {
  return (
    r.provenance?.principal === 'local-owner' &&
    r.provenance.taskId === null &&
    ['author', 'committer'].every(
      (k) => JSON.stringify(actor(r.author.seconds)) === JSON.stringify(r[k])
    )
  );
}
