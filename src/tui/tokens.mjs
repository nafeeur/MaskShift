// MaskShift design tokens.
//
// One file owns every colour, every measurement and every rule about when to
// use them. Views import meaning ("this is a destructive action", "this is a
// secondary label"), never a hex value, so the interface stays coherent when a
// single token moves.
//
// ---------------------------------------------------------------------------
// THE PALETTE — a green-phosphor terminal. There is exactly one hue (120deg, so
// red === blue in every swatch) and the only thing that varies is brightness,
// the way a monochrome CRT has no colour to spend. Seven levels:
//
//   bright   #c8ffc8  headings, user turns, and the inverse bar that marks a failure
//   high     #9dff9d  warnings, accents
//   normal   #4dff4d  body text, primary, success
//   mid      #33c433  secondary text, info
//   low      #2eaf2e  hints and placeholders (still >= 4.5:1 on every surface)
//   rule     #176017  borders and other non-text structure
//   (void)   #010a01  the screen itself, plus three slightly lifted surfaces
//
// RULES OF USE
//
//   Severity is carried by brightness order (failure > warning > success > info
//   > muted) and by *weight*: a failure is drawn inverse (dark text on a bright
//   green bar) and a warning is bold. See SIGNAL_STYLE and Theme.signal().
//   Glyph shape (status.mjs) says the same thing again for terminals without
//   bold or inverse, so no state is ever carried by colour alone.
//
//   tool / skill / mcp are capability classes. They are constant across every
//   view; with one hue they are told apart by brightness and by the glyph that
//   precedes them.
//
// Exactly one solid-filled chip is allowed per screen region: the active tab.
// Every other label is drawn as text on the surface it belongs to.
//
// Contrast: every text role is at least 4.5:1 on every surface (enforced by
// tests/retro-theme.test.mjs).
// ---------------------------------------------------------------------------

/** The raw swatches. Views never import these; they read ROLES through the Theme. */
export const PALETTE = {
  void: '#000600', // sunken wells, code blocks
  ink: '#010a01', // application background
  panel: '#041204', // default panel surface
  raised: '#0a1f0a', // raised surface, inline chips
  select: '#0e300e', // selected row
  line: '#124012', // default border
  rule: '#176017', // strong border, divider between panes
  hairline: '#1a6a1a', // scrollbar thumb, rules
  low: '#2eaf2e',
  mid: '#33c433',
  soft: '#3ee03e',
  normal: '#4dff4d',
  high: '#9dff9d',
  bright: '#c8ffc8',
  deep: '#1f8f1f', // filled tracks, pressed states
};

export const ROLES = {
  // Text ramp — five steps, and only five.
  heading: PALETTE.bright,
  text: PALETTE.normal,
  label: PALETTE.soft,
  dim: PALETTE.mid,
  muted: PALETTE.low,
  faint: PALETTE.rule,
  // A structural line weight (a scrollbar thumb, anything that needs to read as "present" next
  // to `border` rather than as a sixth text-ramp step).
  hairline: PALETTE.hairline,

  // Surfaces.
  background: PALETTE.ink,
  surface: PALETTE.panel,
  surfaceRaised: PALETTE.raised,
  surfaceSunken: PALETTE.void,
  selection: PALETTE.select,

  // Structure.
  border: PALETTE.line,
  borderStrong: PALETTE.rule,
  borderActive: PALETTE.normal,

  // Identity and focus.
  primary: PALETTE.normal,
  primaryDeep: PALETTE.deep,
  primaryTrack: PALETTE.select,
  accent: PALETTE.high,
  // A darker sibling of `accent`, so the wordmark's two-tone gradient (see brand.mjs) reads
  // entirely from roles.
  accentDeep: PALETTE.mid,
  onPrimary: PALETTE.ink,

  // Signals.
  success: PALETTE.normal,
  warning: PALETTE.high,
  danger: PALETTE.bright,
  info: PALETTE.mid,

  // Capability classes.
  tool: PALETTE.soft,
  skill: PALETTE.high,
  mcp: PALETTE.mid,

  // Participants.
  user: PALETTE.bright,
  assistant: PALETTE.normal,
};

/**
 * Weight for a role used as a signal. With one hue there is no colour to spend, so a failure is
 * drawn inverse (the background colour on a bar of the role's colour) and a warning is bold.
 */
export const SIGNAL_STYLE = {
  danger: { inverse: true, bold: true },
  warning: { bold: true },
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
