// One status vocabulary for the whole interface.
//
// Runs, plan steps, MCP servers, automations, bridges, processes and tool
// results all report state as free-form strings from different subsystems.
// Before this module each view invented its own mapping, so "failed" was
// crimson in one pane and orange in another, and a connected server and a
// finished run shared neither colour nor glyph.
//
// Everything now resolves through `statusOf`, which collapses those strings
// onto seven kinds. A kind fixes the tone and the glyph; the label is the only
// thing a caller may override.

import { glyphs } from './box.mjs';
import { spin } from './motion.mjs';

/**
 * The seven kinds.
 *
 *   off      exists but is not participating   · muted
 *   pending  will happen, has not started      ○ muted
 *   active   happening now                     ◐ crimson, animated
 *   ready    available, healthy, not busy      ● info
 *   done     finished successfully             ● success
 *   warn     finished with something to say    ▲ warning
 *   fail     did not finish                    ✕ danger
 */
export const KINDS = {
  // Hollow, not dark: a filled lamp in a muted grey and a filled lamp in a
  // live green are the same shape, and a list of servers has to be readable
  // by shape before it is readable by hue.
  off: { tone: 'muted', glyph: 'ring', mark: 'dot' },
  pending: { tone: 'muted', glyph: 'ring', mark: 'ring' },
  active: { tone: 'primary', glyph: 'spinner', mark: 'caret' },
  ready: { tone: 'info', glyph: 'lamp', mark: 'check' },
  done: { tone: 'success', glyph: 'lamp', mark: 'check' },
  warn: { tone: 'warning', glyph: 'warn', mark: 'warn' },
  fail: { tone: 'danger', glyph: 'cross', mark: 'cross' },
};

// Domain string → [kind, display label]. Anything unlisted falls back to a
// neutral kind with the raw value upper-cased, so a new subsystem state shows
// up legibly instead of silently rendering as grey.
const VOCABULARY = {
  // Runs.
  idle: ['off', 'IDLE'],
  standby: ['off', 'STANDBY'],
  queued: ['pending', 'QUEUED'],
  running: ['active', 'RUNNING'],
  cancelling: ['warn', 'STOPPING'],
  completed: ['done', 'COMPLETE'],
  complete: ['done', 'COMPLETE'],
  succeeded: ['done', 'COMPLETE'],
  ok: ['done', 'OK'],
  failed: ['fail', 'FAILED'],
  error: ['fail', 'ERROR'],
  cancelled: ['off', 'CANCELLED'],
  max_steps: ['warn', 'STEP LIMIT'],

  // Plan steps.
  pending: ['pending', 'PENDING'],
  active: ['active', 'IN FLIGHT'],
  in_progress: ['active', 'IN FLIGHT'],
  done: ['done', 'DONE'],
  blocked: ['fail', 'BLOCKED'],
  skipped: ['off', 'SKIPPED'],

  // MCP and bridges.
  connected: ['done', 'CONNECTED'],
  disconnected: ['pending', 'OFFLINE'],
  available: ['ready', 'AVAILABLE'],
  missing: ['off', 'NOT FOUND'],
  disabled: ['off', 'DISABLED'],
  registry: ['ready', 'REGISTRY'],

  // Automations, plugins, processes, browsers.
  armed: ['ready', 'ARMED'],
  paused: ['off', 'PAUSED'],
  loaded: ['done', 'LOADED'],
  exited: ['off', 'EXITED'],
  headless: ['ready', 'HEADLESS'],
  visible: ['ready', 'VISIBLE'],
};

/** Resolve any subsystem state string to a kind, a tone and a label. */
export function statusOf(value, { label = null } = {}) {
  const key = String(value ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  const [kind, text] = VOCABULARY[key] || ['off', String(value ?? '').toUpperCase() || 'UNKNOWN'];
  return { kind, label: label ?? text, ...KINDS[kind] };
}

/**
 * The glyph for a state. `animate` lets the one genuinely live kind — active —
 * turn over, and is switched off wherever a spinner would be noise (a long
 * checklist, a captured frame).
 */
export function statusGlyph(theme, value, { animate = true } = {}) {
  const mark = glyphs(theme);
  const state = statusOf(value);
  if (state.glyph === 'spinner') return animate ? spin(theme, 'orbit') : mark.ring;
  return mark[state.glyph] || mark.dot;
}

/** The checklist form: a tick, a cross, a caret — never a lamp. */
export function statusMark(theme, value, { animate = false } = {}) {
  const mark = glyphs(theme);
  const state = statusOf(value);
  if (state.kind === 'active' && animate) return spin(theme, 'dots');
  return mark[state.mark] || mark.dot;
}

/** `glyph label` in one tone. The canonical way to show state inline. */
export function statusLine(theme, value, { animate = true, label = null, bold = false } = {}) {
  const state = statusOf(value, { label });
  const tone = theme.role(state.tone);
  return theme.paint(`${statusGlyph(theme, value, { animate })} `, { fg: tone })
    + theme.paint(state.label, { fg: tone, bold });
}
