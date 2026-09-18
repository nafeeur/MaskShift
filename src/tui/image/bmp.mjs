// A BMP decoder covering the common case: uncompressed (BI_RGB) 24-bit or
// 32-bit Windows/BITMAPINFOHEADER-family bitmaps, which is what anything
// that writes a plain .bmp today actually produces. Compressed (RLE) and
// paletted BMPs are rejected with a clear error rather than mis-decoded —
// both are rare enough now that getting them wrong silently would be a
// worse outcome than just not supporting them yet.

function clamp8(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

export function decodeBmp(buffer) {
  if (buffer[0] !== 0x42 || buffer[1] !== 0x4d) throw new Error('Not a BMP file (missing "BM" signature)');
  const dataOffset = buffer.readUInt32LE(10);
  const headerSize = buffer.readUInt32LE(14);
  if (headerSize < 40) throw new Error('Unsupported BMP header (only BITMAPINFOHEADER and newer are supported)');

  const width = buffer.readInt32LE(18);
  const rawHeight = buffer.readInt32LE(22);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0; // negative height means rows are stored top-to-bottom, not BMP's usual bottom-up
  const bitsPerPixel = buffer.readUInt16LE(28);
  const compression = buffer.readUInt32LE(30);

  if (compression !== 0) throw new Error('Compressed BMPs are not supported (only BI_RGB)');
  if (bitsPerPixel !== 24 && bitsPerPixel !== 32) throw new Error(`Unsupported BMP bit depth ${bitsPerPixel} (only 24/32-bit are supported)`);

  const bytesPerPixel = bitsPerPixel / 8;
  const rowSize = Math.ceil((width * bitsPerPixel) / 32) * 4; // rows are padded to a 4-byte boundary
  const rgba = Buffer.alloc(width * height * 4);

  for (let row = 0; row < height; row += 1) {
    const sourceRow = topDown ? row : height - 1 - row;
    const rowStart = dataOffset + sourceRow * rowSize;
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = rowStart + x * bytesPerPixel;
      const destIndex = (row * width + x) * 4;
      // BMP stores BGR(A), not RGB(A).
      rgba[destIndex] = clamp8(buffer[sourceIndex + 2]);
      rgba[destIndex + 1] = clamp8(buffer[sourceIndex + 1]);
      rgba[destIndex + 2] = clamp8(buffer[sourceIndex]);
      rgba[destIndex + 3] = bytesPerPixel === 4 ? buffer[sourceIndex + 3] : 255;
    }
  }
  return { width, height, rgba };
}
