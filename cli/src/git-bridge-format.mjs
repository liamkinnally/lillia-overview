// The bridge reads data objects only. No checkout, repository configuration or Git executable is involved.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { validateNativePath } from './native-store.mjs';
const MiB = 1024 * 1024;
export const bounds = {
  packed: 12 * MiB,
  expanded: 20 * MiB,
  object: 4 * MiB,
  objects: 1024,
  commits: 48,
  entries: 2048,
  depth: 32,
  milliseconds: 12000
};
export function need(ok, message, status = 409) {
  if (!ok) throw Object.assign(Error(message), { status });
}
export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sha1 = (b) => createHash('sha1').update(b).digest();
export const gitId = (type, b) =>
  createHash('sha1')
    .update(type + ' ' + b.length + '\0')
    .update(b)
    .digest('hex');
const types = ['', 'commit', 'tree', 'blob', 'tag', '', 'ofs', 'ref'];
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function utf8(bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    throw Object.assign(Error('Git metadata is outside the supported UTF-8 profile.'), {
      status: 409
    });
  }
}
export function budget() {
  const start = performance.now();
  return () =>
    need(performance.now() - start <= bounds.milliseconds, 'Git bridge time bound exceeded.');
}
function delta(base, program) {
  let pos = 0;
  const byte = () => {
    need(pos < program.length, 'Truncated Git delta.');
    return program[pos++];
  };
  const variable = () => {
    let n = 0;
    for (let shift = 0; shift < 28; shift += 7) {
      const c = byte();
      n += (c & 127) * 2 ** shift;
      if (!(c & 128)) return n;
    }
    need(false, 'Git delta length unsupported.');
  };
  need(variable() === base.length, 'Git delta base size changed.');
  const size = variable();
  need(size <= bounds.object, 'Git delta object exceeds bound.');
  const out = Buffer.alloc(size);
  let written = 0;
  while (pos < program.length) {
    const op = byte();
    let from, n;
    if (op & 128) {
      let offset = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += byte() * 2 ** (8 * i);
      n = 0;
      for (let i = 0; i < 3; i++) if (op & (16 << i)) n += byte() * 2 ** (8 * i);
      n = n || 65536;
      need(offset + n <= base.length, 'Git delta copy exceeds its base.');
      from = base.subarray(offset, offset + n);
    } else {
      n = op;
      need(n > 0 && pos + n <= program.length, 'Invalid Git delta insertion.');
      from = program.subarray(pos, pos + n);
      pos += n;
    }
    need(written + n <= size, 'Git delta exceeds declared result.');
    from.copy(out, written);
    written += n;
  }
  need(written === size, 'Git delta result is incomplete.');
  return out;
}
function unpack(bytes, deadline) {
  need(
    bytes.length >= 32 &&
      bytes.toString('ascii', 0, 4) === 'PACK' &&
      bytes.readUInt32BE(4) === 2 &&
      sha1(bytes.subarray(0, -20)).equals(bytes.subarray(-20)),
    'Unsupported or corrupt Git pack.'
  );
  const count = bytes.readUInt32BE(8);
  need(count > 0 && count <= bounds.objects, 'Git pack object count exceeds bridge bounds.');
  const data = bytes.subarray(0, -20),
    offsets = new Map(),
    objects = new Map(),
    pending = [],
    deltas = { ofs: 0, ref: 0 };
  let pos = 12,
    expanded = 0;
  const byte = () => {
    need(pos < data.length, 'Truncated Git pack.');
    return data[pos++];
  };
  function add(type, raw, offset) {
    const id = gitId(type, raw);
    need(!objects.has(id), 'Duplicate object in Git pack.');
    const entry = { type, raw, id };
    objects.set(id, entry);
    offsets.set(offset, entry);
  }
  for (let i = 0; i < count; i++) {
    deadline();
    const offset = pos;
    let c = byte(),
      size = c & 15,
      shift = 4;
    const type = types[(c >> 4) & 7];
    need(
      ['tree', 'commit', 'blob', 'ofs', 'ref'].includes(type),
      'Unsupported Git pack object type.'
    );
    while (c & 128) {
      need(shift < 28, 'Unsupported Git pack size.');
      c = byte();
      size += (c & 127) * 2 ** shift;
      shift += 7;
    }
    need(
      size <= bounds.object && expanded + size <= bounds.expanded,
      'Git pack expansion exceeds bridge bounds.'
    );
    let base;
    if (type === 'ofs') {
      c = byte();
      let distance = c & 127;
      while (c & 128) {
        need(distance <= offset, 'Invalid Git offset delta.');
        c = byte();
        distance = (distance + 1) * 128 + (c & 127);
      }
      base = offset - distance;
      need(base >= 12 && base < offset, 'Invalid Git offset delta.');
    }
    if (type === 'ref') {
      need(pos + 20 <= data.length, 'Truncated Git reference delta.');
      base = data.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    let inflated;
    try {
      inflated = inflateSync(data.subarray(pos), {
        info: true,
        maxOutputLength: Math.max(1, size)
      });
    } catch {
      need(false, 'Invalid or oversized compressed Git object.');
    }
    const raw = inflated.buffer;
    need(
      raw.length === size && inflated.engine.bytesWritten > 0,
      'Git object length differs from its header.'
    );
    pos += inflated.engine.bytesWritten;
    expanded += size;
    if (base === undefined) add(type, raw, offset);
    else {
      deltas[type]++;
      pending.push({ base, raw, offset });
    }
  }
  need(pos === data.length, 'Trailing Git pack data.');
  while (pending.length) {
    deadline();
    let progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i],
        b = typeof p.base === 'number' ? offsets.get(p.base) : objects.get(p.base);
      if (!b) continue;
      const result = delta(b.raw, p.raw);
      expanded += result.length;
      need(expanded <= bounds.expanded, 'Git delta closure exceeds bridge bounds.');
      add(b.type, result, p.offset);
      pending.splice(i, 1);
      progress = true;
    }
    need(progress, 'Missing Git delta base; thin packs are unsupported.');
  }
  return { objects, deltas };
}
function linkTarget(path, bytes) {
  need(
    bytes.length > 0 && bytes.length <= 4096 && !bytes.includes(0),
    'Unsupported Git symlink target.'
  );
  const parts = utf8(bytes).split('/');
  let depth = path.split('/').length - 1;
  while (parts[0] === '.' || parts[0] === '..') {
    if (parts.shift() === '..') depth--;
    need(depth >= 0, 'Git symlink escapes the selected tree.');
  }
  if (parts.length) {
    try {
      validateNativePath(parts.join('/'));
    } catch {
      need(false, 'Unsupported Git symlink target path.');
    }
  }
}
function actor(value) {
  const match =
    /^([^<>\n\r]+) <([^<>\n\r]+)> (0|[1-9]\d{0,12}) ([+-](?:[01]\d|2[0-3])[0-5]\d)$/.exec(value);
  need(
    match &&
      !/[\u0000-\u001f\u007f]/.test(match[1] + match[2]) &&
      Buffer.byteLength(match[1]) <= 512 &&
      Buffer.byteLength(match[2]) <= 512,
    'Unsupported Git author or committer identity.'
  );
  return { name: match[1], email: match[2], seconds: Number(match[3]), offset: match[4] };
}
function person(a) {
  const text = a.name + ' <' + a.email + '> ' + a.seconds + ' ' + a.offset;
  actor(text);
  return text;
}
function commitBytes(tree, parents, r) {
  return Buffer.from(
    [
      'tree ' + tree,
      ...parents.map((p) => 'parent ' + p),
      'author ' + person(r.author),
      'committer ' + person(r.committer),
      '',
      r.message
    ].join('\n')
  );
}
function parseCommit(raw) {
  const text = utf8(raw),
    at = text.indexOf('\n\n');
  need(at >= 0, 'Git commit lacks a header separator.');
  const lines = text.slice(0, at).split('\n'),
    tree = lines.shift()?.match(/^tree ([0-9a-f]{40})$/)?.[1],
    parents = [];
  while (/^parent /.test(lines[0])) {
    const id = lines.shift().slice(7);
    need(
      /^[0-9a-f]{40}$/.test(id) && !parents.includes(id) && parents.length < 8,
      'Unsupported Git parent list.'
    );
    parents.push(id);
  }
  need(
    tree &&
      lines.length === 2 &&
      lines[0].startsWith('author ') &&
      lines[1].startsWith('committer '),
    'Git commit headers outside the supported profile (e.g. signatures or encoding).'
  );
  const result = {
    tree,
    parents,
    author: actor(lines[0].slice(7)),
    committer: actor(lines[1].slice(10)),
    message: text.slice(at + 2)
  };
  need(
    !result.message.includes('\0') &&
      Buffer.byteLength(result.message) <= 65536 &&
      commitBytes(tree, parents, result).equals(raw),
    'Git commit does not round-trip supported metadata.'
  );
  return result;
}
function bundleHeader(head, ref, advertiseHead = false) {
  return Buffer.from(
    '# v2 git bundle\n' + head + ' ' + ref + '\n' + (advertiseHead ? head + ' HEAD\n' : '') + '\n'
  );
}
export function readBundle(bytes, head, ref, deadline, advertiseHead = false) {
  need(bytes.length <= bounds.packed, 'Git bundle exceeds packed byte bound.');
  const header = bundleHeader(head, ref, advertiseHead);
  need(
    bytes.subarray(0, header.length).equals(header),
    'Expected one complete v2 SHA-1 bundle for the selected ref.'
  );
  const { objects, deltas } = unpack(bytes.subarray(header.length), deadline),
    commits = new Map(),
    files = new Map(),
    visiting = new Set(),
    reachable = new Set();
  let entries = 0;
  const obj = (id, type) => {
    const o = objects.get(id);
    need(o?.type === type, 'Incomplete Git history or incorrect object type.');
    reachable.add(id);
    return o.raw;
  };
  function walkTree(id, prefix, out, depth) {
    deadline();
    need(depth <= bounds.depth, 'Git tree depth exceeds bridge bound.');
    const raw = obj(id, 'tree');
    need(!prefix || raw.length > 0, 'Empty Git subdirectories are unsupported.');
    for (let p = 0; p < raw.length; ) {
      const space = raw.indexOf(32, p),
        zero = raw.indexOf(0, space + 1);
      need(space > p && zero > space + 1 && zero + 21 <= raw.length, 'Malformed Git tree.');
      const mode = raw.toString('ascii', p, space),
        name = utf8(raw.subarray(space + 1, zero)),
        oid = raw.subarray(zero + 1, zero + 21).toString('hex');
      p = zero + 21;
      need(!name.includes('/'), 'Malformed nested Git tree component.');
      const path = prefix + name;
      validateNativePath(path);
      need(++entries <= bounds.entries, 'Git tree entry count exceeds bridge bound.');
      if (mode === '40000') {
        walkTree(oid, path + '/', out, depth + 1);
        continue;
      }
      need(['100644', '100755', '120000'].includes(mode), 'Unsupported Git file mode or gitlink.');
      need(!out.has(path), 'Duplicate Git path.');
      const data = obj(oid, 'blob');
      if (mode === '120000') linkTarget(path, data);
      out.set(path, { path, mode, oid });
      files.set(oid, data);
    }
  }
  function visit(id, depth) {
    deadline();
    if (commits.has(id)) return;
    need(
      !visiting.has(id) && depth <= bounds.depth && commits.size + visiting.size < bounds.commits,
      'Git ancestry exceeds bridge bound.'
    );
    visiting.add(id);
    const r = parseCommit(obj(id, 'commit'));
    for (const parent of r.parents) visit(parent, depth + 1);
    const tree = new Map();
    walkTree(r.tree, '', tree, 0);
    // Native trees cannot preserve malformed ordering, duplicate directories, or case-folded collisions.
    let logical = 0;
    const names = new Map();
    for (const e of tree.values()) {
      logical += files.get(e.oid).length;
      need(logical <= 24 * MiB, 'Git snapshot exceeds native logical tree size.');
      let path = '';
      const parts = e.path.split('/');
      for (let j = 0; j < parts.length; j++) {
        path += (j ? '/' : '') + parts[j];
        const key = path.toLowerCase(),
          kind = (j === parts.length - 1 ? 'f:' : 'd:') + path;
        need(
          !names.has(key) || names.get(key) === kind,
          'Git tree has a case or directory collision.'
        );
        names.set(key, kind);
      }
    }
    need(
      treeId([...tree.values()], (type, raw) => gitId(type, raw)) === r.tree,
      'Git tree does not round-trip supported names and modes.'
    );
    commits.set(id, { ...r, tree });
    visiting.delete(id);
  }
  visit(head, 1);
  need(
    reachable.size === objects.size,
    'Git bundle contains objects outside the selected closure.'
  );
  return { commits, files, deltas };
}
function treeId(entries, emit) {
  const root = new Map();
  for (const e of entries) {
    const parts = e.path.split('/');
    let node = root;
    for (const p of parts.slice(0, -1)) {
      if (!node.has(p)) node.set(p, new Map());
      node = node.get(p);
    }
    node.set(parts.at(-1), e);
  }
  const visit = (node) => {
    const parts = [];
    for (const [name, v] of node) {
      const dir = v instanceof Map,
        oid = dir ? visit(v) : v.oid;
      parts.push({
        key: Buffer.from(name + (dir ? '/' : '')),
        bytes: Buffer.concat([
          Buffer.from((dir ? '40000' : v.mode) + ' ' + name + '\0'),
          Buffer.from(oid, 'hex')
        ])
      });
    }
    parts.sort((a, b) => Buffer.compare(a.key, b.key));
    return emit('tree', Buffer.concat(parts.map((p) => p.bytes)));
  };
  return visit(root);
}
export function exportBundle(native, repository, revisionId, deadline) {
  const objects = new Map(),
    mapped = new Map(),
    gitOwners = new Map(),
    visited = new Set(),
    blobIds = new Map();
  let total = 0,
    paths = 0;
  function emit(type, raw) {
    const id = gitId(type, raw);
    if (!objects.has(id)) {
      total += raw.length;
      need(
        objects.size < bounds.objects && total <= bounds.expanded,
        'Native Git export exceeds object or byte bounds.'
      );
      objects.set(id, { type, raw });
    }
    return id;
  }
  function visit(id, depth) {
    deadline();
    if (mapped.has(id)) return mapped.get(id);
    need(
      !visited.has(id) && visited.size + mapped.size < bounds.commits && depth <= bounds.depth,
      'Native Git export exceeds ancestry bounds.'
    );
    visited.add(id);
    const r = native.revision({ repository, revisionId: id }),
      parents = r.parents.map((p) => visit(p, depth + 1));
    const selected = native.select({ repository, revisionId: id }),
      entries = [];
    paths += selected.entries.length;
    need(paths <= bounds.entries, 'Native Git export exceeds tree entry bound.');
    for (const e of selected.entries) {
      let oid = blobIds.get(e.fileId);
      if (!oid || e.mode === '120000') {
        const data = selected.read(e.path).bytes;
        if (e.mode === '120000') linkTarget(e.path, data);
        oid = emit('blob', data);
        blobIds.set(e.fileId, oid);
      }
      entries.push({ ...e, oid });
    }
    const result = emit('commit', commitBytes(treeId(entries, emit), parents, r));
    need(
      !gitOwners.has(result),
      'Distinct native changesets collapse to the same Git identity in this export.'
    );
    gitOwners.set(result, id);
    mapped.set(id, result);
    visited.delete(id);
    return result;
  }
  const head = visit(revisionId, 1),
    header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.size, 8);
  const chunks = [header];
  let packed = 12;
  for (const { type, raw } of objects.values()) {
    deadline();
    let n = raw.length,
      first = (types.indexOf(type) << 4) | n % 16;
    n = Math.floor(n / 16);
    const hdr = [];
    while (n) {
      hdr.push(first | 128);
      first = n % 128;
      n = Math.floor(n / 128);
    }
    hdr.push(first);
    const compressed = deflateSync(raw);
    packed += hdr.length + compressed.length;
    need(packed + 128 <= bounds.packed, 'Compressed Git export exceeds bridge bounds.');
    chunks.push(Buffer.from(hdr), compressed);
  }
  const pack = Buffer.concat(chunks);
  return {
    head,
    mapped,
    bytes: Buffer.concat([bundleHeader(head, 'refs/heads/export', true), pack, sha1(pack)])
  };
}
