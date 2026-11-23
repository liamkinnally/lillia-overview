import { git } from './guided-setup-source.mjs';
import { isEligible, limits, ordinary, safePath } from './project-workspace-scope.mjs';

const maxFiles = 48;
const maxBytes = 16 * 1024;

function candidates(root, head) {
  const rows = git(root, ['ls-tree', '-r', '-l', '-z', head]).toString('utf8').split('\0');
  const entries = [];
  for (const row of rows) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/u.exec(row);
    if (!match) continue;
    const [, , oid, size, path] = match;
    if (!isEligible(path, [''], []) || Number(size) > limits.fileBytes) continue;
    safePath(path);
    entries.push({ path, oid, size: Number(size) });
  }
  // Use native scope ordering and count even non-text inputs towards its ceiling. The session
  // can omit eligible text, but cannot include a path beyond the enrolled byte or file budget.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let bytes = 0;
  const selected = [];
  for (const entry of entries.slice(0, limits.files)) {
    bytes += entry.size;
    if (bytes > limits.totalBytes) break;
    if (entry.size <= maxBytes) selected.push(entry);
    if (selected.length === maxFiles) break;
  }
  return selected;
}

export function registeredSource(root, head) {
  if (!/^[a-f0-9]{40}$/.test(head)) throw Error('The registered Git commit is unavailable.');
  const entries = candidates(root, head);
  const files = new Map();
  if (entries.length) {
    const input = entries.map(({ oid }) => oid + '\n').join('');
    const output = git(root, ['cat-file', '--batch'], maxFiles * (maxBytes + 100), input);
    let offset = 0;
    for (const { path, oid, size } of entries) {
      const end = output.indexOf(10, offset);
      if (
        end < 0 ||
        output.toString('ascii', offset, end) !== oid + ' blob ' + size ||
        output[end + 1 + size] !== 10
      )
        throw Error('The registered Git blob differs from its listed source identity.');
      const text = ordinary(output.subarray(end + 1, end + 1 + size));
      if (text !== null) files.set(path, text);
      offset = end + 2 + size;
    }
    if (offset !== output.length) throw Error('Unexpected data in the registered Git source.');
  }
  return Object.freeze({
    paths: Object.freeze([...files.keys()]),
    read(path) {
      if (!files.has(path)) throw Error('Choose an eligible path from the listed project source.');
      return files.get(path);
    }
  });
}

export async function readProjectFile(project, path) {
  return project.source.read(path);
}
