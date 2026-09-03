const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const app = {
  state: null,
  workspaceId: null,
  sessionId: null,
  runId: null,
  runStatus: 'idle',
  runStartedAt: null,
  sessions: [],
  messages: [],
  tools: [],
  skills: [],
  mcp: [],
  automations: [],
  plugins: [],
  bridges: [],
  browserInstances: [],
  garage: 'automations',
  tree: [],
  events: [],
  currentView: 'cockpit',
  catalog: 'tools',
  terminalHistory: [],
  terminalIndex: 0,
  eventSource: null,
  pollTimer: null,
};

async function api(path, options = {}) {
  const init = { ...options, headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } };
  if (init.body !== undefined && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
  const response = await fetch(path, init);
  if (response.status === 204) return null;
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(data?.error || data || `HTTP ${response.status}`);
  return data;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

function proseMarkdown(value) {
  let text = escapeHtml(value);
  text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = text.split('\n');
  const output = [];
  let list = null;
  const closeList = () => { if (list) { output.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    const unordered = line.match(/^\s*[-*] (.+)$/);
    const ordered = line.match(/^\s*\d+\. (.+)$/);
    if (unordered) {
      if (list !== 'ul') { closeList(); output.push('<ul>'); list = 'ul'; }
      output.push(`<li>${unordered[1]}</li>`); continue;
    }
    if (ordered) {
      if (list !== 'ol') { closeList(); output.push('<ol>'); list = 'ol'; }
      output.push(`<li>${ordered[1]}</li>`); continue;
    }
    closeList();
    if (/^<h[1-3]>/.test(line)) output.push(line);
    else if (!line.trim()) output.push('');
    else output.push(`<p>${line}</p>`);
  }
  closeList();
  return output.join('\n');
}

function renderMarkdown(value = '') {
  const parts = String(value).split(/```/);
  return parts.map((part, index) => {
    if (index % 2 === 0) return proseMarkdown(part);
    const firstNewline = part.indexOf('\n');
    const code = firstNewline >= 0 ? part.slice(firstNewline + 1) : part;
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }).join('');
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const delta = Date.now() - date.getTime();
  const distance = Math.abs(delta);
  if (distance < 60_000) return 'NOW';
  if (delta < 0) {
    if (distance < 3_600_000) return `IN ${Math.ceil(distance / 60_000)}M`;
    if (distance < 86_400_000) return `IN ${Math.ceil(distance / 3_600_000)}H`;
  } else {
    if (distance < 3_600_000) return `${Math.floor(distance / 60_000)}M`;
    if (distance < 86_400_000) return `${Math.floor(distance / 3_600_000)}H`;
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
}

function duration(ms) {
  if (!Number.isFinite(ms)) return '00:00';
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  $('#toastStack').append(node);
  setTimeout(() => node.remove(), 4600);
}

function setCoreStatus(text, mode = 'ok') {
  const node = $('#coreStatus');
  node.textContent = text;
  if (mode === 'ok') delete node.dataset.mode;
  else node.dataset.mode = mode;
}

function populateWorkspaces() {
  const select = $('#workspaceSelect');
  select.innerHTML = '';
  const workspaces = app.state?.workspaces || [];
  if (!workspaces.length) select.add(new Option('NO TRACK OPEN', ''));
  for (const workspace of workspaces) select.add(new Option(`${workspace.name} — ${workspace.path}`, workspace.id));
  if (app.workspaceId && workspaces.some((item) => item.id === app.workspaceId)) select.value = app.workspaceId;
  $('#terminalCwd').textContent = currentWorkspace()?.path || '~';
}

function currentWorkspace() {
  return app.state?.workspaces?.find((item) => item.id === app.workspaceId) || null;
}

function flattenModels(providers) {
  const options = [];
  for (const provider of providers || []) {
    for (const model of provider.models || []) {
      const id = typeof model === 'string' ? model : model.id;
      if (id) options.push({ ref: `${provider.id}:${id}`, label: `${provider.name || provider.id} / ${id}`, status: provider.status });
    }
  }
  return options;
}

function populateModels(providers = app.state?.providers || []) {
  const select = $('#modelSelect');
  const previous = select.value || app.state?.config?.defaultModel || 'ollama:auto';
  select.innerHTML = '';
  const refs = new Set();
  const add = (ref, label) => { if (!refs.has(ref)) { refs.add(ref); select.add(new Option(label, ref)); } };
  add(app.state?.config?.defaultModel || 'ollama:auto', `AUTO / ${app.state?.config?.defaultModel || 'ollama:auto'}`);
  for (const item of flattenModels(providers)) add(item.ref, item.label);
  for (const provider of providers) add(`${provider.id}:auto`, `${provider.name || provider.id} / AUTO [${provider.status}]`);
  select.value = refs.has(previous) ? previous : (refs.has(app.state?.config?.defaultModel) ? app.state.config.defaultModel : select.options[0]?.value || '');
}

async function refreshProviders() {
  try {
    const providers = await api('/api/providers?discover=true');
    app.state.providers = providers;
    populateModels(providers);
    const online = providers.filter((item) => item.status === 'online').length;
    setCoreStatus(online ? `${online} UP` : 'MODEL? ', online ? 'ok' : 'error');
  } catch (error) {
    setCoreStatus('MODEL ERR', 'error');
    toast(`Provider discovery: ${error.message}`, 'error');
  }
}

function renderSessions() {
  const query = $('#sessionSearch').value.trim().toLowerCase();
  const list = $('#sessionList');
  const filtered = app.sessions.filter((session) => !query || `${session.title} ${session.model_id || ''}`.toLowerCase().includes(query));
  list.innerHTML = filtered.length ? filtered.map((session) => `
    <button class="session-card ${session.id === app.sessionId ? 'active' : ''}" data-session="${escapeHtml(session.id)}">
      <strong>${escapeHtml(session.title || 'Untitled run')}</strong>
      <span><i>${escapeHtml((session.model_id || 'AUTO').split(':').at(-1))}</i><i>${session.status === 'running' ? '● LIVE' : formatDate(session.updated_at)}</i></span>
    </button>`).join('') : '<div class="quiet-card">No runs on this track yet.</div>';
  $$('[data-session]', list).forEach((button) => button.addEventListener('click', () => selectSession(button.dataset.session)));
}

async function refreshSessions(selectNewest = false) {
  if (!app.workspaceId) { app.sessions = []; renderSessions(); return; }
  app.sessions = await api(`/api/sessions?workspaceId=${encodeURIComponent(app.workspaceId)}&limit=300`);
  if (selectNewest && app.sessions[0]) app.sessionId = app.sessions[0].id;
  if (app.sessionId && !app.sessions.some((session) => session.id === app.sessionId)) app.sessionId = app.sessions[0]?.id || null;
  renderSessions();
  if (app.sessionId) await loadMessages();
  else clearSession();
}

function clearSession() {
  app.messages = [];
  app.runId = null;
  app.runStatus = 'idle';
  $('#sessionTitle').textContent = 'MASKSHIFT READY';
  $('#messageList').innerHTML = '';
  $('#emptyState').classList.remove('hidden');
  updateRunUI();
}

async function createSession() {
  if (!app.workspaceId) { $('#workspaceDialog').showModal(); return null; }
  const session = await api('/api/sessions', { method: 'POST', body: { workspaceId: app.workspaceId, title: 'New run', modelRef: $('#modelSelect').value } });
  app.sessionId = session.id;
  await refreshSessions();
  $('#promptInput').focus();
  return session;
}

async function selectSession(sessionId) {
  app.sessionId = sessionId;
  renderSessions();
  const session = app.sessions.find((item) => item.id === sessionId);
  $('#sessionTitle').textContent = session?.title || 'MASKSHIFT RUN';
  await loadMessages();
  const runs = await api(`/api/sessions/${encodeURIComponent(sessionId)}/runs?limit=1`);
  if (runs[0]) {
    app.runId = runs[0].id;
    await refreshRunState();
  } else {
    app.runId = null; app.runStatus = 'idle'; updateRunUI();
  }
}

function renderMessages() {
  const list = $('#messageList');
  $('#emptyState').classList.toggle('hidden', app.messages.length > 0);
  list.innerHTML = app.messages.map((message) => {
    const time = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (message.role === 'tool') {
      const name = message.meta?.toolName || 'TOOL RESULT';
      return `<article class="message tool">
        <div class="message-head"><strong>${escapeHtml(name)}</strong><span>${time}${message.meta?.isError ? ' / ERROR' : ''}</span></div>
        <details><summary>${message.meta?.isError ? 'INSPECT FAILURE' : 'INSPECT OUTPUT'}</summary><pre>${escapeHtml(message.content || '')}</pre></details>
      </article>`;
    }
    const calls = message.meta?.toolCalls || [];
    const body = message.content ? `<div class="message-body">${renderMarkdown(message.content)}</div>` : '';
    return `<article class="message ${message.role}">
      <div class="message-head"><strong>${message.role === 'user' ? 'DRIVER' : 'MASKSHIFT'}</strong><span>${time}${message.meta?.modelRef ? ` / ${escapeHtml(message.meta.modelRef)}` : ''}</span></div>
      ${body}
      ${calls.length ? `<div class="message-body tool-call-badges">${calls.map((call) => `<span>↯ ${escapeHtml(call.name)}</span>`).join('')}</div>` : ''}
    </article>`;
  }).join('');
  requestAnimationFrame(() => { $('#chatViewport').scrollTop = $('#chatViewport').scrollHeight; });
}

async function loadMessages() {
  if (!app.sessionId) return;
  app.messages = await api(`/api/sessions/${encodeURIComponent(app.sessionId)}/messages?limit=2000`);
  const session = app.sessions.find((item) => item.id === app.sessionId);
  $('#sessionTitle').textContent = session?.title || 'MASKSHIFT RUN';
  renderMessages();
}

function updateRunUI(run = null) {
  const status = run?.status || app.runStatus || 'idle';
  app.runStatus = status;
  const live = ['queued', 'running'].includes(status);
  $('#runLamp').className = `status-lamp ${status}`;
  $('#runStatusLabel').textContent = live ? `OVERDRIVE / ${status.toUpperCase()}` : status === 'completed' ? 'FINISH / VERIFIED' : status.toUpperCase();
  $('#stepMetric').textContent = String(run?.step_count || 0).padStart(2, '0');
  $('#stopRunButton').disabled = !live;
  $('#launchButton').disabled = live;
  $('#launchButton span').textContent = live ? 'RUNNING' : 'ENGAGE';
  if (live && !app.runStartedAt) app.runStartedAt = new Date(run?.started_at || Date.now()).getTime();
  if (!live && run) app.runStartedAt = null;
}

function renderPlan(plan) {
  const steps = plan?.steps || [];
  const done = steps.filter((step) => step.status === 'completed').length;
  $('#planProgress').textContent = `${done}/${steps.length}`;
  $('#planList').innerHTML = steps.length ? steps.map((step, index) => `
    <div class="plan-step ${escapeHtml(step.status)}"><b>${step.status === 'completed' ? '✓' : String(index + 1).padStart(2, '0')}</b><div><strong>${escapeHtml(step.text)}</strong>${step.detail ? `<small>${escapeHtml(step.detail)}</small>` : ''}</div></div>
  `).join('') : '<div class="quiet-card">No plan yet. Multi-stage runs will publish one here.</div>';
}

function renderCapabilitiesSnapshot(snapshot) {
  const tools = snapshot?.tools || [];
  const skills = snapshot?.skills || [];
  const mcp = snapshot?.mcpServers || [];
  $('#activeToolsMetric').textContent = tools.length || '—';
  $('#activeSkillsMetric').textContent = skills.length || '—';
  $('#activeMcpMetric').textContent = mcp.length || '—';
  const list = $('#activeCapabilityList');
  list.innerHTML = [
    ...skills.map((name) => `<div class="telemetry-item skill">SKILL / ${escapeHtml(name)}</div>`),
    ...mcp.map((name) => `<div class="telemetry-item mcp">MCP / ${escapeHtml(name)}</div>`),
    ...tools.slice(0, 40).map((name) => `<div class="telemetry-item">TOOL / ${escapeHtml(name)}</div>`),
  ].join('') || '<div class="quiet-card">Loadout appears when a run starts.</div>';
}

async function refreshRunState() {
  if (!app.runId) return;
  try {
    const run = await api(`/api/runs/${encodeURIComponent(app.runId)}`);
    updateRunUI(run);
    renderPlan(run.plan || run.meta?.plan);
    renderCapabilitiesSnapshot(run.capabilities || run.meta?.capabilities);
    const children = (app.state?.activeRuns || []).filter((item) => item.meta?.parentRunId === app.runId).length;
    $('#subagentMetric').textContent = children;
    if (!['queued', 'running'].includes(run.status)) stopPolling();
  } catch (error) { toast(error.message, 'error'); }
}

function startPolling() {
  stopPolling();
  app.pollTimer = setInterval(async () => {
    await Promise.allSettled([refreshRunState(), loadMessages()]);
  }, 1800);
}
function stopPolling() { if (app.pollTimer) clearInterval(app.pollTimer); app.pollTimer = null; }

async function launchRun(prompt) {
  if (!prompt.trim()) return;
  if (!app.workspaceId) { $('#workspaceDialog').showModal(); return; }
  if (!app.sessionId) await createSession();
  $('#promptInput').value = '';
  resizePrompt();
  try {
    setCoreStatus('IGNITION', 'busy');
    const run = await api('/api/runs', {
      method: 'POST', body: {
        sessionId: app.sessionId, workspaceId: app.workspaceId,
        prompt, modelRef: $('#modelSelect').value || app.state.config.defaultModel,
      },
    });
    app.runId = run.id;
    app.runStatus = run.status;
    app.runStartedAt = new Date(run.started_at).getTime();
    updateRunUI(run);
    await Promise.all([loadMessages(), refreshSessions()]);
    startPolling();
  } catch (error) {
    setCoreStatus('FAULT', 'error'); toast(error.message, 'error');
  }
}

async function stopRun() {
  if (!app.runId) return;
  try { await api(`/api/runs/${encodeURIComponent(app.runId)}/cancel`, { method: 'POST', body: {} }); toast('Abort signal sent to run.', 'error'); }
  catch (error) { toast(error.message, 'error'); }
}

function resizePrompt() {
  const input = $('#promptInput');
  input.style.height = 'auto';
  input.style.height = `${Math.min(240, Math.max(76, input.scrollHeight))}px`;
  const length = input.value.length;
  $('#promptLines').textContent = String(input.value.split('\n').length).padStart(2, '0');
  $('#composerMeter').style.width = `${Math.min(100, 3 + length / 35)}%`;
}

function switchView(name) {
  app.currentView = name;
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `${name}View`));
  $$('.nav-tab').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  if (name === 'files') void refreshTree();
  if (name === 'capabilities') void refreshCapabilities();
  if (name === 'mcp') void refreshMcp();
  if (name === 'garage') void refreshGarage();
}

async function refreshWorkspaceInspection() {
  if (!app.workspaceId) return;
  try {
    const [inspection, index] = await Promise.all([
      api(`/api/workspaces/${encodeURIComponent(app.workspaceId)}/inspect`),
      api(`/api/workspaces/${encodeURIComponent(app.workspaceId)}/index`),
    ]);
    $('#gitStatus').textContent = inspection.git?.status || 'NOT A GIT REPOSITORY';
    $('#branchMetric').textContent = inspection.git?.status?.split('\n')[0]?.replace(/^##\s*/, '').slice(0, 16) || '—';
    $('#indexMetric').textContent = index?.files ? `${index.files}F` : 'EMPTY';
  } catch (error) { $('#gitStatus').textContent = error.message; }
}

async function refreshTree() {
  if (!app.workspaceId) return;
  try {
    const data = await api(`/api/workspaces/${encodeURIComponent(app.workspaceId)}/tree?depth=12&limit=20000`);
    app.tree = data.entries || [];
    renderTree();
  } catch (error) { toast(error.message, 'error'); }
}

function renderTree() {
  const query = $('#fileSearch').value.trim().toLowerCase();
  const rows = app.tree.filter((item) => !query || item.path.toLowerCase().includes(query)).slice(0, 10000);
  $('#fileTree').innerHTML = rows.map((item) => `<button class="file-row ${item.type}" data-file="${escapeHtml(item.path)}" data-type="${item.type}" style="padding-left:${7 + Math.min(14, item.depth || 0) * 10}px"><span>${item.type === 'directory' ? '▸' : '·'}</span><span>${escapeHtml(item.name)}</span></button>`).join('');
  $$('.file-row[data-type="file"]', $('#fileTree')).forEach((button) => button.addEventListener('click', () => previewFile(button.dataset.file)));
}

async function previewFile(file) {
  try {
    const data = await api(`/api/workspaces/${encodeURIComponent(app.workspaceId)}/file?path=${encodeURIComponent(file)}&lineNumbers=false`);
    $('#previewPath').textContent = file;
    $('#filePreview code').textContent = data.content;
  } catch (error) { toast(error.message, 'error'); }
}

async function refreshCapabilities() {
  try {
    [app.tools, app.skills] = await Promise.all([api('/api/tools'), api('/api/skills')]);
    renderCapabilityCatalog();
  } catch (error) { toast(error.message, 'error'); }
}

function renderCapabilityCatalog() {
  const query = $('#capabilitySearch').value.trim().toLowerCase();
  const values = app.catalog === 'tools' ? app.tools : app.skills;
  const filtered = values.filter((item) => !query || `${item.name} ${item.description || ''} ${item.category || ''}`.toLowerCase().includes(query));
  $('#capabilityCatalog').innerHTML = filtered.map((item) => {
    const isSkill = app.catalog === 'skills';
    return `<article class="capability-card ${isSkill ? 'skill' : ''}"><header><h3>${escapeHtml(item.name)}</h3><span class="tag">${escapeHtml(isSkill ? 'SKILL' : item.category || 'TOOL')}</span></header><p>${escapeHtml(item.description || '')}</p><footer><small>${escapeHtml(isSkill ? item.source || 'local' : `${item.readOnly ? 'READ' : 'WRITE'} / ${item.risk || 'normal'}`)}</small><button class="card-button" data-detail="${escapeHtml(item.name)}" data-kind="${isSkill ? 'skill' : 'tool'}">INSPECT</button></footer></article>`;
  }).join('') || '<div class="quiet-card">No capability matches the filter.</div>';
  $$('[data-detail]').forEach((button) => button.addEventListener('click', () => showCapabilityDetail(button.dataset.kind, button.dataset.detail)));
}

async function showCapabilityDetail(kind, name) {
  try {
    const value = kind === 'skill' ? await api(`/api/skills/${encodeURIComponent(name)}`) : app.tools.find((item) => item.name === name);
    showDetail(`${kind.toUpperCase()} // ${name}`, kind === 'skill' ? value.body : JSON.stringify(value, null, 2));
  } catch (error) { toast(error.message, 'error'); }
}

function showDetail(title, content) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal wide-modal';
  dialog.innerHTML = `<div class="modal-shell"><div class="modal-head"><div><small>CAPABILITY DETAIL</small><h2>${escapeHtml(title)}</h2></div><button class="close-button">×</button></div><pre style="max-height:65vh;overflow:auto;padding:14px;background:#141414;color:#b7b7b7;font:10px/1.55 var(--mono);white-space:pre-wrap">${escapeHtml(content || '')}</pre></div>`;
  document.body.append(dialog);
  dialog.querySelector('button').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

async function refreshMcp() {
  try {
    app.mcp = await api(`/api/mcp/servers?workspaceId=${encodeURIComponent(app.workspaceId || '')}`);
    $('#mcpCount').textContent = String(app.mcp.length).padStart(3, '0');
    renderMcp();
  } catch (error) { toast(error.message, 'error'); }
}

function renderMcp() {
  const query = $('#mcpSearch').value.trim().toLowerCase();
  const filtered = app.mcp.filter((item) => !query || `${item.name} ${item.title || ''} ${item.description || ''}`.toLowerCase().includes(query));
  $('#mcpCatalog').innerHTML = filtered.map((server) => `<article class="capability-card mcp"><header><h3>${escapeHtml(server.title || server.name)}</h3><span class="tag">${escapeHtml(server.transport || 'MCP')}</span></header><p>${escapeHtml(server.description || server.name)}</p><footer><small class="server-status ${escapeHtml(server.status)}"><i></i>${escapeHtml(server.status)} / ${server.toolCount || 0} tools</small><button class="card-button ${server.status === 'connected' ? 'connected' : ''}" data-mcp="${escapeHtml(server.name)}" data-action="${server.status === 'connected' ? 'disconnect' : 'connect'}">${server.status === 'connected' ? 'DISCONNECT' : 'CONNECT'}</button></footer></article>`).join('') || '<div class="quiet-card">No MCP servers match the filter.</div>';
  $$('[data-mcp]').forEach((button) => button.addEventListener('click', () => toggleMcp(button.dataset.mcp, button.dataset.action)));
}

async function toggleMcp(name, action) {
  try {
    await api(`/api/mcp/servers/${encodeURIComponent(name)}/${action}`, { method: 'POST', body: { workspaceId: app.workspaceId } });
    toast(`${name} ${action === 'connect' ? 'connected' : 'disconnected'}.`, 'success');
    await refreshMcp();
  } catch (error) { toast(`${name}: ${error.message}`, 'error'); }
}

async function searchRegistry(query) {
  const results = $('#registryResults');
  results.innerHTML = '<div class="quiet-card">SCANNING OFFICIAL REGISTRY…</div>';
  try {
    const values = await api(`/api/mcp/registry?q=${encodeURIComponent(query)}&limit=60`);
    results.innerHTML = values.map((item) => `<article class="registry-item"><div><h3>${escapeHtml(item.title || item.name)}</h3><p>${escapeHtml(item.description || '')}</p><small>${escapeHtml(item.name)} / ${escapeHtml(item.version)} / ${item.remotes?.length || 0} remote / ${item.packages?.length || 0} package</small></div><button class="primary-button" data-install="${escapeHtml(item.name)}">INSTALL</button></article>`).join('') || '<div class="quiet-card">No registry matches.</div>';
    $$('[data-install]', results).forEach((button) => button.addEventListener('click', () => installRegistry(button.dataset.install, button)));
  } catch (error) { results.innerHTML = `<div class="quiet-card">${escapeHtml(error.message)}</div>`; }
}

async function installRegistry(name, button) {
  button.disabled = true; button.textContent = 'LINKING';
  try {
    await api('/api/mcp/registry/install', { method: 'POST', body: { registryName: name, prefer: 'remote', workspacePath: currentWorkspace()?.path } });
    toast(`${name} added to MaskShift.`, 'success');
    await refreshMcp();
    button.textContent = 'INSTALLED';
  } catch (error) { toast(error.message, 'error'); button.disabled = false; button.textContent = 'INSTALL'; }
}

function splitCommand(command) {
  const parts = [];
  const regex = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  for (const match of command.matchAll(regex)) parts.push(match[1] ?? match[2] ?? match[3]);
  return parts;
}

async function saveMcp() {
  const name = $('#mcpName').value.trim();
  const transport = $('#mcpTransport').value;
  let data = {};
  try { data = $('#mcpEnvironment').value.trim() ? JSON.parse($('#mcpEnvironment').value) : {}; }
  catch { throw new Error('ENV / headers must be valid JSON.'); }
  let definition;
  if (transport === 'stdio') {
    const parts = splitCommand($('#mcpCommand').value.trim());
    if (!parts.length) throw new Error('A stdio command is required.');
    definition = { transport: 'stdio', command: parts[0], args: parts.slice(1), env: data, enabled: true, lazy: true };
  } else {
    definition = { transport: 'http', url: $('#mcpUrl').value.trim(), headers: data, enabled: true, lazy: true };
  }
  await api('/api/mcp/servers', { method: 'POST', body: { name, definition, workspacePath: currentWorkspace()?.path } });
  toast(`${name} added.`, 'success');
  await refreshMcp();
}

function formatSchedule(schedule) {
  if (!schedule) return 'UNSCHEDULED';
  if (schedule.type === 'interval') {
    const ms = Number(schedule.everyMs || 0);
    if (ms % 86_400_000 === 0) return `EVERY ${ms / 86_400_000}D`;
    if (ms % 3_600_000 === 0) return `EVERY ${ms / 3_600_000}H`;
    if (ms % 60_000 === 0) return `EVERY ${ms / 60_000}M`;
    return `EVERY ${Math.round(ms / 1000)}S`;
  }
  if (schedule.type === 'cron') return schedule.expression;
  if (schedule.type === 'once') return new Date(schedule.at).toLocaleString();
  return JSON.stringify(schedule);
}

async function refreshGarage() {
  try {
    const workspace = app.workspaceId ? `?workspaceId=${encodeURIComponent(app.workspaceId)}` : '';
    [app.automations, app.plugins, app.bridges, app.browserInstances] = await Promise.all([
      api(`/api/automations${workspace}`), api('/api/plugins'), api('/api/bridges'), api('/api/browser/instances'),
    ]);
    $('#automationCount').textContent = app.automations.length;
    $('#pluginCount').textContent = app.plugins.length;
    $('#bridgeCount').textContent = app.bridges.filter((item) => item.available).length;
    $('#browserCount').textContent = app.browserInstances.length;
    renderGarage();
  } catch (error) { toast(`Garage: ${error.message}`, 'error'); }
}

function garagePrimaryLabel() {
  return ({ automations: 'NEW AUTOMATION', plugins: 'INSTALL PLUGIN', bridges: 'RE-SCAN AGENTS', browser: 'LAUNCH BROWSER' })[app.garage] || 'REFRESH';
}

function renderGarage() {
  $('#garagePrimaryButton').textContent = garagePrimaryLabel();
  const catalog = $('#garageCatalog');
  if (app.garage === 'automations') {
    catalog.innerHTML = app.automations.map((item) => `<article class="capability-card automation ${item.enabled ? '' : 'disabled'}">
      <header><h3>${escapeHtml(item.name)}</h3><span class="tag">${item.enabled ? 'ARMED' : 'PAUSED'}</span></header>
      <p>${escapeHtml(item.action?.type?.toUpperCase() || 'ACTION')} / ${escapeHtml(formatSchedule(item.schedule))}<br>${escapeHtml(item.action?.prompt || item.action?.command || item.action?.name || '')}</p>
      <div class="card-metrics"><span>NEXT <b>${escapeHtml(item.next_run_at ? formatDate(item.next_run_at) : '—')}</b></span><span>LAST <b>${escapeHtml(item.last_status || '—')}</b></span></div>
      <footer><small>${escapeHtml(item.id)}</small><div class="card-actions"><button class="card-button" data-auto-run="${escapeHtml(item.id)}">RUN</button><button class="card-button" data-auto-toggle="${escapeHtml(item.id)}" data-enabled="${item.enabled}">${item.enabled ? 'PAUSE' : 'RESUME'}</button><button class="card-button danger" data-auto-delete="${escapeHtml(item.id)}">DEL</button></div></footer>
    </article>`).join('') || '<div class="quiet-card">No automations armed. Schedule an agent run, tool call, or shell command.</div>';
  } else if (app.garage === 'plugins') {
    catalog.innerHTML = app.plugins.map((item) => `<article class="capability-card plugin ${escapeHtml(item.status)}">
      <header><h3>${escapeHtml(item.name)}</h3><span class="tag">${escapeHtml(item.status.toUpperCase())}</span></header>
      <p>${escapeHtml(item.description || item.root)}<br>${item.tools?.length || 0} tools / ${item.skills?.length || 0} skill roots</p>
      <footer><small>V${escapeHtml(item.version || '0.0.0')}</small><div class="card-actions"><button class="card-button" data-plugin-action="reload" data-plugin="${escapeHtml(item.name)}">RELOAD</button><button class="card-button ${item.status === 'active' ? 'connected' : ''}" data-plugin-action="${item.status === 'active' ? 'deactivate' : 'activate'}" data-plugin="${escapeHtml(item.name)}">${item.status === 'active' ? 'STOP' : 'START'}</button></div></footer>
    </article>`).join('') || '<div class="quiet-card">No runtime plugins installed. Native MaskShift capabilities remain available.</div>';
  } else if (app.garage === 'bridges') {
    catalog.innerHTML = app.bridges.map((item) => `<article class="capability-card bridge ${item.available ? 'available' : 'disabled'}">
      <header><h3>${escapeHtml(item.title || item.name)}</h3><span class="tag">${item.available ? 'ONLINE' : 'NOT FOUND'}</span></header>
      <p>${escapeHtml(item.description || '')}</p>
      <footer><small>${escapeHtml(item.version || item.command || '')}</small><button class="card-button" data-bridge-detail="${escapeHtml(item.name)}">INSPECT</button></footer>
    </article>`).join('') || '<div class="quiet-card">No bridge definitions found.</div>';
  } else {
    catalog.innerHTML = app.browserInstances.map((item) => `<article class="capability-card browser">
      <header><h3>${escapeHtml(item.profile)}</h3><span class="tag">${escapeHtml(item.status.toUpperCase())}</span></header>
      <p>${item.headless ? 'HEADLESS' : 'VISIBLE'} / PID ${item.pid} / CDP ${item.port}<br>${escapeHtml(item.userDataDir)}</p>
      <footer><small>${escapeHtml(item.id)}</small><button class="card-button danger" data-browser-close="${escapeHtml(item.id)}">CLOSE</button></footer>
    </article>`).join('') || '<div class="quiet-card">No browser running. Launch a persistent CDP profile for web automation and visual QA.</div>';
  }

  $$('[data-auto-run]', catalog).forEach((button) => button.addEventListener('click', () => void runAutomation(button.dataset.autoRun)));
  $$('[data-auto-toggle]', catalog).forEach((button) => button.addEventListener('click', () => void toggleAutomation(button.dataset.autoToggle, button.dataset.enabled === 'true')));
  $$('[data-auto-delete]', catalog).forEach((button) => button.addEventListener('click', () => void deleteAutomation(button.dataset.autoDelete)));
  $$('[data-plugin-action]', catalog).forEach((button) => button.addEventListener('click', () => void pluginAction(button.dataset.plugin, button.dataset.pluginAction)));
  $$('[data-bridge-detail]', catalog).forEach((button) => button.addEventListener('click', () => {
    const item = app.bridges.find((bridge) => bridge.name === button.dataset.bridgeDetail);
    showDetail(`AGENT BRIDGE // ${item?.title || button.dataset.bridgeDetail}`, JSON.stringify(item, null, 2));
  }));
  $$('[data-browser-close]', catalog).forEach((button) => button.addEventListener('click', () => void closeBrowser(button.dataset.browserClose)));
}

async function createAutomation() {
  const actionType = $('#automationActionType').value;
  let action;
  if (actionType === 'agent') {
    const prompt = $('#automationPrompt').value.trim();
    if (!prompt) throw new Error('An agent prompt is required.');
    action = { type: 'agent', prompt, modelRef: $('#automationModel').value.trim() || null };
  } else if (actionType === 'shell') {
    const command = $('#automationCommand').value.trim();
    if (!command) throw new Error('A shell command is required.');
    action = { type: 'shell', command };
  } else {
    let value;
    try { value = JSON.parse($('#automationTool').value); } catch { throw new Error('Tool definition must be valid JSON.'); }
    if (!value?.name) throw new Error('Tool JSON requires a name.');
    action = { type: 'tool', name: value.name, arguments: value.arguments || {} };
  }
  await api('/api/automations', { method: 'POST', body: {
    workspaceId: app.workspaceId, name: $('#automationName').value.trim(),
    schedule: $('#automationSchedule').value.trim(), enabled: $('#automationEnabled').checked, action,
  } });
  toast('Automation armed.', 'success');
  await refreshGarage();
}

async function runAutomation(id) {
  try { toast('Automation launched.', 'success'); await api(`/api/automations/${encodeURIComponent(id)}/run`, { method: 'POST', body: {} }); await refreshGarage(); }
  catch (error) { toast(error.message, 'error'); }
}

async function toggleAutomation(id, enabled) {
  try { await api(`/api/automations/${encodeURIComponent(id)}`, { method: 'PATCH', body: { enabled: !enabled } }); await refreshGarage(); }
  catch (error) { toast(error.message, 'error'); }
}

async function deleteAutomation(id) {
  try { await api(`/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refreshGarage(); toast('Automation removed.'); }
  catch (error) { toast(error.message, 'error'); }
}

async function installPlugin() {
  await api('/api/plugins', { method: 'POST', body: { source: $('#pluginSource').value.trim(), name: $('#pluginName').value.trim() || null, kind: $('#pluginKind').value } });
  toast('Plugin installed and activated.', 'success');
  await Promise.all([refreshGarage(), refreshCapabilities()]);
}

async function pluginAction(name, action) {
  try { await api(`/api/plugins/${encodeURIComponent(name)}/${action}`, { method: 'POST', body: {} }); await Promise.all([refreshGarage(), refreshCapabilities()]); }
  catch (error) { toast(error.message, 'error'); }
}

async function launchBrowser() {
  await api('/api/browser/instances', { method: 'POST', body: {
    profile: $('#browserProfile').value.trim() || 'default', url: $('#browserUrl').value.trim() || 'about:blank',
    headless: $('#browserHeadless').checked, reuse: $('#browserReuse').checked,
  } });
  toast('Browser CDP link online.', 'success');
  await refreshGarage();
}

async function closeBrowser(id) {
  try { await api(`/api/browser/instances/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refreshGarage(); }
  catch (error) { toast(error.message, 'error'); }
}

function openGaragePrimary() {
  if (app.garage === 'automations') $('#automationDialog').showModal();
  else if (app.garage === 'plugins') $('#pluginDialog').showModal();
  else if (app.garage === 'browser') $('#browserDialog').showModal();
  else void refreshGarage();
}

function appendEvent(event) {
  app.events.unshift(event);
  app.events = app.events.slice(0, 300);
  const className = /failed|error|cancel/i.test(event.type) ? 'hot' : /completed|connected|opened/i.test(event.type) ? 'ok' : /tool|model|index/i.test(event.type) ? 'info' : '';
  const summary = eventSummary(event);
  const node = document.createElement('div');
  node.className = `event-item ${className}`;
  node.innerHTML = `<strong>${escapeHtml(event.type.toUpperCase())}</strong><span>${escapeHtml(summary)} / ${new Date(event.timestamp).toLocaleTimeString()}</span>`;
  $('#eventFeed').prepend(node);
  while ($('#eventFeed').children.length > 300) $('#eventFeed').lastElementChild.remove();
}

function eventSummary(event) {
  const payload = event.payload || {};
  return payload.tool || payload.server || payload.model || payload.message || payload.error || payload.path || payload.status || event.runId || 'signal';
}

function connectEvents() {
  app.eventSource?.close();
  const source = new EventSource('/api/events');
  app.eventSource = source;
  const types = [
    'run.started','run.model-turn','run.assistant','run.tool-result','run.tool-error','run.plan','run.completed','run.failed','run.cancelled','run.max-steps','run.checkpoint','run.warning',
    'tool.started','tool.completed','tool.failed','shell.output','process.started','process.output','process.exited',
    'model.request.started','model.request.completed','model.request.failed','provider.status',
    'mcp.connecting','mcp.connected','mcp.disconnected','mcp.error','mcp.tool.started','mcp.tool.completed','mcp.tool.failed',
    'index.started','index.progress','index.completed','capabilities.primed','capabilities.activated','subagent.started','subagent.completed','workspace.opened','skills.scanned',
    'plugin.activated','plugin.deactivated','plugin.failed','automation.created','automation.updated','automation.started','automation.completed','automation.failed','automation.deleted',
    'browser.started','browser.navigated','browser.exited','bridge.started','bridge.completed','lsp.started','lsp.diagnostics','lsp.exited',
  ];
  for (const type of types) source.addEventListener(type, (raw) => handleEvent(JSON.parse(raw.data)));
  source.addEventListener('connected', () => setCoreStatus('SYNC', 'ok'));
  source.onerror = () => setCoreStatus('RELINK', 'error');
}

let messageRefreshTimer;
function handleEvent(event) {
  appendEvent(event);
  if (event.type === 'shell.output') appendTerminal(event.payload.text, event.payload.stream === 'stderr' ? 'stderr' : '');
  if (event.type === 'index.progress' || event.type === 'index.completed') $('#indexMetric').textContent = `${event.payload.indexedFiles || event.payload.files || 0}F`;
  if (event.type === 'subagent.started') $('#subagentMetric').textContent = String(Number($('#subagentMetric').textContent || 0) + 1);
  if (/^(plugin|automation|browser)\./.test(event.type) && app.currentView === 'garage') void refreshGarage();
  if (event.type === 'run.plan' && (!app.runId || event.runId === app.runId)) renderPlan(event.payload);
  if (event.type === 'capabilities.primed' || event.type === 'capabilities.activated') {
    const snapshot = event.payload.snapshot || event.payload;
    if (!app.runId || event.runId === app.runId) renderCapabilitiesSnapshot(snapshot);
  }
  if (event.runId && event.runId === app.runId) {
    if (event.type === 'run.model-turn') $('#stepMetric').textContent = String(event.payload.step || 0).padStart(2, '0');
    if (/run\.(assistant|tool-result|tool-error)/.test(event.type)) {
      clearTimeout(messageRefreshTimer); messageRefreshTimer = setTimeout(() => void loadMessages(), 150);
    }
    if (/run\.(completed|failed|cancelled|max-steps)/.test(event.type)) {
      app.runStatus = event.type.split('.').at(-1).replace('max-steps', 'max_steps');
      updateRunUI({ status: app.runStatus, step_count: Number($('#stepMetric').textContent) });
      stopPolling(); void Promise.allSettled([loadMessages(), refreshSessions(), refreshWorkspaceInspection()]);
      setCoreStatus(app.runStatus === 'completed' ? 'FINISH' : 'FAULT', app.runStatus === 'completed' ? 'ok' : 'error');
    }
  }
}

function appendTerminal(text, type = '') {
  const output = $('#terminalOutput');
  const node = document.createElement('div');
  node.className = `terminal-line ${type}`;
  node.textContent = text;
  output.append(node);
  output.scrollTop = output.scrollHeight;
  while (output.children.length > 1000) output.firstElementChild.remove();
}

async function executeTerminal(command) {
  if (!command.trim()) return;
  app.terminalHistory.push(command); app.terminalIndex = app.terminalHistory.length;
  appendTerminal(`❯ ${command}`, 'command');
  $('#terminalCommand').value = '';
  try {
    const result = await api('/api/terminal/exec', { method: 'POST', body: { command, workspaceId: app.workspaceId, cwd: '.' } });
    if (result.stdout) appendTerminal(result.stdout);
    if (result.stderr) appendTerminal(result.stderr, 'stderr');
    appendTerminal(`[exit ${result.code} // ${result.durationMs}ms]`, 'muted');
  } catch (error) { appendTerminal(error.message, 'stderr'); }
}

async function openWorkspace(path, { index = true, announce = true } = {}) {
  const workspace = await api('/api/workspaces', { method: 'POST', body: { path, index } });
  const state = await api('/api/state');
  app.state = state; app.workspaceId = workspace.id; app.sessionId = null; app.runId = null;
  populateWorkspaces(); populateModels();
  await Promise.all([refreshSessions(), refreshWorkspaceInspection(), refreshMcp(), refreshCapabilities(), refreshGarage()]);
  if (announce) toast(`Track loaded: ${workspace.path}`, 'success');
  return workspace;
}

function openSettings() {
  const cfg = app.state.config;
  $('#settingDefaultModel').value = cfg.defaultModel || '';
  $('#settingPermission').value = cfg.permissionMode || 'overdrive';
  $('#settingMaxSteps').value = cfg.maxAgentSteps || 96;
  $('#settingParallel').value = cfg.maxParallelSubagents || 6;
  $('#settingAutoIndex').checked = cfg.autoIndex !== false;
  $('#settingAutoCheckpoint').checked = cfg.autoCheckpoint !== false;
  $('#settingAutoCapabilities').checked = cfg.autoLoadCapabilities !== false;
  $('#settingMotion').checked = cfg.ui?.motion !== false;
  $('#settingsDialog').showModal();
}

async function saveSettings() {
  const patch = {
    defaultModel: $('#settingDefaultModel').value.trim(), permissionMode: $('#settingPermission').value,
    maxAgentSteps: Number($('#settingMaxSteps').value), maxParallelSubagents: Number($('#settingParallel').value),
    autoIndex: $('#settingAutoIndex').checked, autoCheckpoint: $('#settingAutoCheckpoint').checked,
    autoLoadCapabilities: $('#settingAutoCapabilities').checked,
    ui: { ...app.state.config.ui, motion: $('#settingMotion').checked },
  };
  app.state.config = await api('/api/config', { method: 'PATCH', body: patch });
  document.body.classList.toggle('no-motion', app.state.config.ui?.motion === false);
  $('#permissionMode').textContent = app.state.config.permissionMode.toUpperCase();
  toast('Core settings saved.', 'success');
}

function bindEvents() {
  $('#openWorkspaceButton').addEventListener('click', () => $('#workspaceDialog').showModal());
  $('#workspaceForm').addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    try { await openWorkspace($('#workspacePathInput').value.trim() || '.'); $('#workspaceDialog').close(); }
    catch (error) { toast(error.message, 'error'); }
  });
  $('#workspaceSelect').addEventListener('change', async (event) => {
    const workspace = app.state?.workspaces?.find((item) => item.id === event.target.value);
    if (!workspace) { app.workspaceId = null; return; }
    try { await openWorkspace(workspace.path, { index: false, announce: false }); }
    catch (error) { toast(error.message, 'error'); populateWorkspaces(); }
  });
  $('#newSessionButton').addEventListener('click', () => void createSession());
  $('#mobileNewSessionButton').addEventListener('click', () => void createSession());
  $('#brandButton').addEventListener('click', () => {
    if (window.matchMedia('(max-width: 760px)').matches) {
      const open = !$('.left-rail').classList.contains('mobile-open');
      $('.left-rail').classList.toggle('mobile-open', open);
      document.body.classList.toggle('mobile-sessions-open', open);
    } else switchView('cockpit');
  });
  $('#mobileRailBackdrop').addEventListener('click', () => {
    $('.left-rail').classList.remove('mobile-open');
    document.body.classList.remove('mobile-sessions-open');
  });
  $('#refreshSessionsButton').addEventListener('click', () => void refreshSessions());
  $('#sessionSearch').addEventListener('input', renderSessions);
  $('#composer').addEventListener('submit', (event) => { event.preventDefault(); void launchRun($('#promptInput').value); });
  $('#promptInput').addEventListener('input', resizePrompt);
  $('#promptInput').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void launchRun(event.currentTarget.value); }
  });
  $('#stopRunButton').addEventListener('click', () => void stopRun());
  $$('.starter-grid button').forEach((button) => button.addEventListener('click', () => { $('#promptInput').value = button.dataset.prompt; resizePrompt(); $('#promptInput').focus(); }));
  $$('.nav-tab').forEach((button) => button.addEventListener('click', () => {
    switchView(button.dataset.view);
    $('.left-rail').classList.remove('mobile-open');
    document.body.classList.remove('mobile-sessions-open');
  }));
  $$('.deck-tabs button').forEach((button) => button.addEventListener('click', () => {
    $$('.deck-tabs button').forEach((item) => item.classList.toggle('active', item === button));
    $$('.deck-pane').forEach((pane) => pane.classList.toggle('active', pane.id === `${button.dataset.deck}Pane`));
  }));
  $('#refreshTreeButton').addEventListener('click', () => void refreshTree());
  $('#fileSearch').addEventListener('input', renderTree);
  $('#copyFileButton').addEventListener('click', async () => { await navigator.clipboard.writeText($('#filePreview code').textContent); toast('File copied.', 'success'); });
  $$('#capabilitiesView .catalog-tabs button').forEach((button) => button.addEventListener('click', () => {
    app.catalog = button.dataset.catalog; $$('#capabilitiesView .catalog-tabs button').forEach((item) => item.classList.toggle('active', item === button)); renderCapabilityCatalog();
  }));
  $('#capabilitySearch').addEventListener('input', renderCapabilityCatalog);
  $('#mcpSearch').addEventListener('input', renderMcp);
  $('#registryButton').addEventListener('click', () => $('#registryDialog').showModal());
  $('[data-close="registryDialog"]').addEventListener('click', () => $('#registryDialog').close());
  $('#registrySearchForm').addEventListener('submit', (event) => { event.preventDefault(); void searchRegistry($('#registrySearchInput').value.trim()); });
  $('#addMcpButton').addEventListener('click', () => $('#mcpDialog').showModal());
  $('#mcpTransport').addEventListener('change', (event) => {
    $('#mcpCommandLabel').classList.toggle('hidden', event.target.value !== 'stdio');
    $('#mcpUrlLabel').classList.toggle('hidden', event.target.value === 'stdio');
  });
  $('#mcpForm').addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    try { await saveMcp(); $('#mcpDialog').close(); }
    catch (error) { toast(error.message, 'error'); }
  });
  $$('.garage-tabs button').forEach((button) => button.addEventListener('click', () => {
    app.garage = button.dataset.garage;
    $$('.garage-tabs button').forEach((item) => item.classList.toggle('active', item === button));
    renderGarage();
  }));
  $('#garageRefreshButton').addEventListener('click', () => void refreshGarage());
  $('#garagePrimaryButton').addEventListener('click', openGaragePrimary);
  $('#automationActionType').addEventListener('change', (event) => {
    $('#automationPromptLabel').classList.toggle('hidden', event.target.value !== 'agent');
    $('#automationCommandLabel').classList.toggle('hidden', event.target.value !== 'shell');
    $('#automationToolLabel').classList.toggle('hidden', event.target.value !== 'tool');
  });
  $('#automationForm').addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    try {
      await createAutomation(); $('#automationDialog').close(); event.currentTarget.reset();
      $('#automationEnabled').checked = true;
      $('#automationActionType').dispatchEvent(new Event('change'));
    }
    catch (error) { toast(error.message, 'error'); }
  });
  $('#pluginForm').addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    try { await installPlugin(); $('#pluginDialog').close(); event.currentTarget.reset(); }
    catch (error) { toast(error.message, 'error'); }
  });
  $('#browserForm').addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    try { await launchBrowser(); $('#browserDialog').close(); }
    catch (error) { toast(error.message, 'error'); }
  });
  $('#settingsButton').addEventListener('click', openSettings);
  $('#settingsForm').addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    try { await saveSettings(); $('#settingsDialog').close(); }
    catch (error) { toast(error.message, 'error'); }
  });
  $('#terminalToggle').addEventListener('click', () => $('#terminalDeck').classList.toggle('open'));
  $('#terminalForm').addEventListener('submit', (event) => { event.preventDefault(); void executeTerminal($('#terminalCommand').value); });
  $('#terminalCommand').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp') { event.preventDefault(); app.terminalIndex = Math.max(0, app.terminalIndex - 1); event.currentTarget.value = app.terminalHistory[app.terminalIndex] || ''; }
    if (event.key === 'ArrowDown') { event.preventDefault(); app.terminalIndex = Math.min(app.terminalHistory.length, app.terminalIndex + 1); event.currentTarget.value = app.terminalHistory[app.terminalIndex] || ''; }
  });
  $('#refreshGitButton').addEventListener('click', () => void refreshWorkspaceInspection());
  $('#clearEventsButton').addEventListener('click', () => { app.events = []; $('#eventFeed').innerHTML = ''; });
  $('#attachContextButton').addEventListener('click', () => { switchView('files'); toast('Select a file, then reference its path in your prompt. Automatic retrieval is always active.'); });
  $('#autoLoadButton').addEventListener('click', (event) => { event.currentTarget.classList.toggle('active'); toast('Automatic capability loading is controlled globally in Settings.'); });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); void createSession(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#promptInput').focus(); }
    if (event.key === 'Escape') $$('dialog[open]').forEach((dialog) => dialog.close());
  });
  window.addEventListener('beforeunload', () => app.eventSource?.close());
}

async function init() {
  bindEvents();
  try {
    app.state = await api('/api/state');
    app.workspaceId = app.state.lastWorkspaceId || app.state.workspaces?.[0]?.id || null;
    $('#permissionMode').textContent = (app.state.config.permissionMode || 'overdrive').toUpperCase();
    $('#toolCount').textContent = String(app.state.toolCount || 0).padStart(3, '0');
    $('#mcpCount').textContent = String(app.state.mcpServers?.length || 0).padStart(3, '0');
    document.body.classList.toggle('no-motion', app.state.config.ui?.motion === false);
    populateWorkspaces(); populateModels(); connectEvents();
    await Promise.all([refreshSessions(true), refreshWorkspaceInspection(), refreshMcp(), refreshCapabilities(), refreshGarage()]);
    void refreshProviders();
    setInterval(() => {
      if (app.runStartedAt) $('#elapsedMetric').textContent = duration(Date.now() - app.runStartedAt);
    }, 1000);
  } catch (error) {
    setCoreStatus('OFFLINE', 'error'); toast(`MaskShift initialization failed: ${error.message}`, 'error');
  }
}

void init();
