// Persistent chrome: the identity band, the view tab strip, the status rail
// and the hint rail.
//
// Four rows frame every view, so they have to be readable at a glance and
// completely silent otherwise. Two rules do most of the work:
//
//   Every piece of telemetry is written the same way — a muted upper-case
//   label followed by its value. The band used to mix `TARGET MaskShift` with
//   bare `T 148` and a lone `OVERDRIVE`, which read as three unrelated
//   interfaces sharing a row.
//
//   The active view tab is the only filled chip on screen. Everything else in
//   the chrome is text on the background.

import { glyphs } from './box.mjs';
import { LAYER } from './regions.mjs';
import { statusOf, statusGlyph } from './status.mjs';
import { fit, padStart, repeat, truncate, visibleWidth } from './text.mjs';
import { BREAKPOINT } from './tokens.mjs';
import { chip, key as typeKey } from './type.mjs';

// Only the permissive mode is tinted. Colouring every mode made the header
// carry three saturated values that all meant "this is normal".
const MODE_TONES = { overdrive: 'warning' };

/** The one way a value is labelled anywhere in the chrome. */
function stat(theme, name, value, tone) {
  return theme.paint(`${name} `, { fg: theme.roles.muted })
    + theme.paint(value, { fg: tone || theme.roles.text, bold: true });
}

/**
 * The separator between two pieces of chrome telemetry.
 *
 * Three columns, not five. At five the identity band could not fit a workspace
 * name, a branch and the capability counts at 132 columns, and the branch was
 * being truncated while blank columns sat between the chips.
 */
function divider(theme) {
  return theme.paint(` ${glyphs(theme).dot} `, { fg: theme.roles.border });
}

/**
 * The wordmark.
 *
 * Drawn as coloured text rather than as a filled chip. When it was a chip the
 * top-left corner stacked three solid blocks in three consecutive rows — the
 * brand, the active tab and the panel title — and none of them read as the
 * selected one.
 */
export function wordmarkInline(theme) {
  return theme.paint('MASK', { fg: theme.roles.primary, bold: true })
    + theme.paint('SHIFT', { fg: theme.roles.text, bold: true });
}

export function headerBand(app, width) {
  const { theme } = app;
  const config = app.runtime.config.get();
  const workspace = app.workspace;
  const brand = ` ${wordmarkInline(theme)}`;
  const mode = String(config.permissionMode || 'overdrive');
  const online = app.providers.filter((provider) => provider.status === 'online').length;

  // Right-hand telemetry, dropped from the left of the group as space runs out.
  const link = theme.paint(`${glyphs(theme).lamp} `, { fg: online ? theme.roles.success : theme.roles.muted })
    + theme.paint(online ? 'LINK' : 'DARK', { fg: online ? theme.roles.text : theme.roles.muted, bold: true });
  // Rendered left to right; dropped in reverse priority. What survives longest
  // is what an operator would actually miss — whether there is a provider at
  // all, and how much this session is allowed to do — not a capability count.
  const rightChips = [
    { priority: 1, text: stat(theme, 'MODE', mode.toUpperCase(), theme.role(MODE_TONES[mode] || 'text')) },
    { priority: 3, text: stat(theme, 'TOOLS', String(app.counts.tools), theme.roles.tool) },
    { priority: 4, text: stat(theme, 'SKILLS', String(app.counts.skills), theme.roles.skill) },
    { priority: 2, text: stat(theme, 'MCP', String(app.counts.mcp), theme.roles.mcp) },
    { priority: 0, text: link },
  ];

  // Budget the row explicitly instead of guessing at it. The left group's
  // fixed cost — the wordmark, two separators and two labels — plus a floor
  // under the two values it carries is what the right group has to fit around;
  // chips fall off the left of that group until it does.
  const gapWidth = visibleWidth(divider(theme));
  const labelCost = visibleWidth('TARGET ') + visibleWidth('PERSONA ');
  const leftFixed = visibleWidth(brand) + gapWidth * 2 + labelCost;
  const valueFloor = 24;

  let spare = width - leftFixed - valueFloor - 3;
  const kept = new Set();
  for (const chipItem of [...rightChips].sort((a, b) => a.priority - b.priority)) {
    const cost = visibleWidth(chipItem.text) + (kept.size ? gapWidth : 0);
    if (cost > spare) continue;
    kept.add(chipItem);
    spare -= cost;
  }
  const right = rightChips.filter((chipItem) => kept.has(chipItem)).map((chipItem) => chipItem.text);

  const tail = right.join(divider(theme));
  const available = Math.max(12, width - leftFixed - visibleWidth(tail) - 3);
  const target = workspace ? `${workspace.name}${app.gitBranch ? ` ${glyphs(theme).dot} ${app.gitBranch}` : ''}` : 'NO TARGET';
  const model = app.modelRef || config.defaultModel || '';
  // The model reference is usually short and fixed; the workspace and branch
  // are neither. Give the model what it actually needs and hand the remainder
  // to the target instead of splitting the row down the middle and truncating
  // a branch name while blank columns sat beside it.
  const modelWidth = Math.max(6, Math.min(visibleWidth(model), Math.floor(available * 0.45)));
  const targetWidth = Math.max(6, available - modelWidth);
  const targetChip = stat(theme, 'TARGET', truncate(target, targetWidth), theme.roles.text);
  const personaChip = stat(theme, 'PERSONA', truncate(model, modelWidth), theme.roles.text);
  const left = [targetChip, personaChip].join(divider(theme));

  const body = `${brand}${divider(theme)}${left}`;
  const gap = Math.max(1, width - visibleWidth(body) - visibleWidth(tail) - 1);

  // The two things most often changed mid-run are the workspace and the model,
  // so both open their picker on a click.
  const regions = app.regions;
  if (regions) {
    const targetColumn = visibleWidth(brand) + visibleWidth(divider(theme));
    regions.add({
      row: 0, column: targetColumn, width: visibleWidth(targetChip), height: 1,
      id: 'chrome:target', layer: LAYER.chrome,
      onPress: (instance) => instance.openWorkspaceDialog(),
    });
    regions.add({
      row: 0,
      column: targetColumn + visibleWidth(targetChip) + visibleWidth(divider(theme)),
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

/**
 * The view tabs.
 *
 * The active tab is the one filled chip in the interface: it is what "you are
 * here" looks like, and nothing else may borrow it. Panels below no longer
 * repeat the view's name, so this row is also the only place it appears.
 */
export function tabStrip(app, width) {
  const { theme } = app;
  const regions = app.regions;
  let out = ' ';
  let column = 1;

  for (const [index, view] of app.views.entries()) {
    const active = view.id === app.view;
    const hovered = regions?.hoverId === `tab:${view.id}`;
    const plain = ` ${view.index} ${view.title} `;
    // The ordinal is navigation, not content: it stays a step quieter than the
    // name it belongs to, in both states.
    const painted = active
      ? theme.paint(' ', { bg: theme.roles.primary })
        + theme.paint(view.index, { fg: theme.mixed(theme.roles.primary, theme.roles.onPrimary, 0.55), bg: theme.roles.primary, bold: true })
        + theme.paint(` ${view.title} `, { fg: theme.roles.onPrimary, bg: theme.roles.primary, bold: true })
      : theme.paint(` ${view.index} `, { fg: theme.roles.faint })
        + theme.paint(`${view.title} `, { fg: hovered ? theme.roles.text : theme.roles.muted, bold: hovered });
    out += painted;

    regions?.add({
      row: 1, column, width: visibleWidth(plain), height: 1,
      id: `tab:${view.id}`, layer: LAYER.chrome,
      onPress: (target) => target.switchView(index),
    });
    column += visibleWidth(plain);

    if (index < app.views.length - 1) {
      out += theme.paint(glyphs(theme).pipe, { fg: theme.roles.border });
      column += 1;
    }
  }

  const railHovered = regions?.hoverId === 'chrome:rail-toggle';
  const railHint = app.railVisible
    ? theme.paint('RAIL ', { fg: theme.roles.muted }) + theme.paint(app.railTab.toUpperCase(), { fg: railHovered ? theme.roles.text : theme.roles.label, bold: true })
    : theme.paint('RAIL ', { fg: theme.roles.faint }) + theme.paint('OFF', { fg: theme.roles.faint });

  // At 80 columns the tabs fill the row on their own. A hint clipped to "RA…"
  // is worse than no hint: drop it whole, the way every other piece of chrome
  // drops rather than shrinks.
  const room = width - visibleWidth(out) - 2;
  if (visibleWidth(railHint) > room) return fit(out, width);

  const gap = Math.max(1, width - visibleWidth(out) - visibleWidth(railHint) - 1);
  regions?.add({
    row: 1, column: width - visibleWidth(railHint) - 1,
    width: visibleWidth(railHint), height: 1,
    id: 'chrome:rail-toggle', layer: LAYER.chrome,
    onPress: (target) => { target.railVisible = !target.railVisible; target.screen.invalidate(); },
  });

  return fit(`${out}${' '.repeat(gap)}${railHint} `, width);
}

/**
 * The status rail: what the run is doing, what it is called, what it has cost.
 *
 * State comes from the shared vocabulary, so the lamp beside a failed run is
 * the same glyph and the same red as the mark beside a failed plan step.
 */
export function statusRail(app, width) {
  const { theme } = app;
  const run = app.activeRun;
  const status = run ? (run.status || 'running') : 'idle';
  const state = statusOf(status);
  const tone = theme.role(state.tone);

  const metrics = [
    stat(theme, 'TURN', String(app.metrics.step).padStart(2, '0')),
    stat(theme, 'TIME', app.metrics.elapsed),
    stat(theme, 'TOKENS', app.metrics.tokens),
    stat(theme, 'COST', app.metrics.cost),
  ].join(divider(theme));

  const lead = theme.paint(`${statusGlyph(theme, status)} `, { fg: tone })
    + theme.paint(state.label, { fg: tone, bold: true })
    + theme.paint(`  ${glyphs(theme).pipe}  `, { fg: theme.roles.border });
  const room = Math.max(8, width - visibleWidth(lead) - visibleWidth(metrics) - 4);
  const title = truncate(app.sessionTitle || (run ? 'RUN IN PROGRESS' : 'STANDBY FOR ORDERS'), room);

  const left = `${lead}${theme.paint(title, { fg: theme.roles.label })}`;
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(metrics) - 2);

  app.regions?.add({
    row: app.screen.size.rows - 2, column: 1,
    width: visibleWidth(left), height: 1,
    id: 'chrome:session', layer: LAYER.chrome,
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
  const hints = app.currentHints();
  const separator = divider(theme);
  const row = app.screen.size.rows - 1;
  let column = 1;
  const pieces = [];

  for (const [index, [key, label, action]] of hints.entries()) {
    if (index > 0) { pieces.push(separator); column += visibleWidth(separator); }
    const hovered = app.regions?.hoverId === `hint:${key}`;
    const text = typeKey(theme, key)
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
  const version = theme.paint(`v${app.version}`, { fg: theme.roles.faint });
  const gap = Math.max(1, width - visibleWidth(body) - visibleWidth(version) - 2);
  return fit(` ${body}${' '.repeat(gap)}${version} `, width);
}

export { chip, padStart, repeat, BREAKPOINT };
