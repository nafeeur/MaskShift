// MaskShift terminal theme: "Phantom Protocol".
//
// The palette itself lives in tokens.mjs; this file is the renderer that puts
// it on the wire, degrading truecolor to 256 and 16 colours so the identity
// survives on any terminal. Nothing here decides what a colour means.

import { Motion } from './motion.mjs';
import { NEUTRAL, PALETTE, ROLES, SIGNAL, BRAND } from './tokens.mjs';

export { PALETTE, ROLES, NEUTRAL, BRAND, SIGNAL };

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

function to256([r, g, b]) {
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}

function to16([r, g, b]) {
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
  constructor({ depth = detectDepth(), unicode = supportsUnicode(), motion = null, frozen = false } = {}) {
    this.depth = depth;
    this.unicode = unicode;
    this.palette = PALETTE;
    this.roles = ROLES;
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
    return `${CSI}${to16(rgb) + 10}m`;
  }

  get reset() { return this.depth === 0 ? '' : `${CSI}0m`; }
  get bold() { return this.depth === 0 ? '' : `${CSI}1m`; }
  get faint() { return this.depth === 0 ? '' : `${CSI}2m`; }
  get italic() { return this.depth === 0 ? '' : `${CSI}3m`; }
  get underline() { return this.depth === 0 ? '' : `${CSI}4m`; }
  get inverse() { return this.depth === 0 ? '' : `${CSI}7m`; }

  paint(text, options = {}) {
    const value = String(text ?? '');
    if (this.depth === 0 || value === '') return value;
    let prefix = '';
    if (options.bold) prefix += this.bold;
    if (options.dim) prefix += this.faint;
    if (options.italic) prefix += this.italic;
    if (options.underline) prefix += this.underline;
    if (options.inverse) prefix += this.inverse;
    if (options.fg) prefix += this.fg(options.fg);
    if (options.bg) prefix += this.bg(options.bg);
    return prefix ? `${prefix}${value}${this.reset}` : value;
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

  role(name) { return this.roles[name] || PALETTE.bone; }
}

export const defaultTheme = new Theme();
