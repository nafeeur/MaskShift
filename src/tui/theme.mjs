// MaskShift terminal theme (green phosphor).
//
// The palette itself lives in tokens.mjs; this file is the renderer that puts
// it on the wire, degrading truecolor to 256 and 16 colours so the identity
// survives on any terminal. Nothing here decides what a colour means.

import { Motion } from './motion.mjs';
import { CONTRASTS, PALETTE, ROLES, ROLE_SETS, SIGNAL_STYLE } from './tokens.mjs';

export { PALETTE, ROLES, CONTRASTS };

export const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;

function envFlag(name) {
  const value = process.env[name];
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

export function detectDepth(stream = process.stdout) {
  if (envFlag('NO_COLOR')) return 0;
  const forced = process.env.FORCE_COLOR;
  if (forced !== undefined) {
    if (forced === '0' || forced === 'false') return 0;
    if (forced === '1' || forced === 'true') return 4;
    if (forced === '2') return 8;
    return 24;
  }
  if (process.env.MASKSHIFT_COLOR === 'off') return 0;
  if (process.env.MASKSHIFT_COLOR === 'basic') return 4;
  if (process.env.MASKSHIFT_COLOR === 'full') return 24;
  if (stream && !stream.isTTY) return 0;
  const term = process.env.TERM || '';
  if (term === 'dumb') return 0;
  const colorterm = (process.env.COLORTERM || '').toLowerCase();
  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) return 24;
  if (['iTerm.app', 'WezTerm', 'ghostty', 'vscode'].includes(process.env.TERM_PROGRAM)) return 24;
  // Inside tmux/screen, TERM reports a 256-colour terminal regardless of what the outer
  // terminal actually supports — COLORTERM, the usual signal, doesn't reliably survive tmux's
  // own environment filtering to tell us otherwise. $TMUX itself does survive (tmux sets it
  // directly on every pane it spawns), so seeing it alongside tmux's own "-256color" TERM is
  // treated as truecolor-capable: virtually every terminal emulator modern enough to run tmux
  // at all supports and passes through 24-bit colour. MASKSHIFT_COLOR=basic overrides this for
  // the rare setup where that assumption is wrong.
  if (process.env.TMUX && /^(tmux|screen)-256color$/.test(term)) return 24;
  if (/-256(color)?$/.test(term)) return 8;
  if (/^(screen|xterm|vt100|rxvt|linux|ansi|tmux)/.test(term)) return 4;
  return stream?.isTTY ? 8 : 0;
}

export function hexToRgb(hex) {
  const value = String(hex).replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const int = Number.parseInt(full, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

export function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

export function mix(fromHex, toHex, ratio) {
  const a = hexToRgb(fromHex);
  const b = hexToRgb(toHex);
  const t = Math.max(0, Math.min(1, ratio));
  return rgbToHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

// The 256-colour cube and grey ramp, built once. Nearest-colour matching (rather than rounding
// each channel) keeps a ramp of similar greens as distinct as the palette allows: rounding
// collapses several of them onto one cube cell.
const CUBE = [0, 95, 135, 175, 215, 255];
const XTERM = [];
for (let index = 16; index < 232; index += 1) {
  const n = index - 16;
  XTERM.push([index, CUBE[Math.floor(n / 36)], CUBE[Math.floor(n / 6) % 6], CUBE[n % 6]]);
}
for (let index = 232; index < 256; index += 1) {
  const level = 8 + (index - 232) * 10;
  XTERM.push([index, level, level, level]);
}
const nearestCache = new Map();

function to256([r, g, b]) {
  const key = (r << 16) | (g << 8) | b;
  let hit = nearestCache.get(key);
  if (hit === undefined) {
    let best = Infinity;
    for (const [index, cr, cg, cb] of XTERM) {
      const distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
      if (distance < best) { best = distance; hit = index; }
    }
    nearestCache.set(key, hit);
  }
  return hit;
}

// A 16-colour terminal has one green and one bright green. A foreground at least as bright as the
// dim half of the ramp (down to the borders) maps to green, the bright half to bright green, and only the genuinely dark
// structure (borders, surfaces) falls to black — never the readable text, which a plain
// "channel on/off" mapping would turn invisible.
function to16([r, g, b], background = false) {
  if (g > r + 24 && g > b + 24) {
    if (background) return g >= 140 ? 32 : 30;
    if (g >= 200) return 92;
    if (g >= 48) return 32;
    return 30;
  }
  const bright = Math.max(r, g, b) > 160 ? 60 : 0;
  const on = (value) => (value >= 110 ? 1 : 0);
  const bit = (on(b) << 2) | (on(g) << 1) | on(r);
  return 30 + bit + bright;
}

export function supportsUnicode() {
  if (process.env.MASKSHIFT_ASCII === '1') return false;
  if (process.platform === 'win32') return Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM);
  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '';
  return /UTF-?8$/i.test(locale) || locale === '' || process.env.TERM === 'xterm-ghostty';
}

export class Theme {
  constructor({
    depth = detectDepth(), unicode = supportsUnicode(), motion = null, frozen = false,
    contrast = process.env.MASKSHIFT_CONTRAST || 'standard', opaque = true, scanlines = false,
  } = {}) {
    this.depth = depth;
    this.unicode = unicode;
    this.palette = PALETTE;
    this.contrast = ROLE_SETS[contrast] ? contrast : 'standard';
    this.roles = ROLE_SETS[this.contrast];
    this.signalStyle = SIGNAL_STYLE;
    // Paint the screen's own background on every cell, so the interface looks the same on a light
    // terminal, over a wallpaper or in a transparent window. `opaque: false` hands the background
    // back to the terminal. `scanlines` alternates the row background very slightly.
    this.opaque = Boolean(opaque);
    this.scanlines = Boolean(scanlines);
    // Animations read the clock through the theme so a headless render can
    // freeze every moving part at once.
    this.motion = motion || new Motion({ frozen });
    this.mixCache = new Map();
  }

  get enabled() { return this.depth > 0; }

  fg(hex) {
    if (this.depth === 0) return '';
    const rgb = hexToRgb(hex);
    if (this.depth >= 24) return `${CSI}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
    if (this.depth >= 8) return `${CSI}38;5;${to256(rgb)}m`;
    return `${CSI}${to16(rgb)}m`;
  }

  bg(hex) {
    if (this.depth === 0) return '';
    const rgb = hexToRgb(hex);
    if (this.depth >= 24) return `${CSI}48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
    if (this.depth >= 8) return `${CSI}48;5;${to256(rgb)}m`;
    return `${CSI}${to16(rgb, true) + 10}m`;
  }

  get reset() { return this.depth === 0 ? '' : `${CSI}0m`; }
  get bold() { return this.depth === 0 ? '' : `${CSI}1m`; }
  get faint() { return this.depth === 0 ? '' : `${CSI}2m`; }
  get italic() { return this.depth === 0 ? '' : `${CSI}3m`; }
  get underline() { return this.depth === 0 ? '' : `${CSI}4m`; }
  get strike() { return this.depth === 0 ? '' : `${CSI}9m`; }
  get inverse() { return this.depth === 0 ? '' : `${CSI}7m`; }

  paint(text, options = {}) {
    const value = String(text ?? '');
    if (this.depth === 0 || value === '') return value;
    let prefix = '';
    // A signal drawn in its own colour carries its weight with it (see SIGNAL_STYLE), so every
    // call site that paints with roles.danger or roles.warning gets it without opting in.
    if (options.fg && !options.bg) options = this.#weighted(options);
    if (options.bold) prefix += this.bold;
    if (options.dim) prefix += this.faint;
    if (options.italic) prefix += this.italic;
    if (options.underline) prefix += this.underline;
    if (options.strike) prefix += this.strike;
    if (options.inverse) prefix += this.inverse;
    if (options.fg) prefix += this.fg(options.fg);
    if (options.bg) prefix += this.bg(options.bg);
    return prefix ? `${prefix}${value}${this.reset}` : value;
  }

  #weighted(options) {
    const style = options.fg === this.roles.danger ? this.signalStyle.danger
      : options.fg === this.roles.warning ? this.signalStyle.warning : null;
    if (!style) return options;
    const { inverse, ...rest } = style;
    return inverse
      ? { ...options, ...rest, fg: this.roles.background, bg: options.fg }
      : { ...options, ...rest };
  }

  /**
   * The escape that sets this screen's ground: text and background on every cell of a row, so
   * unpainted text is the interface's green and not whatever the terminal's default is. Odd rows
   * lift very slightly when scanlines are on. Empty when colour is off or `opaque` is false.
   */
  groundCode(row = 0) {
    if (this.depth === 0 || !this.opaque) return '';
    const ground = this.scanlines && row % 2 === 1 ? this.roles.surface : this.roles.background;
    return this.fg(this.roles.text) + this.bg(ground);
  }

  // Horizontal gradient across the visible characters of a string.
  gradient(text, fromHex, toHex, options = {}) {
    if (this.depth < 8 || !text) return this.paint(text, { fg: fromHex, ...options });
    const characters = [...String(text)];
    const last = Math.max(1, characters.length - 1);
    const attrs = `${options.bold ? this.bold : ''}${options.dim ? this.faint : ''}`;
    let out = '';
    for (const [index, character] of characters.entries()) {
      if (character === ' ') { out += character; continue; }
      out += `${attrs}${this.fg(mix(fromHex, toHex, index / last))}${character}${this.reset}`;
    }
    return out;
  }

  /**
   * Blend two colours, memoised.
   *
   * Terminals have no alpha channel, so "40% crimson" has to be resolved
   * against the surface it will sit on before it goes on the wire. Sweeps and
   * fades call this per column, hence the cache.
   */
  mixed(fromHex, toHex, ratio) {
    const key = `${fromHex}|${toHex}|${Math.round(ratio * 100)}`;
    let value = this.mixCache.get(key);
    if (value === undefined) {
      value = mix(fromHex, toHex, ratio);
      this.mixCache.set(key, value);
    }
    return value;
  }

  /** A colour softened toward the surface it is drawn on. */
  soften(hex, ratio = 0.5, surface = null) {
    return this.mixed(surface || this.roles.surface, hex, 1 - ratio);
  }

  /**
   * Paint options for a role used as a signal (success, warning, danger, ...). Themes with no
   * hue to spare — Retro is all one green — give a signal weight instead: bold, or inverse
   * (dark text on a bar of the role's colour). Themes that don't define one get a plain `fg`.
   */
  signal(name, options = {}) {
    const hex = this.role(name);
    const style = this.signalStyle[name];
    if (!style) return { ...options, fg: hex };
    const { inverse, ...rest } = style;
    return inverse
      ? { ...options, ...rest, fg: this.roles.background, bg: hex }
      : { ...options, ...rest, fg: hex };
  }

  role(name) { return this.roles[name] || PALETTE.normal; }
}

export const defaultTheme = new Theme();
