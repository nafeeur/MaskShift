// 07 FLEET — drive any mix of coding-agent harnesses (Claude Code, Codex, OpenCode, Hermes, Copilot, Aider, custom
// CLIs, MaskShift's own engine) as one team. Members are named seats that keep a role, a history and an inbox; they
// message each other with [[send]] blocks, and a relay keeps the conversation going until the team says it is done.
//
// The view is a catalogue like the others: four sections (members, messages, relays, harnesses), a filter, a list and
// a detail pane. Everything that can take minutes — asking a member, running a relay — starts in the background and
// reports through fleet.* events, so the interface never blocks behind a harness.

import { oneLine, truncate, wrap } from '../text.mjs';
import { statusGlyph, statusOf } from '../status.mjs';
import { SPACE } from '../tokens.mjs';
import { gutter, spread } from '../type.mjs';
import { FormOverlay, TextOverlay } from '../overlays.mjs';
import { detailBlock, handleCatalog, listRow, renderCatalog } from './catalog.mjs';
import { fuzzy } from '../widgets.mjs';

const TABS = [
  { id: 'members', label: 'Members' },
  { id: 'messages', label: 'Messages' },
  { id: 'relays', label: 'Relays' },
  { id: 'harnesses', label: 'Harnesses' },
];

const NAME_WIDTH = 24;
const STATUS_WIDTH = 11;

export function createState() {
  return { harnesses: [], members: [], messages: [], relays: [] };
}

/** Pull the live roster out of the manager (cheap, in memory); the harness probe is only re-run on request. */
export function sync(app) {
  const manager = app.runtime.fleetManager;
  app.fleet.members = manager.list();
  app.fleet.messages = manager.conversation({ limit: 200 });
  app.fleet.relays = manager.listRelays();
}

export async function refresh(app, { force = false } = {}) {
  sync(app);
  try { app.fleet.harnesses = await app.runtime.fleetManager.harnesses({ force }); } catch { /* optional */ }
  app.requestRender();
}

/** Called for every fleet.* event: keep the view current and say out loud when something finishes or breaks. */
export function onEvent(app, event) {
  sync(app);
  const payload = event.payload || {};
  if (event.type === 'fleet.relay.completed') {
    const { relay } = payload;
    app.toast(`Relay ${relay.status}: ${truncate(relay.final || relay.reason || relay.task, 80)}`, relay.status === 'completed' ? 'success' : 'warn');
  } else if (event.type === 'fleet.turn.completed' && !payload.turn?.ok && payload.turn?.error && payload.turn.error !== 'Cancelled') {
    app.toast(`${payload.member.name} failed: ${truncate(payload.turn.error, 90)}`, 'error');
  } else if (event.type === 'fleet.member.fallback') {
    app.toast(`${payload.name}: ${payload.from} unavailable, now using ${payload.to}`, 'warn');
  }
}

export function items(app) {
  const query = app.fleetFilter.value.trim();
  let source = [];
  if (app.fleetTab === 'members') {
    source = app.fleet.members.map((member) => ({
      id: `member:${member.id}`, kind: 'member', name: member.name, status: member.status,
      description: `${member.harness}${member.unread ? ` · ${member.unread} unread` : ''}${member.role ? ` · ${member.role}` : ''}`, raw: member,
    }));
  } else if (app.fleetTab === 'messages') {
    source = [...app.fleet.messages].reverse().map((message) => ({
      id: `message:${message.id}`, kind: 'message', name: `${message.from} → ${message.to}`,
      status: message.status === 'dropped' ? 'failed' : message.status === 'queued' ? 'pending' : 'done',
      description: oneLine(message.dropped || message.body, 120), raw: message,
    }));
  } else if (app.fleetTab === 'relays') {
    source = app.fleet.relays.map((relay) => ({
      id: `relay:${relay.id}`, kind: 'relay', name: truncate(relay.task, NAME_WIDTH), status: relay.status,
      description: `${relay.rounds} round${relay.rounds === 1 ? '' : 's'} · lead ${relay.lead} · ${relay.members.length} members`, raw: relay,
    }));
  } else {
    source = app.fleet.harnesses.map((harness) => ({
      id: `harness:${harness.name}`, kind: 'harness', name: harness.title || harness.name,
      status: harness.available ? 'available' : 'missing', description: harness.command + (harness.version ? ` · ${oneLine(harness.version, 40)}` : ''), raw: harness,
    }));
  }
  if (!query) return source;
  return source
    .map((item) => {
      const match = fuzzy(query, `${item.name} ${item.description}`);
      return match ? { ...item, score: match.score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

function row(app, item, selected, width) {
  const { theme } = app;
  const state = statusOf(item.status);
  const tone = theme.role(state.tone);
  return listRow(app, {
    selected, width,
    marker: statusGlyph(theme, item.status, { animate: true }), markerTone: tone,
    cells: [
      { text: truncate(item.name, NAME_WIDTH), width: NAME_WIDTH, tone: theme.roles.text, bold: true },
      { text: state.label, width: STATUS_WIDTH, tone },
      { text: item.description || '', tone: theme.roles.muted },
    ],
  });
}

export function detail(app, width) {
  const item = app.fleetList.current;
  if (!item) return null;
  const { theme } = app;
  const raw = item.raw || {};
  const text = Math.max(8, width - SPACE.gutter);
  const dim = (value) => wrap(String(value || ''), text).map((line) => theme.paint(line, { fg: theme.roles.dim }));
  const sections = [];
  if (item.kind === 'member') {
    const full = app.runtime.fleetManager.details(raw.id);
    sections.push(
      raw.role || 'No role set.',
      { field: 'harness', value: `${raw.title || raw.harness} (${raw.harness})` },
      raw.fellBackFrom ? { field: 'fell back', value: `from ${raw.fellBackFrom}`, tone: theme.roles.warning } : null,
      { field: 'mode', value: raw.mode },
      { field: 'model', value: raw.model || 'harness default' },
      { field: 'cwd', value: raw.cwd },
      { field: 'branch', value: raw.isolation?.branch || '' },
      { field: 'unread', value: String(raw.unread) },
      { field: 'turns', value: `${raw.stats.turns} · ${raw.stats.failures} failed · ${raw.stats.retries} retried` },
      { field: 'task', value: raw.currentTask || '', tone: theme.roles.accent },
      { field: 'error', value: raw.error || '', tone: theme.roles.danger },
    );
    if (full.inbox.length) {
      sections.push({ heading: 'inbox' });
      for (const mail of full.inbox.slice(-4)) sections.push({ raw: dim(`${mail.from}: ${oneLine(mail.body, 240)}`) });
    }
    if (full.history.length) {
      sections.push({ heading: 'recent turns' });
      for (const turn of full.history.slice(-3).reverse()) {
        sections.push({ field: turn.at.slice(11, 19), value: `${turn.ok ? 'ok' : 'failed'} · ${(turn.durationMs / 1000).toFixed(1)}s${turn.sends.length ? ` · → ${turn.sends.map((send) => send.to).join(', ')}` : ''}${turn.done ? ' · done' : ''}` });
        sections.push({ raw: dim(oneLine(turn.reply || turn.error || '(no output)', 600)) });
      }
    }
  } else if (item.kind === 'message') {
    sections.push(
      { field: 'from', value: raw.from }, { field: 'to', value: raw.to }, { field: 'kind', value: raw.kind },
      { field: 'status', value: raw.status }, { field: 'hops', value: String(raw.hops) },
      { field: 'dropped', value: raw.dropped || '', tone: theme.roles.danger }, { heading: 'message' }, raw.body,
    );
  } else if (item.kind === 'relay') {
    sections.push(
      { field: 'status', value: `${raw.status}${raw.reason ? ` · ${raw.reason}` : ''}` },
      { field: 'lead', value: raw.lead }, { field: 'members', value: raw.members.join(', ') },
      { field: 'rounds', value: String(raw.rounds) }, { heading: 'task' }, raw.task,
    );
    if (raw.final) sections.push({ heading: 'outcome' }, raw.final);
    if (raw.turns.length) {
      sections.push({ heading: 'trace' });
      for (const turn of raw.turns.slice(-12)) {
        sections.push({ field: `r${turn.round} ${turn.name}`, value: `${turn.ok ? 'ok' : 'failed'}${turn.sends.length ? ` · ${turn.sends.join(', ')}` : ''}`, tone: turn.ok ? undefined : theme.roles.danger });
      }
    }
  } else if (item.kind === 'harness') {
    sections.push(
      raw.description || '',
      { field: 'command', value: raw.command }, { field: 'installed', value: raw.available ? 'yes' : 'no', tone: raw.available ? theme.roles.success : theme.roles.muted },
      { field: 'version', value: raw.version || '' },
      raw.available ? { heading: 'use' } : { heading: 'install it, then press r' },
      raw.available ? `Press n to add a ${raw.title || raw.name} member to the fleet.` : '',
    );
  }
  return detailBlock(app, width, sections);
}

const EMPTY = {
  members: { title: 'No agents in the fleet yet', hint: 'n adds one · t starts a team in one go' },
  messages: { title: 'No messages yet', hint: 'Members message each other with [[send]] blocks' },
  relays: { title: 'No relays run yet', hint: 'g hands the team a task' },
  harnesses: { title: 'No harnesses found', hint: 'r rescans' },
};

export function render(app, region) {
  const list = items(app);
  app.fleetList.setItems(list);
  const counts = { members: app.fleet.members.length, messages: app.fleet.messages.length, relays: app.fleet.relays.length, harnesses: app.fleet.harnesses.filter((item) => item.available).length };
  const query = app.fleetFilter.value.trim();
  const running = app.fleet.members.filter((member) => member.status === 'running').length;
  return renderCatalog(app, region, {
    tabs: TABS.map((tab) => ({ ...tab, count: counts[tab.id] })), activeTab: app.fleetTab,
    filter: app.fleetFilter, filterFocus: 'fleet-filter', listFocus: 'fleet',
    placeholder: 'Filter members, messages, relays and harnesses',
    list: app.fleetList, row: (item, selected, width) => row(app, item, selected, width),
    stamp: running ? `${running} working` : `${list.length} ${list.length === 1 ? 'entry' : 'entries'}`,
    empty: query ? { title: `No matches for "${query}"`, hint: '' } : EMPTY[app.fleetTab],
    detail: detail(app, Math.max(30, Math.floor(region.width * 0.4) - 4)),
    detailTitle: app.fleetList.current?.name ? truncate(app.fleetList.current.name, 30) : 'Details',
    detailStamp: { member: 'Member', message: 'Message', relay: 'Relay', harness: 'Harness' }[app.fleetList.current?.kind] || '',
    onTab: (target, id) => { target.fleetTab = id; target.focus = 'fleet'; target.fleetList.first(); },
    onActivate: (target, item) => activate(target, item),
  });
}

// ------------------------------------------------------------------ actions

function selectedMember(app) {
  const item = app.fleetList.current;
  return item?.kind === 'member' ? item.raw : null;
}

function harnessOptions(app) {
  const installed = app.fleet.harnesses.filter((item) => item.available);
  const missing = app.fleet.harnesses.filter((item) => !item.available);
  return [
    ...installed.map((item) => ({ label: item.title || item.name, value: item.name })),
    ...missing.map((item) => ({ label: `${item.title || item.name} (not installed)`, value: item.name })),
  ];
}

function failOnError(app, promise, label) {
  promise.catch((error) => app.toast(`${label}: ${error.message}`, 'error'));
}

export function openSpawn(app, preset = null, { probed = false } = {}) {
  const options = harnessOptions(app);
  if (!options.length) {
    // The probe that fills this list runs when the view opens; a keypress that beats it waits for it once.
    if (probed) app.toast('No harnesses detected — press r to rescan', 'warn');
    else void refresh(app).then(() => openSpawn(app, preset, { probed: true }));
    return;
  }
  app.overlay = new FormOverlay({
    title: 'Add an agent', submitLabel: 'Add to fleet',
    note: 'Several members can share a harness. Pick inspect for read-only work, edit to let it change files.',
    fields: [
      { name: 'harness', label: 'harness', type: 'select', value: preset || options[0].value, options },
      { name: 'name', label: 'name', value: '', hint: 'reviewer (blank = harness name)' },
      { name: 'role', label: 'role', type: 'textarea', rows: 3, value: '', hint: 'What this agent is for' },
      { name: 'mode', label: 'access', type: 'select', value: 'edit', options: [{ label: 'Edit files', value: 'edit' }, { label: 'Inspect only', value: 'inspect' }] },
      { name: 'isolated', label: 'own git worktree', type: 'toggle', value: false },
      { name: 'model', label: 'model override', value: '' },
    ],
    onSubmit: async (values) => {
      const member = await app.runtime.fleetManager.spawn({
        harness: values.harness, name: values.name, role: values.role, mode: values.mode, isolated: Boolean(values.isolated),
        model: values.model || null, workspaceId: app.workspaceId,
      });
      sync(app);
      app.toast(`${member.name} joined the fleet`, 'success');
    },
  });
}

export function openTeam(app) {
  if (!app.fleet.harnesses.length) { void refresh(app).then(() => { if (app.fleet.harnesses.length) openTeam(app); }); return; }
  const installed = app.fleet.harnesses.filter((item) => item.available && !item.internal).map((item) => item.name);
  app.overlay = new FormOverlay({
    title: 'Start a team', submitLabel: 'Start team',
    note: `Comma-separated harnesses, optionally named: claude, codex:reviewer, hermes. Installed: ${installed.join(', ') || 'none found'}.`,
    fields: [
      { name: 'members', label: 'members', value: installed.slice(0, 3).join(', '), hint: 'claude, codex:reviewer, hermes' },
      { name: 'mode', label: 'access', type: 'select', value: 'edit', options: [{ label: 'Edit files', value: 'edit' }, { label: 'Inspect only', value: 'inspect' }] },
      { name: 'isolated', label: 'each in its own git worktree', type: 'toggle', value: false },
    ],
    onSubmit: async (values) => {
      const specs = String(values.members || '').split(',').map((item) => item.trim()).filter(Boolean);
      if (!specs.length) throw new Error('List at least one harness');
      const members = await app.runtime.fleetManager.spawnMany(specs, { workspaceId: app.workspaceId, mode: values.mode, isolated: Boolean(values.isolated) });
      sync(app);
      app.toast(`Added ${members.map((member) => member.name).join(', ')}`, 'success');
    },
  });
}

export function openAsk(app, member = selectedMember(app)) {
  if (!member) { app.toast('Select a member first', 'warn'); return; }
  app.overlay = new FormOverlay({
    title: `Ask ${member.name}`, submitLabel: 'Send',
    note: member.unread ? `${member.unread} unread message${member.unread === 1 ? '' : 's'} will be delivered with this.` : `Runs ${member.title || member.harness} in ${member.cwd}`,
    fields: [{ name: 'message', label: 'message', type: 'textarea', rows: 6, value: '' }],
    onSubmit: (values) => {
      if (!values.message.trim()) throw new Error('A message is required');
      failOnError(app, app.runtime.fleetManager.ask(member.name, { message: values.message, from: 'user' }).then((result) => {
        if (result.ok) app.toast(`${member.name} replied`, 'success');
      }), member.name);
      app.toast(`Sent to ${member.name}`, 'info');
    },
  });
}

export function openTell(app, member = selectedMember(app)) {
  if (!member) { app.toast('Select a member first', 'warn'); return; }
  const others = app.fleet.members.filter((item) => item.id !== member.id);
  app.overlay = new FormOverlay({
    title: 'Pass a message', submitLabel: 'Queue message',
    note: 'Queued in the recipient\'s inbox; delivered the next time it takes a turn. Choose a sender to make it look like a teammate wrote it.',
    fields: [
      { name: 'from', label: 'from', type: 'select', value: 'user', options: [{ label: 'You', value: 'user' }, ...others.map((item) => ({ label: item.name, value: item.name }))] },
      { name: 'to', label: 'to', type: 'select', value: member.name, options: [...app.fleet.members.map((item) => ({ label: item.name, value: item.name })), { label: 'Everyone', value: '*' }] },
      { name: 'message', label: 'message', type: 'textarea', rows: 5, value: '' },
    ],
    onSubmit: (values) => {
      if (!values.message.trim()) throw new Error('A message is required');
      app.runtime.fleetManager.send({ from: values.from, to: values.to, body: values.message });
      sync(app);
      app.toast('Message queued', 'success');
    },
  });
}

export function openRelay(app) {
  if (!app.fleet.members.length) { app.toast('Add members first (n, or t for a whole team)', 'warn'); return; }
  const lead = selectedMember(app)?.name || app.fleet.members[0].name;
  app.overlay = new FormOverlay({
    title: 'Run the fleet on a task', submitLabel: 'Start relay',
    note: 'The lead gets the task first. Members message each other until someone says done, everyone falls quiet, or the round limit is hit.',
    fields: [
      { name: 'task', label: 'task', type: 'textarea', rows: 6, value: '' },
      { name: 'lead', label: 'lead', type: 'select', value: lead, options: app.fleet.members.map((member) => ({ label: `${member.name} (${member.harness})`, value: member.name })) },
      { name: 'rounds', label: 'max rounds', value: '12' },
    ],
    onSubmit: async (values) => {
      if (!values.task.trim()) throw new Error('A task is required');
      const relay = await app.runtime.fleetManager.relay({
        task: values.task, lead: values.lead, maxRounds: Number(values.rounds) || null, background: true,
      });
      app.fleetTab = 'relays';
      app.fleetList.first();
      sync(app);
      app.toast(`Relay started with ${relay.members.length} members`, 'info');
    },
  });
}

function activate(app, item) {
  if (item?.kind === 'member') openAsk(app, item.raw);
  else if (item?.kind === 'harness') openSpawn(app, item.raw.name);
  else if (item?.kind === 'relay' || item?.kind === 'message') {
    app.overlay = new TextOverlay({
      title: item.kind === 'relay' ? 'Relay outcome' : 'Message', stamp: 'esc closes',
      lines: wrap(item.kind === 'relay' ? (item.raw.final || item.raw.reason || item.raw.task) : item.raw.body, 90),
    });
  }
}

function showTranscript(app, member) {
  const full = app.runtime.fleetManager.details(member.id);
  const lines = [];
  for (const turn of full.history) {
    lines.push(`── ${turn.at.slice(11, 19)} · ${turn.ok ? 'ok' : 'failed'} · ${(turn.durationMs / 1000).toFixed(1)}s ──`);
    if (turn.prompt) lines.push(...wrap(`> ${turn.prompt}`, 90));
    lines.push(...wrap(turn.reply || turn.error || '(no output)', 90), '');
  }
  app.overlay = new TextOverlay({ title: `${member.name} transcript`, lines: lines.length ? lines : ['No turns yet.'], stamp: 'esc closes' });
}

export function handle(app, event) {
  const item = app.fleetList.current;
  if (app.focus === 'fleet') {
    const manager = app.runtime.fleetManager;
    switch (true) {
      case event.name === 'n' && !event.ctrl: openSpawn(app); return true;
      case event.name === 't' && !event.ctrl: openTeam(app); return true;
      case event.name === 'g' && !event.ctrl: openRelay(app); return true;
      case event.name === 'a' && !event.ctrl: openAsk(app); return true;
      case event.name === 'm' && !event.ctrl: openTell(app); return true;
      case event.name === 'o' && !event.ctrl && item?.kind === 'member': showTranscript(app, item.raw); return true;
      case event.name === 'r' && !event.ctrl: void refresh(app, { force: true }); return true;
      case event.name === 'enter': activate(app, item); return true;
      case event.name === 's' && !event.ctrl:
        if (item?.kind === 'member') { manager.stop(item.raw.id); app.toast(`Stopping ${item.raw.name}`, 'warn'); }
        else if (item?.kind === 'relay') { manager.cancelRelay(item.raw.id); app.toast('Cancelling relay', 'warn'); }
        else if (!item) manager.stopAll();
        return true;
      case event.name === 'x' && !event.ctrl && item?.kind === 'member':
        manager.reset(item.raw.id); sync(app); app.toast(`${item.raw.name} reset`, 'info'); return true;
      case event.name === 'delete' && item?.kind === 'member':
        failOnError(app, manager.remove(item.raw.id).then(() => { sync(app); app.toast(`${item.raw.name} removed`, 'info'); }), 'Remove');
        return true;
      default: break;
    }
  }
  return handleCatalog(app, event, {
    filter: app.fleetFilter, filterFocus: 'fleet-filter', listFocus: 'fleet', list: app.fleetList, tabs: TABS,
    cycleTab: (direction) => {
      const index = TABS.findIndex((tab) => tab.id === app.fleetTab);
      app.fleetTab = TABS[(index + direction + TABS.length) % TABS.length].id;
      app.fleetList.first();
    },
    onFilter: () => app.fleetList.first(),
  });
}

export const hints = (app) => {
  const base = [['tab', 'section'], ['n', 'add agent'], ['t', 'team'], ['g', 'relay task'], ['r', 'rescan']];
  if (app.fleetTab === 'members') return [...base, ['↵/a', 'ask'], ['m', 'message'], ['o', 'transcript'], ['s', 'stop'], ['x', 'reset'], ['del', 'remove']];
  if (app.fleetTab === 'relays') return [...base, ['↵', 'outcome'], ['s', 'cancel']];
  if (app.fleetTab === 'harnesses') return [...base, ['↵', 'add one']];
  return [...base, ['↵', 'read']];
};

export const meta = { id: 'fleet', index: '7', title: 'Fleet', shortcut: '7' };

// -------------------------------------------------------------------- rail
//
// The team's chatter, newest first: who is talking to whom, so a relay can be followed without opening anything.
export function rail(app, width) {
  const { theme } = app;
  const feed = [...app.fleet.messages].reverse().slice(0, 40);
  const lines = [];
  const working = app.fleet.members.filter((member) => member.status === 'running');
  for (const member of working) {
    lines.push(spread(
      theme.paint(`${member.name}`, { fg: theme.roles.primary, bold: true }),
      theme.paint(truncate(member.currentTask || 'working', Math.max(4, width - member.name.length - 3)), { fg: theme.roles.muted, italic: true }), width,
    ));
  }
  if (working.length && feed.length) lines.push('');
  if (!feed.length && !working.length) {
    return [gutter(theme) + theme.paint('No team chatter yet. Messages between agents appear here.', { fg: theme.roles.muted, italic: true })];
  }
  for (const message of feed) {
    const tone = message.status === 'dropped' ? theme.roles.danger : message.kind === 'reply' ? theme.roles.info : theme.roles.accent;
    lines.push(spread(
      theme.paint(`${message.from} → ${message.to}`, { fg: tone, bold: true }),
      theme.paint(message.at.slice(11, 19), { fg: theme.roles.faint }), width,
    ));
    lines.push(gutter(theme) + theme.paint(truncate(oneLine(message.dropped || message.body, 300), width - SPACE.gutter), { fg: message.status === 'dropped' ? theme.roles.danger : theme.roles.text }));
  }
  return lines;
}
