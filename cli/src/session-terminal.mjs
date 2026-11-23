import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';

// OSC and device-control strings can carry arbitrary payloads, including clipboard data.
const controlStrings = /(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[\s\S]*?(?:\x1b\\|[\x07\x9c]|$)/gu;
const invisibleControls =
  /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

function transcriptText(value) {
  const text = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(controlStrings, '');
  return stripVTControlCharacters(text).replace(invisibleControls, '');
}

function labelText(value) {
  return transcriptText(value).replace(/[\t\n\u2028\u2029]/gu, ' ');
}

function fitProject(path, width) {
  const chars = [...path];
  if (chars.length <= width) return path;
  return '…' + chars.slice(1 - width).join('');
}

export function createTerminal({ input = process.stdin, output = process.stdout, signal } = {}) {
  const tty = Boolean(input.isTTY && output.isTTY);
  const color = tty && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
  const sage = (text) => (color ? `\x1b[38;2;175;192;179m${text}\x1b[0m` : text);
  const slate = (text) => (color ? `\x1b[38;2;154;165;174m${text}\x1b[0m` : text);
  const lifetime = new AbortController();
  const queued = [];
  let showingProgress = false;
  let editing = false;
  let preparing = false;
  let ended = false;
  let waiting;

  // Readline keeps history and accepts type-ahead during a turn. Echo only the prompt being edited.
  const echo = new Writable({
    write(chunk, encoding, done) {
      if (editing) output.write(chunk);
      done();
    }
  });
  Object.defineProperty(echo, 'columns', { get: () => (editing ? output.columns : Infinity) });
  const resize = () => echo.emit('resize');
  if (tty) output.on('resize', resize);
  const reader = createInterface({ input, output: echo, terminal: tty, crlfDelay: Infinity });
  reader.on('line', (line) => {
    if (lifetime.signal.aborted) return;
    if (waiting) finish(line);
    else queued.push(line);
  });
  reader.once('SIGINT', close);
  reader.once('error', close);
  reader.once('close', () => {
    ended = true;
    if (tty) close();
    else finish(null);
  });
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();

  function finish(value) {
    editing = false;
    const resolve = waiting;
    waiting = undefined;
    resolve?.(value);
  }

  function close() {
    if (lifetime.signal.aborted) return;
    progress('');
    lifetime.abort();
    if (tty && editing) output.write('\n');
    finish(null);
    queued.length = 0;
    reader.close();
    output.off('resize', resize);
    signal?.removeEventListener('abort', close);
  }

  function welcome({ model, account, project }) {
    const columns = tty ? output.columns || 80 : Infinity;
    const path = fitProject(labelText(project), Math.max(columns - 11, 2));
    const rule = tty && columns >= 24 ? '  ' + slate('─'.repeat(Math.min(columns - 9, 44))) : '';
    output.write(`${sage('Lillia')}${rule}\n`);
    for (const [label, value] of [
      ['Project', path],
      ['Model', labelText(model)],
      ['Account', labelText(account)]
    ]) {
      if (value) output.write(`  ${slate(label.padEnd(7))}  ${value}\n`);
    }
    output.write('\n');
  }

  function progress(text) {
    if (showingProgress) {
      output.write('\r\x1b[2K');
      showingProgress = false;
    }
    if (!text || !tty || process.env.TERM === 'dumb' || lifetime.signal.aborted) return;
    const width = Math.max(0, (output.columns || 80) - 1);
    const line = [...labelText(text)].slice(0, width).join('');
    if (line) {
      output.write(slate(line));
      showingProgress = true;
    }
  }

  function write(text) {
    progress('');
    const message = transcriptText(text);
    output.write(message.endsWith('\n') ? message : message + '\n');
  }

  async function ask(label = 'You') {
    progress('');
    if (lifetime.signal.aborted || (ended && !queued.length)) return null;
    if (waiting || preparing) throw new Error('A terminal prompt is already open.');
    const prompt = sage(`${labelText(label).trimEnd()} › `);
    if (!tty) output.write(prompt.trimEnd() + '\n');
    if (queued.length) {
      const line = queued.shift();
      if (tty) output.write(prompt + transcriptText(line) + '\n');
      return line;
    }
    return new Promise((resolve) => {
      waiting = resolve;
      editing = true;
      if (!tty) return;
      reader.setPrompt(prompt);
      if (reader.line && process.env.TERM !== 'dumb') reader.prompt(true);
      else output.write(prompt + transcriptText(reader.line));
    });
  }

  async function confirm(label) {
    if (!tty || ended || lifetime.signal.aborted) return ask(label);
    if (waiting || preparing) throw new Error('A terminal prompt is already open.');
    preparing = true;
    let received;
    const markInput = () => {
      received = true;
    };
    input.on('data', markInput);
    try {
      // A synchronous source check can leave earlier keystrokes waiting in the OS. Let a full
      // I/O poll run before opening the prompt, and drain again while bytes keep arriving.
      do {
        received = false;
        await nextTurn();
        await nextTurn();
      } while (received && !ended && !lifetime.signal.aborted);
      if (ended || lifetime.signal.aborted) return null;
      queued.length = 0;
      reader.clearLine();
    } finally {
      input.off('data', markInput);
      preparing = false;
    }
    return ask(label);
  }

  return { welcome, write, ask, confirm, progress, close, signal: lifetime.signal };
}
