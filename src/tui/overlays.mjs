// Floating surfaces: the command palette, pickers, forms, confirmations and
// the key reference. Each overlay owns the keyboard while it is open.

import { glyphs, panel } from './box.mjs';
import { centreOffset } from './layout.mjs';
import { LAYER } from './regions.mjs';
import { fit, repeat, truncate, visibleWidth, wrap } from './text.mjs';
import { SPACE } from './tokens.mjs';
import { chip, columns, gutter, key as typeKey } from './type.mjs';
import { Composer, ListView, TextField, fuzzy, highlightMatch } from './widgets.mjs';

class Overlay {
  constructor({ title = '' } = {}) {
    this.title = title;
    // The app dismisses an overlay when a click lands outside it. A dialogue
    // that must be answered can opt out.
    this.dismissOnOutsideClick = true;
  }

  size(viewport) {
    return {
      columns: Math.min(viewport.columns - 4, 84),
      rows: Math.min(viewport.rows - 4, 22),
    };
  }

  place(app, viewport, lines, cursorColumn = null, cursorRow = null) {
    const size = { columns: visibleWidth(lines[0] ?? ''), rows: lines.length };
    const offset = centreOffset(viewport, size);
    const cursor = cursorColumn === null ? null : {
      row: offset.row + cursorRow,
      column: offset.column + cursorColumn,
    };
    return { lines, offset, cursor };
  }

  /**
   * Claim the overlay's own rectangle so a click inside it never reads as a
   * click on the view behind. Called by every overlay before it adds the
   * finer-grained zones on top.
   */
  claim(app, offset, columns, rows) {
    app.regions?.add({
      row: offset.row, column: offset.column, width: columns, height: rows,
      id: 'overlay:surface', layer: LAYER.overlay,
      onPress: () => {},
    });
  }

  zone(app, spec) {
    app.regions?.add({ layer: LAYER.overlay + 1, ...spec });
  }

  /**
   * Rows of a ListView inside an overlay: a click selects, and because an
   * overlay's whole purpose is to pick something, that same click commits.
   */
  listZone(app, { offset, columns, top, height, list, onPick, id }) {
    this.zone(app, {
      row: offset.row + top,
      column: offset.column + 1,
      width: Math.max(0, columns - 2),
      height,
      id,
      onPress: (target, event, region) => {
        const index = list.offset + (event.row - region.row);
        if (index < 0 || index >= list.items.length) return;
        list.selected = index;
        list.ensureVisible(height);
        onPick(target, list.items[index]);
      },
      onWheel: (target, event) => {
        const step = event.button === 'wheelup' ? -3 : 3;
        list.offset = Math.max(0, Math.min(list.offset + step, Math.max(0, list.items.length - height)));
        list.selected = Math.max(list.offset, Math.min(list.selected, list.offset + height - 1));
        list.selected = Math.max(0, Math.min(list.selected, Math.max(0, list.items.length - 1)));
      },
    });
  }
}

/** Fuzzy command palette over every action MaskShift exposes. */
export class PaletteOverlay extends Overlay {
  constructor(actions) {
    super({ title: 'COMMAND PALETTE' });
    this.actions = actions;
    this.field = new TextField({ placeholder: 'Run a command…' });
    this.list = new ListView();
    this.list.setItems(this.matches(), { keepSelection: false });
  }

  matches() {
    const query = this.field.value.trim();
    if (!query) return this.actions.map((action) => ({ ...action, id: action.id, positions: [] }));
    return this.actions
      .map((action) => {
        const match = fuzzy(query, `${action.label} ${action.group} ${action.id}`);
        if (!match) return null;
        return { ...action, score: match.score, positions: fuzzy(query, action.label)?.positions || [] };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
  }

  render(app, viewport) {
    const { theme } = app;
    const mark = glyphs(theme);
    this.list.setItems(this.matches(), { keepSelection: true });
    const size = this.size(viewport);
    const width = size.columns;
    const rows = this.list.items;
    const listHeight = Math.max(3, size.rows - 5);
    const input = this.field.render(theme, width - 8, { focused: true });

    const body = [
      gutter(theme, mark.caret, { tone: theme.roles.primary }) + input.text,
      theme.paint(repeat(mark.tick, width - 4), { fg: theme.roles.border }),
      // Group, action and shortcut on fixed columns: the palette is scanned
      // vertically, and three ragged edges made that impossible.
      ...this.list.render(theme, width - 4, listHeight, (item, selected, itemWidth) => {
        const line = gutter(theme, selected ? mark.caret : '', { tone: theme.roles.primary })
          + columns(theme, [
            { text: item.group.toUpperCase(), width: 12, tone: theme.roles.faint },
            { text: highlightMatch(theme, truncate(item.label, 44), item.positions, theme.roles.accent, theme.roles.text) },
            { text: item.key || '', width: 10, align: 'right', tone: theme.roles.accent },
          ], Math.max(0, itemWidth - SPACE.gutter));
        return selected
          ? theme.paint(fit(line, itemWidth), { bg: theme.roles.surfaceRaised })
          : fit(line, itemWidth);
      }),
    ];

    const lines = panel({
      theme, width, height: size.rows, title: 'COMMAND PALETTE',
      stamp: `${rows.length} ACTIONS`, focused: true, body,
    });
    const placed = this.place(app, viewport, lines, 2 + 3 + input.cursorColumn, 1);
    this.claim(app, placed.offset, width, lines.length);
    // Body row 0 is the input and row 1 the divider, so the list starts three
    // rows below the overlay's own top edge.
    this.listZone(app, {
      offset: placed.offset, columns: width, top: 3, height: listHeight, list: this.list,
      id: 'overlay:palette',
      onPick: (target, action) => { target.closeOverlay(); if (action) void target.runAction(action.id); },
    });
    return placed;
  }

  handle(app, event) {
    this.list.setItems(this.matches(), { keepSelection: true });
    if (event.name === 'escape') { app.closeOverlay(); return true; }
    if (event.name === 'enter') {
      const action = this.list.current;
      app.closeOverlay();
      if (action) void app.runAction(action.id);
      return true;
    }
    if (this.list.handle(event, 10)) return true;
    if (this.field.handle(event)) { this.list.first(); return true; }
    return true;
  }
}

/** A generic single-choice picker (sessions, models, workspaces, providers). */
export class PickerOverlay extends Overlay {
  constructor({ title, items, onSelect, placeholder = 'Filter…', renderRow = null, footer = '' }) {
    super({ title });
    this.items = items;
    this.onSelect = onSelect;
    this.field = new TextField({ placeholder });
    this.list = new ListView();
    this.renderRow = renderRow;
    this.footer = footer;
    this.list.setItems(this.matches(), { keepSelection: false });
  }

  matches() {
    const query = this.field.value.trim();
    if (!query) return this.items;
    return this.items
      .map((item) => {
        const match = fuzzy(query, `${item.label} ${item.detail || ''}`);
        return match ? { ...item, score: match.score } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
  }

  render(app, viewport) {
    const { theme } = app;
    const mark = glyphs(theme);
    this.list.setItems(this.matches(), { keepSelection: true });
    const size = this.size(viewport);
    const width = size.columns;
    const listHeight = Math.max(3, size.rows - (this.footer ? 6 : 5));
    const input = this.field.render(theme, width - 8, { focused: true });
    const body = [
      gutter(theme, mark.caret, { tone: theme.roles.primary }) + input.text,
      theme.paint(repeat(mark.tick, width - 4), { fg: theme.roles.border }),
      ...this.list.render(theme, width - 4, listHeight, (item, selected, itemWidth) => {
        if (this.renderRow) return this.renderRow(app, item, selected, itemWidth);
        const half = Math.floor(itemWidth * 0.5);
        const line = gutter(theme, selected ? mark.caret : '', { tone: theme.roles.primary })
          + columns(theme, [
            { text: truncate(item.label, half), width: half, tone: item.tone || theme.roles.text, bold: true },
            { text: item.detail || '', tone: theme.roles.muted },
          ], Math.max(0, itemWidth - SPACE.gutter));
        return selected
          ? theme.paint(fit(line, itemWidth), { bg: theme.roles.surfaceRaised })
          : fit(line, itemWidth);
      }),
    ];
    if (this.footer) body.push('', gutter(theme) + theme.paint(truncate(this.footer, width - 6), { fg: theme.roles.muted, italic: true }));

    const lines = panel({
      theme, width, height: size.rows, title: this.title,
      stamp: `${this.list.items.length}`, focused: true, body,
    });
    const placed = this.place(app, viewport, lines, 2 + 3 + input.cursorColumn, 1);
    this.claim(app, placed.offset, width, lines.length);
    this.listZone(app, {
      offset: placed.offset, columns: width, top: 3, height: listHeight, list: this.list,
      id: 'overlay:picker',
      onPick: (target, item) => {
        target.closeOverlay();
        if (!item) return;
        try {
          const result = this.onSelect(item);
          if (result && typeof result.catch === 'function') result.catch((error) => target.toast(error.message, 'error'));
        } catch (error) { target.toast(error.message, 'error'); }
      },
    });
    return placed;
  }

  handle(app, event) {
    this.list.setItems(this.matches(), { keepSelection: true });
    if (event.name === 'escape') { app.closeOverlay(); return true; }
    if (event.name === 'enter') {
      const item = this.list.current;
      app.closeOverlay();
      if (item) {
        try {
          const result = this.onSelect(item);
          if (result && typeof result.catch === 'function') result.catch((error) => app.toast(error.message, 'error'));
        } catch (error) { app.toast(error.message, 'error'); }
      }
      return true;
    }
    if (this.list.handle(event, 10)) return true;
    if (this.field.handle(event)) { this.list.first(); return true; }
    return true;
  }
}

/**
 * A form. Fields are:
 *   { name, label, type: 'text'|'textarea'|'select'|'toggle', value, options, hint }
 */
export class FormOverlay extends Overlay {
  constructor({ title, fields, submitLabel = 'CONFIRM', onSubmit, note = '' }) {
    super({ title });
    this.fields = fields.map((field) => ({
      ...field,
      editor: field.type === 'textarea'
        ? new Composer({ value: String(field.value ?? '') })
        : new TextField({ value: String(field.value ?? '') }),
      rows: field.type === 'textarea' ? (field.rows || 5) : 1,
      toggled: Boolean(field.value),
      optionIndex: Math.max(0, (field.options || []).findIndex((option) => option.value === field.value)),
    }));
    this.index = 0;
    this.submitLabel = submitLabel;
    this.onSubmit = onSubmit;
    this.note = note;
    this.error = '';
    this.pending = false;
  }

  size(viewport) {
    const rows = this.fields.reduce((sum, field) => sum + field.rows + 1, 0) + 7;
    return {
      columns: Math.min(viewport.columns - 4, 86),
      rows: Math.min(viewport.rows - 2, rows + (this.note ? 2 : 0)),
    };
  }

  values() {
    const out = {};
    for (const field of this.fields) {
      if (field.type === 'toggle') out[field.name] = field.toggled;
      else if (field.type === 'select') out[field.name] = field.options[field.optionIndex]?.value;
      else out[field.name] = field.editor.value;
    }
    return out;
  }

  render(app, viewport) {
    const { theme } = app;
    const mark = glyphs(theme);
    const size = this.size(viewport);
    const width = size.columns;
    const inner = width - 4;
    const body = [];
    const spans = [];
    let cursor = null;
    for (const [index, field] of this.fields.entries()) {
      const active = index === this.index;
      spans.push({ index, field, start: body.length });
      body.push(theme.paint(field.label.toUpperCase(), { fg: active ? theme.roles.borderActive : theme.roles.muted, bold: active })
        + (field.hint ? theme.paint(`   e.g. ${field.hint}`, { fg: theme.roles.faint, italic: true }) : ''));
      if (field.type === 'toggle') {
        const box = field.toggled ? `[${mark.check}]` : '[ ]';
        body.push(gutter(theme) + theme.paint(`${box} ${field.toggled ? 'ON' : 'OFF'}`, { fg: field.toggled ? theme.roles.success : theme.roles.muted }));
      } else if (field.type === 'select') {
        const option = field.options[field.optionIndex];
        body.push(gutter(theme, mark.arrowRight, { tone: theme.roles.muted })
          + theme.paint(option?.label ?? '', { fg: theme.roles.accent, bold: true })
          + theme.paint(`   ${field.optionIndex + 1}/${field.options.length}  ←/→`, { fg: theme.roles.faint }));
      } else if (field.type === 'textarea') {
        const layout = field.editor.layout(inner - 3, field.rows);
        for (let line = 0; line < field.rows; line += 1) {
          const text = layout.rows[line] ?? '';
          body.push(theme.paint(active && line === layout.caret.row ? ` ${mark.caret} ` : '   ', { fg: theme.roles.primary })
            + theme.paint(fit(text, inner - 3), { fg: active ? theme.roles.text : theme.roles.muted }));
        }
        if (active) cursor = { row: body.length - field.rows + layout.caret.row, column: 3 + layout.caret.column };
      } else {
        const rendered = field.editor.render(theme, inner - 3, { focused: active });
        body.push(theme.paint(active ? ` ${mark.caret} ` : '   ', { fg: theme.roles.primary }) + rendered.text);
        if (active) cursor = { row: body.length - 1, column: 3 + rendered.cursorColumn };
      }
      spans[spans.length - 1].end = body.length;
    }
    if (this.note) { body.push(''); for (const piece of wrap(this.note, inner)) body.push(theme.paint(piece, { fg: theme.roles.muted, italic: true })); }
    if (this.error) { body.push(''); body.push(theme.paint(truncate(this.error, inner), { fg: theme.roles.danger })); }
    body.push('');
    // A modal's primary action is the one other place a filled chip is
    // correct: there is no tab strip on screen to confuse it with, and a
    // dialogue has to say plainly what pressing return will do.
    const submitChip = chip(theme, this.pending ? `${spinLabel(theme)} WORKING` : this.submitLabel);
    const cancelChip = theme.paint(' CANCEL ', { fg: theme.roles.muted });
    const submitRow = body.length;
    body.push(`${submitChip}  ${cancelChip}   `
      + [['^S', 'submit'], ['tab', 'move'], ['esc', 'cancel']]
        .map(([k, l]) => typeKey(theme, k) + theme.paint(` ${l}`, { fg: theme.roles.muted }))
        .join(theme.paint(` ${mark.dot} `, { fg: theme.roles.border })));

    const lines = panel({
      theme, width, height: Math.min(viewport.rows - 2, body.length + 2), title: this.title,
      stamp: `${this.fields.length} FIELDS`, focused: true, body,
    });
    const offset = centreOffset(viewport, { columns: width, rows: lines.length });

    this.claim(app, offset, width, lines.length);
    // A form taller than the viewport has its body clipped by the panel, so
    // only rows that actually made it onto the screen become click targets.
    const painted = lines.length - 2;
    for (const span of spans) {
      if (span.start >= painted) continue;
      this.zone(app, {
        row: offset.row + 1 + span.start,
        column: offset.column + 1,
        width: Math.max(0, width - 2),
        height: Math.max(1, Math.min(span.end ?? span.start + 1, painted) - span.start),
        id: `overlay:field:${span.field.name}`,
        // A click focuses the field, and for the two field types with no text
        // to place a caret in, it also advances the value.
        onPress: () => {
          this.index = span.index;
          if (span.field.type === 'toggle') span.field.toggled = !span.field.toggled;
          if (span.field.type === 'select') {
            span.field.optionIndex = (span.field.optionIndex + 1) % span.field.options.length;
          }
        },
      });
    }
    if (submitRow < painted) {
      this.zone(app, {
        row: offset.row + 1 + submitRow,
        column: offset.column + 2,
        width: visibleWidth(submitChip),
        height: 1,
        id: 'overlay:submit',
        onPress: (target) => { void this.submit(target); },
      });
      this.zone(app, {
        row: offset.row + 1 + submitRow,
        column: offset.column + 2 + visibleWidth(submitChip) + 2,
        width: visibleWidth(cancelChip),
        height: 1,
        id: 'overlay:cancel',
        onPress: (target) => { if (!this.pending) target.closeOverlay(); },
      });
    }

    return {
      lines, offset,
      cursor: cursor ? { row: offset.row + 1 + cursor.row, column: offset.column + 2 + cursor.column } : null,
    };
  }

  async submit(app) {
    if (this.pending) return;
    this.pending = true;
    this.dismissOnOutsideClick = false;
    this.error = '';
    app.requestRender();
    try {
      await this.onSubmit(this.values());
      if (app.overlay === this) app.closeOverlay();
    } catch (error) {
      this.error = error.message;
      this.pending = false;
      this.dismissOnOutsideClick = true;
      app.requestRender();
    }
  }

  handle(app, event) {
    const field = this.fields[this.index];
    if (this.pending) return true;
    if (event.name === 'escape') { app.closeOverlay(); return true; }
    if (event.ctrl && event.name === 's') { void this.submit(app); return true; }
    if (event.name === 'tab') {
      this.index = (this.index + (event.shift ? -1 : 1) + this.fields.length) % this.fields.length;
      return true;
    }
    if (field.type === 'toggle') {
      if (event.name === 'space' || event.name === 'enter') { field.toggled = !field.toggled; return true; }
      if (event.name === 'up') { this.index = Math.max(0, this.index - 1); return true; }
      if (event.name === 'down') { this.index = Math.min(this.fields.length - 1, this.index + 1); return true; }
      return true;
    }
    if (field.type === 'select') {
      if (event.name === 'left') { field.optionIndex = (field.optionIndex - 1 + field.options.length) % field.options.length; return true; }
      if (event.name === 'right') { field.optionIndex = (field.optionIndex + 1) % field.options.length; return true; }
      if (event.name === 'up') { this.index = Math.max(0, this.index - 1); return true; }
      if (event.name === 'down' || event.name === 'enter') { this.index = Math.min(this.fields.length - 1, this.index + 1); return true; }
      return true;
    }
    if (field.type === 'textarea') {
      if (event.name === 'enter') { field.editor.insert('\n'); return true; }
      if (event.name === 'up' && field.editor.cursor === 0) { this.index = Math.max(0, this.index - 1); return true; }
      if (event.name === 'down' && field.editor.cursor === field.editor.value.length) {
        this.index = Math.min(this.fields.length - 1, this.index + 1);
        return true;
      }
      field.editor.handle(event);
      return true;
    }
    if (event.name === 'enter') {
      if (this.index === this.fields.length - 1) void this.submit(app);
      else this.index += 1;
      return true;
    }
    if (event.name === 'up' && field.editor.cursor === 0) { this.index = Math.max(0, this.index - 1); return true; }
    if (event.name === 'down' && field.editor.cursor === field.editor.value.length) {
      this.index = Math.min(this.fields.length - 1, this.index + 1);
      return true;
    }
    field.editor.handle(event);
    return true;
  }
}

export class ConfirmOverlay extends Overlay {
  constructor({ title = 'CONFIRM', message, danger = false, onConfirm }) {
    super({ title });
    this.message = message;
    this.danger = danger;
    this.onConfirm = onConfirm;
    this.choice = danger ? 1 : 0;
    this.pending = false;
    this.error = '';
  }

  render(app, viewport) {
    const { theme } = app;
    const mark = glyphs(theme);
    const width = Math.min(viewport.columns - 6, 66);
    const body = wrap(this.message, width - 4).map((line) => theme.paint(line, { fg: theme.roles.text }));
    body.push('');
    // The destructive answer is never the quiet one: a confirmation that puts
    // YES in the same neutral as NO is a confirmation nobody reads.
    const yes = this.choice === 0
      ? chip(theme, ' YES ', { tone: this.danger ? theme.roles.danger : theme.roles.success })
      : theme.paint('  YES  ', { fg: theme.roles.muted });
    const no = this.choice === 1
      ? chip(theme, ' NO ', { tone: theme.roles.accent })
      : theme.paint('  NO  ', { fg: theme.roles.muted });
    const buttonRow = body.length;
    body.push(`${yes}   ${no}`);
    if (this.pending) body.push('', theme.paint(`${spinLabel(theme)} Working…`, { fg: theme.roles.muted }));
    if (this.error) body.push('', theme.paint(truncate(this.error, width - 4), { fg: theme.roles.danger }));
    const lines = panel({
      theme, width, height: body.length + 2, title: this.title,
      note: this.danger ? `${mark.warn} DESTRUCTIVE` : '',
      stamp: '←/→ then ↵', focused: true, body,
      colour: this.danger ? theme.roles.danger : theme.roles.accent,
    });
    const offset = centreOffset(viewport, { columns: width, rows: lines.length });

    this.claim(app, offset, width, lines.length);
    this.zone(app, {
      row: offset.row + 1 + buttonRow, column: offset.column + 2,
      width: visibleWidth(yes), height: 1, id: 'overlay:yes',
      onPress: (target) => { void this.confirm(target); },
    });
    this.zone(app, {
      row: offset.row + 1 + buttonRow,
      column: offset.column + 2 + visibleWidth(yes) + 3,
      width: visibleWidth(no), height: 1, id: 'overlay:no',
      onPress: (target) => { if (!this.pending) target.closeOverlay(); },
    });

    return { lines, offset, cursor: null };
  }

  handle(app, event) {
    if (this.pending) return true;
    if (event.name === 'escape' || event.name === 'n') { app.closeOverlay(); return true; }
    if (event.name === 'left' || event.name === 'right' || event.name === 'tab') { this.choice = this.choice === 0 ? 1 : 0; return true; }
    if (event.name === 'y') { void this.confirm(app); return true; }
    if (event.name === 'enter') {
      if (this.choice === 0) void this.confirm(app);
      else app.closeOverlay();
      return true;
    }
    return true;
  }

  async confirm(app) {
    if (this.pending) return;
    this.pending = true;
    this.dismissOnOutsideClick = false;
    this.error = '';
    app.requestRender();
    try {
      await this.onConfirm();
      if (app.overlay === this) app.closeOverlay();
    } catch (error) {
      this.pending = false;
      this.dismissOnOutsideClick = true;
      this.error = error.message;
      app.requestRender();
    }
  }
}

function spinLabel(theme) {
  const frames = theme.unicode ? ['◐', '◓', '◑', '◒'] : ['|', '/', '-', '\\'];
  return frames[Math.floor(theme.motion.elapsed / 120) % frames.length];
}

export class TextOverlay extends Overlay {
  constructor({ title, lines, stamp = '' }) {
    super({ title });
    this.body = lines;
    this.stamp = stamp;
    this.offset = 0;
  }

  render(app, viewport) {
    const { theme } = app;
    const width = Math.min(viewport.columns - 4, 96);
    const height = Math.min(viewport.rows - 2, this.body.length + 2);
    const inner = height - 2;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.body.length - inner)));
    const lines = panel({
      theme, width, height, title: this.title,
      stamp: this.stamp || `${this.body.length} LINES`, focused: true,
      body: this.body.slice(this.offset, this.offset + inner),
    });
    const offset = centreOffset(viewport, { columns: width, rows: lines.length });

    this.claim(app, offset, width, lines.length);
    this.zone(app, {
      row: offset.row, column: offset.column, width, height: lines.length,
      id: 'overlay:text',
      onPress: () => {},
      onWheel: (target, event) => {
        this.offset = Math.max(0, Math.min(
          this.offset + (event.button === 'wheelup' ? -3 : 3),
          Math.max(0, this.body.length - inner),
        ));
      },
    });

    return { lines, offset, cursor: null };
  }

  handle(app, event) {
    if (['escape', 'q', 'enter'].includes(event.name)) { app.closeOverlay(); return true; }
    if (event.name === 'up') { this.offset -= 1; return true; }
    if (event.name === 'down') { this.offset += 1; return true; }
    if (event.name === 'pageup') { this.offset -= 10; return true; }
    if (event.name === 'pagedown') { this.offset += 10; return true; }
    return true;
  }
}
