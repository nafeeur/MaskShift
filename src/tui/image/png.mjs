// A from-scratch PNG decoder. No npm dependency needed: the only "hard" part
// of PNG — inflating the DEFLATE-compressed scanlines — is already built into
// Node as `node:zlib`. Everything else here is chunk parsing and the PNG
// filter algorithms (byte-level, well-specified, and short enough to own).
//
// Scope: 8-bit, non-interlaced PNGs (grayscale, RGB, indexed, grayscale+alpha,
// RGBA) — which is what screenshots, icons and most real-world PNGs are.
// Interlaced (Adam7) and 16-bit-per-channel PNGs are rejected with a clear
// error rather than silently mis-decoded.

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('Not a PNG file (bad signature)');
  }
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const data = buffer.subarray(start, start + length);
    chunks.push({ type, data });
    offset = start + length + 4; // + 4 for the trailing CRC we don't verify.
    if (type === 'IEND') break;
  }
  return chunks;
}

/** Just the dimensions, for callers (Kitty/iTerm2 tiers) that hand the raw
 *  file to a terminal that decodes it itself and only need the aspect ratio. */
export function readPngSize(buffer) {
  const ihdr = readChunks(buffer).find((chunk) => chunk.type === 'IHDR');
  if (!ihdr) throw new Error('PNG has no IHDR chunk');
  return { width: ihdr.data.readUInt32BE(0), height: ihdr.data.readUInt32BE(4) };
}

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Undo the per-scanline PNG filter in place, one scanline at a time. */
function unfilter(raw, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const out = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  let offset = 0;
  for (let row = 0; row < height; row += 1) {
    const filterType = raw[offset];
    const scanline = raw.subarray(offset + 1, offset + 1 + stride);
    const current = out.subarray(row * stride, row * stride + stride);
    for (let index = 0; index < stride; index += 1) {
      const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
      const up = previous[index];
      const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
      const raw8 = scanline[index];
      let value;
      switch (filterType) {
        case 0: value = raw8; break;
        case 1: value = raw8 + left; break;
        case 2: value = raw8 + up; break;
        case 3: value = raw8 + ((left + up) >> 1); break;
        case 4: value = raw8 + paeth(left, up, upLeft); break;
        default: throw new Error(`Unsupported PNG filter type ${filterType}`);
      }
      current[index] = value & 0xff;
    }
    previous = current;
    offset += 1 + stride;
  }
  return out;
}

/** Expand any supported colour type into flat RGBA, one pass. */
function toRgba(pixels, width, height, colorType, palette, transparency) {
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const src = index * channels;
    const dst = index * 4;
    if (colorType === 0) {
      const v = pixels[src];
      rgba[dst] = v; rgba[dst + 1] = v; rgba[dst + 2] = v; rgba[dst + 3] = 255;
    } else if (colorType === 2) {
      rgba[dst] = pixels[src]; rgba[dst + 1] = pixels[src + 1]; rgba[dst + 2] = pixels[src + 2]; rgba[dst + 3] = 255;
    } else if (colorType === 3) {
      const paletteIndex = pixels[src];
      const p = paletteIndex * 3;
      rgba[dst] = palette[p] ?? 0; rgba[dst + 1] = palette[p + 1] ?? 0; rgba[dst + 2] = palette[p + 2] ?? 0;
      rgba[dst + 3] = transparency && paletteIndex < transparency.length ? transparency[paletteIndex] : 255;
    } else if (colorType === 4) {
      const v = pixels[src];
      rgba[dst] = v; rgba[dst + 1] = v; rgba[dst + 2] = v; rgba[dst + 3] = pixels[src + 1];
    } else if (colorType === 6) {
      rgba[dst] = pixels[src]; rgba[dst + 1] = pixels[src + 1]; rgba[dst + 2] = pixels[src + 2]; rgba[dst + 3] = pixels[src + 3];
    }
  }
  return rgba;
}

export function decodePng(buffer) {
  const chunks = readChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR');
  if (!ihdr) throw new Error('PNG has no IHDR chunk');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth} (only 8-bit is supported)`);
  if (interlace !== 0) throw new Error('Interlaced PNGs are not supported');
  if (!(colorType in CHANNELS_BY_COLOR_TYPE)) throw new Error(`Unsupported PNG colour type ${colorType}`);

  const palette = chunks.find((chunk) => chunk.type === 'PLTE')?.data;
  const transparency = chunks.find((chunk) => chunk.type === 'tRNS')?.data;
  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
  const inflated = zlib.inflateSync(idat);

  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  const raw = unfilter(inflated, width, height, channels);
  const rgba = toRgba(raw, width, height, colorType, palette, transparency);
  return { width, height, rgba };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/**
 * Encode raw RGBA pixels as a PNG — the inverse of decodePng, used to turn a
 * format only *this* codebase can decode (JPEG, BMP) into bytes a terminal's
 * own graphics protocol can display, since Kitty's inline-image transmission
 * only understands PNG-encoded payloads (or raw pixel data with its own,
 * separate framing) — see image/render.mjs. Always emits filter type 0
 * (None) per row: simpler than choosing a filter per row, and correctness
 * here matters far more than shaving a few percent off the payload size.
 */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((1 + stride) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + stride)] = 0; // filter: None
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([SIGNATURE, writeChunk('IHDR', ihdr), writeChunk('IDAT', idat), writeChunk('IEND', Buffer.alloc(0))]);
}
