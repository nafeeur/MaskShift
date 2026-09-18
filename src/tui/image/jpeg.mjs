// A baseline (sequential, Huffman-coded) JPEG decoder, from scratch — the
// same "own the well-specified hard part" approach as png.mjs, just with
// more hard parts, because JPEG doesn't get to borrow node:zlib. No support
// for progressive or arithmetic-coded JPEGs: both are rejected with a clear
// error rather than silently mis-decoded, since almost everything that
// actually produces JPEGs (cameras, browsers, `PIL.save(...)`) defaults to
// baseline anyway.

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
];

// cos((2x+1)*u*pi/16) for x,u in [0,8) — the separable IDCT's only
// trigonometry, computed once and reused for every block in the image.
const COS_TABLE = (() => {
  const table = [];
  for (let x = 0; x < 8; x += 1) {
    const row = [];
    for (let u = 0; u < 8; u += 1) row.push(Math.cos(((2 * x + 1) * u * Math.PI) / 16));
    table.push(row);
  }
  return table;
})();
const C = [1 / Math.SQRT2, 1, 1, 1, 1, 1, 1, 1];

/** The inverse of the forward DCT-II JPEG's encoder applied per 8x8 block —
 *  spelled out as the direct separable sum rather than a fast (AAN/Loeffler)
 *  variant, trading some speed for being obviously, checkably correct. */
function idct8x8(block) {
  const tmp = new Float64Array(64);
  // Rows: for each (x, v), sum over u.
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      let sum = 0;
      for (let u = 0; u < 8; u += 1) sum += C[u] * block[y * 8 + u] * COS_TABLE[x][u];
      tmp[y * 8 + x] = sum / 2;
    }
  }
  const out = new Float64Array(64);
  for (let x = 0; x < 8; x += 1) {
    for (let y = 0; y < 8; y += 1) {
      let sum = 0;
      for (let v = 0; v < 8; v += 1) sum += C[v] * tmp[v * 8 + x] * COS_TABLE[y][v];
      out[y * 8 + x] = sum / 2;
    }
  }
  return out;
}

class BitReader {
  constructor(buffer, offset) {
    this.buffer = buffer;
    this.offset = offset;
    this.bitBuffer = 0;
    this.bitCount = 0;
  }

  // Byte-stuffing: an 0xFF in the entropy-coded stream is followed by 0x00
  // (a literal 0xFF byte) or a restart marker (handled by the caller, which
  // stops reading before it). Skips exactly the stuffed 0x00.
  fillByte() {
    let byte = this.buffer[this.offset];
    this.offset += 1;
    if (byte === 0xff) {
      const next = this.buffer[this.offset];
      if (next === 0x00) this.offset += 1;
      else { this.offset -= 1; return null; } // a real marker — caller's problem
    }
    return byte;
  }

  readBit() {
    if (this.bitCount === 0) {
      const byte = this.fillByte();
      if (byte === null) return 0; // ran into a marker (e.g. restart) mid-block padding
      this.bitBuffer = byte;
      this.bitCount = 8;
    }
    this.bitCount -= 1;
    return (this.bitBuffer >> this.bitCount) & 1;
  }

  readBits(n) {
    let value = 0;
    for (let i = 0; i < n; i += 1) value = (value << 1) | this.readBit();
    return value;
  }

  reset() {
    this.bitBuffer = 0;
    this.bitCount = 0;
  }
}

/** Canonical JPEG Huffman table (Annex C/F): BITS is 16 counts of codes per
 *  length, HUFFVAL is the symbols in code order. Decoded bit-by-bit against
 *  a map keyed by `${length}:${code}` — simple, and tables are tiny (at
 *  most 256 symbols), so this never needs to be a fast lookup. */
function buildHuffmanTable(bits, huffval) {
  const codes = new Map();
  let code = 0;
  let symbolIndex = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let i = 0; i < bits[length - 1]; i += 1) {
      codes.set(`${length}:${code}`, huffval[symbolIndex]);
      symbolIndex += 1;
      code += 1;
    }
    code <<= 1;
  }
  return codes;
}

function decodeHuffmanSymbol(reader, table) {
  let code = 0;
  for (let length = 1; length <= 16; length += 1) {
    code = (code << 1) | reader.readBit();
    const symbol = table.get(`${length}:${code}`);
    if (symbol !== undefined) return symbol;
  }
  throw new Error('Corrupt JPEG: no matching Huffman code');
}

/** A Huffman-coded magnitude category `s` is followed by `s` literal bits
 *  encoding a signed value in [-(2^s-1), 2^s-1] — JPEG's "extend" (Annex F.2.2.1). */
function receiveExtend(reader, size) {
  if (size === 0) return 0;
  const value = reader.readBits(size);
  return value < 1 << (size - 1) ? value - (1 << size) + 1 : value;
}

function clamp8(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

export function decodeJpeg(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('Not a JPEG file (missing SOI marker)');

  const quantTables = {};
  const huffmanDC = {};
  const huffmanAC = {};
  let frame = null; // { width, height, components: [{id, h, v, quantId}] }
  let restartInterval = 0;
  let offset = 2;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (marker === 0xd9) break; // EOI

    const length = (buffer[offset] << 8) | buffer[offset + 1];
    const segmentStart = offset + 2;

    if (marker === 0xdb) { // DQT
      let p = segmentStart;
      const end = offset + length;
      while (p < end) {
        const precisionAndId = buffer[p]; p += 1;
        const precision = precisionAndId >> 4;
        const id = precisionAndId & 0x0f;
        const table = new Int32Array(64);
        for (let i = 0; i < 64; i += 1) {
          table[ZIGZAG[i]] = precision === 0 ? buffer[p + i] : (buffer[p + i * 2] << 8) | buffer[p + i * 2 + 1];
        }
        p += precision === 0 ? 64 : 128;
        quantTables[id] = table;
      }
    } else if (marker === 0xc0 || marker === 0xc1) { // SOF0/SOF1: baseline / extended sequential
      const height = (buffer[segmentStart + 1] << 8) | buffer[segmentStart + 2];
      const width = (buffer[segmentStart + 3] << 8) | buffer[segmentStart + 4];
      const count = buffer[segmentStart + 5];
      const components = [];
      for (let i = 0; i < count; i += 1) {
        const base = segmentStart + 6 + i * 3;
        components.push({
          id: buffer[base], h: buffer[base + 1] >> 4, v: buffer[base + 1] & 0x0f, quantId: buffer[base + 2],
        });
      }
      frame = { width, height, components };
    } else if (marker === 0xc2) {
      throw new Error('Progressive JPEGs are not supported');
    } else if (marker === 0xc3 || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcf && marker !== 0xcc)) {
      throw new Error('Only baseline JPEGs are supported (this one uses an unsupported encoding mode)');
    } else if (marker === 0xc4) { // DHT
      let p = segmentStart;
      const end = offset + length;
      while (p < end) {
        const classAndId = buffer[p]; p += 1;
        const tableClass = classAndId >> 4;
        const id = classAndId & 0x0f;
        const bits = buffer.subarray(p, p + 16); p += 16;
        const total = bits.reduce((sum, value) => sum + value, 0);
        const huffval = buffer.subarray(p, p + total); p += total;
        const table = buildHuffmanTable(bits, huffval);
        if (tableClass === 0) huffmanDC[id] = table; else huffmanAC[id] = table;
      }
    } else if (marker === 0xdd) { // DRI
      restartInterval = (buffer[segmentStart] << 8) | buffer[segmentStart + 1];
    } else if (marker === 0xda) { // SOS — entropy-coded data follows immediately
      if (!frame) throw new Error('Corrupt JPEG: scan before frame header');
      const scanCount = buffer[segmentStart];
      const scanComponents = [];
      for (let i = 0; i < scanCount; i += 1) {
        const base = segmentStart + 1 + i * 2;
        scanComponents.push({ id: buffer[base], dcId: buffer[base + 1] >> 4, acId: buffer[base + 1] & 0x0f });
      }
      const entropyStart = offset + length;
      return decodeScan(buffer, entropyStart, frame, scanComponents, quantTables, huffmanDC, huffmanAC, restartInterval);
    }
    offset += length;
  }
  throw new Error('Corrupt JPEG: no scan found');
}

function decodeScan(buffer, entropyStart, frame, scanComponents, quantTables, huffmanDC, huffmanAC, restartInterval) {
  const maxH = Math.max(...frame.components.map((c) => c.h));
  const maxV = Math.max(...frame.components.map((c) => c.v));
  const mcuWidth = 8 * maxH;
  const mcuHeight = 8 * maxV;
  const mcusPerLine = Math.ceil(frame.width / mcuWidth);
  const mcusPerColumn = Math.ceil(frame.height / mcuHeight);

  // Full-resolution (component-sampled) planes, upsampled to the frame size
  // once decoding finishes.
  const planes = frame.components.map((component) => ({
    width: mcusPerLine * component.h * 8,
    height: mcusPerColumn * component.v * 8,
    h: component.h, v: component.v,
    data: new Uint8ClampedArray(mcusPerLine * component.h * 8 * mcusPerColumn * component.v * 8),
  }));

  const reader = new BitReader(buffer, entropyStart);
  const dcPredictors = new Array(frame.components.length).fill(0);
  const block = new Int32Array(64);
  let mcuCount = 0;
  const totalMcus = mcusPerLine * mcusPerColumn;

  function decodeBlock(componentIndex, quantTable, dcTable, acTable) {
    block.fill(0);
    const dcSize = decodeHuffmanSymbol(reader, dcTable);
    const diff = receiveExtend(reader, dcSize);
    dcPredictors[componentIndex] += diff;
    block[0] = dcPredictors[componentIndex] * quantTable[0];

    let k = 1;
    while (k < 64) {
      const runSize = decodeHuffmanSymbol(reader, acTable);
      const run = runSize >> 4;
      const size = runSize & 0x0f;
      if (size === 0) {
        if (run === 15) { k += 16; continue; } // ZRL
        break; // EOB
      }
      k += run;
      if (k >= 64) break;
      const value = receiveExtend(reader, size);
      block[ZIGZAG[k]] = value * quantTable[ZIGZAG[k]];
      k += 1;
    }
    return idct8x8(block);
  }

  for (let my = 0; my < mcusPerColumn; my += 1) {
    for (let mx = 0; mx < mcusPerLine; mx += 1) {
      scanComponents.forEach((scanComponent) => {
        const componentIndex = frame.components.findIndex((c) => c.id === scanComponent.id);
        const component = frame.components[componentIndex];
        const plane = planes[componentIndex];
        const quantTable = quantTables[component.quantId];
        const dcTable = huffmanDC[scanComponent.dcId];
        const acTable = huffmanAC[scanComponent.acId];
        for (let by = 0; by < component.v; by += 1) {
          for (let bx = 0; bx < component.h; bx += 1) {
            const samples = decodeBlock(componentIndex, quantTable, dcTable, acTable);
            const originX = (mx * component.h + bx) * 8;
            const originY = (my * component.v + by) * 8;
            for (let y = 0; y < 8; y += 1) {
              for (let x = 0; x < 8; x += 1) {
                plane.data[(originY + y) * plane.width + (originX + x)] = clamp8(Math.round(samples[y * 8 + x]) + 128);
              }
            }
          }
        }
      });

      mcuCount += 1;
      if (restartInterval && mcuCount % restartInterval === 0 && mcuCount < totalMcus) {
        reader.reset();
        // Skip the RSTn marker (0xFFD0-0xFFD7) the encoder inserted here.
        if (reader.buffer[reader.offset] === 0xff && reader.buffer[reader.offset + 1] >= 0xd0 && reader.buffer[reader.offset + 1] <= 0xd7) {
          reader.offset += 2;
        }
        dcPredictors.fill(0);
      }
    }
  }

  return assemblePixels(frame, planes, maxH, maxV);
}

/** Nearest-neighbour upsample every component to full resolution and convert
 *  YCbCr (or pass through if this JPEG is actually greyscale/single-component)
 *  to RGBA. */
function assemblePixels(frame, planes, maxH, maxV) {
  const { width, height } = frame;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const sample = (plane, x, y) => {
    const sx = Math.min(plane.width - 1, Math.floor((x * plane.h) / maxH));
    const sy = Math.min(plane.height - 1, Math.floor((y * plane.v) / maxV));
    return plane.data[sy * plane.width + sx];
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (planes.length === 1) {
        const v = sample(planes[0], x, y);
        rgba[index] = v; rgba[index + 1] = v; rgba[index + 2] = v; rgba[index + 3] = 255;
        continue;
      }
      const Y = sample(planes[0], x, y);
      const Cb = sample(planes[1], x, y) - 128;
      const Cr = sample(planes[2], x, y) - 128;
      rgba[index] = clamp8(Math.round(Y + 1.402 * Cr));
      rgba[index + 1] = clamp8(Math.round(Y - 0.344136 * Cb - 0.714136 * Cr));
      rgba[index + 2] = clamp8(Math.round(Y + 1.772 * Cb));
      rgba[index + 3] = 255;
    }
  }
  return { width, height, rgba: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength) };
}
