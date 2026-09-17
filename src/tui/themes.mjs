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

  dracula: theme('Dracula', {
    bg: '#282a36', surface: '#2b2e3b', surfaceRaised: '#343746', selection: '#44475a',
    border: '#414458', borderStrong: '#565a72', borderActive: '#bd93f9',
    heading: '#f8f8f2', text: '#f8f8f2', label: '#cbccc6', dim: '#8085a1', muted: '#6272a4', faint: '#4d5273', hairline: '#5a5f7a',
    primary: '#bd93f9', primaryDeep: '#7c5cb8', primaryTrack: '#3d2f52', accent: '#ffb86c', accentDeep: '#b3823f', onPrimary: '#282a36',
    success: '#50fa7b', warning: '#f1fa8c', danger: '#ff5555', info: '#8be9fd',
    tool: '#8be9fd', skill: '#ff79c6', user: '#ffb86c',
  }),

  nord: theme('Nord', {
    bg: '#2e3440', surface: '#3b4252', surfaceRaised: '#434c5e', selection: '#434c5e',
    border: '#3b4252', borderStrong: '#4c566a', borderActive: '#88c0d0',
    heading: '#eceff4', text: '#d8dee9', label: '#e5e9f0', dim: '#9099ab', muted: '#4c566a', faint: '#3f4757', hairline: '#4c566a',
    primary: '#88c0d0', primaryDeep: '#5e81ac', primaryTrack: '#33475a', accent: '#ebcb8b', accentDeep: '#a68a5c', onPrimary: '#2e3440',
    success: '#a3be8c', warning: '#ebcb8b', danger: '#bf616a', info: '#81a1c1',
    tool: '#8fbcbb', skill: '#b48ead', user: '#ebcb8b',
  }),

  'solarized-dark': theme('Solarized Dark', {
    bg: '#002b36', surface: '#073642', surfaceRaised: '#0f4a58', selection: '#0a4552',
    border: '#0d3d49', borderStrong: '#586e75', borderActive: '#6c71c4',
    heading: '#fdf6e3', text: '#839496', label: '#93a1a1', dim: '#657b83', muted: '#586e75', faint: '#0d3d49', hairline: '#3a5a63',
    primary: '#6c71c4', primaryDeep: '#4d4f96', primaryTrack: '#2b2c52', accent: '#b58900', accentDeep: '#7d5d00', onPrimary: '#002b36',
    success: '#859900', warning: '#cb4b16', danger: '#dc322f', info: '#268bd2',
    tool: '#2aa198', skill: '#d33682', user: '#b58900',
  }),

  'solarized-light': theme('Solarized Light', {
    bg: '#fdf6e3', surface: '#eee8d5', surfaceRaised: '#e3dcc4', selection: '#dedbc4',
    border: '#e3dcc4', borderStrong: '#93a1a1', borderActive: '#6c71c4',
    heading: '#002b36', text: '#435156', label: '#485a60', dim: '#616e6f', muted: '#768181', faint: '#ded9c0', hairline: '#c2bc9f',
    primary: '#6c71c4', primaryDeep: '#4d4f96', primaryTrack: '#dcdaf0', accent: '#b58900', accentDeep: '#8a6800', onPrimary: '#fdf6e3',
    success: '#859900', warning: '#cb4b16', danger: '#dc322f', info: '#268bd2',
    tool: '#2aa198', skill: '#d33682', user: '#b58900',
  }),

  'gruvbox-dark': theme('Gruvbox Dark', {
    bg: '#282828', surface: '#3c3836', surfaceRaised: '#504945', selection: '#45403d',
    border: '#3c3836', borderStrong: '#665c54', borderActive: '#fe8019',
    heading: '#fbf1c7', text: '#ebdbb2', label: '#d5c4a1', dim: '#a89984', muted: '#928374', faint: '#4b4643', hairline: '#665c54',
    primary: '#fe8019', primaryDeep: '#af3a03', primaryTrack: '#4a2410', accent: '#fabd2f', accentDeep: '#b57614', onPrimary: '#282828',
    success: '#b8bb26', warning: '#fabd2f', danger: '#fb4934', info: '#83a598',
    tool: '#8ec07c', skill: '#d3869b', user: '#fabd2f',
  }),

  'gruvbox-light': theme('Gruvbox Light', {
    bg: '#fbf1c7', surface: '#ebdbb2', surfaceRaised: '#d5c4a1', selection: '#e0d5b5',
    border: '#d5c4a1', borderStrong: '#a89984', borderActive: '#d65d0e',
    heading: '#282828', text: '#3c3836', label: '#504945', dim: '#665c54', muted: '#7c6f64', faint: '#e3d7ae', hairline: '#bdae93',
    primary: '#d65d0e', primaryDeep: '#9d4310', primaryTrack: '#f3d3ab', accent: '#d79921', accentDeep: '#9c7017', onPrimary: '#fbf1c7',
    success: '#98971a', warning: '#d79921', danger: '#cc241d', info: '#458588',
    tool: '#689d6a', skill: '#b16286', user: '#d79921',
  }),

  'one-dark': theme('One Dark', {
    bg: '#282c34', surface: '#2c313a', surfaceRaised: '#3a3f4b', selection: '#3e4451',
    border: '#3a3f4b', borderStrong: '#4b5263', borderActive: '#61afef',
    heading: '#dcdfe4', text: '#abb2bf', label: '#9da5b4', dim: '#7f848e', muted: '#5c6370', faint: '#383e49', hairline: '#4b5263',
    primary: '#61afef', primaryDeep: '#3b7cb0', primaryTrack: '#1d3a52', accent: '#e5c07b', accentDeep: '#a4893f', onPrimary: '#282c34',
    success: '#98c379', warning: '#e5c07b', danger: '#e06c75', info: '#56b6c2',
    tool: '#56b6c2', skill: '#c678dd', user: '#e5c07b',
  }),

  'one-light': theme('One Light', {
    bg: '#fafafa', surface: '#eaeaeb', surfaceRaised: '#dedee0', selection: '#e5e5e6',
    border: '#dedee0', borderStrong: '#a0a1a7', borderActive: '#4078f2',
    heading: '#282c34', text: '#383a42', label: '#4f525c', dim: '#696c77', muted: '#808186', faint: '#e5e5e6', hairline: '#cccdd1',
    primary: '#4078f2', primaryDeep: '#2955ad', primaryTrack: '#c9d8fb', accent: '#c18401', accentDeep: '#8c5f00', onPrimary: '#fafafa',
    success: '#50a14f', warning: '#c18401', danger: '#e45649', info: '#0184bc',
    tool: '#0184bc', skill: '#a626a4', user: '#c18401',
  }),

  monokai: theme('Monokai', {
    bg: '#272822', surface: '#2f3129', surfaceRaised: '#3e4030', selection: '#3e3d32',
    border: '#3e4030', borderStrong: '#75715e', borderActive: '#f92672',
    heading: '#f8f8f2', text: '#f8f8f2', label: '#cfcfc2', dim: '#a3a396', muted: '#75715e', faint: '#3b3c33', hairline: '#524f42',
    primary: '#f92672', primaryDeep: '#b31c50', primaryTrack: '#4a0e22', accent: '#e6db74', accentDeep: '#a89e4f', onPrimary: '#272822',
    success: '#a6e22e', warning: '#e6db74', danger: '#f92672', info: '#66d9ef',
    tool: '#66d9ef', skill: '#ae81ff', user: '#e6db74',
  }),

  'tokyo-night': theme('Tokyo Night', {
    bg: '#1a1b26', surface: '#1f2335', surfaceRaised: '#292e42', selection: '#33467c',
    border: '#292e42', borderStrong: '#414868', borderActive: '#7aa2f7',
    heading: '#c0caf5', text: '#a9b1d6', label: '#9aa5ce', dim: '#787c99', muted: '#565f89', faint: '#24283b', hairline: '#414868',
    primary: '#7aa2f7', primaryDeep: '#3d59a1', primaryTrack: '#1f2d4a', accent: '#e0af68', accentDeep: '#a17a3f', onPrimary: '#1a1b26',
    success: '#9ece6a', warning: '#e0af68', danger: '#f7768e', info: '#7dcfff',
    tool: '#7dcfff', skill: '#bb9af7', user: '#e0af68',
  }),

  'catppuccin-mocha': theme('Catppuccin Mocha', {
    bg: '#1e1e2e', surface: '#313244', surfaceRaised: '#45475a', selection: '#45475a',
    border: '#313244', borderStrong: '#585b70', borderActive: '#cba6f7',
    heading: '#cdd6f4', text: '#cdd6f4', label: '#bac2de', dim: '#a6adc8', muted: '#6c7086', faint: '#292c3c', hairline: '#45475a',
    primary: '#cba6f7', primaryDeep: '#8c5fc9', primaryTrack: '#3a2b52', accent: '#f9e2af', accentDeep: '#ab9a5e', onPrimary: '#1e1e2e',
    success: '#a6e3a1', warning: '#f9e2af', danger: '#f38ba8', info: '#89b4fa',
    tool: '#94e2d5', skill: '#f5c2e7', user: '#f9e2af',
  }),

  'catppuccin-latte': theme('Catppuccin Latte', {
    bg: '#eff1f5', surface: '#ccd0da', surfaceRaised: '#bcc0cc', selection: '#dce0e8',
    border: '#ccd0da', borderStrong: '#9ca0b0', borderActive: '#8839ef',
    heading: '#4c4f69', text: '#474a63', label: '#515469', dim: '#66687d', muted: '#787b8a', faint: '#e6e9ef', hairline: '#acb0be',
    primary: '#8839ef', primaryDeep: '#6929b8', primaryTrack: '#e0cbfa', accent: '#df8e1d', accentDeep: '#9c6414', onPrimary: '#eff1f5',
    success: '#40a02b', warning: '#df8e1d', danger: '#d20f39', info: '#1e66f5',
    tool: '#179299', skill: '#ea76cb', user: '#df8e1d',
  }),

  'catppuccin-frappe': theme('Catppuccin Frappé', {
    bg: '#303446', surface: '#414559', surfaceRaised: '#51576d', selection: '#51576d',
    border: '#414559', borderStrong: '#626880', borderActive: '#ca9ee6',
    heading: '#c6d0f5', text: '#c6d0f5', label: '#b5bfe2', dim: '#a5adce', muted: '#737994', faint: '#292c3c', hairline: '#51576d',
    primary: '#ca9ee6', primaryDeep: '#8f6ba3', primaryTrack: '#3a2f47', accent: '#e5c890', accentDeep: '#a18c5e', onPrimary: '#303446',
    success: '#a6d189', warning: '#e5c890', danger: '#e78284', info: '#8caaee',
    tool: '#81c8be', skill: '#f4b8e4', user: '#e5c890',
  }),

  'catppuccin-macchiato': theme('Catppuccin Macchiato', {
    bg: '#24273a', surface: '#363a4f', surfaceRaised: '#494d64', selection: '#494d64',
    border: '#363a4f', borderStrong: '#5b6078', borderActive: '#c6a0f6',
    heading: '#cad3f5', text: '#cad3f5', label: '#b8c0e0', dim: '#a5adcb', muted: '#6e738d', faint: '#1e2030', hairline: '#494d64',
    primary: '#c6a0f6', primaryDeep: '#8c6bb0', primaryTrack: '#372c49', accent: '#eed49f', accentDeep: '#a8945f', onPrimary: '#24273a',
    success: '#a6da95', warning: '#eed49f', danger: '#ed8796', info: '#8aadf4',
    tool: '#8bd5ca', skill: '#f5bde6', user: '#eed49f',
  }),

  'everforest-dark': theme('Everforest Dark', {
    bg: '#2d353b', surface: '#343f44', surfaceRaised: '#3d484d', selection: '#3d484d',
    border: '#343f44', borderStrong: '#4f585e', borderActive: '#a7c080',
    heading: '#d3c6aa', text: '#d3c6aa', label: '#c3b598', dim: '#9da9a0', muted: '#7a8478', faint: '#272e33', hairline: '#475258',
    primary: '#a7c080', primaryDeep: '#748a52', primaryTrack: '#2f3a24', accent: '#dbbc7f', accentDeep: '#9c8654', onPrimary: '#2d353b',
    success: '#a7c080', warning: '#dbbc7f', danger: '#e67e80', info: '#7fbbb3',
    tool: '#83c092', skill: '#d699b6', user: '#dbbc7f',
  }),

  'rose-pine': theme('Rosé Pine', {
    bg: '#191724', surface: '#1f1d2e', surfaceRaised: '#26233a', selection: '#403d52',
    border: '#26233a', borderStrong: '#524f67', borderActive: '#c4a7e7',
    heading: '#e0def4', text: '#e0def4', label: '#908caa', dim: '#908caa', muted: '#6e6a86', faint: '#1f1d2e', hairline: '#403d52',
    primary: '#c4a7e7', primaryDeep: '#8a71a8', primaryTrack: '#332a44', accent: '#f6c177', accentDeep: '#ac8752', onPrimary: '#191724',
    success: '#9ccfd8', warning: '#f6c177', danger: '#eb6f92', info: '#31748f',
    tool: '#9ccfd8', skill: '#ebbcba', user: '#f6c177',
  }),

  'rose-pine-dawn': theme('Rosé Pine Dawn', {
    bg: '#faf4ed', surface: '#fffaf3', surfaceRaised: '#f2e9e1', selection: '#dfdad9',
    border: '#f2e9e1', borderStrong: '#cecacd', borderActive: '#907aa9',
    heading: '#575279', text: '#4e4a6d', label: '#57546a', dim: '#6d6984', muted: '#837e8e', faint: '#f4ede8', hairline: '#cecacd',
    primary: '#907aa9', primaryDeep: '#6b5b7f', primaryTrack: '#e6def0', accent: '#ea9d34', accentDeep: '#a66f24', onPrimary: '#faf4ed',
    success: '#56949f', warning: '#ea9d34', danger: '#b4637a', info: '#286983',
    tool: '#56949f', skill: '#d7827e', user: '#ea9d34',
  }),

  'ayu-dark': theme('Ayu Dark', {
    bg: '#0a0e14', surface: '#0d1017', surfaceRaised: '#131721', selection: '#253340',
    border: '#131721', borderStrong: '#3d4751', borderActive: '#39bae6',
    heading: '#e6e1cf', text: '#bfbdb6', label: '#b3b1ad', dim: '#828c99', muted: '#626a73', faint: '#0f131a', hairline: '#3d4751',
    primary: '#39bae6', primaryDeep: '#2a86a8', primaryTrack: '#123444', accent: '#ffb454', accentDeep: '#b37e3a', onPrimary: '#0a0e14',
    success: '#c2d94c', warning: '#ffb454', danger: '#f26d78', info: '#59c2ff',
    tool: '#95e6cb', skill: '#d2a6ff', user: '#ffb454',
  }),

  'ayu-light': theme('Ayu Light', {
    bg: '#fafafa', surface: '#f0f0f0', surfaceRaised: '#e7e8e9', selection: '#e0e7f1',
    border: '#e7e8e9', borderStrong: '#abb0b6', borderActive: '#399ee6',
    heading: '#5c6166', text: '#4d5156', label: '#565b60', dim: '#68707a', muted: '#7f8287', faint: '#eeeeee', hairline: '#d5d6d7',
    primary: '#399ee6', primaryDeep: '#2872ac', primaryTrack: '#cde5fa', accent: '#fa8d3e', accentDeep: '#b06327', onPrimary: '#fafafa',
    success: '#86b300', warning: '#f2ae49', danger: '#f51818', info: '#399ee6',
    tool: '#4cbf99', skill: '#a37acc', user: '#fa8d3e',
  }),

  kanagawa: theme('Kanagawa', {
    bg: '#1f1f28', surface: '#2a2a37', surfaceRaised: '#363646', selection: '#2d4f67',
    border: '#2a2a37', borderStrong: '#54546d', borderActive: '#7e9cd8',
    heading: '#dcd7ba', text: '#dcd7ba', label: '#c8c093', dim: '#a6a69c', muted: '#727169', faint: '#16161d', hairline: '#54546d',
    primary: '#7e9cd8', primaryDeep: '#5a76ad', primaryTrack: '#232f45', accent: '#e6c384', accentDeep: '#a4894f', onPrimary: '#1f1f28',
    success: '#98bb6c', warning: '#e6c384', danger: '#c34043', info: '#7fb4ca',
    tool: '#6a9589', skill: '#957fb8', user: '#ff9e3b',
  }),

  'github-dark': theme('GitHub Dark', {
    bg: '#0d1117', surface: '#161b22', surfaceRaised: '#21262d', selection: '#1c3a5e',
    border: '#21262d', borderStrong: '#30363d', borderActive: '#58a6ff',
    heading: '#f0f6fc', text: '#c9d1d9', label: '#b1bac4', dim: '#8b949e', muted: '#6e7681', faint: '#161b22', hairline: '#30363d',
    primary: '#58a6ff', primaryDeep: '#3672b0', primaryTrack: '#152a44', accent: '#d29922', accentDeep: '#946c18', onPrimary: '#0d1117',
    success: '#3fb950', warning: '#d29922', danger: '#f85149', info: '#58a6ff',
    tool: '#39c5cf', skill: '#bc8cff', user: '#d29922',
  }),

  'github-light': theme('GitHub Light', {
    bg: '#ffffff', surface: '#f6f8fa', surfaceRaised: '#eaeef2', selection: '#ddf4ff',
    border: '#eaeef2', borderStrong: '#d0d7de', borderActive: '#0969da',
    heading: '#1f2328', text: '#1f2328', label: '#3d444d', dim: '#59636e', muted: '#656d76', faint: '#f6f8fa', hairline: '#d0d7de',
    primary: '#0969da', primaryDeep: '#0757ba', primaryTrack: '#cbe3fc', accent: '#9a6700', accentDeep: '#6b4700', onPrimary: '#ffffff',
    success: '#1a7f37', warning: '#9a6700', danger: '#cf222e', info: '#0969da',
    tool: '#1b7c83', skill: '#8250df', user: '#9a6700',
  }),

  'night-owl': theme('Night Owl', {
    bg: '#011627', surface: '#0b2942', surfaceRaised: '#122d42', selection: '#1d3b53',
    border: '#0b2942', borderStrong: '#2d5770', borderActive: '#82aaff',
    heading: '#d6deeb', text: '#d6deeb', label: '#c5e4fd', dim: '#8ba1b7', muted: '#637777', faint: '#01111d', hairline: '#2d5770',
    primary: '#82aaff', primaryDeep: '#5a7bb8', primaryTrack: '#1c2d4d', accent: '#addb67', accentDeep: '#7a9c48', onPrimary: '#011627',
    success: '#22da6e', warning: '#ffeb95', danger: '#ef5350', info: '#7fdbca',
    tool: '#7fdbca', skill: '#c792ea', user: '#ffeb95',
  }),

  'material-darker': theme('Material Darker', {
    bg: '#212121', surface: '#292929', surfaceRaised: '#333333', selection: '#404040',
    border: '#292929', borderStrong: '#4f4f4f', borderActive: '#82aaff',
    heading: '#eeffff', text: '#eeffff', label: '#c9c9c9', dim: '#9c9c9c', muted: '#545454', faint: '#1a1a1a', hairline: '#4f4f4f',
    primary: '#82aaff', primaryDeep: '#5a7bb8', primaryTrack: '#1c2d4d', accent: '#ffcb6b', accentDeep: '#b3903f', onPrimary: '#212121',
    success: '#c3e88d', warning: '#ffcb6b', danger: '#ff5370', info: '#89ddff',
    tool: '#89ddff', skill: '#c792ea', user: '#ffcb6b',
  }),

  'synthwave-84': theme('Synthwave ’84', {
    bg: '#262335', surface: '#2a2139', surfaceRaised: '#34294f', selection: '#463465',
    border: '#34294f', borderStrong: '#553a75', borderActive: '#ff7edb',
    heading: '#ffffff', text: '#f4eee4', label: '#c6c0d6', dim: '#a599c9', muted: '#848bbd', faint: '#1e1a2f', hairline: '#553a75',
    primary: '#ff7edb', primaryDeep: '#b355a0', primaryTrack: '#4a2140', accent: '#fede5d', accentDeep: '#b3a041', onPrimary: '#262335',
    success: '#72f1b8', warning: '#fede5d', danger: '#fe4450', info: '#36f9f6',
    tool: '#36f9f6', skill: '#b084eb', user: '#fede5d',
  }),

  cobalt2: theme('Cobalt2', {
    bg: '#193549', surface: '#1b3b52', surfaceRaised: '#204a68', selection: '#0d3a58',
    border: '#1b3b52', borderStrong: '#2c5a7a', borderActive: '#ffc600',
    heading: '#ffffff', text: '#e8e8e8', label: '#cbe1ff', dim: '#8bb6d6', muted: '#5b8ab0', faint: '#0f2739', hairline: '#2c5a7a',
    primary: '#ffc600', primaryDeep: '#b38a00', primaryTrack: '#453400', accent: '#ff9d00', accentDeep: '#b36e00', onPrimary: '#193549',
    success: '#3ad900', warning: '#ffc600', danger: '#ff2c70', info: '#9effff',
    tool: '#80fcff', skill: '#9b859d', user: '#ffc600',
  }),

  horizon: theme('Horizon', {
    bg: '#1c1e26', surface: '#232530', surfaceRaised: '#2e303e', selection: '#2e303e',
    border: '#232530', borderStrong: '#3c3f4c', borderActive: '#e95678',
    heading: '#f0f0f2', text: '#cbced0', label: '#b1b4bb', dim: '#8c9199', muted: '#6c6f93', faint: '#16161c', hairline: '#3c3f4c',
    primary: '#e95678', primaryDeep: '#a83c56', primaryTrack: '#3f1c26', accent: '#fab795', accentDeep: '#b28167', onPrimary: '#1c1e26',
    success: '#29d398', warning: '#fab795', danger: '#e95678', info: '#26bbd9',
    tool: '#59e1e3', skill: '#b877db', user: '#fab795',
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
