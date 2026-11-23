// Thompson-style state simulation. Every input character visits each position at
// most twice, including zero-width transitions. No input pattern reaches RegExp.
const invalid = (message) => {
  throw Object.assign(Error(message), { status: 400 });
};
export function searchWork() {
  let left = 16 * 1024 * 1024;
  return (n) => {
    left -= n;
    if (left < 0)
      throw Object.assign(Error('Search work limit reached. Narrow the path prefix or query.'), {
        status: 422
      });
  };
}
const metachar = '(){}|^$*+?[]';
function machine(atoms, startAnchor, endAnchor) {
  return (text, spend) => {
    let current = new Int32Array(atoms.length + 1).fill(-1),
      next = new Int32Array(atoms.length + 1);
    const keep = (arr, i, from) => {
      if (arr[i] < 0 || from < arr[i]) arr[i] = from;
    };
    for (let pos = 0; pos <= text.length; pos++) {
      spend(atoms.length + 1);
      if (!startAnchor || pos === 0) keep(current, 0, pos);
      for (let i = 0; i < atoms.length; i++)
        if (current[i] >= 0 && atoms[i].optional) keep(current, i + 1, current[i]);
      const match = current[atoms.length];
      if (match >= 0 && (!endAnchor || pos === text.length)) return match;
      if (pos === text.length) break;
      next.fill(-1);
      for (let i = 0; i < atoms.length; i++)
        if (current[i] >= 0 && atoms[i].test(text[pos]))
          keep(next, atoms[i].repeat ? i : i + 1, current[i]);
      [current, next] = [next, current];
    }
    return -1;
  };
}
export function boundedRegex(pattern) {
  if (!pattern.length || pattern.length > 128)
    invalid('Use a regular expression with 1–128 characters.');
  let pos = 0,
    start = false,
    end = false;
  const atoms = [];
  if (pattern[pos] === '^') {
    start = true;
    pos++;
  }
  while (pos < pattern.length) {
    const c = pattern[pos++];
    if (c === '$' && pos === pattern.length) {
      end = true;
      break;
    }
    let test;
    if (c === '.') test = () => true;
    else if (c === '[') {
      let negate = false;
      if (pattern[pos] === '^') {
        negate = true;
        pos++;
      }
      const ranges = [];
      while (pos < pattern.length && pattern[pos] !== ']') {
        const lo = pattern[pos++];
        let hi = lo;
        if (pattern[pos] === '-' && pattern[pos + 1] !== ']') {
          pos++;
          hi = pattern[pos++];
        }
        if (!hi || lo > hi || lo === '\\' || hi === '\\' || lo === '[')
          invalid('Invalid character range.');
        ranges.push([lo, hi]);
      }
      if (!ranges.length || pattern[pos++] !== ']')
        invalid('Unterminated or empty character class.');
      test = (ch) => ranges.some(([lo, hi]) => lo <= ch && ch <= hi) !== negate;
    } else if (c === '\\') {
      const value = pattern[pos++];
      if (!value) invalid('Incomplete search escape.');
      if (value === 'd') test = (ch) => ch >= '0' && ch <= '9';
      else if (value === 'w') test = (ch) => /[a-zA-Z0-9_]/.test(ch);
      else if (value === 's') test = (ch) => /\s/u.test(ch);
      else {
        if (!'.\\(){}|^$*+?[]-'.includes(value)) invalid('Unsupported search escape.');
        test = (ch) => ch === value;
      }
    } else {
      if (metachar.includes(c))
        invalid('Grouping, alternation, counts and misplaced operators are unsupported.');
      test = (ch) => ch === c;
    }
    const q = pattern[pos];
    if (q === '+' || q === '*' || q === '?') pos++;
    if (q === '+') atoms.push({ test });
    atoms.push({
      test,
      optional: q === '?' || q === '*' || q === '+',
      repeat: q === '*' || q === '+'
    });
  }
  return machine(atoms, start, end);
}
export function pathGlob(pattern) {
  const segments = pattern.split('/');
  if (
    segments.length > 32 ||
    segments.some((s) => !s || s === '.' || s === '..' || (s.includes('**') && s !== '**'))
  )
    invalid('Use slash-separated glob components, with ** as a complete component.');
  const parts = segments.map((s) =>
    s === '**'
      ? null
      : machine(
          s
            .split('')
            .map((c) =>
              c === '*'
                ? { test: () => true, optional: true, repeat: true }
                : { test: c === '?' ? () => true : (ch) => ch === c }
            ),
          true,
          true
        )
  );
  return (value, spend) => {
    const names = value.split('/');
    let active = new Set([0]);
    for (let p = 0; p <= names.length; p++) {
      spend(parts.length + 1);
      for (let j = 0; j < parts.length; j++)
        if (active.has(j) && parts[j] === null) active.add(j + 1);
      if (p === names.length) return active.has(parts.length);
      const next = new Set();
      for (const j of active)
        if (j < parts.length) {
          if (!parts[j]) next.add(j);
          else if (parts[j](names[p], spend) >= 0) next.add(j + 1);
        }
      active = next;
      if (!active.size) return false;
    }
  };
}
