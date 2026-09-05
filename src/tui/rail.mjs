// The right rail: plan of attack, live loadout telemetry, the event bus and
// a git pulse. Toggle with ctrl+b, cycle with ctrl+r.

import { glyphs, meter, panel, sparkline } from './box.mjs';
import { fit, padStart, truncate, visibleWidth, wrap } from './text.mjs';

export const RAIL_TABS = ['plan', 'telemetry', 'events', 'git'];

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

export function render(app, region) {
  const { theme } = app;
  const { width, height } = region;
  const inner = width - 4;
  const builders = { plan: planLines, telemetry: telemetryLines, events: eventLines, git: gitLines };
  const body = builders[app.railTab](app, inner);
  app.railView.set(body);

  const titles = { plan: 'PLAN OF ATTACK', telemetry: 'LOADOUT', events: 'EVENT FEED', git: 'GIT PULSE' };
  const stamps = {
    plan: app.plan?.steps?.length ? `${app.plan.steps.length} steps` : '',
    telemetry: `${app.subagents} subagents`,
    events: `${app.events.length} events`,
    git: app.gitBranch || '',
  };

  return panel({
    theme, width, height, title: titles[app.railTab], index: '',
    stamp: stamps[app.railTab], focused: app.focus === 'rail',
    body: app.railView.render(height - 2, inner),
  });
}

export function handle(app, event) {
  if (event.name === 'tab') { app.cycleRail(1); return true; }
  if (event.name === 'c' && app.railTab === 'events') { app.events = []; return true; }
  if (event.name === 'r' && app.railTab === 'git') { void app.refreshGit(); return true; }
  return app.railView.handle(event, app.bodyRegion.height - 2);
}
