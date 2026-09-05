// Reusable interactive pieces: text fields, the multi-line composer,
// scrollable lists and viewports, spinners and toasts.

import { glyphs } from './box.mjs';
import { fit, repeat, truncate } from './text.mjs';

export class TextField {
  constructor({ value = '', placeholder = '', onSubmit = null, mask = false } = {}) {
    this.value = value;
    this.cursor = value.length;
    this.placeholder = placeholder;
    this.onSubmit = onSubmit;
    this.mask = mask;
    this.history = [];
    this.historyIndex = -1;
  }

  set(value) {
    this.value = value ?? '';
    this.cursor = this.value.length;
  }

  clear() { this.set(''); }

  remember(entry) {
    if (!entry) return;
    if (this.history[this.history.length - 1] !== entry) this.history.push(entry);
    this.historyIndex = this.history.length;
  }

  handle(event) {
    if (event.name === 'paste') { this.insert(event.text.replace(/\n/g, ' ')); return true; }
    if (event.printable && !event.ctrl && !event.alt) { this.insert(event.name); return true; }
    switch (true) {
      case event.name === 'left' && !event.ctrl: this.cursor = Math.max(0, this.cursor - 1); return true;
      case event.name === 'right' && !event.ctrl: this.cursor = Math.min(this.value.length, this.cursor + 1); return true;
      case event.name === 'left' && event.ctrl: this.cursor = this.wordLeft(); return true;
      case event.name === 'right' && event.ctrl: this.cursor = this.wordRight(); return true;
      case event.name === 'home' || (event.ctrl && event.name === 'a'): this.cursor = 0; return true;
      case event.name === 'end' || (event.ctrl && event.name === 'e'): this.cursor = this.value.length; return true;
      case event.name === 'backspace': {
        if (this.cursor === 0) return true;
        this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
        this.cursor -= 1;
        return true;
      }
      case event.name === 'delete': {
        this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
        return true;
      }
      case event.ctrl && event.name === 'u': this.value = this.value.slice(this.cursor); this.cursor = 0; return true;
      case event.ctrl && event.name === 'k': this.value = this.value.slice(0, this.cursor); return true;
      case event.ctrl && event.name === 'w': {
        const target = this.wordLeft();
        this.value = this.value.slice(0, target) + this.value.slice(this.cursor);
        this.cursor = target;
        return true;
      }
      case event.name === 'up' && this.history.length > 0: {
        this.historyIndex = Math.max(0, this.historyIndex - 1);
        this.set(this.history[this.historyIndex] ?? '');
        return true;
      }
      case event.name === 'down' && this.history.length > 0: {
        this.historyIndex = Math.min(this.history.length, this.historyIndex + 1);
        this.set(this.history[this.historyIndex] ?? '');
        return true;
      }
      case event.name === 'enter': {
        if (this.onSubmit) this.onSubmit(this.value);
        return true;
      }
      default: return false;
    }
  }

  insert(text) {
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
  }

  wordLeft() {
    let index = this.cursor;
    while (index > 0 && /\s/.test(this.value[index - 1])) index -= 1;
    while (index > 0 && !/\s/.test(this.value[index - 1])) index -= 1;
    return index;
  }

  wordRight() {
    let index = this.cursor;
    while (index < this.value.length && !/\s/.test(this.value[index])) index += 1;
    while (index < this.value.length && /\s/.test(this.value[index])) index += 1;
    return index;
  }

  /** Render into `width` columns, returning { text, cursorColumn }. */
  render(theme, width, { focused = true } = {}) {
    const mark = glyphs(theme);
    if (!this.value) {
      const hint = theme.paint(truncate(this.placeholder, width), { fg: theme.roles.border, italic: true });
      return { text: fit(hint, width), cursorColumn: 0 };
    }
    const shown = this.mask ? repeat(mark.dot, this.value.length) : this.value;
    const offset = Math.max(0, this.cursor - width + 1);
    const window = shown.slice(offset, offset + width);
    return {
      text: fit(theme.paint(window, { fg: focused ? theme.roles.text : theme.roles.muted }), width),
      cursorColumn: Math.min(width - 1, this.cursor - offset),
    };
  }
}

export class Composer {
  constructor({ value = '', placeholder = '' } = {}) {
    this.value = value;
    this.cursor = value.length;
    this.placeholder = placeholder;
    this.history = [];
    this.historyIndex = 0;
    this.draft = '';
  }

  set(value) { this.value = value ?? ''; this.cursor = this.value.length; }
  clear() { this.set(''); }

  remember(entry) {
    if (!entry.trim()) return;
    this.history.push(entry);
    this.historyIndex = this.history.length;
  }

  insert(text) {
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
  }

  lineBounds() {
    const start = this.value.lastIndexOf('\n', Math.max(0, this.cursor - 1)) + 1;
    const nextBreak = this.value.indexOf('\n', this.cursor);
    return { start, end: nextBreak === -1 ? this.value.length : nextBreak };
  }

  handle(event) {
    if (event.name === 'paste') { this.insert(event.text); return true; }
    if (event.printable && !event.ctrl && !event.alt) { this.insert(event.name); return true; }
    if (event.alt && event.name === 'enter') { this.insert('\n'); return true; }
    switch (true) {
      case event.name === 'backspace': {
        if (this.cursor === 0) return true;
        this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
        this.cursor -= 1;
        return true;
      }
      case event.name === 'delete':
        this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
        return true;
      case event.name === 'left': this.cursor = Math.max(0, this.cursor - 1); return true;
      case event.name === 'right': this.cursor = Math.min(this.value.length, this.cursor + 1); return true;
      case event.name === 'home': this.cursor = this.lineBounds().start; return true;
      case event.name === 'end': this.cursor = this.lineBounds().end; return true;
      case event.ctrl && event.name === 'u': this.value = this.value.slice(this.cursor); this.cursor = 0; return true;
      case event.ctrl && event.name === 'w': {
        let index = this.cursor;
        while (index > 0 && /\s/.test(this.value[index - 1])) index -= 1;
        while (index > 0 && !/\s/.test(this.value[index - 1])) index -= 1;
        this.value = this.value.slice(0, index) + this.value.slice(this.cursor);
        this.cursor = index;
        return true;
      }
      case event.name === 'up': {
        const { start } = this.lineBounds();
        if (start === 0) {
          if (this.historyIndex > 0) {
            if (this.historyIndex === this.history.length) this.draft = this.value;
            this.historyIndex -= 1;
            this.set(this.history[this.historyIndex]);
          }
          return true;
        }
        const column = this.cursor - start;
        const previousStart = this.value.lastIndexOf('\n', start - 2) + 1;
        this.cursor = Math.min(previousStart + column, start - 1);
        return true;
      }
      case event.name === 'down': {
        const { end } = this.lineBounds();
        if (end === this.value.length) {
          if (this.historyIndex < this.history.length) {
            this.historyIndex += 1;
            this.set(this.historyIndex === this.history.length ? this.draft : this.history[this.historyIndex]);
          }
          return true;
        }
        const column = this.cursor - this.lineBounds().start;
        const nextEnd = this.value.indexOf('\n', end + 1);
        this.cursor = Math.min(end + 1 + column, nextEnd === -1 ? this.value.length : nextEnd);
        return true;
      }
      default: return false;
    }
  }

  /** Soft-wrap into `width` columns and locate the caret. */
  layout(width, maxRows) {
    const rows = [];
    let caret = { row: 0, column: 0 };
    let consumed = 0;
    for (const logical of this.value.split('\n')) {
      const pieces = width > 0 ? chunk(logical, width) : [logical];
      for (const [index, piece] of pieces.entries()) {
        const start = consumed;
        const end = consumed + piece.length;
        if (this.cursor >= start && (this.cursor < end || (this.cursor === end && index === pieces.length - 1))) {
          caret = { row: rows.length, column: this.cursor - start };
        }
        rows.push(piece);
        consumed = end;
      }
      consumed += 1; // the newline
    }
    if (rows.length === 0) rows.push('');
    const offset = Math.max(0, caret.row - maxRows + 1);
    return { rows: rows.slice(offset, offset + maxRows), caret: { row: caret.row - offset, column: caret.column }, total: rows.length };
  }
}

function chunk(text, width) {
  if (text.length === 0) return [''];
  const pieces = [];
  let index = 0;
  while (index < text.length) {
    let take = Math.min(width, text.length - index);
    if (index + take < text.length) {
      const space = text.lastIndexOf(' ', index + take);
      if (space > index + Math.floor(width / 3)) take = space - index + 1;
    }
    pieces.push(text.slice(index, index + take));
    index += take;
  }
  return pieces;
}

/** A selectable, filterable, scrolling list. */
export class ListView {
  constructor({ items = [], selected = 0 } = {}) {
    this.items = items;
    this.selected = selected;
    this.offset = 0;
  }

  setItems(items, { keepSelection = true } = {}) {
    const previous = keepSelection ? this.items[this.selected]?.id : null;
    this.items = items;
    const found = previous ? items.findIndex((item) => item.id === previous) : -1;
    this.selected = found >= 0 ? found : Math.min(this.selected, Math.max(0, items.length - 1));
  }

  get current() { return this.items[this.selected] ?? null; }

  move(delta, viewport = 10) {
    if (this.items.length === 0) return;
    this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + delta));
    this.ensureVisible(viewport);
  }

  first() { this.selected = 0; this.offset = 0; }
  last(viewport = 10) { this.selected = Math.max(0, this.items.length - 1); this.ensureVisible(viewport); }

  ensureVisible(viewport) {
    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + viewport) this.offset = this.selected - viewport + 1;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.items.length - viewport)));
  }

  handle(event, viewport = 10) {
    switch (true) {
      case event.name === 'up' || (event.ctrl && event.name === 'p'): this.move(-1, viewport); return true;
      case event.name === 'down' || (event.ctrl && event.name === 'n'): this.move(1, viewport); return true;
      case event.name === 'pageup': this.move(-viewport, viewport); return true;
      case event.name === 'pagedown': this.move(viewport, viewport); return true;
      case event.name === 'home': this.first(); return true;
      case event.name === 'end': this.last(viewport); return true;
      default: return false;
    }
  }

  /** `renderer(item, selected, width)` returns one styled line. */
  render(theme, width, height, renderer) {
    this.ensureVisible(height);
    const lines = [];
    const window = this.items.slice(this.offset, this.offset + height);
    for (const [index, item] of window.entries()) {
      lines.push(fit(renderer(item, this.offset + index === this.selected, width), width));
    }
    while (lines.length < height) lines.push(' '.repeat(width));
    return lines;
  }
}

/** A scrollable buffer of pre-rendered lines. */
export class Viewport {
  constructor() {
    this.lines = [];
    this.offset = 0;
    this.stick = true;
  }

  set(lines) {
    this.lines = lines;
    if (this.stick) this.offset = Number.POSITIVE_INFINITY;
  }

  clampOffset(height) {
    const max = Math.max(0, this.lines.length - height);
    this.offset = Math.max(0, Math.min(this.offset, max));
    this.stick = this.offset >= max;
    return this.offset;
  }

  scroll(delta, height) {
    this.offset = this.clampOffset(height) + delta;
    this.clampOffset(height);
  }

  toBottom() { this.offset = Number.POSITIVE_INFINITY; this.stick = true; }
  toTop() { this.offset = 0; this.stick = false; }

  handle(event, height) {
    switch (true) {
      case event.name === 'up': this.scroll(-1, height); return true;
      case event.name === 'down': this.scroll(1, height); return true;
      case event.name === 'pageup': this.scroll(-Math.max(1, height - 2), height); return true;
      case event.name === 'pagedown': this.scroll(Math.max(1, height - 2), height); return true;
      case event.name === 'home': this.toTop(); return true;
      case event.name === 'end': this.toBottom(); return true;
      default: return false;
    }
  }

  /**
   * `anchor: 'bottom'` pads above the content instead of below it, so a shell
   * transcript grows upward from the prompt the way a real terminal does.
   */
  render(height, width, { anchor = 'top' } = {}) {
    const start = this.clampOffset(height);
    const window = this.lines.slice(start, start + height);
    while (window.length < height) {
      if (anchor === 'bottom') window.unshift('');
      else window.push('');
    }
    return window.map((line) => fit(line, width));
  }

  // A one-column scrollbar rendered alongside the viewport.
  scrollbar(theme, height) {
    const mark = glyphs(theme);
    if (this.lines.length <= height) return new Array(height).fill(' ');
    const thumb = Math.max(1, Math.round((height / this.lines.length) * height));
    const track = height - thumb;
    const ratio = this.offset / Math.max(1, this.lines.length - height);
    const top = Math.round(ratio * track);
    return new Array(height).fill(null).map((value, index) => (
      index >= top && index < top + thumb
        ? theme.paint(mark.spine, { fg: theme.roles.primary })
        : theme.paint(mark.spine, { fg: theme.roles.border })
    ));
  }
}

const SPINNERS = {
  unicode: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  ascii: ['|', '/', '-', '\\'],
  pulse: ['◜', '◝', '◞', '◟'],
};

export class Spinner {
  constructor(kind = 'unicode') {
    this.frames = SPINNERS[kind] || SPINNERS.unicode;
    this.tick = 0;
  }

  advance() { this.tick = (this.tick + 1) % 10_000; }

  frame(theme) {
    const frames = theme.unicode ? this.frames : SPINNERS.ascii;
    return frames[this.tick % frames.length];
  }
}

export class Toasts {
  constructor({ limit = 4, ttlMs = 4200 } = {}) {
    this.items = [];
    this.limit = limit;
    this.ttlMs = ttlMs;
    this.counter = 0;
  }

  push(message, tone = 'info') {
    this.counter += 1;
    this.items.push({ id: this.counter, message, tone, expiresAt: Date.now() + this.ttlMs });
    if (this.items.length > this.limit) this.items.shift();
  }

  prune() {
    const now = Date.now();
    const before = this.items.length;
    this.items = this.items.filter((item) => item.expiresAt > now);
    return this.items.length !== before;
  }

  render(theme, width) {
    const mark = glyphs(theme);
    const tones = {
      info: theme.roles.info, success: theme.roles.success,
      warn: theme.roles.warning, error: theme.roles.danger,
    };
    return this.items.map((item) => {
      const colour = tones[item.tone] || theme.roles.info;
      const body = truncate(item.message, width - 4);
      return theme.paint(`${mark.spine} `, { fg: colour })
        + theme.paint(fit(body, width - 2), { fg: theme.roles.text, bg: theme.palette.raised });
    });
  }
}

/** Subsequence fuzzy match with a score; higher is better, null means no match. */
export function fuzzy(query, target) {
  if (!query) return { score: 0, positions: [] };
  const needle = query.toLowerCase();
  const haystack = String(target ?? '').toLowerCase();
  let index = 0;
  let score = 0;
  let previous = -2;
  const positions = [];
  for (const character of needle) {
    if (character === ' ') continue;
    const found = haystack.indexOf(character, index);
    if (found === -1) return null;
    score += found === previous + 1 ? 6 : 1;
    if (found === 0 || /[\s\-_/:.]/.test(haystack[found - 1] || '')) score += 4;
    positions.push(found);
    previous = found;
    index = found + 1;
  }
  return { score: score - Math.floor(haystack.length / 24), positions };
}

export function highlightMatch(theme, text, positions, colour) {
  if (!positions?.length) return text;
  const set = new Set(positions);
  return [...String(text)].map((character, index) => (
    set.has(index) ? theme.paint(character, { fg: colour || theme.roles.accent, bold: true }) : character
  )).join('');
}
