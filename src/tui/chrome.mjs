// Persistent chrome: the identity band, the view tab strip and the status rail.

import { badge, glyphs } from './box.mjs';
import { fit, padStart, repeat, truncate, visibleWidth } from './text.mjs';

const MODE_TONES = { overdrive: 'primary', balanced: 'warning', review: 'info' };

function chip(theme, label, value, tone) {
  return theme.paint(`${label} `, { fg: theme.roles.border })
    + theme.paint(value, { fg: tone || theme.roles.text, bold: true });
}

export function headerBand(app, width) {
  const { theme } = app;
  const mark = glyphs(theme);
  const config = app.runtime.config.get();
  const workspace = app.workspace;
  const brand = theme.paint(' MASK', { fg: theme.palette.ink, bg: theme.palette.crimson, bold: true })
    + theme.paint('SHIFT ', { fg: theme.palette.ink, bg: theme.palette.gold, bold: true });
  const gapPair = theme.paint('  ', {});
  const separator = theme.paint(`  ${mark.dot}  `, { fg: theme.roles.border });

  const mode = String(config.permissionMode || 'overdrive');
  const online = app.providers.filter((provider) => provider.status === 'online').length;

  // Right-hand telemetry, dropped from the left of the group as space runs out.
  const rightChips = [
    theme.paint(mode.toUpperCase(), { fg: theme.role(MODE_TONES[mode] || 'primary'), bold: true }),
    chip(theme, 'T', String(app.counts.tools).padStart(3, '0'), theme.palette.cyanide),
    chip(theme, 'S', String(app.counts.skills).padStart(3, '0'), theme.palette.violet),
    chip(theme, 'MCP', String(app.counts.mcp).padStart(2, '0'), theme.palette.azure),
    theme.paint(mark.lamp, { fg: online ? theme.roles.success : theme.roles.danger })
      + theme.paint(online ? ' LINK' : ' DARK', { fg: theme.roles.muted }),
  ];

  // Reserve enough room for the target and persona before spending on chips.
  const reserved = 34;
  let spare = width - visibleWidth(brand) - 3 - reserved;
  const right = [];
  for (const piece of [...rightChips].reverse()) {
    const cost = visibleWidth(piece) + 2;
    if (cost > spare) break;
    right.unshift(piece);
    spare -= cost;
  }

  const tail = right.join(gapPair);
  const available = Math.max(12, width - visibleWidth(brand) - visibleWidth(tail) - 3 - 20);
  const targetWidth = Math.max(6, Math.ceil(available * 0.58));
  const modelWidth = Math.max(6, available - targetWidth);
  const target = workspace ? `${workspace.name}${app.gitBranch ? ` ${mark.dot} ${app.gitBranch}` : ''}` : 'NO TARGET';
  const left = [
    chip(theme, 'TARGET', truncate(target, targetWidth), theme.palette.bone),
    chip(theme, 'PERSONA', truncate(app.modelRef || config.defaultModel, modelWidth), theme.palette.gold),
  ].join(separator);

  const body = `${brand} ${left}`;
  const gap = Math.max(1, width - visibleWidth(body) - visibleWidth(tail) - 1);
  return fit(`${body}${' '.repeat(gap)}${tail} `, width);
}

export function tabStrip(app, width) {
  const { theme } = app;
  const mark = glyphs(theme);
  let out = ' ';
  for (const view of app.views) {
    const active = view.id === app.view;
    const label = `${view.index} ${view.title}`;
    out += active
      ? theme.paint(` ${label} `, { fg: theme.palette.ink, bg: theme.palette.crimson, bold: true })
      : theme.paint(` ${label} `, { fg: theme.roles.muted });
    out += theme.paint(mark.pipe, { fg: theme.roles.border });
  }
  const railHint = app.railVisible
    ? theme.paint(` ${app.railTab.toUpperCase()} `, { fg: theme.palette.ink, bg: theme.palette.hairline, bold: true })
    : theme.paint(' RAIL OFF ', { fg: theme.roles.border });
  const gap = Math.max(1, width - visibleWidth(out) - visibleWidth(railHint) - 1);
  return fit(`${out}${' '.repeat(gap)}${railHint} `, width);
}

const STATUS_TONES = {
  running: 'primary', queued: 'warning', completed: 'success',
  failed: 'danger', cancelled: 'muted', max_steps: 'warning', idle: 'muted',
};

export function statusRail(app, width) {
  const { theme } = app;
  const mark = glyphs(theme);
  const run = app.activeRun;
  const status = run ? (run.status || 'running') : 'idle';
  const tone = theme.role(STATUS_TONES[status] || 'muted');
  const lamp = run && ['running', 'queued'].includes(status)
    ? theme.paint(app.spinner.frame(theme), { fg: tone })
    : theme.paint(mark.lamp, { fg: tone });

  const title = run
    ? truncate(app.sessionTitle || 'RUN IN PROGRESS', Math.max(10, Math.floor(width * 0.32)))
    : truncate(app.sessionTitle || 'STANDBY FOR ORDERS', Math.max(10, Math.floor(width * 0.32)));

  const metrics = [
    chip(theme, 'TURN', String(app.metrics.step).padStart(2, '0')),
    chip(theme, 'TIME', app.metrics.elapsed),
    chip(theme, 'TOK', app.metrics.tokens),
    chip(theme, 'COST', app.metrics.cost),
  ].join(theme.paint(`  ${mark.dot}  `, { fg: theme.roles.border }));

  const left = `${lamp} ${theme.paint(status.toUpperCase(), { fg: tone, bold: true })} ${theme.paint(mark.pipe, { fg: theme.roles.border })} ${theme.paint(title, { fg: theme.roles.text })}`;
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(metrics) - 2);
  return fit(` ${left}${' '.repeat(gap)}${metrics} `, width);
}

export function hintRail(app, width) {
  const { theme } = app;
  const mark = glyphs(theme);
  const hints = app.currentHints();
  const separator = theme.paint(`  ${mark.dot}  `, { fg: theme.roles.border });
  const body = hints.map(([key, label]) => (
    theme.paint(key, { fg: theme.palette.gold, bold: true }) + theme.paint(` ${label}`, { fg: theme.roles.muted })
  )).join(separator);
  const version = theme.paint(`v${app.version}`, { fg: theme.roles.border });
  const gap = Math.max(1, width - visibleWidth(body) - visibleWidth(version) - 2);
  return fit(` ${body}${' '.repeat(gap)}${version} `, width);
}

export { badge, padStart, repeat };
