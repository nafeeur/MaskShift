// Double-buffered terminal screen.
//
// Frames are produced as an array of fully styled lines; the screen diffs them
// against the previous frame and rewrites only the rows that changed, which
// keeps large repaints flicker-free over SSH.

import { ESC } from './theme.mjs';
import { fit, sanitizeTerminalLine } from './text.mjs';

const CSI = `${ESC}[`;
const BEL = String.fromCharCode(7);

export const ANSI = {
  altScreenOn: `${CSI}?1049h`,
  altScreenOff: `${CSI}?1049l`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  clear: `${CSI}2J${CSI}H`,
  clearLine: `${CSI}2K`,
  home: `${CSI}H`,
  reset: `${CSI}0m`,
  bracketedPasteOn: `${CSI}?2004h`,
  bracketedPasteOff: `${CSI}?2004l`,
  // DEC 2026 "synchronized output": tells a supporting terminal to buffer everything between
  // these two and present it as one atomic screen update, instead of painting each rewritten row
  // as its write arrives. Without it, a multi-row repaint over a slow link (SSH, tmux) or during
  // a burst of streaming deltas can show a half-updated frame for a moment — the "jaggedy" tear
  // this exists to prevent. It's a DEC private-mode escape: a terminal that doesn't recognize it
  // just ignores the bytes, so this is safe everywhere, not just on terminals that support it.
  syncOutputOn: `${CSI}?2026h`,
  syncOutputOff: `${CSI}?2026l`,
  saveTitle: `${CSI}22;0t`,
  restoreTitle: `${CSI}23;0t`,
  // ?1000 button reports, ?1002 adds drag, ?1003 adds bare hover motion, and
  // ?1006 is the SGR encoding — the only one that addresses a cell past
  // column 223 and survives a UTF-8 stream.
  mouseOn: (hover = false) => `${CSI}?1000h${CSI}?${hover ? 1003 : 1002}h${CSI}?1006h`,
  mouseOff: `${CSI}?1006l${CSI}?1003l${CSI}?1002l${CSI}?1000l`,
  moveTo: (row, column) => `${CSI}${row + 1};${column + 1}H`,
};

export class Screen {
  constructor({ output = process.stdout, theme, mouse = 'click' } = {}) {
    this.output = output;
    this.theme = theme;
    this.previous = [];
    this.active = false;
    this.cursor = null;
    this.title = null;
    this.onResize = null;
    // 'off' | 'click' (press, release, drag) | 'hover' (adds bare motion).
    this.mouse = mouse;
    this.mouseActive = false;
    this.handleResize = () => {
      this.previous = [];
      if (this.onResize) this.onResize(this.size);
    };
  }

  get size() {
    return {
      columns: Math.max(1, this.output.columns || 80),
      rows: Math.max(1, this.output.rows || 24),
    };
  }

  write(text) {
    this.output.write(text);
  }

  enter() {
    if (this.active) return;
    this.active = true;
    this.previous = [];
    this.output.ref?.();
    this.write(`${ANSI.saveTitle}${ANSI.altScreenOn}${ANSI.hideCursor}${ANSI.clear}`);
    this.applyMouse();
    this.output.on('resize', this.handleResize);
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    this.output.off('resize', this.handleResize);
    if (this.mouseActive) { this.write(ANSI.mouseOff); this.mouseActive = false; }
    this.write(`${ANSI.reset}${ANSI.showCursor}${ANSI.altScreenOff}${ANSI.restoreTitle}`);
    // Writing is synchronous for a TTY, but the handle itself stays referenced until told
    // otherwise, which is what kept the process alive after quitting.
    this.output.unref?.();
  }

  /**
   * Bring the terminal's mouse reporting in line with `this.mouse`.
   * Tracking is left off while the screen is inactive so a crash between
   * `enter` and `leave` cannot strand the terminal in reporting mode.
   */
  applyMouse() {
    const wanted = this.active && this.mouse !== 'off';
    if (wanted === this.mouseActive && !wanted) return;
    if (!wanted) { this.write(ANSI.mouseOff); this.mouseActive = false; return; }
    this.write(ANSI.mouseOff + ANSI.mouseOn(this.mouse === 'hover'));
    this.mouseActive = true;
  }

  setMouse(mode) {
    if (this.mouse === mode) return;
    this.mouse = mode;
    this.applyMouse();
  }

  setTitle(text) {
    if (this.title === text) return;
    this.title = text;
    this.write(`${ESC}]0;${text}${BEL}`);
  }

  // Paint one frame. `cursor` is { row, column } or null to keep it hidden.
  render(lines, cursor = null) {
    const { columns, rows } = this.size;
    const frame = [];
    for (let row = 0; row < rows; row += 1) {
      frame.push(fit(sanitizeTerminalLine(lines[row] ?? ''), columns));
    }
    let out = '';
    let changedRows = 0;
    for (let row = 0; row < rows; row += 1) {
      if (this.previous[row] === frame[row]) continue;
      changedRows += 1;
      out += `${ANSI.moveTo(row, 0)}${ANSI.clearLine}${frame[row]}${ANSI.reset}`;
    }
    if (cursor) out += `${ANSI.moveTo(cursor.row, cursor.column)}${ANSI.showCursor}`;
    else if (this.cursor) out += ANSI.hideCursor;
    this.cursor = cursor;
    this.previous = frame;
    this.frame = frame;
    // A single-row touch-up (the common case: a spinner frame, a cursor blink) is already
    // atomic as far as the terminal's own line-buffering is concerned — synchronized output
    // earns its keep on a real multi-row repaint.
    if (out) this.write(changedRows > 1 ? `${ANSI.syncOutputOn}${out}${ANSI.syncOutputOff}` : out);
  }

  // Drop the cached frame so the next render repaints everything.
  invalidate() {
    this.previous = [];
  }
}
