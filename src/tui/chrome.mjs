// Persistent chrome: the identity band, the view tab strip and the status rail.

import { badge, glyphs } from './box.mjs';
import { LAYER } from './regions.mjs';
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
  const targetChip = chip(theme, 'TARGET', truncate(target, targetWidth), theme.palette.bone);
  const personaChip = chip(theme, 'PERSONA', truncate(app.modelRef || config.defaultModel, modelWidth), theme.palette.gold);
  const left = [targetChip, personaChip].join(separator);

  const body = `${brand} ${left}`;
  const gap = Math.max(1, width - visibleWidth(body) - visibleWidth(tail) - 1);

  // The two things most often changed mid-run are the workspace and the model,
  // so both open their picker on a click.
  const regions = app.regions;
  if (regions) {
    const targetColumn = visibleWidth(brand) + 1;
    regions.add({
      row: 0, column: targetColumn, width: visibleWidth(targetChip), height: 1,
      id: 'chrome:target', layer: LAYER.chrome,
      onPress: (instance) => instance.openWorkspaceDialog(),
    });
    regions.add({
      row: 0,
      column: targetColumn + visibleWidth(targetChip) + visibleWidth(separator),
      width: visibleWidth(personaChip),
      height: 1,
      id: 'chrome:persona', layer: LAYER.chrome,
      onPress: (instance) => instance.openModelPicker(),
    });
    if (right.length === rightChips.length) {
      regions.add({
        row: 0,
        column: visibleWidth(body) + gap,
        width: visibleWidth(right[0]),
        height: 1,
        id: 'chrome:mode', layer: LAYER.chrome,
        onPress: (instance) => instance.cyclePermissionMode(),
      });
    }
  }

  return fit(`${body}${' '.repeat(gap)}${tail} `, width);
}

export function tabStrip(app, width) {
  const { theme } = app;
  const mark = glyphs(theme);
  const regions = app.regions;
  let out = ' ';
  let column = 1;

  for (const [index, view] of app.views.entries()) {
    const active = view.id === app.view;
    const hovered = regions?.hoverId === `tab:${view.id}`;
    const label = ` ${view.index} ${view.title} `;
    out += active
      ? theme.paint(label, { fg: theme.palette.ink, bg: theme.palette.crimson, bold: true })
      : theme.paint(label, { fg: hovered ? theme.roles.text : theme.roles.muted, bold: hovered });

    regions?.add({
      row: 1,
      column,
      width: visibleWidth(label),
      height: 1,
      id: `tab:${view.id}`,
      layer: LAYER.chrome,
      onPress: (target) => target.switchView(index),
    });
    column += visibleWidth(label);

    // A separator belongs *between* tabs; the trailing one had nothing to
    // separate the last tab from.
    if (index < app.views.length - 1) {
      out += theme.paint(mark.pipe, { fg: theme.roles.border });
      column += 1;
    }
  }

  const railHint = app.railVisible
    ? theme.paint(` ${app.railTab.toUpperCase()} `, { fg: theme.palette.ink, bg: theme.palette.hairline, bold: true })
    : theme.paint(' RAIL OFF ', { fg: theme.roles.border });
  const gap = Math.max(1, width - visibleWidth(out) - visibleWidth(railHint) - 1);

  regions?.add({
    row: 1,
    column: width - visibleWidth(railHint) - 1,
    width: visibleWidth(railHint),
    height: 1,
    id: 'chrome:rail-toggle',
    layer: LAYER.chrome,
    onPress: (target) => { target.railVisible = !target.railVisible; target.screen.invalidate(); },
  });

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

  const metrics = [
    chip(theme, 'TURN', String(app.metrics.step).padStart(2, '0')),
    chip(theme, 'TIME', app.metrics.elapsed),
    chip(theme, 'TOK', app.metrics.tokens),
    chip(theme, 'COST', app.metrics.cost),
  ].join(theme.paint(`  ${mark.dot}  `, { fg: theme.roles.border }));

  // The title used to be clipped at a third of the width regardless of how
  // much space the metrics actually left, so a long heist name was cut with
  // sixty blank columns beside it. Give it whatever remains.
  const lead = `${lamp} ${theme.paint(status.toUpperCase(), { fg: tone, bold: true })} ${theme.paint(mark.pipe, { fg: theme.roles.border })} `;
  const room = Math.max(8, width - visibleWidth(lead) - visibleWidth(metrics) - 4);
  const title = truncate(app.sessionTitle || (run ? 'RUN IN PROGRESS' : 'STANDBY FOR ORDERS'), room);

  const left = `${lead}${theme.paint(title, { fg: theme.roles.text })}`;
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(metrics) - 2);

  app.regions?.add({
    row: app.screen.size.rows - 2,
    column: 1,
    width: visibleWidth(left),
    height: 1,
    id: 'chrome:session',
    layer: LAYER.chrome,
    onPress: (instance) => instance.openSessionPicker(),
  });

  return fit(` ${left}${' '.repeat(gap)}${metrics} `, width);
}

/**
 * The hint rail doubles as a menu: a hint may carry a third element, a
 * handler, and then the key and its label are clickable as well as typeable.
 */
export function hintRail(app, width) {
  const { theme } = app;
  const mark = glyphs(theme);
  const hints = app.currentHints();
  const separator = theme.paint(`  ${mark.dot}  `, { fg: theme.roles.border });
  const row = app.screen.size.rows - 1;
  let column = 1;
  const pieces = [];

  for (const [index, [key, label, action]] of hints.entries()) {
    if (index > 0) { pieces.push(separator); column += visibleWidth(separator); }
    const hovered = app.regions?.hoverId === `hint:${key}`;
    const text = theme.paint(key, { fg: theme.palette.gold, bold: true })
      + theme.paint(` ${label}`, { fg: hovered ? theme.roles.text : theme.roles.muted });
    const span = visibleWidth(key) + 1 + visibleWidth(label);
    if (action) {
      app.regions?.add({
        row, column, width: span, height: 1,
        id: `hint:${key}`, layer: LAYER.chrome,
        onPress: (instance) => action(instance),
      });
    }
    pieces.push(text);
    column += span;
  }

  const body = pieces.join('');
  const version = theme.paint(`v${app.version}`, { fg: theme.roles.border });
  const gap = Math.max(1, width - visibleWidth(body) - visibleWidth(version) - 2);
  return fit(` ${body}${' '.repeat(gap)}${version} `, width);
}

export { badge, padStart, repeat };
