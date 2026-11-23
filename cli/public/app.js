const $ = (id) => document.getElementById(id);
const activeStatuses = new Set(['starting', 'running', 'waiting_for_input', 'interrupting']);
const terminalStatuses = new Set([
  'completed',
  'failed',
  'interrupted',
  'recovery_needed',
  'blocked'
]);
const labels = {
  waiting_for_input: 'Needs input',
  recovery_needed: 'Recovery needed',
  queued: 'Queued',
  starting: 'Starting',
  running: 'Running',
  interrupting: 'Interrupting',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  blocked: 'Blocked',
  ready: 'Ready',
  stopped: 'Stopped',
  error: 'Error'
};
let state = null;
let selectedId = null;
let selectedDetail = null;
let filter = 'all';
let source = null;
let detailTimer = null;
let detailLoading = false;
let detailAgain = false;
let taskSignature = '';
let approvalSignature = '';
let activitySignature = '';
let dependencySignature = '';
let modelsSignature = '';
let connected = false;
let selectionVersion = 0;
let stateVersion = 0;
const pendingApprovals = new Set();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function clear(node) {
  node.replaceChildren();
}
function statusPill(status) {
  return el('span', `status-pill ${status || ''}`, labels[status] || status || 'Unknown');
}
function pretty(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
function shortId(value) {
  return value ? String(value).slice(0, 8) : '';
}
function timeLabel(value, full = false) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return full
    ? date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function showError(error) {
  $('global-error').textContent = error?.message || String(error);
  $('global-error').hidden = false;
}
function clearError() {
  $('global-error').hidden = true;
}
async function api(path, body) {
  const options =
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state?.csrfToken || '' },
          body: JSON.stringify(body)
        };
  const response = await fetch(path, options);
  const result = await response
    .json()
    .catch(() => ({ error: `Server returned ${response.status}` }));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
async function withButton(button, callback) {
  button.disabled = true;
  try {
    return await callback();
  } finally {
    button.disabled = false;
  }
}
function applyState(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.tasks)) return;
  state = snapshot;
  stateVersion += 1;
  $('workspace-path').textContent = snapshot.config?.workspaceRoot || 'Workspace unavailable';
  $('workspace-path').title = snapshot.config?.workspaceRoot || '';
  const runtime = snapshot.runtime || {};
  $('runtime-status').className = `status-pill ${runtime.status || 'stopped'}`;
  $('runtime-status').textContent =
    `Runtime ${labels[runtime.status]?.toLowerCase() || runtime.status || 'unavailable'}`;
  $('runtime-status').title = runtime.error || '';
  $('runtime-error').hidden = !runtime.error;
  $('runtime-error').textContent = runtime.error ? `Codex runtime: ${runtime.error}` : '';
  $('reconnect').disabled = snapshot.tasks.some((task) => activeStatuses.has(task.status));
  $('reconnect').title = $('reconnect').disabled
    ? 'Interrupt active assignments before reconnecting the runtime.'
    : 'Reconnect the Codex app server';
  $('queue-label').textContent = snapshot.paused ? 'Queue paused' : 'Queue running';
  $('queue-indicator').className = snapshot.paused ? 'dot' : 'dot lime';
  $('toggle-queue').textContent = snapshot.paused ? 'Resume' : 'Pause';
  $('task-count').textContent = snapshot.tasks.length;
  if (!$('task-cwd').value && !$('new-task-dialog').open)
    $('task-cwd').value = snapshot.config?.workspaceRoot || '';
  renderModels();
  renderTasks();
  renderDependencies();
  if (selectedId) {
    const task = snapshot.tasks.find((item) => item.id === selectedId);
    if (task) renderTask(task);
    renderApprovals();
    scheduleDetail();
  }
}
function renderModels() {
  const models = state?.runtime?.models || [];
  const signature = pretty(models);
  if (signature === modelsSignature) return;
  modelsSignature = signature;
  const select = $('task-model');
  const previous = select.value;
  select.replaceChildren(new Option('Runtime default', ''));
  for (const model of models) {
    const id = typeof model === 'string' ? model : model.id || model.model;
    if (!id) continue;
    select.add(
      new Option(typeof model === 'string' ? model : model.displayName || model.name || id, id)
    );
  }
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}
function matchingTasks() {
  return (state?.tasks || [])
    .filter(
      (task) =>
        filter === 'all' ||
        (filter === 'active' && (activeStatuses.has(task.status) || task.status === 'queued')) ||
        (filter === 'attention' &&
          ['waiting_for_input', 'recovery_needed', 'failed', 'blocked'].includes(task.status)) ||
        (filter === 'done' && ['completed', 'interrupted'].includes(task.status))
    )
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
function renderTasks(force = false) {
  const tasks = matchingTasks();
  const signature = pretty(tasks) + selectedId + filter;
  if (!force && signature === taskSignature) return;
  taskSignature = signature;
  const list = $('task-list');
  const scrollTop = list.scrollTop;
  const scrollLeft = list.scrollLeft;
  clear(list);
  if (!tasks.length) {
    list.append(
      el(
        'div',
        'list-empty',
        state?.tasks.length
          ? 'No assignments in this view.'
          : 'Your queue is clear.\nCreate an assignment to get started.'
      )
    );
    return;
  }
  for (const task of tasks) {
    const card = el('button', `task-card${task.id === selectedId ? ' selected' : ''}`);
    card.type = 'button';
    card.setAttribute('aria-pressed', String(task.id === selectedId));
    const top = el('div', 'task-card-top');
    top.append(el('h3', '', task.title || 'Untitled assignment'));
    const description = el('p', 'task-description', task.prompt);
    const bottom = el('div', 'task-card-bottom');
    const time = el('time', '', timeLabel(task.createdAt, true));
    time.dateTime = task.createdAt || '';
    bottom.append(statusPill(task.status), time);
    card.append(top, description, bottom);
    card.addEventListener('click', () => selectTask(task.id));
    list.append(card);
  }
  list.scrollTop = scrollTop;
  list.scrollLeft = scrollLeft;
}
function renderDependencies() {
  const tasks = state?.tasks || [];
  const signature = pretty(tasks.map(({ id, title, status }) => ({ id, title, status })));
  if (signature === dependencySignature) return;
  dependencySignature = signature;
  const target = $('dependency-options');
  const checked = new Set([...target.querySelectorAll('input:checked')].map((node) => node.value));
  clear(target);
  if (!tasks.length) {
    target.append(el('p', 'field-help', 'No assignments available yet.'));
    return;
  }
  for (const task of tasks) {
    const label = el('label', 'dependency-option');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.value = task.id;
    checkbox.checked = checked.has(task.id);
    label.append(checkbox, el('span', '', `${task.title} · ${labels[task.status] || task.status}`));
    target.append(label);
  }
}
function selectTask(id) {
  selectedId = id;
  selectedDetail = null;
  selectionVersion += 1;
  activitySignature = '';
  approvalSignature = '';
  $('continue-prompt').value = '';
  $('continue-error').hidden = true;
  $('empty-detail').hidden = true;
  $('task-detail').hidden = false;
  const task = state?.tasks.find((item) => item.id === id);
  if (task) renderTask(task);
  renderTasks(true);
  renderApprovals();
  $('activity-list').replaceChildren(el('p', 'activity-empty', 'Loading activity…'));
  clearTimeout(detailTimer);
  fetchDetail();
}
function renderTask(task) {
  $('detail-title').textContent = task.title || 'Untitled assignment';
  $('detail-id').textContent = shortId(task.id);
  $('detail-id').title = task.id;
  $('detail-status').className = `status-pill ${task.status}`;
  $('detail-status').textContent = labels[task.status] || task.status;
  const metadata = [
    task.cwd,
    task.model || 'Runtime default',
    task.sandbox === 'workspace-write' ? 'Workspace write' : 'Read-only'
  ];
  const meta = $('detail-meta');
  if (meta.dataset.signature !== pretty(metadata)) {
    meta.dataset.signature = pretty(metadata);
    meta.replaceChildren(...metadata.map((text) => el('span', '', text)));
  }
  $('detail-time').textContent = `Created ${timeLabel(task.createdAt, true)}`;
  $('detail-prompt').textContent = task.prompt || '';
  $('task-error').hidden = !task.error;
  $('task-error').textContent = task.error || '';
  const output =
    typeof task.output === 'string' ? task.output : task.output ? pretty(task.output) : '';
  const outputElement = $('task-output');
  if (outputElement.textContent !== output) {
    const atBottom =
      outputElement.scrollTop + outputElement.clientHeight >= outputElement.scrollHeight - 35;
    const previous = outputElement.scrollTop;
    outputElement.textContent = output;
    outputElement.scrollTop = atBottom ? outputElement.scrollHeight : previous;
  }
  outputElement.hidden = !output;
  $('output-empty').hidden = !!output;
  $('output-label').textContent = activeStatuses.has(task.status)
    ? 'Runtime output'
    : task.status === 'completed'
      ? 'Turn completed'
      : '';
  $('interrupt').hidden = !(
    task.canInterrupt ?? ['starting', 'running', 'waiting_for_input'].includes(task.status)
  );
  $('continue-form').hidden = !(
    task.canContinue ??
    (task.threadId && terminalStatuses.has(task.status))
  );
  const thread = $('thread-info');
  if (thread.dataset.thread !== (task.threadId || '')) {
    thread.dataset.thread = task.threadId || '';
    thread.replaceChildren(
      el('div', '', 'CODEX THREAD'),
      el('span', '', task.threadId || 'Created when the assignment starts.')
    );
  }
}
function scheduleDetail() {
  if (detailTimer || !selectedId) return;
  detailTimer = setTimeout(() => {
    detailTimer = null;
    fetchDetail();
  }, 550);
}
async function fetchDetail() {
  if (!selectedId) return;
  if (detailLoading) {
    detailAgain = true;
    return;
  }
  const id = selectedId;
  const version = selectionVersion;
  const snapshotVersion = stateVersion;
  detailLoading = true;
  try {
    const detail = await api(`/api/tasks/${encodeURIComponent(id)}`);
    if (id !== selectedId || version !== selectionVersion) return;
    selectedDetail = detail;
    // A state snapshot arriving during this request is newer than its task payload.
    renderTask(
      snapshotVersion === stateVersion
        ? detail.task
        : state.tasks.find((task) => task.id === id) || detail.task
    );
    renderActivity(detail.events || []);
  } catch (error) {
    if (id === selectedId) {
      $('activity-list').replaceChildren(el('p', 'form-error', error.message));
    }
  } finally {
    detailLoading = false;
    if (detailAgain) {
      detailAgain = false;
      scheduleDetail();
    }
  }
}
function eventLabel(type) {
  const common = {
    created: 'Assignment created',
    queued: 'Added to queue',
    starting: 'Starting Codex',
    running: 'Turn started',
    completed: 'Turn completed',
    failed: 'Task failed',
    interrupted: 'Task interrupted',
    recovery_needed: 'Recovery required',
    approval: 'Approval requested',
    approval_resolved: 'Request answered'
  };
  return (
    common[type] ||
    String(type)
      .replaceAll(/[._/]/g, ' ')
      .replace(/^\w/, (letter) => letter.toUpperCase())
  );
}
function renderActivity(events) {
  const signature = pretty(events);
  if (signature === activitySignature) return;
  activitySignature = signature;
  const list = $('activity-list');
  const scroll = list.scrollTop;
  clear(list);
  $('activity-count').textContent = events.length;
  if (!events.length) list.append(el('p', 'activity-empty', 'No activity recorded yet.'));
  // Keep the view useful when a runtime emits many token notifications.
  for (const event of events.slice(-80).reverse()) {
    const item = el('div', 'activity-item');
    const time = el('time', '', timeLabel(event.createdAt, true));
    time.dateTime = event.createdAt || '';
    item.append(el('div', 'activity-item-title', eventLabel(event.type)), time);
    if (event.payload !== undefined && event.payload !== null) {
      const details = el('details');
      details.append(el('summary', '', 'View event'), el('pre', '', pretty(event.payload)));
      item.append(details);
    }
    list.append(item);
  }
  list.scrollTop = scroll;
}
function renderApprovals() {
  const approvals = (state?.approvals || []).filter((approval) => approval.taskId === selectedId);
  const signature = pretty(approvals);
  if (signature === approvalSignature) return;
  approvalSignature = signature;
  const target = $('approvals');
  // Retain existing request nodes and their typed answers across snapshots.
  const existing = new Map([...target.children].map((node) => [node.dataset.approval, node]));
  for (const approval of approvals) {
    const node = existing.get(approval.id) || createApproval(approval);
    target.append(node);
    existing.delete(approval.id);
  }
  for (const node of existing.values()) node.remove();
}
function createApproval(approval) {
  const card = el('form', 'approval-card');
  card.dataset.approval = approval.id;
  const params = approval.params || {};
  const method = approval.method || '';
  const isQuestion = method === 'item/tool/requestUserInput';
  const canAccept =
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval';
  const heading = el('div', 'approval-heading');
  heading.append(
    el(
      'h3',
      '',
      isQuestion ? 'Your input is needed' : canAccept ? 'Approval requested' : 'Unsupported request'
    ),
    el('span', 'eyebrow', 'REVIEW')
  );
  card.append(heading);
  const description = isQuestion
    ? Array.isArray(params.questions) && params.questions.length
      ? 'Answer the questions below to let Codex continue. You can also interrupt the task.'
      : 'This request contains no supported questions. Interrupt the task to stop it.'
    : canAccept
      ? method.includes('fileChange')
        ? 'Codex is asking to change files. Review the request before allowing it.'
        : 'Codex is asking to run a command. Review the request before allowing it.'
      : 'This request cannot be approved in this version. Decline it to respond to the runtime.';
  card.append(el('p', '', description));
  if (params.reason) card.append(el('p', '', params.reason));
  const questionFields = [];
  if (isQuestion && Array.isArray(params.questions)) {
    for (const question of params.questions) {
      const group = el('div', 'question');
      if (question.header) group.append(el('span', 'eyebrow', question.header));
      group.append(el('p', '', question.question || question.id));
      const radios = [];
      if (Array.isArray(question.options) && question.options.length) {
        const options = el('div', 'question-options');
        question.options.forEach((option, index) => {
          const label = el('label', 'question-option');
          const radio = el('input');
          radio.type = 'radio';
          radio.name = `${approval.id}-${question.id}`;
          radio.value = option.label || '';
          radio.required = !question.isOther;
          const text = el('span');
          text.append(el('strong', '', option.label));
          if (option.description) text.append(el('small', '', option.description));
          label.append(radio, text);
          options.append(label);
          radios.push(radio);
        });
        group.append(options);
      }
      let input = null;
      if (!radios.length || question.isOther) {
        const label = el('label', '', radios.length ? 'Or write your own answer' : 'Your answer');
        input = el(question.isSecret ? 'input' : 'textarea');
        if (question.isSecret) input.type = 'password';
        else input.rows = 2;
        input.required = !radios.length;
        input.setAttribute('aria-label', question.question || question.id || 'Your answer');
        if (radios.length) {
          input.addEventListener('input', () => {
            if (input.value.trim())
              radios.forEach((radio) => {
                radio.checked = false;
                radio.required = false;
              });
          });
          radios.forEach((radio) =>
            radio.addEventListener('change', () => {
              input.value = '';
            })
          );
        }
        group.append(label, input);
      }
      questionFields.push({ id: question.id, radios, input });
      card.append(group);
    }
  } else {
    card.append(el('pre', '', pretty(params)));
  }
  const error = el('p', 'form-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const actions = el('div', 'approval-actions');
  const decline = el(
    'button',
    `button button-small${isQuestion ? ' button-danger' : ''}`,
    isQuestion ? 'Interrupt task' : 'Decline'
  );
  decline.type = 'button';
  const submit = el(
    'button',
    'button button-primary button-small',
    isQuestion ? 'Send answers' : 'Allow once'
  );
  submit.type = 'submit';
  actions.append(decline);
  if (canAccept || (isQuestion && questionFields.length)) actions.append(submit);
  card.append(error, actions);
  async function respond(body, interrupt = false) {
    if (pendingApprovals.has(approval.id)) return;
    pendingApprovals.add(approval.id);
    decline.disabled = true;
    submit.disabled = true;
    error.hidden = true;
    try {
      const path = interrupt
        ? `/api/tasks/${encodeURIComponent(approval.taskId)}/interrupt`
        : `/api/approvals/${encodeURIComponent(approval.id)}`;
      await api(path, body);
      await refreshState();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      pendingApprovals.delete(approval.id);
      decline.disabled = false;
      submit.disabled = false;
    }
  }
  decline.addEventListener('click', () =>
    isQuestion ? respond({}, true) : respond({ decision: 'decline' })
  );
  card.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!isQuestion) {
      respond({ decision: 'accept' });
      return;
    }
    const answers = {};
    for (const field of questionFields) {
      const answer =
        field.input?.value.trim() || field.radios.find((radio) => radio.checked)?.value;
      if (!answer) {
        error.textContent = 'Please answer each question before continuing.';
        error.hidden = false;
        return;
      }
      answers[field.id] = { answers: [answer] };
    }
    if (!questionFields.length) {
      error.textContent = 'No supported questions were provided. Interrupt the task to stop it.';
      error.hidden = false;
      return;
    }
    respond({ answers });
  });
  return card;
}
async function refreshState() {
  applyState(await api('/api/state'));
}
function openNewTask() {
  if (!state) {
    showError(new Error('The workspace is still connecting. Try again in a moment.'));
    return;
  }
  $('new-task-error').hidden = true;
  $('new-task-dialog').showModal();
  $('task-title').focus();
}
for (const button of document.querySelectorAll('[data-new-task]'))
  button.addEventListener('click', openNewTask);
$('close-dialog').addEventListener('click', () => $('new-task-dialog').close());
$('new-task-dialog').addEventListener('click', (event) => {
  if (event.target === $('new-task-dialog')) {
    const rect = $('new-task-dialog').getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      $('new-task-dialog').close();
  }
});
document.addEventListener('keydown', (event) => {
  if (
    event.key.toLowerCase() === 'n' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) &&
    !$('new-task-dialog').open
  ) {
    event.preventDefault();
    openNewTask();
  }
});
for (const button of document.querySelectorAll('[data-filter]'))
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    for (const filterButton of document.querySelectorAll('[data-filter]')) {
      filterButton.classList.toggle('active', filterButton === button);
      filterButton.setAttribute('aria-pressed', String(filterButton === button));
    }
    renderTasks(true);
  });
$('new-task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {
    title: $('task-title').value.trim(),
    prompt: $('task-prompt').value.trim(),
    sandbox: $('task-sandbox').value,
    dependsOn: [...$('dependency-options').querySelectorAll('input:checked')].map(
      (input) => input.value
    )
  };
  if (!body.title || !body.prompt) {
    $('new-task-error').textContent = 'Add a title and a task description.';
    $('new-task-error').hidden = false;
    return;
  }
  if ($('task-cwd').value.trim()) body.cwd = $('task-cwd').value.trim();
  if ($('task-model').value) body.model = $('task-model').value;
  await withButton($('create-task'), async () => {
    $('new-task-error').hidden = true;
    try {
      const result = await api('/api/tasks', body);
      $('new-task-dialog').close();
      $('task-title').value = '';
      $('task-prompt').value = '';
      for (const input of $('dependency-options').querySelectorAll('input')) input.checked = false;
      await refreshState();
      selectTask(result.task.id);
      clearError();
    } catch (error) {
      $('new-task-error').textContent = error.message;
      $('new-task-error').hidden = false;
    }
  });
});
$('toggle-queue').addEventListener('click', () =>
  withButton($('toggle-queue'), async () => {
    if (!state) return;
    try {
      await api('/api/control', { paused: !state.paused });
      await refreshState();
      clearError();
    } catch (error) {
      showError(error);
    }
  })
);
$('reconnect').addEventListener('click', () =>
  withButton($('reconnect'), async () => {
    try {
      await api('/api/runtime/reconnect', {});
      await refreshState();
      clearError();
    } catch (error) {
      showError(error);
    }
  })
);
$('interrupt').addEventListener('click', () =>
  withButton($('interrupt'), async () => {
    try {
      await api(`/api/tasks/${encodeURIComponent(selectedId)}/interrupt`, {});
      await refreshState();
      clearError();
    } catch (error) {
      showError(error);
    }
  })
);
$('continue-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = $('continue-prompt').value.trim();
  if (!prompt) return;
  const button = $('continue-form').querySelector('button');
  await withButton(button, async () => {
    $('continue-error').hidden = true;
    try {
      const result = await api(`/api/tasks/${encodeURIComponent(selectedId)}/continue`, { prompt });
      await refreshState();
      selectTask(result.task.id);
      clearError();
    } catch (error) {
      $('continue-error').textContent = error.message;
      $('continue-error').hidden = false;
    }
  });
});
function connectEvents() {
  source?.close();
  source = new EventSource('/api/events');
  source.addEventListener('open', () => {
    connected = true;
    $('connection-status').textContent = 'Connected';
    $('connection-status').className = 'connection-status online';
  });
  source.addEventListener('state', (event) => {
    try {
      applyState(JSON.parse(event.data));
    } catch {
      showError(new Error('An invalid state update was received. Reconnecting may resolve this.'));
    }
  });
  source.addEventListener('error', () => {
    connected = false;
    $('connection-status').textContent = 'Reconnecting…';
    $('connection-status').className = 'connection-status';
  });
}
async function start() {
  try {
    await refreshState();
    clearError();
    connectEvents();
  } catch (error) {
    showError(error);
    $('connection-status').textContent = 'Connection failed';
    $('task-list').replaceChildren(
      el(
        'div',
        'list-empty',
        'Could not load the workspace. Check that the local server is running.'
      )
    );
    setTimeout(start, 5000);
  }
}
start();
