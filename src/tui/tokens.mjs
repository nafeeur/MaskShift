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
//
// Hue budget: eight hues total. Warm half carries identity, operator and
// severity; cool half carries capability classes. info and mcp share the blue
// family on purpose and are separated by weight, not hue — info is the lighter
// of the two.
// ---------------------------------------------------------------------------

/**
 * The neutral ramp. Twelve steps, cool graphite, ordered light-ascending.
 * `bone` is deliberately warm: body text is the one place the interface
 * borrows the wordmark's cream, which keeps long reading passages from
 * feeling like cold chrome.
 */
export const NEUTRAL = {
  ink: '#08090C', // application background
  well: '#0D0F13', // sunken wells, code blocks
  panel: '#12151B', // default panel surface
  raised: '#1A1E26', // raised surface, inline chips
  line: '#222731', // default border
  edge: '#2E343F', // strong border, divider between panes
  hairline: '#3F4653', // scrollbar thumb, rules
  muted: '#7A8494', // hints, placeholders, stamps  (5.2:1 on ink)
  smoke: '#929BAA', // dim text, unfocused labels
  silver: '#B8C0CB', // labels
  bone: '#ECE8E0', // body text
  chalk: '#FFFFFF', // headings only
};

/** Brand hues. Crimson is the identity; gold is the operator. */
export const BRAND = {
  crimson: '#E32C40', // the badge red, straight from the mark
  blood: '#A01A2A', // filled tracks, pressed states
  deep: '#530E19', // empty track behind a crimson fill
  rose: '#FF7186', // hover, "touched by the brand", crimson-as-text
  gold: '#E9A227',
  brass: '#8A5F14',
};

/** Semantic hues. Distinct from the brand hues above. */
export const SIGNAL = {
  success: '#35CF8B',
  warning: '#F7C948', // yellower than gold, so a warning is not the operator
  danger: '#FF6B4A', // orange-red, never mistaken for crimson
  info: '#7FB8FF',
  tool: '#2BD9C0',
  skill: '#A78BFA',
  mcp: '#3D8BF5',
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
  // Removed: `ember`. It sat between gold and danger and gave the warm half a
  // fourth meaning. Anything that used it wants `gold` or `danger`.
  ember: BRAND.gold,
};

export const ROLES = {
  // Text ramp — five steps, and only five.
  heading: NEUTRAL.chalk,
  text: NEUTRAL.bone,
  label: NEUTRAL.silver,
  dim: NEUTRAL.smoke,
  muted: NEUTRAL.muted,
  faint: NEUTRAL.hairline,
  // A structural line weight (a scrollbar thumb, anything that needs to read as "present" next
  // to `border` rather than as a sixth text-ramp step) — distinct from `faint` above despite
  // sharing its hex value, since the two are drawn from the same neutral swatch by coincidence,
  // not because they mean the same thing.
  hairline: NEUTRAL.hairline,

  // Surfaces.
  background: NEUTRAL.ink,
  surface: NEUTRAL.panel,
  surfaceRaised: NEUTRAL.raised,
  surfaceSunken: NEUTRAL.well,
  // A full-row highlight (the selected row in a list) needs more separation
  // from `background` than surfaceRaised gives it — that value reads fine
  // behind a short inline-code chip, where the eye is judging it against the
  // text sitting on it, but nearly vanishes as a wide band against the void.
  // edge mixed ~28% toward crimson: a selected row reads as a dose of the
  // identity colour rather than a grey band that could belong to any app.
  selection: '#5E3040',

  // Structure.
  border: NEUTRAL.line,
  borderStrong: NEUTRAL.edge,
  borderActive: BRAND.crimson,

  // Identity and focus.
  primary: BRAND.crimson,
  // Crimson as small text falls to ~4.1:1 against the background; rose keeps
  // the same family without dropping below the ramp's contrast floor.
  primaryText: BRAND.rose,
  primaryDeep: BRAND.blood,
  primaryTrack: BRAND.deep,
  accent: BRAND.gold,
  // A darker sibling of `accent`, the same relationship `primaryDeep` has to `primary` — added
  // so the wordmark's two-tone gradient (see brand.mjs) can read entirely from roles instead of
  // reaching for brand-specific palette names that only make sense for this one theme.
  accentDeep: BRAND.brass,
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
