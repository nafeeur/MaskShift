// Double-buffered terminal screen.
//
// Frames are produced as an array of fully styled lines; the screen diffs them
// against the previous frame and rewrites only the rows that changed, which
// keeps large repaints flicker-free over SSH.

import { ESC } from './theme.mjs';
import { fit } from './text.mjs';

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
      columns: Math.max(40, this.output.columns || 80),
      rows: Math.max(12, this.output.rows || 24),
    };
  }

  write(text) {
    this.output.write(text);
  }

  enter() {
    if (this.active) return;
    this.active = true;
    this.previous = [];
    this.write(`${ANSI.altScreenOn}${ANSI.hideCursor}${ANSI.clear}`);
    this.applyMouse();
    this.output.on('resize', this.handleResize);
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    this.output.off('resize', this.handleResize);
    if (this.mouseActive) { this.write(ANSI.mouseOff); this.mouseActive = false; }
    this.write(`${ANSI.reset}${ANSI.showCursor}${ANSI.altScreenOff}`);
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
    for (let row = 0; row < rows; row += 1) frame.push(fit(lines[row] ?? '', columns));
    let out = '';
    for (let row = 0; row < rows; row += 1) {
      if (this.previous[row] === frame[row]) continue;
      out += `${ANSI.moveTo(row, 0)}${ANSI.clearLine}${frame[row]}${ANSI.reset}`;
    }
    if (cursor) out += `${ANSI.moveTo(cursor.row, cursor.column)}${ANSI.showCursor}`;
    else if (this.cursor) out += ANSI.hideCursor;
    this.cursor = cursor;
    this.previous = frame;
    this.frame = frame;
    if (out) this.write(out);
  }

  // Drop the cached frame so the next render repaints everything.
  invalidate() {
    this.previous = [];
  }
}
