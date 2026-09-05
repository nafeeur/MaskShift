// Floating surfaces: the command palette, pickers, forms, confirmations and
// the key reference. Each overlay owns the keyboard while it is open.

import { glyphs, panel } from './box.mjs';
import { centreOffset } from './layout.mjs';
import { fit, padStart, truncate, visibleWidth, wrap } from './text.mjs';
import { Composer, ListView, TextField, fuzzy, highlightMatch } from './widgets.mjs';

class Overlay {
  constructor({ title = '', index = '' } = {}) {
    this.title = title;
    this.index = index;
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
}

/** Fuzzy command palette over every action MaskShift exposes. */
export class PaletteOverlay extends Overlay {
  constructor(actions) {
    super({ title: 'COMMAND PALETTE' });
    this.actions = actions;
    this.field = new TextField({ placeholder: 'RUN A COMMAND…' });
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
      theme.paint(` ${mark.caret} `, { fg: theme.palette.crimson, bold: true }) + input.text,
      theme.paint(''.padEnd(width - 4, theme.unicode ? '╌' : '-'), { fg: theme.roles.border }),
      ...this.list.render(theme, width - 4, listHeight, (item, selected, itemWidth) => {
        const label = highlightMatch(theme, truncate(item.label, 40), item.positions, theme.palette.gold);
        const group = theme.paint(fit(item.group.toUpperCase(), 12), { fg: theme.roles.border });
        const key = item.key ? theme.paint(padStart(item.key, 10), { fg: theme.palette.gold }) : ' '.repeat(10);
        const line = `${theme.paint(selected ? mark.caret : ' ', { fg: theme.palette.crimson })} ${group}${fit(label, itemWidth - 24)}${key}`;
        return selected ? theme.paint(fit(line, itemWidth), { bg: theme.palette.raised }) : fit(line, itemWidth);
      }),
    ];

    const lines = panel({
      theme, width, height: size.rows, title: 'COMMAND PALETTE', index: '⌘',
      stamp: `${rows.length} actions`, focused: true, body,
    });
    return this.place(app, viewport, lines, 2 + 3 + input.cursorColumn, 1);
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
  constructor({ title, items, onSelect, placeholder = 'FILTER…', renderRow = null, footer = '' }) {
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
      theme.paint(` ${mark.caret} `, { fg: theme.palette.crimson, bold: true }) + input.text,
      theme.paint(''.padEnd(width - 4, theme.unicode ? '╌' : '-'), { fg: theme.roles.border }),
      ...this.list.render(theme, width - 4, listHeight, (item, selected, itemWidth) => {
        if (this.renderRow) return this.renderRow(app, item, selected, itemWidth);
        const label = theme.paint(fit(truncate(item.label, Math.floor(itemWidth * 0.5)), Math.floor(itemWidth * 0.5)), {
          fg: item.tone || theme.palette.gold, bold: true,
        });
        const detail = theme.paint(truncate(item.detail || '', itemWidth - Math.floor(itemWidth * 0.5) - 3), { fg: theme.roles.muted });
        const line = `${theme.paint(selected ? mark.caret : ' ', { fg: theme.palette.crimson })} ${label}${detail}`;
        return selected ? theme.paint(fit(line, itemWidth), { bg: theme.palette.raised }) : fit(line, itemWidth);
      }),
    ];
    if (this.footer) body.push('', theme.paint(truncate(this.footer, width - 4), { fg: theme.roles.border, italic: true }));

    const lines = panel({
      theme, width, height: size.rows, title: this.title, index: mark.diamond,
      stamp: `${this.list.items.length}`, focused: true, body,
    });
    return this.place(app, viewport, lines, 2 + 3 + input.cursorColumn, 1);
  }

  handle(app, event) {
    this.list.setItems(this.matches(), { keepSelection: true });
    if (event.name === 'escape') { app.closeOverlay(); return true; }
    if (event.name === 'enter') {
      const item = this.list.current;
      app.closeOverlay();
      if (item) void this.onSelect(item);
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
    let cursor = null;
    for (const [index, field] of this.fields.entries()) {
      const active = index === this.index;
      body.push(theme.paint(field.label.toUpperCase(), { fg: active ? theme.palette.crimson : theme.roles.muted, bold: active })
        + (field.hint ? theme.paint(`   e.g. ${field.hint}`, { fg: theme.roles.border, italic: true }) : ''));
      if (field.type === 'toggle') {
        const box = field.toggled ? `[${mark.check}]` : '[ ]';
        body.push(theme.paint(` ${box} ${field.toggled ? 'ON' : 'OFF'}`, { fg: field.toggled ? theme.roles.success : theme.roles.border }));
      } else if (field.type === 'select') {
        const option = field.options[field.optionIndex];
        body.push(theme.paint(` ${mark.arrowRight} `, { fg: theme.roles.border })
          + theme.paint(option?.label ?? '', { fg: theme.palette.gold, bold: true })
          + theme.paint(`   ${field.optionIndex + 1}/${field.options.length}  ←/→`, { fg: theme.roles.border }));
      } else if (field.type === 'textarea') {
        const layout = field.editor.layout(inner - 3, field.rows);
        for (let line = 0; line < field.rows; line += 1) {
          const text = layout.rows[line] ?? '';
          body.push(theme.paint(active && line === layout.caret.row ? ` ${mark.caret} ` : '   ', { fg: theme.palette.crimson })
            + theme.paint(fit(text, inner - 3), { fg: active ? theme.roles.text : theme.roles.muted }));
        }
        if (active) cursor = { row: body.length - field.rows + layout.caret.row, column: 3 + layout.caret.column };
      } else {
        const rendered = field.editor.render(theme, inner - 3, { focused: active });
        body.push(theme.paint(active ? ` ${mark.caret} ` : '   ', { fg: theme.palette.crimson }) + rendered.text);
        if (active) cursor = { row: body.length - 1, column: 3 + rendered.cursorColumn };
      }
    }
    if (this.note) { body.push(''); for (const piece of wrap(this.note, inner)) body.push(theme.paint(piece, { fg: theme.roles.border, italic: true })); }
    if (this.error) { body.push(''); body.push(theme.paint(truncate(this.error, inner), { fg: theme.roles.danger })); }
    body.push('');
    body.push(theme.paint(` ${this.submitLabel} `, { fg: theme.palette.ink, bg: theme.palette.crimson, bold: true })
      + theme.paint('  ctrl+s submits', { fg: theme.roles.border })
      + theme.paint('   tab moves', { fg: theme.roles.border })
      + theme.paint('   esc cancels', { fg: theme.roles.border }));

    const lines = panel({
      theme, width, height: Math.min(viewport.rows - 2, body.length + 2), title: this.title, index: mark.mask,
      stamp: `${this.fields.length} fields`, focused: true, body,
    });
    const offset = centreOffset(viewport, { columns: width, rows: lines.length });
    return {
      lines, offset,
      cursor: cursor ? { row: offset.row + 1 + cursor.row, column: offset.column + 2 + cursor.column } : null,
    };
  }

  submit(app) {
    try {
      const result = this.onSubmit(this.values());
      if (result && typeof result.catch === 'function') result.catch((error) => app.toast(error.message, 'error'));
      app.closeOverlay();
    } catch (error) {
      this.error = error.message;
    }
  }

  handle(app, event) {
    const field = this.fields[this.index];
    if (event.name === 'escape') { app.closeOverlay(); return true; }
    if (event.ctrl && event.name === 's') { this.submit(app); return true; }
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
      if (this.index === this.fields.length - 1) this.submit(app);
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
  }

  render(app, viewport) {
    const { theme } = app;
    const mark = glyphs(theme);
    const width = Math.min(viewport.columns - 6, 66);
    const body = wrap(this.message, width - 4).map((line) => theme.paint(line, { fg: theme.roles.text }));
    body.push('');
    const yes = this.choice === 0
      ? theme.paint('  YES  ', { fg: theme.palette.ink, bg: this.danger ? theme.palette.crimson : theme.palette.toxic, bold: true })
      : theme.paint('  YES  ', { fg: theme.roles.muted });
    const no = this.choice === 1
      ? theme.paint('  NO  ', { fg: theme.palette.ink, bg: theme.palette.gold, bold: true })
      : theme.paint('  NO  ', { fg: theme.roles.muted });
    body.push(`${yes}   ${no}`);
    const lines = panel({
      theme, width, height: body.length + 2, title: this.title,
      index: this.danger ? mark.warn : mark.diamond,
      stamp: '←/→ then ↵', focused: true, body,
      colour: this.danger ? theme.palette.crimson : theme.palette.gold,
    });
    const offset = centreOffset(viewport, { columns: width, rows: lines.length });
    return { lines, offset, cursor: null };
  }

  handle(app, event) {
    if (event.name === 'escape' || event.name === 'n') { app.closeOverlay(); return true; }
    if (event.name === 'left' || event.name === 'right' || event.name === 'tab') { this.choice = this.choice === 0 ? 1 : 0; return true; }
    if (event.name === 'y') { app.closeOverlay(); void this.onConfirm(); return true; }
    if (event.name === 'enter') {
      app.closeOverlay();
      if (this.choice === 0) void this.onConfirm();
      return true;
    }
    return true;
  }
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
      theme, width, height, title: this.title, index: glyphs(theme).mask,
      stamp: this.stamp || `${this.body.length} lines`, focused: true,
      body: this.body.slice(this.offset, this.offset + inner),
    });
    const offset = centreOffset(viewport, { columns: width, rows: lines.length });
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
