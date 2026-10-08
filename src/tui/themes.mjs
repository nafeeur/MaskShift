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
}) {
  return {
    name,
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

export const DEFAULT_THEME_ID = 'maskshift';

export const THEMES = {
  maskshift: { name: 'MaskShift', roles: ROLES },

  // Old green-phosphor terminal: one hue (green) in different brightnesses, nothing else.
  // Every role is a shade of green; status is told apart by glyph shape (see status.mjs) and
  // by brightness, exactly as the two-tone themes do, not by an extra hue.
  retro: theme('Retro', {
    bg: '#030a03', surface: '#061106', surfaceRaised: '#0a1a0a', selection: '#0f2a0f',
    border: '#0f2a0f', borderStrong: '#1f5a1f', borderActive: '#33ff33',
    heading: '#66ff66', text: '#33ff33', label: '#2bd62b', dim: '#22a822', muted: '#1a7a1a', faint: '#0d3d0d', hairline: '#145214',
    primary: '#33ff33', primaryDeep: '#1f9e1f', primaryTrack: '#0f3d0f', accent: '#99ff99', accentDeep: '#4fbf4f', onPrimary: '#030a03',
    success: '#66ff66', warning: '#99ff99', danger: '#c8ffc8', info: '#2bd62b',
    tool: '#4fe84f', skill: '#80ff80', user: '#b3ffb3',
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
