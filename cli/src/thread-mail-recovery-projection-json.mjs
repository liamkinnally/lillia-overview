import { recoveryConflict } from './recovery-format.mjs';
// Replace typed JSON leaves without reserializing unrelated bytes or escapes.
export function replaceJsonLeaves(text, replacements) {
  let pos = 0;
  const edits = [],
    seen = new Set();
  const skip = () => {
    while (/\s/.test(text[pos] || '') && pos < text.length) pos++;
  };
  function string() {
    const start = pos++;
    while (pos < text.length) {
      if (text[pos++] === '\\') pos++;
      else if (text[pos - 1] === '"') return [start, pos];
    }
    throw recoveryConflict('Invalid projection JSON string.');
  }
  function value(path) {
    skip();
    const start = pos,
      token = text[pos];
    if (token === '{') {
      pos++;
      skip();
      if (text[pos] !== '}')
        for (;;) {
          skip();
          const [a, b] = string(),
            key = JSON.parse(text.slice(a, b));
          skip();
          if (text[pos++] !== ':') throw recoveryConflict('Invalid projection JSON object.');
          value([...path, key]);
          skip();
          if (text[pos] !== ',') break;
          pos++;
        }
      if (text[pos++] !== '}') throw recoveryConflict('Invalid projection JSON object.');
    } else if (token === '[') {
      pos++;
      skip();
      let index = 0;
      if (text[pos] !== ']')
        for (;;) {
          value([...path, index++]);
          skip();
          if (text[pos] !== ',') break;
          pos++;
        }
      if (text[pos++] !== ']') throw recoveryConflict('Invalid projection JSON array.');
    } else if (token === '"') string();
    else {
      while (pos < text.length && !/[\s,}\]]/.test(text[pos])) pos++;
    }
    const key = JSON.stringify(path);
    if (replacements.has(key)) {
      if (seen.has(key)) throw recoveryConflict('Duplicate projection JSON key.');
      seen.add(key);
      edits.push([start, pos, JSON.stringify(replacements.get(key))]);
    }
  }
  JSON.parse(text);
  value([]);
  skip();
  if (pos !== text.length || seen.size !== replacements.size)
    throw recoveryConflict('Projection JSON path differs.');
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0]))
    text = text.slice(0, start) + replacement + text.slice(end);
  return text;
}
