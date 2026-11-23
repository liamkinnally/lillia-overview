import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { boundedRegex, pathGlob, searchWork } from './search-pattern.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 400) => {
  throw Object.assign(Error(message), { status });
};
const pythonSource = String.raw`
import ast,json,resource,sys
resource.setrlimit(resource.RLIMIT_CPU,(2,2))
if sys.version_info[:3]!=(3,9,6): raise ValueError()
result=[]
for source in json.load(sys.stdin):
    tree=ast.parse(source,mode='exec',feature_version=(3,9))
    defs=[]
    for n in ast.walk(tree):
        if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)):
            kind='class' if isinstance(n,ast.ClassDef) else 'async function' if isinstance(n,ast.AsyncFunctionDef) else 'function'
            defs.append([n.name,kind,n.lineno,n.end_lineno])
            if len(defs)>4096: raise ValueError()
    result.append(sorted(defs,key=lambda x:x[2]))
print(json.dumps(result,separators=(',',':')))
`;
function definitions(files) {
  if (
    files.length > 256 ||
    files.some((f) => Buffer.byteLength(f.text) > 262144) ||
    files.reduce((n, f) => n + Buffer.byteLength(f.text), 0) > 1048576
  )
    fail('Python definition index exceeds its parsing bound. Narrow the path prefix.', 422);
  if (!files.length) return [];
  const child = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', pythonSource], {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    encoding: 'utf8',
    input: JSON.stringify(files.map((f) => f.text)),
    timeout: 2800,
    killSignal: 'SIGKILL',
    maxBuffer: 1048576
  });
  if (child.error || child.status !== 0)
    fail(
      'Python 3.9 definition index unavailable for this selection. Check its syntax or narrow the prefix.',
      422
    );
  return JSON.parse(child.stdout);
}
// A large or diverse file set may exceed the posting budget. The fallback
// searches the same verified snapshot and reports this choice to the caller.
function postings(files) {
  if (files.reduce((n, f) => n + (f.text?.length ?? 0), 0) > 2 * 1024 * 1024) return null;
  const result = new Map();
  let count = 0;
  for (let n = 0; n < files.length; n++) {
    const text = files[n].text;
    if (!text) continue;
    const seen = new Set();
    for (let i = 0; i + 2 < text.length; i++) {
      const gram = text.slice(i, i + 3);
      if (seen.has(gram)) continue;
      if (++count > 65536) return null;
      seen.add(gram);
      const bucket = result.get(gram);
      if (bucket) bucket.push(n);
      else result.set(gram, [n]);
    }
  }
  return result;
}
const isPython = (path) => path.endsWith('.py') || path.endsWith('.pyi');
function* physicalLines(text) {
  const breaks = /\r\n|[\r\n]/g;
  let start = 0,
    line = 1,
    byteOffset = 0,
    match;
  while ((match = breaks.exec(text))) {
    yield { line, start, end: match.index, byteOffset };
    byteOffset += Buffer.byteLength(text.slice(start, breaks.lastIndex));
    start = breaks.lastIndex;
    line++;
  }
  yield { line, start, end: text.length, byteOffset };
}
const snippet = (line, column) =>
  line.slice(Math.max(0, column - 80), Math.max(0, column - 80) + 320);
export function normalizeSearch({ mode = 'text', query, language }) {
  if (
    !['text', 'path', 'glob', 'regex', 'definition'].includes(mode) ||
    typeof query !== 'string' ||
    !query.length ||
    query.length > 256 ||
    !query.isWellFormed() ||
    /[\r\n\0]/.test(query)
  )
    fail('Invalid native search mode or query.');
  if (language !== undefined && language !== 'python') fail('Supported language filter is python.');
  if (mode === 'definition' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(query))
    fail('Supply an exact Python definition name.');
  return { mode, query, language: language ?? (mode === 'definition' ? 'python' : null) };
}
// Construct only from descriptors already admitted by the caller. Each cache
// belongs to one service client authority and only complete builds are published.
export class NativeSearch {
  #snapshots = new Map();
  search({ repository, revisionId, authorization, entries, read }, raw) {
    const { mode, query, language } = normalizeSearch(raw);
    const regex = mode === 'regex' ? boundedRegex(query) : null,
      glob = mode === 'glob' ? pathGlob(query) : null;
    const selected = entries.filter((e) => !language || isPython(e.path));
    const generation = hash([
      'native-search-v1',
      repository,
      revisionId,
      authorization,
      language,
      mode === 'definition' ? 'python-ast-3.9.6' : mode === 'path' || glob ? 'paths' : 'text',
      selected.map((e) => [e.path, e.mode, e.fileId])
    ]);
    let index = this.#snapshots.get(generation);
    if (!index) {
      let size = 0;
      const files = selected.map((e) => {
        if (mode === 'path' || glob || e.mode === '120000') return { ...e, text: null };
        const bytes = read(e.path).bytes;
        size += bytes.length;
        if (size > 24 * 1024 * 1024)
          fail('Search selection exceeds the native index size limit.', 422);
        let text = null;
        if (!bytes.includes(0))
          try {
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
          } catch {}
        return { ...e, text };
      });
      if (mode === 'definition') {
        const py = files.filter((f) => f.text !== null);
        let defs;
        try {
          defs = definitions(py);
        } catch (error) {
          if (error.status !== 422) throw error;
          return {
            index: { state: 'unavailable', generation: null, language, reason: error.message },
            results: []
          };
        }
        py.forEach((f, i) => {
          f.definitions = defs[i];
        });
      }
      const grams = mode === 'text' || mode === 'regex' ? postings(files) : null;
      index = { files, grams, size: size + (grams ? 4 * 1024 * 1024 : 0) };
      this.#snapshots.set(generation, index);
      let total = [...this.#snapshots.values()].reduce((n, entry) => n + entry.size, 0);
      while (this.#snapshots.size > 8 || total > 32 * 1024 * 1024) {
        const [key, prior] = this.#snapshots.entries().next().value;
        this.#snapshots.delete(key);
        total -= prior.size;
      }
    } else {
      this.#snapshots.delete(generation);
      this.#snapshots.set(generation, index);
    }
    const results = [],
      spend = searchWork();
    const hit = (file, line, endLine, extra = {}) => {
      if (results.length >= 8192)
        fail('Too many matches for this selection. Narrow its prefix or query.', 422);
      results.push({
        repository,
        revisionId,
        path: file.path,
        fileId: file.fileId,
        line,
        endLine,
        indexGeneration: generation,
        ...extra
      });
    };
    const indices =
      mode === 'text' && query.length >= 3 && index.grams
        ? (index.grams.get(query.slice(0, 3)) ?? [])
        : null;
    const candidates = indices === null ? index.files : indices.map((n) => index.files[n]);
    for (const f of candidates) {
      if (mode === 'path' || glob) {
        if (glob ? glob(f.path, spend) : f.path.includes(query)) hit(f, null, null);
        continue;
      }
      if (f.text === null) continue;
      if (mode === 'text') {
        const pos = f.text.indexOf(query);
        if (pos >= 0)
          for (const part of physicalLines(f.text))
            if (part.end > pos) {
              hit(f, part.line, part.line, {
                byteOffset: part.byteOffset,
                snippet: snippet(f.text.slice(part.start, part.end), pos - part.start)
              });
              break;
            }
      } else if (mode === 'definition') {
        const selected = f.definitions.filter((d) => d[0] === query);
        if (!selected.length) continue;
        const byLine = new Map(selected.map((d) => [d[2], d]));
        for (const part of physicalLines(f.text)) {
          const def = byLine.get(part.line);
          if (!def) continue;
          const [symbol, symbolKind, line, endLine] = def;
          hit(f, line, endLine, {
            byteOffset: part.byteOffset,
            symbol,
            symbolKind,
            snippet: snippet(f.text.slice(part.start, part.end), 0)
          });
        }
      } else {
        for (const part of physicalLines(f.text)) {
          const line = f.text.slice(part.start, part.end),
            pos = regex(line, spend);
          if (pos >= 0) {
            hit(f, part.line, part.line, {
              byteOffset: part.byteOffset,
              snippet: snippet(line, pos)
            });
            break;
          }
        }
      }
    }
    const strategy =
      mode === 'definition'
        ? 'python-ast'
        : mode === 'path' || glob
          ? 'path-list'
          : indices !== null
            ? 'trigram'
            : 'exact-scan';
    return { index: { state: 'indexed', generation, language, strategy }, results };
  }
}
