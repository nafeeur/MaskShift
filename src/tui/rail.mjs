// The right rail: plan of attack, live loadout telemetry, the event bus and
// a git pulse. Toggle with ctrl+b, cycle with ctrl+r.

import { glyphs, meter, rule, sparkline } from './box.mjs';
import { LAYER } from './regions.mjs';
import { fit, padStart, truncate, visibleWidth, wrap } from './text.mjs';

export const RAIL_TABS = ['plan', 'telemetry', 'events', 'git'];

const RAIL_TITLES = { plan: 'PLAN', telemetry: 'LOADOUT', events: 'EVENTS', git: 'GIT' };

function planLines(app, width) {
  const { theme } = app;
  const mark = glyphs(theme);
  const plan = app.plan;
  if (!plan?.steps?.length) {
    return [theme.paint('No plan yet. Multi-stage runs publish one here.', { fg: theme.roles.border, italic: true })];
  }
  const lines = [];
  if (plan.summary) {
    for (const piece of wrap(plan.summary, width)) lines.push(theme.paint(piece, { fg: theme.roles.dim, italic: true }));
    lines.push('');
  }
  const done = plan.steps.filter((step) => step.status === 'done' || step.status === 'completed').length;
  lines.push(meter(theme, done, plan.steps.length, width - 8)
    + theme.paint(` ${done}/${plan.steps.length}`, { fg: theme.roles.muted }));
  lines.push('');
  for (const [index, step] of plan.steps.entries()) {
    const state = String(step.status || 'pending');
    const icon = ['done', 'completed'].includes(state) ? mark.check
      : state === 'active' || state === 'in_progress' ? mark.caret
        : state === 'blocked' || state === 'failed' ? mark.cross : mark.dot;
    const tone = ['done', 'completed'].includes(state) ? theme.roles.success
      : state === 'active' || state === 'in_progress' ? theme.palette.gold
        : state === 'blocked' || state === 'failed' ? theme.roles.danger : theme.roles.border;
    const head = theme.paint(`${icon} `, { fg: tone }) + theme.paint(padStart(String(index + 1), 2), { fg: theme.roles.border }) + ' ';
    const body = wrap(step.title || step.text || '', Math.max(6, width - visibleWidth(head)));
    lines.push(`${head}${theme.paint(body[0] ?? '', { fg: tone === theme.roles.border ? theme.roles.muted : theme.roles.text })}`);
    for (const piece of body.slice(1)) lines.push(`${' '.repeat(visibleWidth(head))}${theme.paint(piece, { fg: theme.roles.muted })}`);
  }
  return lines;
}

function telemetryLines(app, width) {
  const { theme } = app;
  const mark = glyphs(theme);
  const snapshot = app.capabilitySnapshot;
  const lines = [];
  const gauges = [
    ['TOOLS', snapshot?.tools?.length ?? 0, app.counts.tools, theme.palette.cyanide],
    ['SKILLS', snapshot?.skills?.length ?? 0, app.counts.skills, theme.palette.violet],
    ['MCP', snapshot?.mcpServers?.length ?? 0, Math.max(1, app.counts.mcp), theme.palette.azure],
    ['SUBAGENTS', app.subagents, Math.max(1, app.runtime.config.get().maxParallelSubagents), theme.palette.gold],
  ];
  for (const [label, value, total, colour] of gauges) {
    lines.push(theme.paint(fit(label, 11), { fg: theme.roles.muted })
      + theme.paint(padStart(String(value), 4), { fg: colour, bold: true })
      + theme.paint(` / ${total}`, { fg: theme.roles.border }));
    lines.push(`${' '.repeat(11)}${meter(theme, value, total, Math.max(4, width - 12), { colour })}`);
  }
  lines.push('');
  lines.push(theme.paint(`${mark.spine} TOKEN FLOW`, { fg: theme.palette.crimson, bold: true }));
  lines.push(sparkline(theme, app.tokenHistory, width - 2, theme.palette.gold));
  lines.push('');
  lines.push(theme.paint(`${mark.spine} ACTIVE LOADOUT`, { fg: theme.palette.crimson, bold: true }));
  const active = [
    ...(snapshot?.tools || []).map((name) => [name, theme.palette.cyanide]),
    ...(snapshot?.skills || []).map((name) => [name, theme.palette.violet]),
    ...(snapshot?.mcpServers || []).map((name) => [`mcp:${name}`, theme.palette.azure]),
  ];
  if (!active.length) lines.push(theme.paint('Nothing summoned yet.', { fg: theme.roles.border, italic: true }));
  for (const [name, colour] of active.slice(0, 200)) {
    lines.push(theme.paint(`${mark.dot} `, { fg: theme.roles.border }) + theme.paint(truncate(name, width - 2), { fg: colour }));
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
  const mark = glyphs(theme);
  if (!app.events.length) return [theme.paint('Bus is quiet.', { fg: theme.roles.border, italic: true })];
  const lines = [];
  for (const event of app.events) {
    const tone = theme.role(EVENT_TONES[event.type] || 'muted');
    const time = theme.paint(app.stamp(event.timestamp), { fg: theme.roles.border });
    const type = theme.paint(truncate(event.type.replace(/^run\./, ''), 18), { fg: tone, bold: true });
    lines.push(fit(`${time} ${type}`, width));
    const summary = app.summarizeEvent(event);
    if (summary) {
      for (const piece of wrap(summary, width - 2).slice(0, 3)) {
        lines.push(theme.paint(`  ${piece}`, { fg: theme.roles.muted }));
      }
    }
  }
  return lines;
}

function gitLines(app, width) {
  const { theme } = app;
  if (!app.gitStatus) return [theme.paint('No workspace signal.', { fg: theme.roles.border, italic: true })];
  const lines = [];
  for (const raw of app.gitStatus.split('\n')) {
    if (!raw.trim()) continue;
    const status = raw.slice(0, 2);
    const tone = raw.startsWith('##') ? theme.palette.gold
      : status.includes('?') ? theme.roles.border
        : status.includes('M') ? theme.palette.azure
          : status.includes('A') ? theme.roles.success
            : status.includes('D') ? theme.roles.danger : theme.roles.text;
    lines.push(theme.paint(truncate(raw, width), { fg: tone }));
  }
  return lines.length ? lines : [theme.paint('Working tree clean.', { fg: theme.roles.success })];
}

/**
 * The rail is a column, not a card.
 *
 * Boxing it put a second vertical rule hard against the main stage's — a
 * two-column wall down the full height of the screen for no information. A
 * single divider separates the two just as clearly, gives the rail two more
 * columns of content, and leaves room to spell the sections out as tabs
 * instead of hiding them behind ctrl+r.
 */
export function render(app, region) {
  const { theme } = app;
  const { width, height } = region;
  const focused = app.focus === 'rail';
  // The main stage already draws a vertical rule along this boundary; adding
  // the rail's own would just be the same wall one column wider. A gutter and
  // the stage's edge separate them.
  const inner = Math.max(4, width - 2);

  const builders = { plan: planLines, telemetry: telemetryLines, events: eventLines, git: gitLines };
  const body = builders[app.railTab](app, inner);
  app.railView.set(body);

  const stamps = {
    plan: app.plan?.steps?.length ? `${app.plan.steps.length} steps` : '',
    telemetry: `${app.subagents} sub`,
    events: `${app.events.length}`,
    git: app.gitBranch || '',
  };

  const lines = [
    tabRow(app, inner),
    // With no frame of its own, this rule is where the rail shows that it owns
    // the keyboard.
    rule(theme, inner, '', {
      stamp: stamps[app.railTab],
      colour: focused ? theme.roles.borderActive : theme.roles.border,
      weight: focused ? 'heavy' : 'light',
    }),
    ...app.railView.render(Math.max(0, height - 2), inner),
  ];

  registerRegions(app, region, inner);
  return lines.slice(0, height).map((line) => ` ${fit(line, inner)}`);
}

// Spelling the sections out costs one row and removes a keystroke nobody
// discovers on their own.
function tabRow(app, width) {
  const { theme } = app;
  let out = '';
  for (const tab of RAIL_TABS) {
    const label = RAIL_TITLES[tab];
    out += tab === app.railTab
      ? theme.paint(` ${label} `, { fg: theme.palette.ink, bg: theme.palette.crimson, bold: true })
      : theme.paint(` ${label} `, { fg: app.regions?.hoverId === `rail:${tab}` ? theme.roles.text : theme.roles.muted });
  }
  return fit(out, width);
}

function registerRegions(app, region, inner) {
  const regions = app.regions;
  if (!regions) return;
  let column = region.column + 1;
  for (const tab of RAIL_TABS) {
    const span = visibleWidth(RAIL_TITLES[tab]) + 2;
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

  const bodyHeight = Math.max(0, region.height - 2);
  regions.add({
    row: region.row + 2,
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
  return app.railView.handle(event, Math.max(1, app.bodyRegion.height - 2));
}
