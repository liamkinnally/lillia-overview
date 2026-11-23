import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { admitIssue, inspectIssue } from './guided-run.mjs';
import { deliverResult } from './guided-result.mjs';
import { setupProject } from './guided-setup.mjs';
import { readConversation, saveExchange } from './session-history.mjs';

const help =
  'Ask about a project or describe a change. Use /open PATH to pick a folder, /settings to edit run limits and output, /status to see your last task, /watch to follow it, /diff to preview, /save to export, or /quit.';
const yes = (text) => /^(y|yes)$/i.test(text?.trim() || '');
const active = (view) => ['running', 'active', 'pending', 'queued'].includes(view.goal.state);

function stageText(view) {
  const { goal, projectChange } = view;
  if (goal.state === 'completed' && projectChange.stage === 'completed') return 'Completed';
  if (active(view) && projectChange.stage === 'author') return 'Author stage';
  if (active(view) && projectChange.stage === 'reviewer') return 'Independent review';
  return goal.state === projectChange.stage ? goal.state : goal.state + ' · ' + projectChange.stage;
}

function statusText(view) {
  const detail =
    view.blocker?.reason || view.projectChange.reviewerFinal?.note || view.projectChange.detail;
  return [stageText(view), detail].filter(Boolean).join('\n');
}

function describe(view) {
  return [view.goal.objective, statusText(view)].filter(Boolean).join('\n');
}

async function defaultServices() {
  return {
    ...(await import('./session-agent.mjs')),
    ...(await import('./session-project.mjs')),
    ...(await import('./session-activity.mjs')),
    setupProject,
    admitIssue,
    inspectIssue,
    deliverResult
  };
}

export async function runTerminalSession({ terminal, services, cwd = process.cwd() } = {}) {
  services ??= await defaultServices();
  terminal ??= (await import('./session-terminal.mjs')).createTerminal();
  const { write, signal } = terminal;
  const ask = async (label) => {
    const prompt = label.trimEnd().endsWith('[y/N]') ? terminal.confirm : terminal.ask;
    const answer = await prompt(label);
    if (answer === null || signal?.aborted)
      throw Object.assign(Error('Session closed.'), { code: 'SESSION_CLOSED' });
    return answer;
  };
  let account,
    project = null,
    unbound = [],
    goalId = null,
    goalSummary = '',
    goalActive = false,
    pending = null;
  function selected() {
    if (!project)
      throw Error('Choose a Git project first. Enter its path or tell me where to look.');
    return project;
  }
  async function latest() {
    const view = await services.inspectIssue(selected(), goalId || undefined);
    goalSummary = describe(view);
    goalActive = active(view);
    return view;
  }
  async function open(path) {
    const root = await services.findProject(path, { cwd });
    const next = await services.openProject(root, { ask, write });
    if (!next) return false;
    if (!project) {
      for (let i = 0; i + 1 < unbound.length; i += 2)
        saveExchange(next, account.accountBinding, unbound[i].text, unbound[i + 1].text);
    }
    project = next;
    goalId = null;
    goalSummary = '';
    goalActive = false;
    unbound = [];
    write('Working in ' + project.workspaceRoot);
    try {
      const view = await latest();
      write('Last task\n' + describe(view));
      if (active(view)) write('Use /watch to follow this task.');
    } catch (error) {
      if (!error.message.startsWith('No task yet.')) write(error.message);
    }
    return true;
  }
  async function result(view, previewOnly) {
    write(
      await services.deliverResult({
        goal: view,
        config: selected().config,
        command: project.command,
        previewOnly
      })
    );
  }
  async function follow(view) {
    const started = performance.now();
    let cursor = 0;
    let last = '';
    let activityUnavailable = false;
    try {
      while (!signal?.aborted) {
        goalSummary = describe(view);
        goalActive = active(view);
        if (services.readSessionActivity) {
          try {
            const entries = await services.readSessionActivity(selected(), view, cursor);
            for (const entry of entries) {
              write(entry.label);
              cursor = entry.cursor;
            }
            activityUnavailable = false;
          } catch {
            if (!activityUnavailable) write('Detailed activity unavailable. Showing task status.');
            activityUnavailable = true;
          }
        }
        const status = statusText(view);
        if (status !== last) {
          write(status);
          last = status;
        }
        if (!goalActive) break;
        const seconds = Math.floor((performance.now() - started) / 1000);
        const elapsed = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
        terminal.progress?.('Watching · ' + elapsed + ' elapsed');
        await delay(2500, undefined, { signal });
        view = await services.inspectIssue(selected(), view.goal.id);
      }
    } finally {
      terminal.progress?.('');
    }
    if (
      signal?.aborted ||
      view.goal.state !== 'completed' ||
      view.projectChange.stage !== 'completed'
    )
      return;
    await result(view, true);
    if (yes(await ask('Save this reviewed patch? [y/N]'))) await result(view, false);
  }
  async function propose(objective) {
    if (typeof objective !== 'string' || !objective.trim() || Buffer.byteLength(objective) > 4000)
      throw Error('Describe the proposed change in 1 to 4,000 UTF-8 bytes.');
    if (
      /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(objective)
    )
      throw Error(
        'The proposed change contains hidden control characters. Ask for a plain-text proposal.'
      );
    const { workspaceRoot, config } = selected();
    write(
      'Proposed change in ' +
        workspaceRoot +
        '\n' +
        objective +
        '\nAuthor and independent reviewer · ' +
        config.maxAttempts +
        ' attempts · ' +
        config.maxActiveSeconds +
        ' active seconds'
    );
    if (!yes(await ask('Start this task? [y/N]'))) return;
    if ((await services.accountStatus({ signal })).accountBinding !== account.accountBinding)
      throw Object.assign(Error('Codex account changed. Reopen Lillia to continue.'), {
        code: 'CODEX_ACCOUNT_CHANGED'
      });
    signal?.throwIfAborted();
    goalId = await services.admitIssue(project, objective);
    write(
      'Task ' + goalId + ' · Close the terminal at any time. Reopen this project to check progress.'
    );
    await follow(await latest());
  }
  async function chat(message) {
    if (goalActive) await latest();
    const history = project ? readConversation(project, account.accountBinding) : unbound;
    const facts = project
      ? { workspaceRoot: project.workspaceRoot, context: project.context, goal: goalSummary }
      : null;
    const input = {
      message,
      history,
      project: facts,
      accountBinding: account.accountBinding,
      signal
    };
    write('Asking Codex…');
    let response = await services.askAgent(input);
    if (response.readPath && facts && !response.folder) {
      let source;
      try {
        source = await services.readProjectFile(project, response.readPath);
      } catch (error) {
        source = 'File unavailable: ' + error.message;
      }
      response = await services.askAgent({
        ...input,
        project: {
          ...facts,
          context:
            facts.context +
            '\nRequested source ' +
            JSON.stringify(response.readPath) +
            '\n' +
            source
        }
      });
    }
    if (typeof response.reply !== 'string' || !response.reply.trim())
      throw Error('Codex returned an empty reply.');
    write(response.reply);
    // A proposed switch can never carry a task or transcript out of an existing project.
    const prior = project;
    if (response.folder) {
      if (!(await open(response.folder))) return;
      if (!prior) saveExchange(project, account.accountBinding, message, response.reply);
      const objective = response.objective || pending;
      pending = null;
      if (!prior && objective) await propose(objective);
      return;
    }
    if (project) saveExchange(project, account.accountBinding, message, response.reply);
    else
      unbound = [
        ...unbound,
        { role: 'user', text: message.slice(0, 3000) },
        { role: 'assistant', text: response.reply.slice(0, 3000) }
      ].slice(-12);
    if (response.objective) {
      if (project) await propose(response.objective);
      else {
        pending = response.objective;
        write('Which project should I use? Enter its folder path to continue.');
      }
    }
  }
  async function openPath(path) {
    if ((await open(path)) && pending) {
      const objective = pending;
      pending = null;
      await propose(objective);
    }
  }
  async function handle(text) {
    if (text === '/help') return write(help);
    if (text === '/settings') {
      const current = selected();
      const config = await services.setupProject({ ...current, ask, write, edit: true });
      if (config) project = { ...current, config };
      return;
    }
    if (text === '/status') return write(describe(await latest()));
    if (text === '/watch') return follow(await latest());
    if (text === '/diff' || text === '/save') return result(await latest(), text === '/diff');
    if (text === '/open' || text.startsWith('/open '))
      return openPath(text.slice(5).trim() || (await ask('Project folder')));
    if (/^(?:~\/|\.\.?\/|\/)/u.test(text)) return openPath(text);
    if (Buffer.byteLength(text) > 4000) throw Error('Keep a message within 4,000 UTF-8 bytes.');
    return chat(text);
  }
  async function recover(error) {
    if (error.code === 'SESSION_CLOSED' || signal?.aborted) return false;
    write(error.message);
    return !['CODEX_ACCOUNT_CHANGED', 'CODEX_SIGN_IN_REQUIRED'].includes(error.code);
  }
  try {
    try {
      account = await services.accountStatus({ signal });
    } catch (error) {
      if (error.code !== 'CODEX_SIGN_IN_REQUIRED') throw error;
      terminal.welcome({ model: 'Codex', account: null, project: null });
      if (!yes(await ask('Connect your Codex account using the native sign-in? [y/N]'))) return;
      account = await services.connectAccount({ signal });
    }
    terminal.welcome({ ...account, project: null });
    write('Type /help for session commands.');
    const candidate = (await services.currentProject(cwd)) || (await services.lastProject());
    if (candidate)
      try {
        await open(candidate);
      } catch (error) {
        if (!(await recover(error))) return;
      }
    if (!project)
      write(
        'Which project do you want to work on? Paste a Git folder path, or tell me where it is.'
      );
    while (!signal?.aborted) {
      const line = await terminal.ask(project ? basename(project.workspaceRoot) + ' · You' : 'You');
      if (line === null) break;
      const message = line.trim();
      if (message === '/quit' || message === '/exit') break;
      if (!message) continue;
      try {
        await handle(message);
      } catch (error) {
        if (!(await recover(error))) break;
      }
    }
  } catch (error) {
    if (error.code !== 'SESSION_CLOSED' && !signal?.aborted) throw error;
  } finally {
    terminal.close();
  }
}
