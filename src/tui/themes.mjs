// The theme registry: every named colour scheme selectable via /theme, mapped onto the same
// role contract tokens.mjs's default "MaskShift" theme uses (see tokens.mjs's own comment for
// what each role means). Swapping `roles` is the entire theme switch — nothing else in the
// interface knows or cares which one is active; see theme.mjs's Theme.setTheme().
//
// Each entry's colours are drawn from that theme's own well-known, published palette (background,
// foreground, comment/muted tones, and its ANSI-style red/green/yellow/blue/magenta/cyan accents),
// then assigned to roles the same way tokens.mjs's own comment prescribes: exactly one hue per
// meaning. `mcp` always mirrors `info` and `assistant` always mirrors `text` — true of the
// original MaskShift theme too, not a shortcut invented for the others.
import { ROLES } from './tokens.mjs';

function theme(name, {
  bg, surface, surfaceRaised, surfaceSunken = bg, selection,
  border, borderStrong, borderActive,
  heading, text, label, dim, muted, faint, hairline,
  primary, primaryDeep, primaryTrack, accent, accentDeep, onPrimary,
  success, warning, danger, info,
  tool, skill, user,
}, signalStyle = {}) {
  return {
    name,
    signalStyle,
    roles: {
      heading, text, label, dim, muted, faint, hairline,
      background: bg, surface, surfaceRaised, surfaceSunken, selection,
      border, borderStrong, borderActive,
      primary, primaryDeep, primaryTrack, accent, accentDeep, onPrimary,
      success, warning, danger, info,
      tool, skill, mcp: info, user, assistant: text,
    },
  };
}

export const DEFAULT_THEME_ID = 'retro';

export const THEMES = {
  maskshift: { name: 'MaskShift', roles: ROLES },

  // Green-phosphor terminal. One hue (120deg, so red === blue in every swatch) in a handful of
  // brightness levels, the way a monochrome CRT has no colour to spend and only intensity:
  //
  //   bright  #c8ffc8  headings, and the inverse bar that marks a failure
  //   high    #9dff9d  warnings
  //   normal  #4dff4d  body text, primary, success
  //   mid     #33c433  secondary text, info
  //   low     #2eaf2e  hints and placeholders (still >= 4.5:1 on every surface)
  //   rule    #176017  borders and other non-text structure
  //
  // Severity is carried by brightness order (failure > warning > success > info > muted) and
  // by *weight*: a failure is drawn inverse (dark on bright green), a warning is bold. Glyph
  // shape (see status.mjs) still says the same thing for terminals without bold or inverse.
  retro: theme('Retro', {
    bg: '#010a01', surface: '#041204', surfaceRaised: '#0a1f0a', surfaceSunken: '#000600', selection: '#0e300e',
    border: '#124012', borderStrong: '#176017', borderActive: '#4dff4d',
    heading: '#c8ffc8', text: '#4dff4d', label: '#3ee03e', dim: '#33c433', muted: '#2eaf2e', faint: '#176017', hairline: '#1a6a1a',
    primary: '#4dff4d', primaryDeep: '#1f8f1f', primaryTrack: '#0e300e', accent: '#9dff9d', accentDeep: '#33c433', onPrimary: '#010a01',
    success: '#4dff4d', warning: '#9dff9d', danger: '#c8ffc8', info: '#33c433',
    tool: '#3ee03e', skill: '#9dff9d', user: '#c8ffc8',
  }, {
    danger: { inverse: true, bold: true },
    warning: { bold: true },
  }),
};

export function listThemes() {
  return Object.entries(THEMES).map(([id, entry]) => ({ id, name: entry.name }));
}

export function resolveThemeId(id) {
  return THEMES[id] ? id : DEFAULT_THEME_ID;
}

export function resolveTheme(id) {
  return THEMES[resolveThemeId(id)];
}
