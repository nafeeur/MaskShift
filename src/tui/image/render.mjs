// Turns an image file into terminal lines, picking the best mechanism this
// terminal actually supports (see protocol.mjs) and falling back all the way
// down to plain Unicode + colour if it supports none of them.
//
// The escape sequence for a Kitty/iTerm2 placement is emitted once, as the
// content of a single anchor row — the rest of the image's row-span in our
// own line buffer is just blank strings reserving the vertical space. Because
// Screen only rewrites a row when its string actually changed (see
// screen.mjs), an unchanged preview is never re-sent to the terminal on
// every repaint, and switching files sends a fresh placement (with an
// explicit "delete previous images" first, for Kitty) instead of stacking
// old ones underneath the new text.

import fs from 'node:fs';
import path from 'node:path';
import { decodePng, readPngSize } from './png.mjs';
import { detectImageProtocol } from './protocol.mjs';

const ESC = '\x1b';
const KITTY_CHUNK = 4096;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export function isImagePath(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Fit an image into a `maxCols` x `maxRows` character box, aspect-preserved,
 *  knowing each terminal row can show two source pixel-rows (half-block). */
function fitCells(imageWidth, imageHeight, maxCols, maxRows) {
  let cols = maxCols;
  let rows = Math.max(1, Math.round(((imageHeight / imageWidth) * cols) / 2));
  if (rows > maxRows) {
    rows = maxRows;
    cols = Math.max(1, Math.round(((imageWidth / imageHeight) * rows) * 2));
  }
  return { cols: Math.max(1, Math.min(cols, maxCols)), rows: Math.max(1, Math.min(rows, maxRows)) };
}

function kittyLines(buffer, cols, rows) {
  const base64 = buffer.toString('base64');
  const chunks = [];
  for (let offset = 0; offset < base64.length; offset += KITTY_CHUNK) chunks.push(base64.slice(offset, offset + KITTY_CHUNK));
  let out = `${ESC}_Ga=d${ESC}\\`; // Drop any image this pane placed earlier, so switching files doesn't stack them.
  chunks.forEach((chunk, index) => {
    const first = index === 0;
    const last = index === chunks.length - 1;
    const control = first ? `a=T,f=100,C=1,c=${cols},r=${rows},m=${last ? 0 : 1}` : `m=${last ? 0 : 1}`;
    out += `${ESC}_G${control};${chunk}${ESC}\\`;
  });
  return { anchor: out, rows };
}

function itermLines(buffer, cols, rows) {
  const base64 = buffer.toString('base64');
  const anchor = `${ESC}]1337;File=inline=1;width=${cols};height=${rows};preserveAspectRatio=1:${base64}\x07`;
  return { anchor, rows };
}

function sampleNearest(rgba, width, height, x, y) {
  const sx = Math.min(width - 1, Math.floor(x));
  const sy = Math.min(height - 1, Math.floor(y));
  const index = (sy * width + sx) * 4;
  return [rgba[index], rgba[index + 1], rgba[index + 2], rgba[index + 3]];
}

function toHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

/** Alpha-composite a possibly-transparent source pixel onto the pane's own
 *  background so a transparent PNG doesn't render as jet black. */
function overComposite(pixel, backgroundHex, hexToRgb) {
  const alpha = pixel[3] / 255;
  if (alpha >= 0.999) return [pixel[0], pixel[1], pixel[2]];
  const bg = hexToRgb(backgroundHex);
  return [
    pixel[0] * alpha + bg[0] * (1 - alpha),
    pixel[1] * alpha + bg[1] * (1 - alpha),
    pixel[2] * alpha + bg[2] * (1 - alpha),
  ];
}

function halfblockLines(theme, decoded, cols, rows, hexToRgb) {
  const { width, height, rgba } = decoded;
  const pixelRows = rows * 2;
  const lines = [];
  for (let row = 0; row < rows; row += 1) {
    let line = '';
    for (let col = 0; col < cols; col += 1) {
      const sx = (col / cols) * width;
      const topPixel = overComposite(sampleNearest(rgba, width, height, sx, (row * 2 / pixelRows) * height), theme.roles.background, hexToRgb);
      const bottomPixel = overComposite(sampleNearest(rgba, width, height, sx, ((row * 2 + 1) / pixelRows) * height), theme.roles.background, hexToRgb);
      line += theme.fg(toHex(topPixel)) + theme.bg(toHex(bottomPixel)) + '▀';
    }
    lines.push(line + theme.reset);
  }
  return lines;
}

/**
 * Build the preview lines for an image file, sized to fit `maxCols` x
 * `maxRows`. Returns `{ lines, error }` — `lines` is always exactly as many
 * rows as it reserves, so the caller's layout math never has to special-case
 * an image versus a text preview.
 *
 * Synchronous (this is CPU work on a local file, not network I/O) so it can
 * be called straight from a view's render() without restructuring the
 * paint loop around another async round-trip the way fs_read's own preview
 * text is fetched.
 */
export function buildImagePreview(theme, absolutePath, { maxCols, maxRows, hexToRgb }) {
  const extension = path.extname(absolutePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) return { lines: [], error: 'Not an image file.' };

  const protocol = detectImageProtocol();
  if (protocol === 'none') return { lines: [], error: 'Image preview is disabled (MASKSHIFT_IMAGE=off).' };

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch (error) {
    return { lines: [], error: `Couldn't read ${path.basename(absolutePath)}: ${error.message}` };
  }

  if (protocol === 'kitty' || protocol === 'iterm') {
    let cols = maxCols;
    let rows = Math.min(maxRows, Math.round(maxCols / 2));
    if (extension === '.png') {
      try {
        const size = readPngSize(buffer);
        ({ cols, rows } = fitCells(size.width, size.height, maxCols, maxRows));
      } catch { /* fall through with the plain box guess above */ }
    }
    const { anchor: escape, rows: usedRows } = protocol === 'kitty' ? kittyLines(buffer, cols, rows) : itermLines(buffer, cols, rows);
    // The escape itself never becomes a `lines` string — that array is what
    // Screen.render() sanitizes, and an OSC/APC payload is exactly what that
    // sanitizer exists to strip. It travels instead as `overlay`, a value the
    // caller places at an absolute screen position outside that pipeline
    // (see files.mjs and screen.mjs). `lines` here just reserves the blank
    // vertical space so layout and scrolling still work like any other preview.
    return {
      lines: Array.from({ length: usedRows }, () => ''),
      overlay: { escape, rows: usedRows, key: `${absolutePath}|${buffer.length}|${cols}x${rows}|${protocol}` },
    };
  }

  if (extension !== '.png') {
    return { lines: [], error: `This terminal has no inline-image support MaskShift can use, and ASCII preview only supports PNG (got ${extension}).` };
  }
  let decoded;
  try {
    decoded = decodePng(buffer);
  } catch (error) {
    return { lines: [], error: `Couldn't decode this PNG: ${error.message}` };
  }
  const { cols, rows } = fitCells(decoded.width, decoded.height, maxCols, maxRows);
  return { lines: halfblockLines(theme, decoded, cols, rows, hexToRgb) };
}
