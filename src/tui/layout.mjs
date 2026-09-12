// Composition helpers: stack panels beside and above each other.

import { fit, sliceAnsi, visibleWidth } from './text.mjs';

/** Join equal-height columns side by side. Each column is { lines, width }. */
export function hstack(columns, height) {
  const rows = height ?? Math.max(0, ...columns.map((column) => column.lines.length));
  const out = [];
  for (let row = 0; row < rows; row += 1) {
    out.push(columns.map((column) => fit(column.lines[row] ?? '', column.width)).join(''));
  }
  return out;
}

/** Concatenate blocks vertically, clipping or padding to `height` when given. */
export function vstack(blocks, height = null, width = null) {
  const out = [];
  for (const block of blocks) out.push(...block);
  if (height === null) return out;
  const clipped = out.slice(0, height);
  while (clipped.length < height) clipped.push(width ? ' '.repeat(width) : '');
  return clipped;
}

/**
 * Split a total width into weighted columns with minimums.
 * `parts` is [{ weight, min, max }] and the remainder lands on the widest part.
 *
 * The result always sums to exactly `total`, even when the declared minimums
 * don't fit inside it — a caller sized for a 92-column split doesn't stop
 * being called just because the real terminal is narrower than that. Below
 * that point minimums are honoured as far as they can be and then given up
 * on, largest first, rather than the row being left wider than its frame.
 */
export function split(total, parts) {
  const weights = parts.reduce((sum, part) => sum + (part.weight ?? 1), 0);
  const sizes = parts.map((part) => Math.max(part.min ?? 0, Math.floor((total * (part.weight ?? 1)) / weights)));
  for (const [index, part] of parts.entries()) {
    if (part.max !== undefined) sizes[index] = Math.min(sizes[index], part.max);
  }
  let used = sizes.reduce((sum, value) => sum + value, 0);
  let guard = 0;
  while (used !== total && guard < 500) {
    guard += 1;
    const direction = used < total ? 1 : -1;
    let target = -1;
    for (const [index, part] of parts.entries()) {
      if (direction > 0 && (part.max === undefined || sizes[index] < part.max)) {
        if (target === -1 || sizes[index] > sizes[target]) target = index;
      }
      if (direction < 0 && sizes[index] > (part.min ?? 0)) {
        if (target === -1 || sizes[index] > sizes[target]) target = index;
      }
    }
    if (target === -1 && direction < 0) {
      // Every part is already at its declared minimum and the total still
      // doesn't fit — the minimums themselves are the problem, so shrink
      // whichever part is currently largest below its minimum instead of
      // returning a row wider than the space it has to render into.
      for (const [index, size] of sizes.entries()) {
        if (size > 0 && (target === -1 || size > sizes[target])) target = index;
      }
    }
    if (target === -1) break;
    sizes[target] += direction;
    used += direction;
  }
  return sizes;
}

/**
 * Centre a block of lines inside a viewport, returning { row, column }.
 * `viewport.top` shifts the result down by a fixed number of rows — for a
 * viewport that describes a band starting partway down the real frame
 * (the body, below the header and tab strip) rather than the frame itself.
 */
export function centreOffset(viewport, size) {
  return {
    row: (viewport.top || 0) + Math.max(0, Math.floor((viewport.rows - size.rows) / 2)),
    column: Math.max(0, Math.floor((viewport.columns - size.columns) / 2)),
  };
}

/** Paint `block` over `base` at the given offset. Both are arrays of lines. */
export function overlay(base, block, offset, width) {
  const out = [...base];
  for (const [index, line] of block.entries()) {
    const row = offset.row + index;
    if (row < 0 || row >= out.length) continue;
    const current = fit(out[row] ?? '', width);
    const head = sliceAnsi(current, 0, offset.column);
    const tail = sliceAnsi(current, offset.column + visibleWidth(line), width);
    out[row] = fit(`${head}${line}${tail}`, width);
  }
  return out;
}
