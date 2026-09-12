// Raw-mode input decoder.
//
// Turns the byte soup arriving on stdin into { name, ctrl, alt, shift, ... }
// events, including bracketed paste so dropping a large prompt into the
// composer stays a single event instead of a thousand keystrokes, and SGR
// mouse reports so every panel, tab and row can be clicked as well as typed
// at.

import { EventEmitter } from 'node:events';
import { ESC } from './theme.mjs';

const CTRL_NAMES = {
  0x00: 'space', 0x08: 'backspace', 0x09: 'tab', 0x0d: 'enter', 0x7f: 'backspace',
};

const CSI_FINAL = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end',
  P: 'f1', Q: 'f2', R: 'f3', S: 'f4', Z: 'backtab',
};

const CSI_TILDE = {
  1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown',
  11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5', 17: 'f6', 18: 'f7',
  19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12',
};

function modifiers(code) {
  const value = Number(code || 1) - 1;
  return { shift: Boolean(value & 1), alt: Boolean(value & 2), ctrl: Boolean(value & 4) };
}

function key(name, extra = {}) {
  return { name, ctrl: false, alt: false, shift: false, sequence: '', ...extra };
}

const MOUSE_BUTTONS = ['left', 'middle', 'right', 'none'];
const WHEEL_BUTTONS = ['wheelup', 'wheeldown', 'wheelleft', 'wheelright'];

/**
 * Turn an xterm button mask plus 1-based cell coordinates into a mouse event.
 *
 * The two encodings disagree about button code 3: SGR reports a release
 * through the `m` terminator and uses code 3 for "no button", which combined
 * with the motion bit is a bare hover. Legacy X10 has no separate terminator
 * and spends code 3 on the release itself, so it can never report a hover.
 */
function mouse(mask, x, y, released, legacy = false) {
  const shift = Boolean(mask & 4);
  const alt = Boolean(mask & 8);
  const ctrl = Boolean(mask & 16);
  const motion = Boolean(mask & 32);
  const wheel = Boolean(mask & 64);
  const low = mask & 3;

  let button;
  let type;
  if (wheel) {
    button = WHEEL_BUTTONS[low];
    type = 'wheel';
  } else {
    button = MOUSE_BUTTONS[low];
    if (released) type = 'release';
    // Motion with no button held is a hover, only sent under ?1003h.
    else if (motion) type = button === 'none' ? 'move' : 'drag';
    else if (legacy && low === 3) type = 'release';
    else type = 'press';
  }

  return {
    name: 'mouse',
    type,
    button,
    row: Math.max(0, y - 1),
    column: Math.max(0, x - 1),
    ctrl,
    alt,
    shift,
    sequence: '',
  };
}

/**
 * Decode a chunk into discrete key events.
 * Returns { events, rest } where `rest` is an incomplete trailing sequence.
 */
export function decode(chunk) {
  const events = [];
  let index = 0;
  while (index < chunk.length) {
    const character = chunk[index];

    if (character !== ESC) {
      const code = character.codePointAt(0);
      if (code < 32 || code === 0x7f) {
        const name = CTRL_NAMES[code];
        if (name) { events.push(key(name, { sequence: character })); index += 1; continue; }
        const letter = String.fromCharCode(code + 96);
        events.push(key(letter, { ctrl: true, sequence: character }));
        index += 1;
        continue;
      }
      const glyph = String.fromCodePoint(code);
      events.push(key(glyph, { sequence: glyph, printable: true }));
      index += glyph.length;
      continue;
    }

    // Lone ESC at the very end: keep it, the next chunk may complete it.
    if (index === chunk.length - 1) return { events, rest: chunk.slice(index) };

    const next = chunk[index + 1];

    if (next === '[' || next === 'O') {
      // SGR mouse (?1006): ESC [ < mask ; col ; row M|m — the only encoding
      // that survives a UTF-8 stream and terminals wider than 223 columns.
      if (chunk[index + 2] === '<') {
        const sgr = /^\[<(\d+);(\d+);(\d+)([Mm])/.exec(chunk.slice(index + 1));
        if (!sgr) return { events, rest: chunk.slice(index) };
        events.push(mouse(Number(sgr[1]), Number(sgr[2]), Number(sgr[3]), sgr[4] === 'm'));
        index += 1 + sgr[0].length;
        continue;
      }

      // Legacy X10 mouse: ESC [ M then three bytes biased by 32. Kept as a
      // fallback for terminals that ignore ?1006h; it cannot address a cell
      // past column 223, so coordinates are clamped rather than wrapped.
      if (chunk[index + 2] === 'M') {
        if (chunk.length < index + 6) return { events, rest: chunk.slice(index) };
        const mask = chunk.codePointAt(index + 3) - 32;
        const x = chunk.codePointAt(index + 4) - 32;
        const y = chunk.codePointAt(index + 5) - 32;
        if (mask >= 0 && x >= 0 && y >= 0) events.push(mouse(mask, x, y, false, true));
        index += 6;
        continue;
      }

      const match = /^(\[|O)([0-9;]*)([~A-Za-z])/.exec(chunk.slice(index + 1));
      if (!match) return { events, rest: chunk.slice(index) };

      // Bracketed paste arrives as ESC[200~ ... ESC[201~.
      if (match[1] === '[' && match[2] === '200' && match[3] === '~') {
        const start = index + 1 + match[0].length;
        const terminator = chunk.indexOf(`${ESC}[201~`, start);
        if (terminator === -1) return { events, rest: chunk.slice(index) };
        events.push(key('paste', { text: chunk.slice(start, terminator), sequence: 'paste' }));
        index = terminator + 6;
        continue;
      }

      const parameters = match[2].split(';');
      const final = match[3];
      const flags = modifiers(parameters[1]);
      if (final === '~') {
        const name = CSI_TILDE[Number(parameters[0])];
        if (name) events.push(key(name, { ...flags, sequence: match[0] }));
      } else if (CSI_FINAL[final]) {
        const name = CSI_FINAL[final];
        const shift = name === 'backtab' ? true : flags.shift;
        events.push(key(name === 'backtab' ? 'tab' : name, { ...flags, shift, sequence: match[0] }));
      }
      index += 1 + match[0].length;
      continue;
    }

    // ESC + printable is Alt+key; ESC ESC is a plain escape.
    if (next === ESC) { events.push(key('escape', { sequence: ESC })); index += 1; continue; }
    const code = next.codePointAt(0);
    if (code < 32) {
      events.push(key(String.fromCharCode(code + 96), { ctrl: true, alt: true, sequence: chunk.slice(index, index + 2) }));
    } else {
      const glyph = String.fromCodePoint(code);
      events.push(key(glyph, { alt: true, sequence: `${ESC}${glyph}`, printable: false }));
      index += glyph.length - 1;
    }
    index += 2;
  }
  return { events, rest: '' };
}

export class Keyboard extends EventEmitter {
  constructor({ input = process.stdin } = {}) {
    super();
    this.input = input;
    this.buffer = '';
    this.attached = false;
    this.paused = false;
    this.wasRaw = Boolean(input.isRaw);
    this.wasPaused = Boolean(input.isPaused?.());
    this.handleData = (chunk) => {
      if (this.paused) return;
      this.buffer += chunk;
      const { events, rest } = decode(this.buffer);
      this.buffer = rest;
      for (const event of events) {
        if (event.name === 'mouse') { this.emit('mouse', event); continue; }
        // A bare ESC that never resolved into a sequence.
        if (event.sequence === ESC && event.name !== 'escape') continue;
        this.emit('key', event);
      }
      // A trailing lone ESC means "escape" once no continuation arrives.
      if (this.buffer === ESC) {
        clearTimeout(this.escapeTimer);
        this.escapeTimer = setTimeout(() => {
          if (this.buffer === ESC) {
            this.buffer = '';
            this.emit('key', key('escape', { sequence: ESC }));
          }
        }, 40);
        this.escapeTimer.unref?.();
      }
    };
  }

  start() {
    if (this.attached) return;
    this.attached = true;
    this.wasRaw = Boolean(this.input.isRaw);
    this.wasPaused = Boolean(this.input.isPaused?.());
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.setEncoding('utf8');
    this.input.resume();
    this.input.on('data', this.handleData);
  }

  stop() {
    if (!this.attached) return;
    this.attached = false;
    clearTimeout(this.escapeTimer);
    this.input.off('data', this.handleData);
    if (this.input.isTTY) this.input.setRawMode(this.wasRaw);
    if (this.wasPaused) this.input.pause();
  }
}

// Convenience matcher used throughout the views.
export function matches(event, spec) {
  const parts = spec.toLowerCase().split('+');
  const name = parts.pop();
  const wantCtrl = parts.includes('ctrl');
  const wantAlt = parts.includes('alt');
  const wantShift = parts.includes('shift');
  return event.name.toLowerCase() === name
    && Boolean(event.ctrl) === wantCtrl
    && Boolean(event.alt) === wantAlt
    && (wantShift ? Boolean(event.shift) : true);
}
