import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import { decodeBmp } from '../src/tui/image/bmp.mjs';
import { decodeJpeg } from '../src/tui/image/jpeg.mjs';
import { decodePng, encodePng, readPngSize } from '../src/tui/image/png.mjs';
import { detectImageProtocol } from '../src/tui/image/protocol.mjs';
import { buildImagePreview, isImagePath } from '../src/tui/image/render.mjs';
import { Theme, hexToRgb } from '../src/tui/theme.mjs';
import { fit, sanitizeTerminalLine, visibleWidth } from '../src/tui/text.mjs';
import { detectImageResult } from '../src/tui/views/chat.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// An 8x8 baseline JPEG (quality 90), four 4x4 solid-colour quadrants —
// red/green top, blue/yellow bottom — encoded once with Pillow (libjpeg)
// so this test has a real, independently-produced JPEG to decode rather
// than one built by the same code under test.
const JPEG_QUADRANTS_FIXTURE = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDK/YJ0X/hcv/Cdfvv7H/s37D/D5/meZ9o91xjy/fOfaiiiv5N+kDRp8J+JWaZNky9lh6XseWPxW5sPSm9Z80neUm9W97LSyOTMeGcp45xU+IeIaPtsXWtzz5pQvyJQj7sJRirRjFaRV7Xd22z/2Q==',
  'base64',
);

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

function assertNear(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ~${expected}, got ${actual}`);
}

test('decodeJpeg decodes a real (Pillow/libjpeg-encoded) baseline JPEG correctly', () => {
  const decoded = decodeJpeg(JPEG_QUADRANTS_FIXTURE);
  assert.equal(decoded.width, 8);
  assert.equal(decoded.height, 8);
  const pixel = (x, y) => {
    const i = (y * 8 + x) * 4;
    return [decoded.rgba[i], decoded.rgba[i + 1], decoded.rgba[i + 2]];
  };
  const quadrants = [
    { at: [1, 1], expect: [255, 0, 0] }, // top-left: red
    { at: [6, 1], expect: [0, 255, 0] }, // top-right: green
    { at: [1, 6], expect: [0, 0, 255] }, // bottom-left: blue
    { at: [6, 6], expect: [255, 255, 0] }, // bottom-right: yellow
  ];
  for (const { at, expect } of quadrants) {
    const [r, g, b] = pixel(...at);
    assertNear(r, expect[0], 20, `red at (${at})`);
    assertNear(g, expect[1], 20, `green at (${at})`);
    assertNear(b, expect[2], 20, `blue at (${at})`);
  }
});

test('decodeJpeg rejects progressive and non-baseline JPEGs instead of mis-decoding them', () => {
  // SOF2 (0xC2) is the progressive marker — swap the fixture's SOF0 (0xC0) for it.
  const corrupted = Buffer.from(JPEG_QUADRANTS_FIXTURE);
  const sofIndex = corrupted.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sofIndex >= 0, 'fixture should contain an SOF0 marker');
  corrupted[sofIndex + 1] = 0xc2;
  assert.throws(() => decodeJpeg(corrupted), /[Pp]rogressive/);
  assert.throws(() => decodeJpeg(Buffer.from([0x00, 0x01, 0x02])), /SOI/);
});

/** Build a minimal uncompressed 24-bit BMP (BITMAPINFOHEADER) by hand — the
 *  format is simple enough that a fixture doesn't need Pillow's help. */
function buildBmp(width, height, pixelAt) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelDataSize = rowSize * height;
  const fileSize = 14 + 40 + pixelDataSize;
  const buffer = Buffer.alloc(fileSize);
  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(fileSize, 2);
  buffer.writeUInt32LE(14 + 40, 10); // pixel data offset
  buffer.writeUInt32LE(40, 14); // header size (BITMAPINFOHEADER)
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22); // positive: bottom-up
  buffer.writeUInt16LE(1, 26); // planes
  buffer.writeUInt16LE(24, 28); // bits per pixel
  buffer.writeUInt32LE(0, 30); // BI_RGB
  for (let y = 0; y < height; y += 1) {
    const sourceRow = height - 1 - y; // bottom-up storage
    const rowStart = 14 + 40 + y * rowSize;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelAt(x, sourceRow);
      const offset = rowStart + x * 3;
      buffer[offset] = b; buffer[offset + 1] = g; buffer[offset + 2] = r;
    }
  }
  return buffer;
}

test('decodeBmp reads an uncompressed 24-bit BMP pixel-exact', () => {
  const bmp = buildBmp(4, 3, (x, y) => [x * 60, y * 80, 255 - x * 60]);
  const decoded = decodeBmp(bmp);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 3);
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const i = (y * 4 + x) * 4;
      assert.equal(decoded.rgba[i], x * 60);
      assert.equal(decoded.rgba[i + 1], y * 80);
      assert.equal(decoded.rgba[i + 2], 255 - x * 60);
      assert.equal(decoded.rgba[i + 3], 255);
    }
  }
});

test('decodeBmp rejects compressed and paletted BMPs instead of mis-decoding them', () => {
  assert.throws(() => decodeBmp(Buffer.from('not a bmp')), /signature/);
  const bmp = buildBmp(2, 2, () => [0, 0, 0]);
  bmp.writeUInt32LE(1, 30); // claim BI_RLE8 compression
  assert.throws(() => decodeBmp(bmp), /[Cc]ompressed/);
});

test('encodePng round-trips arbitrary RGBA pixels exactly', () => {
  const width = 5; const height = 4;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = (i * 17) % 256; rgba[i * 4 + 1] = (i * 31) % 256;
    rgba[i * 4 + 2] = (i * 53) % 256; rgba[i * 4 + 3] = i % 2 === 0 ? 255 : 128;
  }
  const png = encodePng(width, height, rgba);
  const decoded = decodePng(png);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual(Buffer.from(decoded.rgba), rgba);
});

test('buildImagePreview on a Kitty terminal re-encodes JPEG as PNG instead of sending raw JPEG bytes tagged f=100', () => {
  const theme = new Theme({ depth: 24, unicode: true });
  const file = path.join(os.tmpdir(), `maskshift-kitty-jpeg-${process.pid}.jpg`);
  fs.writeFileSync(file, JPEG_QUADRANTS_FIXTURE);
  const previous = process.env.MASKSHIFT_IMAGE;
  process.env.MASKSHIFT_IMAGE = 'kitty';
  try {
    const result = buildImagePreview(theme, file, { maxCols: 20, maxRows: 10, hexToRgb });
    assert.equal(result.error, undefined);
    assert.ok(result.overlay);
    // f=100 means "the payload is PNG data" — extract it and confirm it
    // really is a valid, decodable PNG rather than the original JPEG bytes.
    const match = /;([A-Za-z0-9+/=]+)\x1b\\/.exec(result.overlay.escape.split('f=100').at(-1));
    assert.ok(match, 'expected a base64 payload after the f=100 control segment');
    const payload = Buffer.from(match[1], 'base64');
    const decoded = decodePng(payload);
    assert.ok(decoded.width > 0 && decoded.height > 0);
  } finally {
    if (previous === undefined) delete process.env.MASKSHIFT_IMAGE; else process.env.MASKSHIFT_IMAGE = previous;
    fs.unlinkSync(file);
  }
});

test('buildImagePreview on a Kitty terminal refuses an undecodable format instead of sending malformed bytes', () => {
  const theme = new Theme({ depth: 24, unicode: true });
  const file = path.join(os.tmpdir(), `maskshift-kitty-gif-${process.pid}.gif`);
  fs.writeFileSync(file, Buffer.from('GIF89a'));
  const previous = process.env.MASKSHIFT_IMAGE;
  process.env.MASKSHIFT_IMAGE = 'kitty';
  try {
    const result = buildImagePreview(theme, file, { maxCols: 20, maxRows: 10, hexToRgb });
    assert.equal(result.overlay, undefined);
    assert.match(result.error, /PNG data/);
  } finally {
    if (previous === undefined) delete process.env.MASKSHIFT_IMAGE; else process.env.MASKSHIFT_IMAGE = previous;
    fs.unlinkSync(file);
  }
});

test('buildImagePreview on iTerm2 passes any recognised image format through unmodified, format-agnostic', () => {
  const theme = new Theme({ depth: 24, unicode: true });
  const file = path.join(os.tmpdir(), `maskshift-iterm-gif-${process.pid}.gif`);
  const gifBytes = Buffer.from('GIF89a-not-a-real-gif-but-iterm-does-not-care');
  fs.writeFileSync(file, gifBytes);
  const previous = process.env.MASKSHIFT_IMAGE;
  process.env.MASKSHIFT_IMAGE = 'iterm';
  try {
    const result = buildImagePreview(theme, file, { maxCols: 20, maxRows: 10, hexToRgb });
    assert.equal(result.error, undefined);
    assert.ok(result.overlay);
    assert.ok(result.overlay.escape.includes(gifBytes.toString('base64')));
  } finally {
    if (previous === undefined) delete process.env.MASKSHIFT_IMAGE; else process.env.MASKSHIFT_IMAGE = previous;
    fs.unlinkSync(file);
  }
});
