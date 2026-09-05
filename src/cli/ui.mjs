// Styled output for the non-interactive CLI.
//
// The CLI wears the same Phantom Protocol palette as the TUI: crimson rules,
// bone text, gold keys. Every printer degrades to plain text under --json,
// NO_COLOR or a redirected stdout.

import { glyphs, meter, rule } from '../tui/box.mjs';
import { heroBlock, SUBTITLE } from '../tui/brand.mjs';
import { renderMarkdown } from '../tui/markdown.mjs';
import { Theme } from '../tui/theme.mjs';
import { fit, oneLine, padStart, repeat, truncate, visibleWidth, wrap } from '../tui/text.mjs';

export class Ui {
  constructor({ json = false, stream = process.stdout, errorStream = process.stderr } = {}) {
    this.json = json;
    this.stream = stream;
    this.errorStream = errorStream;
    this.theme = new Theme({ depth: json ? 0 : undefined });
    this.marks = glyphs(this.theme);
  }

  get width() {
    return Math.max(48, Math.min(this.stream.columns || 100, 160));
  }

  write(text = '') { this.stream.write(`${text}\n`); }
  writeError(text = '') { this.errorStream.write(`${text}\n`); }

  emit(value) {
    if (this.json) { this.write(JSON.stringify(value, null, 2)); return true; }
    return false;
  }

  banner(version, { compact = false } = {}) {
    if (this.json) return;
    const { theme } = this;
    if (compact) {
      this.write(theme.paint(' MASK', { fg: theme.palette.ink, bg: theme.palette.crimson, bold: true })
        + theme.paint('SHIFT ', { fg: theme.palette.ink, bg: theme.palette.gold, bold: true })
        + theme.paint(`  ${SUBTITLE}  ${this.marks.dot}  v${version}`, { fg: theme.roles.muted }));
      return;
    }
    for (const line of heroBlock(theme, this.width)) this.write(line);
    this.write(this.theme.paint(fit(`v${version}  ${this.marks.dot}  ${SUBTITLE}`, this.width, { align: 'center' }), { fg: this.theme.roles.muted }));
    this.write('');
  }

  heading(text, index = '') {
    if (this.json) return;
    const { theme } = this;
    const label = `${index ? `${index} ` : ''}${text.toUpperCase()}`;
    this.write('');
    this.write(theme.paint(` ${label} `, { fg: theme.palette.ink, bg: theme.palette.crimson, bold: true })
      + theme.paint(repeat(theme.unicode ? '━' : '=', Math.max(0, this.width - visibleWidth(label) - 2)), { fg: theme.palette.blood }));
  }

  section(text) {
    if (this.json) return;
    this.write('');
    this.write(this.theme.paint(`${this.marks.spine} ${text.toUpperCase()}`, { fg: this.theme.palette.crimson, bold: true }));
  }

  line(text = '') { if (!this.json) this.write(text); }

  paragraph(text) {
    if (this.json) return;
    for (const piece of wrap(text, this.width)) this.write(this.theme.paint(piece, { fg: this.theme.roles.muted }));
  }

  markdown(text) {
    if (this.json) return;
    for (const piece of renderMarkdown(this.theme, text, this.width)) this.write(piece);
  }

  /** Key/value block. `pairs` is [[label, value, tone?]]. */
  fields(pairs, labelWidth = 16) {
    if (this.json) return;
    const { theme } = this;
    for (const [label, value, tone] of pairs) {
      if (value === undefined || value === null || value === '') continue;
      const body = wrap(String(value), Math.max(10, this.width - labelWidth - 2));
      this.write(theme.paint(fit(String(label).toUpperCase(), labelWidth), { fg: theme.roles.muted })
        + theme.paint(body[0] ?? '', { fg: tone || theme.roles.text }));
      for (const piece of body.slice(1)) this.write(`${' '.repeat(labelWidth)}${theme.paint(piece, { fg: tone || theme.roles.text })}`);
    }
  }

  /**
   * Aligned table. `columns` is [{ key, label, width?, align?, tone? }].
   */
  table(columns, rows) {
    if (this.json) { this.write(JSON.stringify(rows, null, 2)); return; }
    const { theme } = this;
    const sizes = columns.map((column) => {
      const longest = Math.max(
        visibleWidth(column.label || column.key),
        ...rows.map((row) => visibleWidth(String(cellValue(row, column) ?? ''))),
      );
      return Math.min(column.width || longest, column.max || 60);
    });
    const total = sizes.reduce((sum, value) => sum + value + 2, 0);
    if (total > this.width) {
      const widest = sizes.indexOf(Math.max(...sizes));
      sizes[widest] = Math.max(8, sizes[widest] - (total - this.width));
    }
    this.write(columns.map((column, index) => theme.paint(
      fit(String(column.label || column.key).toUpperCase(), sizes[index], { align: column.align || 'left' }),
      { fg: theme.palette.crimson, bold: true },
    )).join('  '));
    this.write(theme.paint(sizes.map((size) => repeat(theme.unicode ? '─' : '-', size)).join('  '), { fg: theme.roles.border }));
    for (const row of rows) {
      this.write(columns.map((column, index) => {
        const raw = String(cellValue(row, column) ?? '');
        const tone = typeof column.tone === 'function' ? column.tone(row, this.theme) : column.tone;
        return theme.paint(fit(raw, sizes[index], { align: column.align || 'left' }), { fg: tone || theme.roles.text });
      }).join('  '));
    }
  }

  bullet(text, tone) {
    if (this.json) return;
    this.write(this.theme.paint(`  ${this.marks.diamond} `, { fg: tone || this.theme.palette.crimson })
      + this.theme.paint(text, { fg: this.theme.roles.text }));
  }

  status(kind, text) {
    if (this.json) return;
    const tones = {
      ok: [this.marks.check, this.theme.roles.success],
      warn: [this.marks.warn, this.theme.roles.warning],
      fail: [this.marks.cross, this.theme.roles.danger],
      info: [this.marks.dot, this.theme.roles.info],
    };
    const [icon, tone] = tones[kind] || tones.info;
    this.write(this.theme.paint(`${icon} `, { fg: tone }) + this.theme.paint(text, { fg: this.theme.roles.text }));
  }

  ok(text) { this.status('ok', text); }
  warn(text) { this.status('warn', text); }
  fail(text) { this.status('fail', text); }
  info(text) { this.status('info', text); }

  meter(value, max, width = 24) {
    return meter(this.theme, value, max, width);
  }

  rule(label = '') {
    if (this.json) return;
    this.write(rule(this.theme, this.width, label));
  }

  key(name, description, labelWidth = 30) {
    if (this.json) return;
    const width = Math.max(labelWidth, visibleWidth(name) + 2);
    if (width + 20 > this.width) {
      this.write(this.theme.paint(`  ${name}`, { fg: this.theme.palette.gold, bold: true }));
      if (description) this.write(this.theme.paint(`  ${' '.repeat(4)}${description}`, { fg: this.theme.roles.muted }));
      return;
    }
    this.write(this.theme.paint(`  ${fit(name, width)}`, { fg: this.theme.palette.gold, bold: true })
      + this.theme.paint(truncate(description, this.width - width - 3), { fg: this.theme.roles.muted }));
  }
}

function cellValue(row, column) {
  if (typeof column.value === 'function') return column.value(row);
  return row[column.key];
}

export { oneLine, truncate, padStart };
