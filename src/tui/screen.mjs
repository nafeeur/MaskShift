// Double-buffered terminal screen.
//
// Frames are produced as an array of fully styled lines; the screen diffs them
// against the previous frame and rewrites only the rows that changed, which
// keeps large repaints flicker-free over SSH.

import { ESC } from './theme.mjs';
import { fit, sanitizeTerminalLine, underlay } from './text.mjs';
import { DELETE_ALL, deleteEscape } from './image/kitty.mjs';

const CSI = `${ESC}[`;
const BEL = String.fromCharCode(7);

export const ANSI = {
  altScreenOn: `${CSI}?1049h`,
  altScreenOff: `${CSI}?1049l`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  // DECSCUSR: a blinking block (1) like a terminal of the period, and back to the user's own (0).
  cursorBlock: `${CSI}1 q`,
  cursorDefault: `${CSI}0 q`,
  clear: `${CSI}2J${CSI}H`,
  clearLine: `${CSI}2K`,
  home: `${CSI}H`,
  reset: `${CSI}0m`,
  bracketedPasteOn: `${CSI}?2004h`,
  bracketedPasteOff: `${CSI}?2004l`,
  // DEC 1004 focus reporting: the terminal sends CSI I / CSI O (see
  // input.mjs) when it gains or loses focus. Used to gate the desktop
  // notification on a finished run to "the user actually isn't looking
  // right now" rather than firing every time regardless. A terminal that
  // doesn't support it just never sends those bytes — MaskShift then treats
  // focus as unknown and simply never suppresses the notification on that
  // account, the same graceful-ignore every other DEC private mode gets.
  focusOn: `${CSI}?1004h`,
  focusOff: `${CSI}?1004l`,
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
  // Kitty graphics protocol: delete every image this pane placed. Sent
  // whenever an image overlay goes from present to absent — the placement
  // otherwise just sits there until something else happens to overwrite
  // those exact cells, which is the "picture doesn't go away" bug.
  kittyDeleteImages: `${ESC}_Ga=d${ESC}\\`,
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
    // The last inline-image placement actually sent to the terminal (see
    // `render`'s `overlay` parameter) — tracked so an unchanged image isn't
    // re-transmitted (a real cost: these payloads are base64 image bytes,
    // not a few SGR codes) on every one of the many frames it sits through.
    this.imageKey = null;
    // Which protocol drew it, so a *disappearing* image (switched views,
    // switched files, opened a modal) knows how to actually take it off the
    // terminal instead of just forgetting it was ever sent — Kitty holds a
    // placement until something explicitly deletes it or the alt-screen
    // itself is torn down, so simply stopping isn't enough.
    this.imageProtocol = null;
    // Where it was last drawn — an unchanged image that *scrolled* (same
    // key, new row) still needs resending: Kitty's placement is a cell-
    // coordinate overlay outside the normal text grid, so redrawing that
    // row's text alone leaves the old placement floating at its old
    // position instead of following the content it was anchored to.
    this.imageRow = null;
    this.imageColumn = null;
    // Placeholder images (see image/kitty.mjs) the terminal currently holds, id -> key. They are
    // drawn by ordinary text cells, so the only state to keep right is "has this one been
    // transmitted yet", and anything the terminal may have lost is simply sent again.
    this.images = new Map();
    // Deliberately doesn't also reset imageKey/imageProtocol: render()'s own
    // overlay diff is the one place that decides an image needs clearing
    // from the real terminal, and it can only make that call correctly if
    // it still remembers what (if anything) is actually sitting there.
    this.handleResize = () => {
      this.previous = [];
      this.images.clear();
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
    this.write(`${ANSI.saveTitle}${ANSI.altScreenOn}${ANSI.hideCursor}${ANSI.clear}${ANSI.focusOn}${ANSI.cursorBlock}`);
    this.applyMouse();
    this.output.on('resize', this.handleResize);
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    this.output.off('resize', this.handleResize);
    if (this.mouseActive) { this.write(ANSI.mouseOff); this.mouseActive = false; }
    // Leaving the alt-screen normally takes any Kitty placement with it, but
    // that's the terminal's own behaviour to rely on, not a guarantee — the
    // explicit delete costs nothing and closes the one path a stray image
    // could otherwise survive past MaskShift's own exit.
    const clearImage = (this.imageProtocol === 'kitty' || this.images.size) ? (this.images.size ? DELETE_ALL : ANSI.kittyDeleteImages) : '';
    this.images.clear();
    this.imageKey = null;
    this.imageProtocol = null;
    this.imageRow = null;
    this.imageColumn = null;
    this.write(`${clearImage}${ANSI.focusOff}${ANSI.cursorDefault}${ANSI.reset}${ANSI.showCursor}${ANSI.altScreenOff}${ANSI.restoreTitle}`);
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

  /**
   * Paint one frame. `cursor` is { row, column } or null to keep it hidden.
   *
   * `overlay`, when given, is `{ row, column, escape, key }` — a terminal
   * graphics protocol placement (Kitty/iTerm2 inline images; see
   * tui/image/render.mjs) written directly to the terminal at an absolute
   * screen position, bypassing `sanitizeTerminalLine` entirely. That
   * sanitizer is the trust boundary for anything that flows through `lines`
   * — model text, tool output, file contents — so an overlay is accepted
   * only as this separate, structurally distinct parameter, never smuggled
   * through a line string. Only code inside MaskShift itself constructs one.
   */
  render(lines, cursor = null, overlays = null) {
    const { columns, rows } = this.size;
    // One overlay, several, or none. Placeholder images are drawn by the text rows themselves and
    // only need transmitting; at most one classic placement is positioned on top of the text.
    const list = (Array.isArray(overlays) ? overlays : [overlays]).filter(Boolean);
    const overlay = list.find((item) => item.protocol !== 'kitty-unicode') || null;
    const placeholders = list.filter((item) => item.protocol === 'kitty-unicode');
    // invalidate()/a resize dropped the cached frame — every row is about to
    // be rewritten from scratch, which on a real terminal can itself be what
    // disturbs (or outright clears) an existing Kitty placement. An
    // unchanged overlay would otherwise be skipped as "already sent"; here
    // that assumption no longer holds, so it needs resending too.
    const fullRepaint = this.previous.length === 0;
    const frame = [];
    for (let row = 0; row < rows; row += 1) {
      const line = fit(sanitizeTerminalLine(lines[row] ?? ''), columns);
      const ground = this.theme?.groundCode ? this.theme.groundCode(row) : '';
      frame.push(ground ? underlay(line, ground) : line);
    }
    let out = '';
    // Transmit before the rows that refer to the image, in the same write, so a placeholder
    // never reaches the terminal ahead of its picture.
    const wanted = new Set(placeholders.map((item) => item.id));
    for (const item of placeholders) {
      if (this.images.get(item.id) === item.key) continue;
      out += item.escape;
      this.images.set(item.id, item.key);
    }
    let changedRows = 0;
    for (let row = 0; row < rows; row += 1) {
      if (this.previous[row] === frame[row]) continue;
      changedRows += 1;
      out += `${ANSI.moveTo(row, 0)}${ANSI.clearLine}${frame[row]}${ANSI.reset}`;
    }
    const moved = overlay && (overlay.row !== this.imageRow || overlay.column !== this.imageColumn);
    if (overlay && (overlay.key !== this.imageKey || moved || fullRepaint)) {
      // Kitty's placement escape already carries its own delete-all prefix
      // (see image/render.mjs's kittyLines), so resending it here — even
      // for the exact same image, just scrolled to a new row — both moves
      // it and cleans up whatever was at its old position in one write.
      out += `${ANSI.moveTo(overlay.row, overlay.column)}${overlay.escape}`;
      this.imageKey = overlay.key;
      this.imageProtocol = overlay.protocol || null;
      this.imageRow = overlay.row;
      this.imageColumn = overlay.column;
    } else if (!overlay && this.imageKey) {
      // The escape that drew a *new* image already carries its own
      // Kitty delete-all prefix (see image/render.mjs), so that transition
      // self-clears. This is the other one: no new image to draw at all.
      if (this.imageProtocol === 'kitty') out += ANSI.kittyDeleteImages;
      this.imageKey = null;
      this.imageProtocol = null;
      this.imageRow = null;
      this.imageColumn = null;
    }
    // Images no row refers to any more are freed in the terminal instead of piling up there.
    for (const id of [...this.images.keys()]) {
      if (wanted.has(id)) continue;
      out += deleteEscape(id);
      this.images.delete(id);
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

  // Drop the cached frame so the next render repaints everything. Leaves
  // imageKey/imageProtocol alone for the same reason handleResize does.
  invalidate() {
    this.previous = [];
  }

  /**
   * Make the terminal match what this screen believes it is showing. Called when the terminal
   * regains focus, the process resumes or the window is resized — the moments a terminal (or tmux,
   * or a window manager) may have dropped, kept or moved graphics behind our back. Repaints every
   * row and sends every image again; a classic placement is re-placed with its own delete first.
   */
  resync() {
    this.previous = [];
    this.images.clear();
    this.imageKey = null;
  }
}
