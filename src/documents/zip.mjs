// A small ZIP reader built on node:zlib, so OOXML/ODF/EPUB containers can be opened with no
// npm dependency. It reads the central directory (the authoritative index), supports stored
// and deflated entries, and caps what any one entry may inflate to so a hostile archive
// cannot exhaust memory.

import zlib from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export const MAX_ENTRY_BYTES = 128 * 1024 * 1024;

export class ZipArchive {
  constructor(buffer) {
    this.buffer = buffer;
    this.entries = new Map();
    this.#readDirectory();
  }

  #readDirectory() {
    const buffer = this.buffer;
    const floor = Math.max(0, buffer.length - 22 - 0xffff);
    let eocd = -1;
    for (let index = buffer.length - 22; index >= floor; index -= 1) {
      if (buffer.readUInt32LE(index) === EOCD_SIGNATURE) { eocd = index; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP container (no end-of-central-directory record)');
    const count = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    if (offset === 0xffffffff) throw new Error('ZIP64 archives are not supported');
    for (let entry = 0; entry < count; entry += 1) {
      if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
      const flags = buffer.readUInt16LE(offset + 8);
      const method = buffer.readUInt16LE(offset + 10);
      const compressedSize = buffer.readUInt32LE(offset + 20);
      const size = buffer.readUInt32LE(offset + 24);
      const nameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      const localOffset = buffer.readUInt32LE(offset + 42);
      const name = buffer.toString(flags & 0x800 ? 'utf8' : 'latin1', offset + 46, offset + 46 + nameLength);
      this.entries.set(name, { name, method, compressedSize, size, localOffset, encrypted: Boolean(flags & 1) });
      offset += 46 + nameLength + extraLength + commentLength;
    }
  }

  names() { return [...this.entries.keys()]; }

  has(name) { return this.entries.has(name); }

  read(name) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`ZIP entry not found: ${name}`);
    if (entry.encrypted) throw new Error(`ZIP entry is password-protected: ${name}`);
    if (entry.size > MAX_ENTRY_BYTES) throw new Error(`ZIP entry ${name} is too large (${entry.size} bytes)`);
    const buffer = this.buffer;
    const at = entry.localOffset;
    if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== LOCAL_SIGNATURE) throw new Error(`Corrupt ZIP entry header: ${name}`);
    const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
    const raw = buffer.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    throw new Error(`Unsupported ZIP compression method ${entry.method} for ${name}`);
  }

  readText(name) { return this.read(name).toString('utf8'); }

  /** Entry text, or null when the entry is absent (optional parts such as comments). */
  readTextIfPresent(name) { return this.has(name) ? this.readText(name) : null; }
}
