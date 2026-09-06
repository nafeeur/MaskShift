// MaskShift design tokens.
//
// One file owns every colour, every measurement and every rule about when to
// use them. Views import meaning ("this is a destructive action", "this is a
// secondary label"), never a hex value, so the interface stays coherent when a
// single token moves.
//
// ---------------------------------------------------------------------------
// RULES OF USE — the reason the old interface read as noise was that one
// colour meant six things at once. These are enforced by convention:
//
//   crimson   Identity and focus. The active view, the pane holding the
//             keyboard, the wordmark. Never a data value, never a severity.
//   gold      The operator: their turn, their keys, their pending input.
//   danger    Failure and destruction only — a distinct red so a failed run
//             never reads as "this pane is focused".
//   tool /    Capability classes. Constant across every view so a cyan token
//   skill /   always means "tool" wherever it appears.
//   mcp
//   neutrals  Everything else. Hierarchy is carried by the neutral ramp and
//             by weight, not by hue.
//
// Exactly one solid-filled chip is allowed per screen region: the active tab.
// Every other label is drawn as text on the surface it belongs to.
// ---------------------------------------------------------------------------

/**
 * The neutral ramp. Eleven steps from the application background to pure
 * white, with a trace of violet so the greys sit under the crimson without
 * turning muddy. Steps are ordered: anything later is lighter.
 */
export const NEUTRAL = {
  ink: '#08080b',
  well: '#0d0d12',
  panel: '#121218',
  raised: '#1f1f2a',
  line: '#24242f',
  edge: '#33333f',
  hairline: '#43434f',
  muted: '#61616f',
  smoke: '#8a8a99',
  silver: '#b8b8c4',
  bone: '#e7e6ea',
  chalk: '#ffffff',
};

/** Brand hues. Crimson is the identity; gold is the operator. */
export const BRAND = {
  crimson: '#e5384f',
  blood: '#a0202f',
  deep: '#5c1420',
  ember: '#ff7a45',
  gold: '#f0b429',
  brass: '#8a6414',
};

/** Semantic hues. Deliberately distinct from the brand hues above. */
export const SIGNAL = {
  success: '#3ecf8e',
  warning: '#f0b429',
  danger: '#ff5f56',
  info: '#4aa8ff',
  tool: '#2bd9c0',
  skill: '#a78bfa',
  mcp: '#4aa8ff',
};

export const PALETTE = {
  ...NEUTRAL,
  ...BRAND,
  ...SIGNAL,
  // Retained aliases so older call sites keep resolving to a sane colour.
  ash: NEUTRAL.muted,
  azure: SIGNAL.info,
  violet: SIGNAL.skill,
  cyanide: SIGNAL.tool,
  toxic: SIGNAL.success,
  surface: NEUTRAL.panel,
};

export const ROLES = {
  // Text ramp — four steps, and only four.
  heading: NEUTRAL.chalk,
  text: NEUTRAL.bone,
  label: NEUTRAL.silver,
  dim: NEUTRAL.smoke,
  muted: NEUTRAL.muted,
  faint: NEUTRAL.hairline,

  // Surfaces.
  background: NEUTRAL.ink,
  surface: NEUTRAL.panel,
  surfaceRaised: NEUTRAL.raised,
  surfaceSunken: NEUTRAL.well,

  // Structure.
  border: NEUTRAL.line,
  borderStrong: NEUTRAL.edge,
  borderActive: BRAND.crimson,

  // Identity and focus.
  primary: BRAND.crimson,
  primaryDeep: BRAND.blood,
  primaryTrack: BRAND.deep,
  accent: BRAND.gold,
  onPrimary: NEUTRAL.ink,

  // Signals.
  success: SIGNAL.success,
  warning: SIGNAL.warning,
  danger: SIGNAL.danger,
  info: SIGNAL.info,

  // Capability classes.
  tool: SIGNAL.tool,
  skill: SIGNAL.skill,
  mcp: SIGNAL.mcp,

  // Participants.
  user: BRAND.gold,
  assistant: NEUTRAL.bone,
};

/**
 * The measurement scale. Every pane is laid out from these, so content lines
 * up across panes that know nothing about each other.
 *
 *   FRAME    the panel border itself
 *   PAD      breathing room between the border and any content
 *   GUTTER   a fixed marker column reserved at the head of every content row:
 *            a speaker rail, a status glyph, a bullet, a selection bar. It is
 *            reserved even when empty, which is what keeps the left edge of
 *            the text identical for every kind of row in a pane.
 */
export const SPACE = {
  frame: 1,
  pad: 1,
  gutter: 2,
  indent: 2,
  columnGap: 2,
};

/** Distance from a panel's outer column to the first column of body text. */
export const CONTENT_OFFSET = SPACE.frame + SPACE.pad + SPACE.gutter;

/** Widths shared by aligned two-column layouts (detail panes, settings). */
export const FIELD_LABEL_WIDTH = 14;

/** Breakpoints. Below each, the named element is dropped rather than squeezed. */
export const BREAKPOINT = {
  rail: 108,
  detail: 92,
  wordmark: 74,
  headerMetrics: 96,
};

/** Motion timings, in milliseconds. Shared so nothing animates on its own beat. */
export const DURATION = {
  fast: 140,
  base: 240,
  slow: 420,
  breath: 2400,
  sweep: 1600,
  toast: 4200,
  toastFade: 520,
};
