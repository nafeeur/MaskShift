// The right sidebar: the plan, the tools in use, the event feed
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

import { glyphs, meter, rule, sparkline } from './box.mjs';
import { LAYER } from './regions.mjs';
import { statusMark, statusOf } from './status.mjs';
import { fit, padEnd, padStart, truncate, visibleWidth, wrap } from './text.mjs';
import { SPACE } from './tokens.mjs';
import { columns, gutter, label as typeLabel, spread } from './type.mjs';

export const RAIL_TABS = ['plan', 'telemetry', 'events'];

export const RAIL_TITLES = { plan: 'Plan', telemetry: 'Active', events: 'Events' };

/**
 * A rail section heading: a hairline rule with the name set into it, and an optional stamp at the
 * far end. Sections are separated by this one line, never by a box.
 */
function heading(theme, text, width, stamp = '') {
  return rule(theme, width, text, { weight: 'square', stamp, colour: theme.roles.border });
}

/** An empty state: a short complete sentence, then what to do about it. */
function emptyState(theme, text, sentence, hint) {
  const lines = wrap(sentence, text).map((piece) => gutter(theme) + theme.paint(piece, { fg: theme.roles.muted }));
  if (hint) lines.push(gutter(theme) + theme.paint(hint, { fg: theme.roles.faint }));
  return lines;
}

const GAUGE_LABEL = 10;
const GAUGE_VALUE = 9;

/**
 * One dashboard row: a fixed-width label, a meter that takes the rest, and a right-aligned value.
 * Every gauge in the rail goes through this, so the labels, the bars and the numbers each form
 * their own straight column.
 */
function gaugeRow(theme, name, value, total, text, { colour, valueText = null } = {}) {
  const valueCell = valueText ?? `${value}/${total}`;
  const bar = Math.max(3, text - GAUGE_LABEL - GAUGE_VALUE);
  return gutter(theme)
    + theme.paint(padEnd(name, GAUGE_LABEL), { fg: theme.roles.muted })
    + meter(theme, value, total, bar, { colour })
    + theme.paint(padStart(valueCell, GAUGE_VALUE), { fg: colour, bold: true });
}

function planLines(app, width) {
  const { theme } = app;
  const plan = app.plan;
  const text = Math.max(6, width - SPACE.gutter);
  if (!plan?.steps?.length) {
    return emptyState(theme, text, 'No plan yet. Multi-stage runs publish one here.', 'ctrl+r  next section');
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

// Where the window size came from, in the words a user would use.
const CONTEXT_SOURCES = {
  config: 'set in config', provider: 'reported by the provider', family: 'from the model family',
  learned: 'learned from an overflow', default: 'assumed (model unknown)',
};

function compactTokens(value) {
  if (!value) return '—';
  return value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(value);
}

function telemetryLines(app, width) {
  const { theme } = app;
  const snapshot = app.capabilitySnapshot;
  const text = Math.max(6, width - SPACE.gutter);
  const lines = [];
  const context = app.contextState;
  if (context) {
    const tone = theme.role(context.tone);
    lines.push(heading(theme, 'Context', width, String(context.tier || '')));
    lines.push(gaugeRow(theme, 'Used', context.used, context.window, text, {
      colour: tone, valueText: `${Math.round(context.ratio * 100)}%`,
    }));
    lines.push(gutter(theme) + theme.paint(`${context.label} tokens`, { fg: theme.roles.text }));
    const origin = CONTEXT_SOURCES[context.source] || context.source || 'unknown';
    for (const piece of wrap(`Window ${origin}. Replies up to ${compactTokens(context.maxOutputTokens)} tokens.`, text)) {
      lines.push(gutter(theme) + theme.paint(piece, { fg: theme.roles.muted }));
    }
  }
  lines.push(heading(theme, 'Loaded', width));
  const gauges = [
    ['Tools', snapshot?.tools?.length ?? 0, app.counts.tools, theme.roles.tool],
    ['Skills', snapshot?.skills?.length ?? 0, app.counts.skills, theme.roles.skill],
    ['MCP', snapshot?.mcpServers?.length ?? 0, Math.max(1, app.counts.mcp), theme.roles.mcp],
    ['Subagents', app.subagents, Math.max(1, app.runtime.config.get().maxParallelSubagents), theme.roles.accent],
  ];
  for (const [name, value, total, colour] of gauges) {
    lines.push(gaugeRow(theme, name, value, total, text, { colour }));
  }

  lines.push(heading(theme, 'Token flow', width));
  lines.push(gutter(theme) + sparkline(theme, app.tokenHistory, text, theme.roles.accent));

  const active = [
    ...(snapshot?.tools || []).map((name) => [name, theme.roles.tool]),
    ...(snapshot?.skills || []).map((name) => [name, theme.roles.skill]),
    ...(snapshot?.mcpServers || []).map((name) => [`mcp:${name}`, theme.roles.mcp]),
  ];
  lines.push(heading(theme, 'Active tools', width, active.length ? String(active.length) : ''));
  if (!active.length) lines.push(...emptyState(theme, text, 'Nothing loaded yet. Tools and skills appear here as a run uses them.'));
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
  if (!app.events.length) return emptyState(theme, text, 'No events yet. Start a run and its steps appear here.', 'c  clear when there are some');
  const lines = [];
  for (const event of app.events) {
    const tone = theme.role(EVENT_TONES[event.type] || 'muted');
    // Time and type on fixed columns; the summary wraps into the gutter, so a
    // long event never breaks the timeline running down the left.
    lines.push(gutter(theme) + columns(theme, [
      { text: app.stamp(event.timestamp), width: 5, tone: theme.roles.faint },
      { text: event.type.replace(/^run\./, ''), tone, bold: true },
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

export function render(app, region) {
  const { width, height } = region;
  const inner = Math.max(4, width - 2);

  const builders = { plan: planLines, telemetry: telemetryLines, events: eventLines };
  const body = builders[app.railTab](app, inner);
  app.railView.set(body);

  const stamps = {
    plan: app.plan?.steps?.length ? `${app.plan.steps.length} steps` : '',
    telemetry: `${app.subagents} subagents`,
    events: String(app.events.length),
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
    out += hovered && theme.enabled && !active
      ? theme.paint(RAIL_TITLES[tab], { fg: theme.roles.onPrimary, bg: theme.roles.dim, bold: true })
      : theme.paint(RAIL_TITLES[tab], {
        fg: active ? theme.roles.heading : theme.roles.muted,
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
  return app.railView.handle(event, Math.max(1, app.bodyRegion.height - 1));
}

/**
 * A single-section rail pane for a non-chat view (see files.mjs, git.mjs,
 * browser.mjs, runtime.mjs and capabilities.mjs's own `rail()` exports) —
 * the same one-row heading, click region and scroll wiring `render()` above
 * gives the plan/active/events tabs, without every view reimplementing it.
 * Each caller passes its own Viewport so scroll position doesn't leak
 * between views that happen to share the rail slot at different times.
 */
export function renderPane(app, region, { title, stamp = '', lines, viewport }) {
  const { theme } = app;
  const { width, height } = region;
  const inner = Math.max(4, width - 2);
  viewport.set(lines);
  const out = [
    heading(theme, title, inner, stamp),
    ...viewport.render(Math.max(0, height - 1), inner),
  ];
  registerPaneRegions(app, region, viewport);
  return out.slice(0, height).map((line) => ` ${fit(line, inner)}`);
}

function registerPaneRegions(app, region, viewport) {
  const regions = app.regions;
  if (!regions) return;
  const bodyHeight = Math.max(0, region.height - 1);
  regions.add({
    row: region.row + 1,
    column: region.column,
    width: region.width,
    height: bodyHeight,
    id: 'rail:pane-body',
    layer: LAYER.rail,
    onPress: (target) => { target.focus = 'rail'; },
    onWheel: (target, event) => { viewport.scroll(event.button === 'wheelup' ? -3 : 3, bodyHeight); },
  });
}
