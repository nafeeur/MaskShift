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
// the way a monochrome CRT has no colour to spend. Seven levels (the values below are the
// `standard` contrast; `high` and `soft` keep the same roles):
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

/**
 * The raw swatches, per contrast level. Views never import these; they read ROLES through the
 * Theme. `standard` is the default; `high` pushes every text level toward white-green on pure
 * black for low-vision use or a washed-out display; `soft` lowers the glare for long sessions
 * (its dimmest text is still 4.5:1 on its own surfaces).
 */
export const PALETTES = {
  standard: {
    void: '#000600', ink: '#010a01', panel: '#041204', raised: '#0a1f0a', select: '#0e300e',
    line: '#124012', rule: '#176017', hairline: '#1a6a1a',
    low: '#2eaf2e', mid: '#33c433', soft: '#3ee03e', normal: '#4dff4d', high: '#9dff9d', bright: '#c8ffc8',
    // Two values that exist only to carry severity: unique, so Theme.paint() can recognise them
    // and add weight (see SIGNAL_STYLE) wherever a signal is drawn, however a call site got here.
    caution: '#a6ffa6', alert: '#e0ffe0',
    deep: '#1f8f1f',
  },
  high: {
    void: '#000000', ink: '#000000', panel: '#020a02', raised: '#061806', select: '#0b2a0b',
    line: '#1f5a1f', rule: '#2d8a2d', hairline: '#2d8a2d',
    low: '#5fe05f', mid: '#78f078', soft: '#8cf58c', normal: '#a8ffa8', high: '#c8ffc8', bright: '#eaffea',
    caution: '#d4ffd4', alert: '#f6fff6',
    deep: '#3fb83f',
  },
  soft: {
    void: '#000400', ink: '#010601', panel: '#030c03', raised: '#071607', select: '#0b220b',
    line: '#0e300e', rule: '#134a13', hairline: '#165416',
    low: '#26a026', mid: '#2ab52a', soft: '#31cc31', normal: '#3adb3a', high: '#6fe86f', bright: '#99f099',
    caution: '#7aeb7a', alert: '#a8f4a8',
    deep: '#1a7a1a',
  },
};

export const PALETTE = PALETTES.standard;

export function buildRoles(P) {
  return {
    // Text ramp — five steps, and only five.
    heading: P.bright,
    text: P.normal,
    label: P.soft,
    dim: P.mid,
    muted: P.low,
    faint: P.rule,
    // A structural line weight (a scrollbar thumb, anything that needs to read as "present" next
    // to `border` rather than as a sixth text-ramp step).
    hairline: P.hairline,

    // Surfaces.
    background: P.ink,
    surface: P.panel,
    surfaceRaised: P.raised,
    surfaceSunken: P.void,
    selection: P.select,

    // Structure.
    border: P.line,
    borderStrong: P.rule,
    borderActive: P.normal,

    // Identity and focus.
    primary: P.normal,
    primaryDeep: P.deep,
    primaryTrack: P.select,
    accent: P.high,
    // A darker sibling of `accent`, so the wordmark's two-tone gradient (see brand.mjs) reads
    // entirely from roles.
    accentDeep: P.mid,
    onPrimary: P.ink,

    // Signals.
    success: P.normal,
    warning: P.caution,
    danger: P.alert,
    info: P.mid,

    // Capability classes.
    tool: P.soft,
    skill: P.high,
    mcp: P.mid,

    // Participants.
    user: P.bright,
    assistant: P.normal,
  };
}

export const ROLE_SETS = {
  standard: buildRoles(PALETTES.standard),
  high: buildRoles(PALETTES.high),
  soft: buildRoles(PALETTES.soft),
};

export const ROLES = ROLE_SETS.standard;
export const CONTRASTS = Object.keys(ROLE_SETS);

/**
 * Weight for a role used as a signal. With one hue there is no colour to spend, so a failure is
 * drawn inverse (the background colour on a bar of the role's colour) and a warning is bold.
 * Applied by Theme.paint() whenever the foreground is exactly the danger or warning colour.
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
