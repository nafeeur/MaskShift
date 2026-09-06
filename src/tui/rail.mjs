// The right rail: the plan of attack, live loadout telemetry, the event bus
// and a git pulse. Toggle with ctrl+b, cycle with ctrl+r.
//
// The rail is a column, not a card. Boxing it put a second vertical rule hard
// against the main stage's — a two-column wall down the full height of the
// screen for no information.
//
// It spends exactly one row on chrome, which is what the stage spends on its
// top rail, so the first line of a plan sits on the same screen row as the
// first line of the transcript beside it. It used to spend two, and every row
// in the rail was one out of step with the pane it was reporting on.

import { glyphs, meter, sparkline } from './box.mjs';
import { LAYER } from './regions.mjs';
import { statusMark, statusOf } from './status.mjs';
import { fit, padStart, truncate, visibleWidth, wrap } from './text.mjs';
import { SPACE } from './tokens.mjs';
import { columns, gutter, label as typeLabel, spread } from './type.mjs';

export const RAIL_TABS = ['plan', 'telemetry', 'events', 'git'];

const RAIL_TITLES = { plan: 'PLAN', telemetry: 'LOADOUT', events: 'EVENTS', git: 'GIT' };

/** A rail section heading. Quieter than a pane title, louder than a value. */
function heading(theme, text, width, stamp = '') {
  return spread(typeLabel(theme, text, { tone: theme.roles.label }),
    stamp ? theme.paint(stamp, { fg: theme.roles.faint }) : '', width);
}

function planLines(app, width) {
  const { theme } = app;
  const plan = app.plan;
  const text = Math.max(6, width - SPACE.gutter);
  if (!plan?.steps?.length) {
    return [gutter(theme) + theme.paint('No plan yet. Multi-stage runs publish one here.', { fg: theme.roles.muted, italic: true })];
  }
  const lines = [];
  if (plan.summary) {
    for (const piece of wrap(plan.summary, text)) lines.push(gutter(theme) + theme.paint(piece, { fg: theme.roles.dim }));
    lines.push('');
  }

  const done = plan.steps.filter((step) => statusOf(step.status).kind === 'done').length;
  lines.push(gutter(theme)
    + meter(theme, done, plan.steps.length, Math.max(4, text - 8), { colour: theme.roles.success })
    + theme.paint(padStart(`${done}/${plan.steps.length}`, 8), { fg: theme.roles.muted }));
  lines.push('');

  // The mark carries the state and the gutter carries the mark, so a step's
  // text starts on the same column whether it is done, running or waiting.
  for (const step of plan.steps) {
    const state = statusOf(step.status || 'pending');
    const tone = theme.role(state.tone);
    const body = wrap(step.title || step.text || '', text);
    lines.push(gutter(theme, statusMark(theme, step.status || 'pending', { animate: true }), { tone })
      + theme.paint(body[0] ?? '', { fg: state.kind === 'pending' ? theme.roles.muted : theme.roles.text }));
    for (const piece of body.slice(1)) lines.push(gutter(theme) + theme.paint(piece, { fg: theme.roles.muted }));
  }
  return lines;
}

function telemetryLines(app, width) {
  const { theme } = app;
  const snapshot = app.capabilitySnapshot;
  const text = Math.max(6, width - SPACE.gutter);
  const lines = [];
  const gauges = [
    ['TOOLS', snapshot?.tools?.length ?? 0, app.counts.tools, theme.roles.tool],
    ['SKILLS', snapshot?.skills?.length ?? 0, app.counts.skills, theme.roles.skill],
    ['MCP', snapshot?.mcpServers?.length ?? 0, Math.max(1, app.counts.mcp), theme.roles.mcp],
    ['SUBAGENTS', app.subagents, Math.max(1, app.runtime.config.get().maxParallelSubagents), theme.roles.accent],
  ];
  for (const [name, value, total, colour] of gauges) {
    lines.push(gutter(theme) + spread(
      typeLabel(theme, name, { tone: theme.roles.muted }),
      theme.paint(String(value), { fg: colour, bold: true }) + theme.paint(` / ${total}`, { fg: theme.roles.faint }),
      text,
    ));
    lines.push(gutter(theme) + meter(theme, value, total, text, { colour }));
    lines.push('');
  }

  lines.push(heading(theme, 'Token flow', width));
  lines.push(gutter(theme) + sparkline(theme, app.tokenHistory, text, theme.roles.accent));
  lines.push('');

  const active = [
    ...(snapshot?.tools || []).map((name) => [name, theme.roles.tool]),
    ...(snapshot?.skills || []).map((name) => [name, theme.roles.skill]),
    ...(snapshot?.mcpServers || []).map((name) => [`mcp:${name}`, theme.roles.mcp]),
  ];
  lines.push(heading(theme, 'Active loadout', width, active.length ? String(active.length) : ''));
  if (!active.length) lines.push(gutter(theme) + theme.paint('Nothing summoned yet.', { fg: theme.roles.muted, italic: true }));
  for (const [name, colour] of active.slice(0, 200)) {
    lines.push(gutter(theme, glyphs(theme).dot, { tone: theme.roles.faint })
      + theme.paint(truncate(name, text), { fg: colour }));
  }
  return lines;
}

const EVENT_TONES = {
  'run.started': 'info', 'run.completed': 'success', 'run.failed': 'danger',
  'run.tool-call': 'tool', 'run.tool-result': 'tool', 'run.tool-error': 'danger',
  'run.assistant': 'text', 'run.model-turn': 'muted', 'run.checkpoint': 'warning',
  'run.warning': 'warning', 'run.max-steps': 'warning', 'run.cancelling': 'warning',
};

function eventLines(app, width) {
  const { theme } = app;
  const text = Math.max(6, width - SPACE.gutter);
  if (!app.events.length) return [gutter(theme) + theme.paint('Bus is quiet.', { fg: theme.roles.muted, italic: true })];
  const lines = [];
  for (const event of app.events) {
    const tone = theme.role(EVENT_TONES[event.type] || 'muted');
    // Time and type on fixed columns; the summary wraps into the gutter, so a
    // long event never breaks the timeline running down the left.
    lines.push(gutter(theme) + columns(theme, [
      { text: app.stamp(event.timestamp), width: 5, tone: theme.roles.faint },
      { text: event.type.replace(/^run\./, '').toUpperCase(), tone, bold: true },
    ], text));
    const summary = app.summarizeEvent(event);
    if (summary) {
      for (const piece of wrap(summary, text).slice(0, 3)) {
        lines.push(gutter(theme) + theme.paint(piece, { fg: theme.roles.muted }));
      }
    }
  }
  return lines;
}

function gitLines(app, width) {
  const { theme } = app;
  const text = Math.max(6, width - SPACE.gutter);
  if (!app.gitStatus) return [gutter(theme) + theme.paint('No workspace signal.', { fg: theme.roles.muted, italic: true })];
  const lines = [];
  for (const raw of app.gitStatus.split('\n')) {
    if (!raw.trim()) continue;
    const code = raw.slice(0, 2);
    const branch = raw.startsWith('##');
    const tone = branch ? theme.roles.accent
      : code.includes('?') ? theme.roles.muted
        : code.includes('M') ? theme.roles.info
          : code.includes('A') ? theme.roles.success
            : code.includes('D') ? theme.roles.danger : theme.roles.text;
    // The porcelain code lives in the gutter like every other row marker; the
    // path beside it then starts where all the other text in the rail starts.
    lines.push(branch
      ? gutter(theme) + theme.paint(truncate(raw.replace(/^##\s*/, ''), text), { fg: tone, bold: true })
      : gutter(theme, code.trim() || glyphs(theme).dot, { tone })
        + theme.paint(truncate(raw.slice(3), text), { fg: theme.roles.text }));
  }
  return lines.length ? lines : [gutter(theme, glyphs(theme).check, { tone: theme.roles.success })
    + theme.paint('Working tree clean.', { fg: theme.roles.dim })];
}

export function render(app, region) {
  const { width, height } = region;
  const inner = Math.max(4, width - 2);

  const builders = { plan: planLines, telemetry: telemetryLines, events: eventLines, git: gitLines };
  const body = builders[app.railTab](app, inner);
  app.railView.set(body);

  const stamps = {
    plan: app.plan?.steps?.length ? `${app.plan.steps.length} STEPS` : '',
    telemetry: `${app.subagents} SUB`,
    events: String(app.events.length),
    git: (app.gitBranch || '').toUpperCase(),
  };

  const lines = [
    sectionRow(app, inner, stamps[app.railTab]),
    ...app.railView.render(Math.max(0, height - 1), inner),
  ];

  registerRegions(app, region, inner);
  return lines.slice(0, height).map((line) => ` ${fit(line, inner)}`);
}

/**
 * The section switcher.
 *
 * Spelling the sections out removes a keystroke nobody discovers on their own,
 * and it fits on one row because the active section is marked by weight rather
 * than by a filled chip — the chip belongs to the view tabs, and having two
 * chips lit in two different strips made neither of them mean anything.
 */
function sectionRow(app, width, stamp) {
  const { theme } = app;
  let out = '';
  for (const [index, tab] of RAIL_TABS.entries()) {
    if (index > 0) out += theme.paint(` ${glyphs(theme).dot} `, { fg: theme.roles.border });
    const active = tab === app.railTab;
    const hovered = app.regions?.hoverId === `rail:${tab}`;
    out += theme.paint(RAIL_TITLES[tab], {
      fg: active ? theme.roles.heading : (hovered ? theme.roles.text : theme.roles.muted),
      bold: active,
      underline: active,
    });
  }
  return spread(out, stamp ? theme.paint(stamp, { fg: theme.roles.faint }) : '', width);
}

function registerRegions(app, region, inner) {
  const regions = app.regions;
  if (!regions) return;
  let column = region.column + 1;
  for (const [index, tab] of RAIL_TABS.entries()) {
    if (index > 0) column += 3;
    const span = visibleWidth(RAIL_TITLES[tab]);
    regions.add({
      row: region.row,
      column,
      width: span,
      height: 1,
      id: `rail:${tab}`,
      layer: LAYER.rail + 1,
      onPress: (target) => {
        target.railTab = tab;
        target.focus = 'rail';
        target.railView.toTop();
        if (tab === 'git') void target.refreshGit();
      },
    });
    column += span;
  }

  const bodyHeight = Math.max(0, region.height - 1);
  regions.add({
    row: region.row + 1,
    column: region.column,
    width: region.width,
    height: bodyHeight,
    id: 'rail:body',
    layer: LAYER.rail,
    onPress: (target) => { target.focus = 'rail'; },
    onWheel: (target, event) => {
      target.railView.scroll(event.button === 'wheelup' ? -3 : 3, bodyHeight);
    },
  });
}

export function handle(app, event) {
  if (event.name === 'tab') { app.cycleRail(1); return true; }
  if (event.name === 'c' && app.railTab === 'events') { app.events = []; return true; }
  if (event.name === 'r' && app.railTab === 'git') { void app.refreshGit(); return true; }
  return app.railView.handle(event, Math.max(1, app.bodyRegion.height - 1));
}
