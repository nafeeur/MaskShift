// A question put to the person inside the chat itself: pick one or several options, type an answer
// of their own, confirm, enter a secret, or approve a tool call. It sits directly above the
// composer — no dialog, no other screen — and owns the keyboard until it is answered, so a run
// that needs a decision reads like a conversation rather than an interruption.
//
// Option rows are a list: ↑/↓ moves, digits jump, space toggles when several may be chosen, enter
// submits, esc declines. A final "type your own answer" row is a text field; arriving on it and
// typing is enough. The component is pure state plus a renderer; app.mjs and interaction.mjs wire
// what happens to an answer.

import { glyphs } from './box.mjs';
import { fit, selectedRow, truncate, wrap } from './text.mjs';
import { SPACE } from './tokens.mjs';
import { chip, gutter, key as typeKey } from './type.mjs';
import { TextField } from './widgets.mjs';

const detailOf = (option) => [option.price, option.rating ? `${option.rating}★` : '', option.detail].filter(Boolean).join('  ·  ');

export class InlinePrompt {
  /**
   * kind: 'choose' | 'text' | 'secret' | 'confirm' | 'approval'
   * options: [{ id, label, detail?, price?, rating?, tone? }] (choose, confirm, approval)
   * onAnswer(answer): called once with { ids, other } | { value } | { yes } | { choice }, or null if declined.
   */
  constructor({
    kind, title = '', question = '', options = [], multi = false, allowOther = false, otherLabel = 'Type your own answer…',
    preview = null, danger = false, placeholder = '', defaultId = null, onAnswer,
  }) {
    this.kind = kind;
    this.title = title;
    this.question = question;
    this.options = options;
    this.multi = multi;
    this.allowOther = allowOther;
    this.otherLabel = otherLabel;
    this.preview = preview;
    this.danger = danger;
    this.onAnswer = onAnswer;
    this.selected = new Set();
    this.other = new TextField({ placeholder: kind === 'choose' ? otherLabel : placeholder, mask: kind === 'secret' });
    const start = defaultId === null ? 0 : Math.max(0, options.findIndex((option) => option.id === defaultId));
    // Text and secret prompts are just the field; for danger the safe answer starts selected.
    this.cursor = kind === 'text' || kind === 'secret' ? 0 : (danger ? Math.max(0, options.length - 1) : start);
    this.answered = false;
  }

  get hasField() { return this.kind === 'text' || this.kind === 'secret'; }
  get otherIndex() { return this.options.length; }
  get onOther() { return this.hasField || (this.allowOther && this.cursor === this.otherIndex); }
  get rowCount() { return this.options.length + (this.allowOther ? 1 : 0); }

  finish(answer) {
    if (this.answered) return;
    this.answered = true;
    this.onAnswer(answer);
  }

  decline() { this.finish(null); }

  #submitChoice(ids = null) {
    if (this.kind === 'confirm') { this.finish({ yes: this.options[this.cursor]?.id === 'yes' }); return; }
    if (this.kind === 'approval') { this.finish({ choice: this.options[this.cursor]?.id || 'no' }); return; }
    const other = this.allowOther ? this.other.value.trim() : '';
    if (ids) { this.finish({ ids, other: other || null }); return; }
    this.finish({ ids: [], other: other || null });
  }

  #chosenIds() {
    if (this.multi) return this.options.filter((option) => this.selected.has(option.id)).map((option) => option.id);
    return this.options[this.cursor] ? [this.options[this.cursor].id] : [];
  }

  submit() {
    if (this.hasField) {
      const value = this.other.value;
      if (this.kind === 'secret' && !value) { this.decline(); return; }
      if (!value.trim() && this.kind === 'text') { this.decline(); return; }
      this.finish({ value });
      return;
    }
    if (this.kind === 'confirm' || this.kind === 'approval') { this.#submitChoice(); return; }
    if (this.cursor === this.otherIndex && this.allowOther) {
      if (!this.other.value.trim()) return;
      this.finish({ ids: this.multi ? this.#chosenIds() : [], other: this.other.value.trim() });
      return;
    }
    const ids = this.multi ? (this.selected.size ? this.#chosenIds() : this.#chosenIds().concat(this.options[this.cursor]?.id).filter(Boolean)) : this.#chosenIds();
    this.#submitChoice(ids);
  }

  /** A click or digit on row `index`. */
  activate(index) {
    this.cursor = Math.max(0, Math.min(this.rowCount - 1, index));
    if (this.cursor === this.otherIndex && this.allowOther) return;
    if (this.multi && this.kind === 'choose') { this.toggle(); return; }
    this.submit();
  }

  toggle() {
    const option = this.options[this.cursor];
    if (!option) return;
    if (this.selected.has(option.id)) this.selected.delete(option.id); else this.selected.add(option.id);
  }

  handle(event) {
    if (event.name === 'escape') { this.decline(); return true; }
    if (this.hasField) {
      if (event.name === 'enter') { this.submit(); return true; }
      this.other.handle(event);
      return true;
    }
    if (event.name === 'up') { this.cursor = (this.cursor - 1 + this.rowCount) % this.rowCount; return true; }
    if (event.name === 'down') { this.cursor = (this.cursor + 1) % this.rowCount; return true; }
    if (event.name === 'tab') { this.cursor = (this.cursor + (event.shift ? -1 : 1) + this.rowCount) % this.rowCount; return true; }
    if (event.name === 'pageup' || event.name === 'home') { this.cursor = 0; return true; }
    if (event.name === 'pagedown' || event.name === 'end') { this.cursor = this.rowCount - 1; return true; }
    if (this.onOther) {
      if (event.name === 'enter') { this.submit(); return true; }
      this.other.handle(event);
      return true;
    }
    if (event.name === 'enter') { this.submit(); return true; }
    if (event.name === 'space' || event.name === ' ') {
      if (this.multi && this.kind === 'choose') this.toggle(); else this.submit();
      return true;
    }
    if ((this.kind === 'confirm' || this.kind === 'approval') && !event.ctrl && !event.alt) {
      const byKey = { y: 'yes', n: 'no', a: 'always' }[event.name];
      const index = this.options.findIndex((option) => option.id === byKey);
      if (index >= 0) { this.cursor = index; this.submit(); return true; }
    }
    if (/^[1-9]$/.test(event.name) && !event.ctrl && !event.alt) {
      const index = Number(event.name) - 1;
      if (index < this.rowCount) { this.activate(index); return true; }
    }
    return true;
  }

  /**
   * Draw into `width` columns and at most `maxRows` rows. Returns the lines, which row offset each
   * option sits on (for clicks) and where the text caret is, if one is showing.
   */
  render(app, width, maxRows = 14) {
    const { theme } = app;
    const mark = glyphs(theme);
    const rows = [];
    const hit = [];
    const accent = this.danger ? theme.roles.danger : theme.roles.accent;
    const head = chip(theme, ` ${truncate(this.title || 'Question', Math.max(8, width - 12))} `, { tone: accent });
    rows.push(fit(gutter(theme) + head, width));
    const questionLines = wrap(this.question, Math.max(10, width - SPACE.gutter - 2)).slice(0, 4);
    for (const line of questionLines) rows.push(fit(gutter(theme) + theme.paint(line, { fg: theme.roles.text, bold: true }), width));

    // Everything below the question is the answer area; the preview gives way first when short of room.
    const listRows = this.rowCount + (this.hasField ? 1 : 0);
    const room = Math.max(0, maxRows - rows.length - listRows - 1);
    const previewLines = (this.preview || []).slice(0, room);
    for (const line of previewLines) rows.push(fit(gutter(theme) + line, width));
    if (previewLines.length < (this.preview || []).length) {
      rows[rows.length - 1] = fit(gutter(theme) + theme.paint(`… ${(this.preview || []).length - previewLines.length + 1} more lines`, { fg: theme.roles.faint, italic: true }), width);
    }

    let cursor = null;
    const fieldWidth = Math.max(8, width - SPACE.gutter - 4);
    if (this.hasField) {
      const rendered = this.other.render(theme, fieldWidth, { focused: true });
      rows.push(fit(gutter(theme, mark.caret, { tone: theme.roles.primary }) + rendered.text, width));
      cursor = { row: rows.length - 1, column: SPACE.gutter + rendered.cursorColumn };
    } else {
      const numberWidth = String(this.rowCount).length;
      this.options.forEach((option, index) => {
        const active = index === this.cursor;
        const box = this.multi && this.kind === 'choose' ? (this.selected.has(option.id) ? `[${mark.check}] ` : '[ ] ') : '';
        const number = theme.paint(`${String(index + 1).padStart(numberWidth)}. `, { fg: active ? accent : theme.roles.muted });
        const label = theme.paint(`${box}${option.label}`, { fg: option.tone || (active ? theme.roles.text : theme.roles.text), bold: active });
        const detail = detailOf(option);
        const used = SPACE.gutter + numberWidth + 2 + (box ? 4 : 0) + option.label.length;
        const tail = detail && width - used > 8 ? theme.paint(`  ${truncate(detail, width - used - 2)}`, { fg: theme.roles.muted }) : '';
        const line = fit(gutter(theme, active ? mark.caret : '', { tone: accent }) + number + label + tail, width);
        hit.push({ offset: rows.length, index });
        rows.push(active ? selectedRow(theme, line) : line);
      });
      if (this.allowOther) {
        const active = this.cursor === this.otherIndex;
        const prefix = gutter(theme, active ? mark.caret : '', { tone: accent })
          + theme.paint(`${String(this.otherIndex + 1).padStart(numberWidth)}. `, { fg: active ? accent : theme.roles.muted });
        const rendered = this.other.render(theme, Math.max(8, width - SPACE.gutter - numberWidth - 4), { focused: active });
        const line = fit(prefix + rendered.text, width);
        hit.push({ offset: rows.length, index: this.otherIndex });
        if (active) cursor = { row: rows.length, column: SPACE.gutter + numberWidth + 2 + rendered.cursorColumn };
        rows.push(active ? selectedRow(theme, line) : line);
      }
    }

    const keys = this.hasField
      ? [['↵', 'send'], ['esc', 'cancel']]
      : this.kind === 'confirm' || this.kind === 'approval'
        ? [['↑↓', 'move'], ['↵', 'choose'], ['y/n', 'quick answer'], ['esc', 'decline']]
        : [['↑↓', 'move'], ...(this.multi ? [['space', 'select']] : []), ['↵', this.multi ? 'submit' : 'choose'], ['1-9', 'jump'], ['esc', 'cancel']];
    const hints = keys.map(([k, label]) => typeKey(theme, k) + theme.paint(` ${label}`, { fg: theme.roles.muted }))
      .join(theme.paint(` ${mark.dot} `, { fg: theme.roles.border }));
    rows.push(fit(gutter(theme) + hints, width));
    return { lines: rows, hit, cursor };
  }
}
