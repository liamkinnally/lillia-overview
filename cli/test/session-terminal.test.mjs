import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import { createTerminal } from '../src/session-terminal.mjs';

function start(t, { tty = false, columns = 80, signal } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = tty;
  output.columns = columns;
  let screen = '';
  output.setEncoding('utf8').on('data', (chunk) => {
    screen += chunk;
  });
  const terminal = createTerminal({ input, output, signal });
  t.after(() => terminal.close());
  return { terminal, input, screen: () => screen };
}

test('a script may finish sending all answers before the first question', async (t) => {
  const { terminal, input, screen } = start(t);
  input.end('explain this project\r\n\ninspect the tests');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await terminal.ask('You'), 'explain this project');
  assert.equal(await terminal.ask('Continue?'), '');
  assert.equal(await terminal.ask(), 'inspect the tests');
  assert.equal(await terminal.ask(), null);
  assert.equal(terminal.signal.aborted, false, 'script EOF must let submitted work finish');
  assert.doesNotMatch(screen(), /explain this project|\x1b/);
});

test('the transcript keeps paragraphs and strips terminal commands from every display field', async (t) => {
  const { terminal, input, screen } = start(t);
  terminal.welcome({
    model: 'astra\x07',
    project: 'my\nproject\x1bc',
    account: 'Pro\x9d52;c;secret\x9c'
  });
  terminal.write('one\r\n\x1b[31mtwo\x1b[0m\x1bPsecret\x1b\\\x1b]0;secret\x07\r\x08\u202e');
  const answer = terminal.ask('You\x1b[2J');
  input.end('hello');
  assert.equal(await answer, 'hello');
  assert.match(screen(), /Lillia/);
  assert.match(screen(), /my project/);
  assert.match(screen(), /astra/);
  assert.match(screen(), /Pro/);
  assert.match(screen(), /one\ntwo\n/);
  assert.match(screen(), /You/);
  assert.doesNotMatch(screen(), /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e]|secret/);
});

test('the narrow welcome preserves project and model without an empty account field', (t) => {
  const { terminal, screen } = start(t, { tty: true, columns: 28 });
  terminal.welcome({
    model: 'gpt-6.2-astra',
    project: '/Volumes/studies/long-parent-folder/project-name'
  });
  const visible = stripVTControlCharacters(screen());
  assert.match(visible, /project-name/);
  assert.match(visible, /gpt-6.2-astra/);
  assert.doesNotMatch(visible, /undefined|null|Account/i);
  assert.ok(visible.split('\n').every((row) => [...row].length <= 28));
});

test('cancellation and close settle a pending prompt and discard queued answers', async (t) => {
  const controller = new AbortController();
  const { terminal, input } = start(t, { signal: controller.signal });
  const pending = terminal.ask('You');
  controller.abort();
  input.end('stale\n');
  assert.equal(await pending, null);
  assert.equal(await terminal.ask(), null);
  assert.equal(terminal.signal.aborted, true);
  terminal.close();
  const second = start(t);
  const waiting = second.terminal.ask();
  second.terminal.close();
  assert.equal(await waiting, null);
  assert.equal(second.terminal.signal.aborted, true);
});

test('Ctrl-C cancels an active turn while typing ahead stays quiet until the next prompt', async (t) => {
  const { terminal, input, screen } = start(t, { tty: true });
  const first = terminal.ask();
  input.write('first\rsecond\rhalf');
  assert.equal(await first, 'first');
  assert.doesNotMatch(stripVTControlCharacters(screen()), /second|half/);
  terminal.write('Reply');
  assert.equal(await terminal.ask(), 'second');
  const partial = terminal.ask();
  input.write(' line\r');
  assert.equal(await partial, 'half line');
  const shown = stripVTControlCharacters(screen());
  for (const word of ['first', 'second', 'half line']) {
    assert.equal(shown.split(word).length, 2, 'each user turn appears once');
  }
  input.write('\x03');
  assert.equal(terminal.signal.aborted, true);
  assert.equal(await terminal.ask(), null);
});

test('a folder confirmation preserves distinct spaces in the selected path', async (t) => {
  const { terminal, input, screen } = start(t);
  terminal.welcome({ project: '/repos/two  spaces', model: 'model' });
  const answer = terminal.ask('Open /repos/two  spaces? [y/N] ');
  input.end('n');
  assert.equal(await answer, 'n');
  assert.equal(screen().split('/repos/two  spaces').length, 3);
});

test('a broken input stream cancels work and releases the pending prompt', async (t) => {
  const { terminal, input } = start(t);
  const pending = terminal.ask();
  input.destroy(new Error('Disconnected terminal'));
  assert.equal(await pending, null);
  assert.equal(terminal.signal.aborted, true);
});

test('a TTY confirmation discards completed and partially edited answers from before its prompt', async (t) => {
  const { terminal, input, screen } = start(t, { tty: true });
  const chat = terminal.ask();
  input.write('please check\ryes\ry');
  assert.equal(await chat, 'please check');
  terminal.write('Proposed change');
  const approval = terminal.confirm('Start? [y/N]');
  for (let n = 0; !screen().includes('Start?') && n < 12; n++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.match(screen(), /Start\?/);
  input.write('no\rnext chat\r');
  assert.equal(await approval, 'no');
  assert.equal(await terminal.ask(), 'next chat');
  assert.doesNotMatch(screen(), /yes/);
});

test('redirected session scripts may queue their explicit confirmation', async (t) => {
  const { terminal, input } = start(t);
  input.end('check this\nyes\n');
  assert.equal(await terminal.ask(), 'check this');
  assert.equal(await terminal.confirm('Start? [y/N]'), 'yes');
  assert.equal(await terminal.confirm('Save? [y/N]'), null);
});

test('a live progress line clears before durable output and is quiet on a pipe', (t) => {
  const previousTerm = process.env.TERM;
  process.env.TERM = 'xterm-256color';
  t.after(() => {
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
  });
  const { terminal, screen } = start(t, { tty: true, columns: 24 });
  terminal.progress('Watching 0:01');
  terminal.progress('Watching 0:04');
  terminal.write('Reviewer · Checks passed');
  assert.match(
    screen(),
    /Watching 0:01[^\n]*\r\x1b\[2K[^\n]*Watching 0:04[^\n]*\r\x1b\[2KReviewer · Checks passed\n/u
  );
  const plain = start(t);
  plain.terminal.progress('Watching 0:01');
  assert.equal(plain.screen(), '');
});
