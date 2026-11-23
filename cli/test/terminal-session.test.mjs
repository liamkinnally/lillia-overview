import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTerminalSession } from '../src/terminal-session.mjs';
import { readConversation, saveExchange } from '../src/session-history.mjs';

const alice = {
  provider: 'Codex',
  model: 'Astra',
  account: 'Alice',
  accountBinding: 'a'.repeat(64)
};
async function fixture(t, lines, overrides = {}, controller = new AbortController()) {
  const dir = await mkdtemp(join(tmpdir(), 'lillia-dialog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = [],
    turns = [],
    admissions = [],
    exports = [];
  const project = {
    workspaceRoot: '/projects/demo',
    stateDir: dir,
    config: { maxAttempts: 2, maxActiveSeconds: 600 },
    context: 'range.mjs'
  };
  const terminal = {
    signal: controller.signal,
    welcome: (x) => output.push(JSON.stringify(x)),
    write: (x) => output.push(x),
    ask: async (q) => {
      output.push(q);
      return lines.shift() ?? null;
    },
    close() {}
  };
  terminal.confirm = async (label) => {
    output.push(label);
    return lines.shift() ?? null;
  };
  const services = {
    accountStatus: async () => alice,
    currentProject: async () => null,
    lastProject: async () => null,
    findProject: async (p) => p,
    openProject: async (p, { ask }) =>
      (await ask('Open ' + p + '?')) === 'yes' ? { ...project, workspaceRoot: p } : null,
    askAgent: async (input) => {
      turns.push(input);
      if (input.message === 'open my demo')
        return { reply: 'Use your demo.', folder: '/projects/demo' };
      if (input.message === 'why?')
        return input.project.context.includes('function range')
          ? { reply: 'The range prints each end.' }
          : { reply: 'I need the source.', readPath: 'range.mjs' };
      return { reply: 'I can fix that.', objective: 'Collapse equal ends.' };
    },
    readProjectFile: async (p, path) => {
      assert.equal(path, 'range.mjs');
      return 'function range(){}';
    },
    admitIssue: async (p, o) => {
      admissions.push(o);
      return 'g1';
    },
    inspectIssue: async (p, id) => {
      if (!id) throw Error('No task yet. Use lillia run "your issue".');
      return {
        goal: { id, state: 'completed', objective: 'Collapse equal ends.' },
        projectChange: { stage: 'completed' }
      };
    },
    deliverResult: async ({ previewOnly }) => {
      exports.push(!!previewOnly);
      return previewOnly ? 'diff --git a/range b/range' : 'Saved patch';
    },
    ...overrides
  };
  await runTerminalSession({ terminal, services });
  return { output: output.join('\n'), turns, admissions, exports, project };
}

test('start unbound, choose a repo in conversation, read eligible source, confirm one reviewed task and save its patch', async (t) => {
  const f = await fixture(t, ['open my demo', 'yes', 'why?', 'yeah fix it', 'yes', 'yes', '/quit']);
  assert.equal(f.turns[0].project, null);
  assert.equal(f.turns[1].project.workspaceRoot, '/projects/demo');
  assert.match(f.turns[2].project.context, /function range/);
  assert.match(f.output, /The range prints each end/);
  assert.match(f.output, /diff --git/);
  assert.match(f.output, /Saved patch/);
  assert.deepEqual(f.admissions, ['Collapse equal ends.']);
  assert.deepEqual(f.exports, [true, false]);
  assert.ok(f.turns.every((x) => x.accountBinding === alice.accountBinding));
});

test('declining project or task never starts work and an unconfirmed repo never receives history', async (t) => {
  const f = await fixture(
    t,
    ['no', 'open my demo', 'no', '/open /projects/demo', 'yes', 'fix that', 'no', '/quit'],
    { lastProject: async () => '/previous' }
  );
  assert.deepEqual(f.admissions, []);
  assert.deepEqual(f.exports, []);
  assert.equal(f.turns[0].project, null);
  assert.deepEqual(f.turns[1].history, []);
});

test('a project switch clears the previous conversation and cancels an ambiguous cross-project proposal', async (t) => {
  const f = await fixture(
    t,
    [
      '/open /first',
      'yes',
      'private first message',
      'no',
      'switch to second',
      'yes',
      'hello',
      'no',
      '/quit'
    ],
    {
      askAgent: async (input) => {
        if (input.message === 'hello') assert.deepEqual(input.history, []);
        return input.message === 'switch to second'
          ? { reply: 'Opening second', folder: '/second', objective: 'Stale suggestion' }
          : { reply: 'Sure', objective: 'example' };
      }
    }
  );
  assert.deepEqual(f.admissions, []);
  assert.match(f.output, /Opening second/);
});

test('history survives reopening the same project and stays bound to the same provider account', async (t) => {
  const f = await fixture(t, ['/quit']);
  await saveExchange(f.project, alice.accountBinding, 'owner question', 'answer');
  assert.deepEqual(await readConversation(f.project, alice.accountBinding), [
    { role: 'user', text: 'owner question' },
    { role: 'assistant', text: 'answer' }
  ]);
  assert.deepEqual(await readConversation(f.project, 'b'.repeat(64)), []);
});

test('reopening and checking status uses saved local work without another model turn or admission', async (t) => {
  const view = {
    goal: { id: 'rejected', objective: 'Original request', state: 'blocked' },
    projectChange: { stage: 'blocked', reviewerFinal: { decision: 'reject', note: 'Off by one.' } }
  };
  const f = await fixture(t, ['yes', '/status', '/quit'], {
    lastProject: async () => '/projects/demo',
    inspectIssue: async () => view
  });
  assert.match(f.output, /Original request/);
  assert.match(f.output, /Off by one/);
  assert.equal(f.turns.length, 0);
  assert.deepEqual(f.admissions, []);
});

test('a requested change mentioned before its folder survives a later manual selection and still needs consent', async (t) => {
  const f = await fixture(t, ['fix equal ends', '/open /demo', 'yes', 'no', '/quit']);
  assert.equal(f.turns.length, 1);
  assert.match(f.output, /Proposed change in \/demo\nCollapse equal ends\./);
  assert.deepEqual(f.admissions, []);
});

test('the main agent can explain the saved review when a project is reopened', async (t) => {
  const view = {
    goal: { id: 'g', objective: 'Format range', state: 'blocked' },
    projectChange: {
      stage: 'blocked',
      reviewerFinal: { note: 'Equal bounds still printed twice.' }
    }
  };
  const f = await fixture(t, ['yes', 'why did it stop?', '/quit'], {
    lastProject: async () => '/demo',
    inspectIssue: async () => view,
    askAgent: async (input) => {
      assert.match(input.project.goal, /Equal bounds still printed twice/);
      return { reply: 'The reviewer caught duplicate bounds.' };
    }
  });
  assert.match(f.output, /The reviewer caught duplicate bounds/);
});

test('closing the terminal during the final account check prevents admission', async (t) => {
  const controller = new AbortController();
  let checks = 0;
  const result = await fixture(
    t,
    ['/open /demo', 'yes', 'fix this', 'yes'],
    {
      accountStatus: async () => {
        if (++checks === 2) controller.abort();
        return alice;
      }
    },
    controller
  );
  assert.deepEqual(result.admissions, []);
});

test('a proposed objective with invisible terminal controls cannot be approved', async (t) => {
  const result = await fixture(t, ['/open /demo', 'yes', 'fix this', 'yes', '/quit'], {
    askAgent: async () => ({
      reply: 'Proposal ready',
      objective: 'Fix\u001b]0;concealed\u0007 output'
    })
  });
  assert.deepEqual(result.admissions, []);
  assert.match(result.output, /control characters/);
});

test('a folder-free first question stays available when the owner selects their first project', async (t) => {
  const f = await fixture(
    t,
    ['why is the range odd?', '/open /demo', 'yes', 'what did you find?', '/quit'],
    {
      askAgent: async (input) => {
        if (input.project) {
          assert.match(input.history[0].text, /range odd/);
          return { reply: 'I can check the range now.' };
        }
        return { reply: 'Which folder contains it?' };
      }
    }
  );
  assert.match(f.output, /I can check the range now/);
});

test('a question about an active goal receives its latest local review', async (t) => {
  let n = 0;
  const f = await fixture(t, ['/open /demo', 'yes', 'did it finish?', '/quit'], {
    inspectIssue: async () =>
      ++n === 1
        ? {
            goal: { id: 'g', state: 'running', objective: 'Do it' },
            projectChange: { stage: 'author' }
          }
        : {
            goal: { id: 'g', state: 'completed', objective: 'Do it' },
            projectChange: { stage: 'completed', reviewerFinal: { note: 'Independently reviewed' } }
          },
    askAgent: async (input) => {
      assert.match(input.project.goal, /Independently reviewed/);
      return { reply: 'Yes, the review finished.' };
    }
  });
  assert.match(f.output, /Yes, the review finished/);
});

test('the opening question naming its own folder survives confirmation', async (t) => {
  const f = await fixture(t, ['in /demo why is 4 doubled?', 'yes', 'explain it now', '/quit'], {
    askAgent: async (input) => {
      if (!input.project) return { reply: 'Please confirm that folder.', folder: '/demo' };
      assert.equal(input.history.at(-2).text, 'in /demo why is 4 doubled?');
      return { reply: 'Checking the duplicate.' };
    }
  });
  assert.match(f.output, /Checking the duplicate/);
});

test('editing settings in the session changes the limits displayed for the next task', async (t) => {
  const f = await fixture(t, ['/open /demo', 'yes', '/settings', 'fix it', 'no', '/quit'], {
    setupProject: async (opts) => {
      assert.equal(opts.edit, true);
      return { ...opts.config, maxAttempts: 3, maxActiveSeconds: 900 };
    }
  });
  assert.match(f.output, /3 attempts · 900 active seconds/);
  assert.deepEqual(f.admissions, []);
});

test('watch prints new recorded actions once across polls and ends with the reviewed diff', async (t) => {
  let polls = 0;
  const cursors = [];
  const f = await fixture(t, ['/open /demo', 'yes', '/watch', 'no', '/quit'], {
    inspectIssue: async () => {
      polls++;
      const finished = polls >= 3;
      return {
        goal: {
          id: 'g1',
          objective: 'Collapse equal ends.',
          state: finished ? 'completed' : 'active'
        },
        projectChange: {
          stage: finished ? 'completed' : 'author',
          reviewerFinal: finished ? { note: 'Verified.' } : null
        }
      };
    },
    readSessionActivity: async (project, view, after) => {
      cursors.push(after);
      return after === 0
        ? [{ cursor: 1, label: 'Author · Edited range.mjs' }]
        : [{ cursor: 2, label: 'Reviewer · Checks passed' }];
    }
  });
  assert.deepEqual(cursors, [0, 1]);
  assert.equal(f.output.split('Author · Edited range.mjs').length, 2);
  assert.match(
    f.output,
    /Edited range\.mjs[\s\S]*Reviewer · Checks passed[\s\S]*Verified\.[\s\S]*diff --git/
  );
  assert.doesNotMatch(f.output, /completed · completed/);
  assert.equal(f.turns.length, 0);
});
