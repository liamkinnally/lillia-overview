import { claudeModels, defaultClaudeModel } from './claude-models.mjs';

const names =
  /\b(?:claude(?:-[a-z0-9][a-z0-9.-]*[a-z0-9]| code| desktop)?(?:\s+(?:fable|opus|sonnet|haiku))?(?:[ -]+\d+(?:[.-]\d+)*)?|(?:fable|opus|sonnet|haiku|gemini|deepseek|grok|qwen|llama|mistral|copilot)(?:[ -]+\d+(?:[.-]\d+)*)?|gpt-[a-z0-9-]+|codex|astra)\b/gu;
const excluded =
  /\b(?:do not|don't|never|avoid|without|except|exclude|no|not)\s+(?:want to\s+)?(?:(?:use|using|run|running|ask|asking|have|let|involve|involving)\s+)?(?:the\s+)?$/u;
const excludedDestination =
  /\b(?:do not|don't|never|avoid|without)\s+(?:want to\s+)?(?:send(?:ing)?|assign(?:ing)?|delegat(?:e|ing)|hand(?:ing)?|transfer(?:ring)?|rout(?:e|ing)|dispatch(?:ing)?)\b[^;!?\n]{0,120}\b(?:to|through|via)\s+(?:the\s+)?$/u;
const routeVerb =
  /\b(?:use|using|ask|tell|have|let|via|get|assign|delegate)\s+(?:(?:only|the|model)\s+)?$/u;
const delegateTo = /\b(?:delegate|assign|hand|send)\b[^!?;\n]{0,80}\bto\s+$/u;
const addressed =
  /\b(?:(?:run|do|review|check|implement|fix|investigate)\s+(?:(?:it|this|that|the (?:job|review|task|work))\s+)?|done\s+)(?:with|through|on|by)\s+$/u;
const nonDirective =
  /\b(?:we|i|they|it|the app|the tool|the code|the project|the team)\s+(?:(?:are|were|is|already|currently|usually|sometimes|might|should|could|can)\s+)*$/u;
const subjectQuestion = /\b(?:whether|where|why|if|how)\s+(?:to\s+)?$/u;
const discussesProject =
  /\b(?:investigat\w*|examin\w*|find|check|determin\w*|explain)\b.*\b(?:if|whether|where|why|how)\b|\b(?:doc(?:s|umentation)?|log|example|note|message|test)\s+(?:says?|mentions?|suggests?|uses?|contains?)\b/u;
const reportedInstruction =
  /\b(?:said|says|told (?:me|us)|instructed (?:me|us)|asked (?:me|us)|suggested|previously|previous (?:author|reviewer))\b/u;
const addressToAgent =
  /^(?:(?:hey|please|kindly|also|just|only|now|go ahead and|feel free to|make sure to|i(?:'d| would) like (?:you )?to|i (?:want|need) (?:you )?to|(?:can|could|will|would|should|may) (?:you|we))\s*)*$/u;
const projectSubject =
  /^\s+(?:adapter|error|integration|bug|setting|log|route|model|session|support|issue|output|response|request|configuration)s?\b/u;
const roleNames = {
  reviewer: /^(?:review(?:er|ing)?|check(?:er)?|verify|verification)\b/u,
  author:
    /^(?:author(?:ing)?|implement(?:er|ation)?|edit(?:or|ing)?|writ(?:e|er|ing)|build|fix|do the edit)\b/u,
  planner: /^plan(?:ner|ning)?\b/u
};

function namedRoute(name) {
  if (['codex', 'astra', 'gpt-6-astra'].includes(name)) return { provider: 'codex' };
  if (['claude', 'claude code', 'claude desktop'].includes(name)) return { provider: 'claude' };
  const modelName = name.replace(/^claude(?: code| desktop)?[ -]/u, '').replace(/[ .]+/gu, '-');
  const model = claudeModels.find(
    (value) =>
      value === 'claude-' + modelName ||
      (['opus', 'fable'].includes(modelName) && value.startsWith('claude-' + modelName + '-'))
  );
  return model ? { provider: 'claude', model } : { provider: 'unsupported', name };
}

function unquoteProvider(wrapped, inside) {
  const name = inside.trim();
  const matches = [...name.matchAll(names)];
  return matches.length === 1 && matches[0][0] === name ? name : ' ';
}

function assignments(ownerText) {
  // A quoted instruction in a bug report is project data. A quoted model
  // identifier in “use `claude-opus-4-6`” can still name the requested route.
  let text = ownerText
    .toLowerCase()
    .replaceAll('’', "'")
    .replace(/^\s*>[^\n]*$/gmu, ' ')
    .replace(/```[\s\S]*?(?:```|$)/gu, ' ')
    .replace(/[`"“]([^`"”\n]*)[`"”]/gu, unquoteProvider)
    .replace(/(?<!\w)['‘]([^'\n]+)'(?!\w)/gu, unquoteProvider);
  const mentions = [...text.matchAll(names)],
    chosen = [],
    omit = [],
    masked = [],
    onlyModels = new Set();
  let prior = null,
    unresolved = false;
  for (const [i, match] of mentions.entries()) {
    const name = match[0],
      start = match.index,
      end = start + name.length;
    const before = text.slice(0, start),
      after = text.slice(end, mentions[i + 1]?.index ?? text.length);
    const clause = before.split(/[;!?\n]|[.](?=\s)|\b(?:and|but|then)\b/u).at(-1);
    const negation = clause.match(excluded) ?? clause.match(excludedDestination);
    const route = namedRoute(name);
    if (negation) {
      omit.push(route);
      masked.push([before.length - clause.length + negation.index, end]);
      prior = null;
      continue;
    }
    const availability = /\b(?:i|we)\s+(only\s+)?have(?: access to)?\s+(only\s+)?$/u.exec(clause);
    if (availability) {
      if (route.model && (availability[1] || availability[2])) onlyModels.add(route.model);
      prior = { end, subject: true };
      continue;
    }
    const between = prior ? text.slice(prior.end, start) : '';
    const inList = Boolean(prior && /^\s*(?:,?\s*(?:and|or|then)|,)\s*$/u.test(between));
    const candidateVerb = clause.match(routeVerb);
    const leader = candidateVerb ? clause.slice(0, candidateVerb.index) : clause;
    const addressedLead = leader.split(/[,—–]/u).at(-1).trim();
    const verb =
      candidateVerb &&
      (addressToAgent.test(addressedLead) || /^(?:using|via)\b/u.test(candidateVerb[0]));
    const polite = /\b(?:can|could|would|should|will|may) (?:we|you)\s+$/u.test(leader);
    const subject =
      discussesProject.test(clause) ||
      reportedInstruction.test(clause) ||
      (candidateVerb && !polite && (nonDirective.test(leader) || subjectQuestion.test(leader)));
    if (subject || (inList && prior.subject)) {
      prior = { end, subject: true };
      continue;
    }
    const afterLead = after
      .trimStart()
      .replace(/^[),]\s*/u, '')
      .replace(/^(?:(?:as|for|to|should|must|will|is)\s+)?(?:the\s+)?/u, '');
    const beforeRole =
      before.match(/\b(author|reviewer|planner)\s*[:=]\s*$/u)?.[1] ??
      before.match(/\b(author|review|implement|write)\s+(?:it\s+)?(?:by|with|using)\s*$/u)?.[1];
    const role = Object.keys(roleNames).find((key) => roleNames[key].test(beforeRole ?? afterLead));
    const qualifies =
      prior?.assignment?.provider === 'claude' &&
      route.model &&
      /^\s*(?:\(|\/|,?\s*(?:specifically|on|with|using|model))\s*$/u.test(between);
    if (qualifies) {
      if (prior.assignment.model && prior.assignment.model !== route.model) unresolved = true;
      prior.assignment.model = route.model;
      if (role) prior.assignment.role = role;
      prior.end = end;
      continue;
    }
    const actor =
      role &&
      (beforeRole ||
        /^\s*(?:as|for|should|must|will)\s+/u.test(after) ||
        /(?:^|[.;!?\n,:]|\b(?:and|then|want|like))\s*$/u.test(before));
    const preferred =
      /\b(?:i want|i'd like|i would like|we'd like|we want)\s+$/u.test(clause) ||
      /^\s+for (?:this|that|the) (?:one|task|job|request|edit|change)\b/u.test(after);
    if (
      !verb &&
      !delegateTo.test(clause) &&
      !addressed.test(clause) &&
      !actor &&
      !preferred &&
      !(inList && prior.assignment)
    ) {
      const about =
        projectSubject.test(after) ||
        /\b(?:investigate|debug|inspect|document|compare|diagnose|support for|interoperability with)\s+(?:the\s+)?$/u.test(
          clause
        );
      if (!about) unresolved = true;
      prior = { end, subject: about };
      continue;
    }
    const both = /^\s+(?:for|as)\s+(?:both\s+)?(?:author and reviewer|reviewer and author)\b/u.test(
      after
    );
    const assignment = { ...route, role: both ? 'both' : (role ?? 'worker') };
    chosen.push(assignment);
    prior = { end, assignment };
  }
  for (const [start, end] of masked.reverse()) text = text.slice(0, start) + ' ' + text.slice(end);
  return { chosen, omit, text, unresolved, onlyModels };
}

const refuse = (reason) => ({ error: reason + ' No work was started.' });

function disallowsCli(text) {
  const clauses = text.split(/[.!?;\n]|\bbut\b/u);
  for (const clause of clauses) {
    if (!/\b(?:cli|command[- ]line|terminal|fall\s*back)\b/u.test(clause)) continue;
    if (
      /\b(?:ask|confirm|check with me|permission|approval)\b/u.test(clause) ||
      /\b(?:do not|don't|never|without|no|not|avoid)\b[^,;]{0,80}\b(?:cli|command[- ]line|terminal|fall\s*back)\b/u.test(
        clause
      )
    )
      return true;
  }
  if (/\b(?:desktop|app(?: sessions?)?)\s*(?:only|exclusively)\b/u.test(text)) return true;
  if (
    !/\b(?:claude (?:desktop|(?:code )?app)|desktop (?:app|code|session)|app[- ]first)\b/u.test(
      text
    )
  )
    return false;
  const allowsCli =
    /\b(?:cli|command[- ]line)\s+(?:is\s+)?(?:fine|ok(?:ay)?|allowed|as (?:a )?fallback)\b|\bfall\s*back to (?:the )?(?:cli|command[- ]line)\b|\b(?:use|allow) (?:the )?(?:cli|command[- ]line)\b/u;
  return !allowsCli.test(text);
}

function resolveRoutes(kind, { chosen, omit, text, unresolved, onlyModels }, mode) {
  if (
    /\b(?:switch|reassign|reroute|move|take over)\b[^.!?;\n]{0,100}\b(?:running|active|current|existing|in[- ]flight)\s+(?:job|task|work|attempt)\b/u.test(
      text
    )
  )
    return refuse(
      'The existing task remains pinned to its provider. Specify a distinct new task if you want another provider to do new work.'
    );
  if (unresolved)
    return refuse(
      'The provider assignment is unclear. Specify who should do this work and, for changes, who should review it.'
    );
  if (chosen.some((r) => r.provider === 'unsupported'))
    return refuse(
      'That provider or model is unavailable. Choose Codex, Claude Fable 5.2, or Claude Opus 4.6.'
    );
  if (omit.some((r) => r.provider === 'codex'))
    return refuse('This workflow requires Codex for planning or an independent development role.');
  if (chosen.some((r) => r.provider === 'claude' && r.role === 'planner'))
    return refuse('The project planner uses Codex. Claude can be the worker, author, or reviewer.');
  const workers = chosen.filter((r) => r.role !== 'planner');
  const models = new Set(workers.map((r) => r.model).filter(Boolean));
  if (models.size > 1)
    return refuse('One goal can pin only one Claude model. Split the work or choose one model.');
  const needsClaude = workers.some((r) => r.provider === 'claude');
  const [requestedModel] = models;
  if (needsClaude && requestedModel && onlyModels.size && !onlyModels.has(requestedModel))
    return refuse('The requested Claude model conflicts with your stated model access.');
  const claudeModel =
    requestedModel ?? (needsClaude && onlyModels.size === 1 ? [...onlyModels][0] : undefined);
  const specificModel = claudeModel ? { claudeModel } : {};
  if (needsClaude && mode === 'codex-only')
    return refuse(
      'Claude is unavailable in this Codex-only session. Choose a mixed session or request Codex for this task.'
    );
  if (needsClaude && disallowsCli(text))
    return refuse(
      'A verified Claude Desktop work session is unavailable. The installed Claude CLI requires your permission under this request.'
    );
  if (
    needsClaude &&
    omit.some(
      (r) =>
        r.provider === 'claude' && (!r.model || r.model === (claudeModel ?? defaultClaudeModel))
    )
  )
    return refuse(
      'The requested Claude route is also excluded. Specify the provider and model to use.'
    );
  if (kind === 'plan') {
    const providers = new Set(workers.map((r) => r.provider));
    if (providers.size > 1 || workers.some((r) => r.role === 'both'))
      return refuse(
        'This text-work delegation needs one worker provider. Split distinct assignments or request a reviewed file change.'
      );
    return { workerProvider: needsClaude ? 'claude' : 'codex', ...specificModel };
  }
  const author = new Set(),
    reviewer = new Set();
  for (const worker of workers) {
    if (worker.role !== 'reviewer') author.add(worker.provider);
    if (worker.role === 'reviewer' || worker.role === 'both') reviewer.add(worker.provider);
  }
  if (author.size > 1 || reviewer.size > 1)
    return refuse(
      'The author or reviewer has conflicting provider assignments. Specify one provider per role.'
    );
  const authorProvider = [...author][0] ?? 'codex',
    reviewerProvider = [...reviewer][0] ?? 'codex';
  if (authorProvider === 'claude' && reviewerProvider === 'claude')
    return refuse(
      'A Claude development role requires an independent Codex counterpart. Choose which provider should author and which should review.'
    );
  return { authorProvider, reviewerProvider, ...specificModel };
}

export function projectChatProviders(ownerText, mode = 'mixed') {
  const intent = assignments(ownerText);
  return {
    textWithoutExclusions: intent.text,
    grants: {
      version: 1,
      defaultClaudeModel,
      plan: resolveRoutes('plan', intent, mode),
      develop: resolveRoutes('develop', intent, mode)
    }
  };
}
