import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import { decodePng, readPngSize } from '../src/tui/image/png.mjs';
import { detectImageProtocol } from '../src/tui/image/protocol.mjs';
import { buildImagePreview, isImagePath } from '../src/tui/image/render.mjs';
import { Theme, hexToRgb } from '../src/tui/theme.mjs';
import { fit, sanitizeTerminalLine, visibleWidth } from '../src/tui/text.mjs';
import { detectImageResult } from '../src/tui/views/chat.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Build a real, valid PNG in memory (no fixture file, no npm dependency —
 *  just the same chunk/zlib mechanics the decoder itself undoes), applying
 *  a different PNG filter type to each row so all five get exercised. */
function buildPng(width, height, pixelAt) {
  const bytesPerPixel = 3;
  const stride = width * bytesPerPixel;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelAt(x, y);
      row[x * bytesPerPixel] = r; row[x * bytesPerPixel + 1] = g; row[x * bytesPerPixel + 2] = b;
    }
    rows.push(row);
  }
  const raw = Buffer.alloc(height * (1 + stride));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const filterType = y % 5;
    raw[offset] = filterType;
    const current = rows[y];
    const previous = rows[y - 1] || Buffer.alloc(stride);
    for (let index = 0; index < stride; index += 1) {
      const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
      const up = previous[index];
      const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
      let filtered;
      if (filterType === 0) filtered = current[index];
      else if (filterType === 1) filtered = current[index] - left;
      else if (filterType === 2) filtered = current[index] - up;
      else if (filterType === 3) filtered = current[index] - ((left + up) >> 1);
      else filtered = current[index] - paeth(left, up, upLeft);
      raw[offset + 1 + index] = filtered & 0xff;
    }
    offset += 1 + stride;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

test('decodePng round-trips exact pixel values through every PNG filter type', () => {
  const width = 15; // wide enough that width % 5 !== 0 forces the filters to line up unevenly with rows
  const height = 15;
  const pixelAt = (x, y) => [(x * 16) % 256, (y * 16) % 256, ((x + y) * 8) % 256];
  const png = buildPng(width, height, pixelAt);

  assert.deepEqual(readPngSize(png), { width, height });

  const decoded = decodePng(png);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const [r, g, b] = pixelAt(x, y);
      assert.equal(decoded.rgba[index], r, `red mismatch at (${x},${y})`);
      assert.equal(decoded.rgba[index + 1], g, `green mismatch at (${x},${y})`);
      assert.equal(decoded.rgba[index + 2], b, `blue mismatch at (${x},${y})`);
      assert.equal(decoded.rgba[index + 3], 255);
    }
  }
});

test('decodePng rejects what it cannot safely decode instead of mis-rendering it', () => {
  assert.throws(() => decodePng(Buffer.from('not a png')), /signature/);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 16; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 16-bit depth, unsupported
  const bad = Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => decodePng(bad), /bit depth/);
});

test('isImagePath recognises common raster extensions and nothing else', () => {
  assert.equal(isImagePath('/a/b/screenshot.PNG'), true);
  assert.equal(isImagePath('photo.jpeg'), true);
  assert.equal(isImagePath('notes.md'), false);
  assert.equal(isImagePath('archive.tar.gz'), false);
});

test('detectImageProtocol picks Kitty, iTerm2 or the universal half-block fallback in that priority', () => {
  assert.equal(detectImageProtocol({ KITTY_WINDOW_ID: '1' }), 'kitty');
  assert.equal(detectImageProtocol({ TERM_PROGRAM: 'WezTerm' }), 'kitty');
  assert.equal(detectImageProtocol({ TERM_PROGRAM: 'iTerm.app' }), 'iterm');
  assert.equal(detectImageProtocol({ TERM: 'xterm-256color' }), 'halfblock');
  assert.equal(detectImageProtocol({ MASKSHIFT_IMAGE: 'off' }), 'none');
});

test('the half-block preview never emits a raw OSC/APC byte a downstream sanitizer would have to catch', () => {
  const width = 8; const height = 8;
  const png = buildPng(width, height, (x, y) => [(x * 32) % 256, (y * 32) % 256, 128]);
  const theme = new Theme({ depth: 24, unicode: true });
  const file = path.join(os.tmpdir(), `maskshift-image-test-${process.pid}.png`);
  fs.writeFileSync(file, png);
  try {
    const result = buildImagePreview(theme, file, { maxCols: 20, maxRows: 10, hexToRgb });
    assert.equal(result.error, undefined);
    assert.ok(result.lines.length > 0 && result.lines.length <= 10);
    for (const line of result.lines) {
      // Every row should be plain SGR-styled text: sanitizing it must be a no-op,
      // and it must actually contain visible cell glyphs, not just colour codes.
      assert.equal(sanitizeTerminalLine(line), line);
      assert.ok(visibleWidth(line) > 0);
    }
  } finally {
    fs.unlinkSync(file);
  }
});

test('a Kitty overlay escape is treated as zero-width and untruncated by the text pipeline', async () => {
  const width = 4; const height = 4;
  const png = buildPng(width, height, (x, y) => [x * 64, y * 64, 0]);
  const theme = new Theme({ depth: 24, unicode: true });
  const file = path.join(os.tmpdir(), `maskshift-image-kitty-${process.pid}.png`);
  fs.writeFileSync(file, png);
  const previous = process.env.MASKSHIFT_IMAGE;
  process.env.MASKSHIFT_IMAGE = 'kitty';
  try {
    const result = buildImagePreview(theme, file, { maxCols: 20, maxRows: 10, hexToRgb });
    assert.equal(result.error, undefined);
    assert.ok(result.overlay, 'expected a Kitty overlay descriptor');
    const { escape } = result.overlay;
    assert.match(escape, /^\x1b_Ga=d\x1b\\/, 'should self-clear any previous placement first');
    assert.match(escape, /\x1b_Ga=T,f=100,C=1,c=\d+,r=\d+,m=\d;/, 'should transmit-and-display with an explicit cell box');
    // Everything after that is the base64 PNG payload, chunked and terminated per the
    // Kitty protocol — no bare ESC should appear outside of an `ESC _ ... ESC \` run.
    assert.equal((escape.match(/\x1b_G/g) || []).length, (escape.match(/\x1b\\/g) || []).length);
    // The whole thing must round-trip through the same pipeline a rendered
    // frame row goes through (fit/visibleWidth) without being cut into.
    assert.equal(visibleWidth(escape), 0);
    // Zero visible width means fit() pads with the full 200 columns rather
    // than truncating into the escape bytes themselves.
    assert.equal(fit(escape, 200), `${escape}${' '.repeat(200)}`);
    // Every reserved row is a blank placeholder — the escape itself is never
    // embedded as `lines` content (see render.mjs and screen.mjs).
    for (const line of result.lines) assert.equal(line, '');
  } finally {
    if (previous === undefined) delete process.env.MASKSHIFT_IMAGE; else process.env.MASKSHIFT_IMAGE = previous;
    fs.unlinkSync(file);
  }
});

test('buildImagePreview reports a clear error instead of throwing for a non-image or unreadable path', () => {
  const theme = new Theme({ depth: 24, unicode: true });
  assert.equal(buildImagePreview(theme, '/tmp/not-an-image.txt', { maxCols: 10, maxRows: 10, hexToRgb }).error, 'Not an image file.');
  const missing = buildImagePreview(theme, '/tmp/does-not-exist-maskshift.png', { maxCols: 10, maxRows: 10, hexToRgb });
  assert.match(missing.error, /Couldn.t read/);
});

test('detectImageResult finds an image path inside a JSON tool result (browser_screenshot and friends)', () => {
  const workspacePath = '/work';
  const shot = { role: 'tool', content: JSON.stringify({ instanceId: 'i1', file: '/work/artifacts/shot.png', bytes: 42 }) };
  assert.equal(detectImageResult(shot, workspacePath), '/work/artifacts/shot.png');

  const relative = { role: 'tool', content: JSON.stringify({ path: 'screens/out.jpg' }) };
  assert.equal(detectImageResult(relative, workspacePath), path.resolve(workspacePath, 'screens/out.jpg'));

  const barePath = { role: 'tool', content: '/work/logo.webp' };
  assert.equal(detectImageResult(barePath, workspacePath), '/work/logo.webp');
});

test('detectImageResult stays quiet for ordinary tool output, non-tool messages, and non-image fields', () => {
  const workspacePath = '/work';
  assert.equal(detectImageResult({ role: 'tool', content: JSON.stringify({ files: ['a.js', 'b.js'] }) }, workspacePath), null);
  assert.equal(detectImageResult({ role: 'tool', content: 'node --test tests/tui.test.mjs → 12 pass, 0 fail' }, workspacePath), null);
  assert.equal(detectImageResult({ role: 'tool', content: JSON.stringify({ file: '/work/report.pdf' }) }, workspacePath), null);
  assert.equal(detectImageResult({ role: 'assistant', content: '/work/shot.png' }, workspacePath), null);
});
