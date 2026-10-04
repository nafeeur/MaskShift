// A from-scratch PDF text extractor. No poppler, no npm package: the compression is node:zlib,
// and the rest — object syntax, object streams, the page tree, font encodings, ToUnicode CMaps
// and the text operators — is parsed here.
//
// It rebuilds the object table by scanning for "N G obj" rather than trusting xref tables, which
// also makes it tolerant of damaged files and incremental updates (the last definition wins).
//
// Honest limits: encrypted PDFs are refused; scanned pages have no text layer (the caller falls
// back to OCR when available); fonts that are subset-encoded with no ToUnicode map and no
// standard encoding cannot be decoded and are counted so the caller can say so.

import crypto from 'node:crypto';
import zlib from 'node:zlib';

const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const MAX_PDF_BYTES = 200 * 1024 * 1024;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;

class Name { constructor(value) { this.n = value; } }
class Str { constructor(value) { this.s = value; } }
class Ref { constructor(num, gen) { this.num = num; this.gen = gen; } }

const isName = (value, expected) => value instanceof Name && (expected === undefined || value.n === expected);

// ----------------------------------------------------------------------------- lexer

class Lexer {
  constructor(source, pos = 0) { this.s = source; this.pos = pos; }

  skipSpace() {
    const s = this.s;
    while (this.pos < s.length) {
      const code = s.charCodeAt(this.pos);
      if (WHITESPACE.has(code)) this.pos += 1;
      else if (code === 37) { while (this.pos < s.length && s.charCodeAt(this.pos) !== 10 && s.charCodeAt(this.pos) !== 13) this.pos += 1; }
      else break;
    }
  }

  // Returns {t, v}: t is 'num' | 'name' | 'str' | 'kw' | '[' | ']' | '<<' | '>>' | 'eof'.
  next() {
    this.skipSpace();
    const s = this.s;
    if (this.pos >= s.length) return { t: 'eof' };
    const ch = s[this.pos];
    const code = s.charCodeAt(this.pos);
    if (ch === '/') {
      this.pos += 1;
      let raw = '';
      while (this.pos < s.length) {
        const c = s.charCodeAt(this.pos);
        if (WHITESPACE.has(c) || DELIMITERS.has(c)) break;
        raw += s[this.pos]; this.pos += 1;
      }
      return { t: 'name', v: new Name(raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))) };
    }
    if (ch === '(') return { t: 'str', v: new Str(this.#literalString()) };
    if (ch === '<') {
      if (s[this.pos + 1] === '<') { this.pos += 2; return { t: '<<' }; }
      return { t: 'str', v: new Str(this.#hexString()) };
    }
    if (ch === '>') {
      if (s[this.pos + 1] === '>') { this.pos += 2; return { t: '>>' }; }
      this.pos += 1; return this.next();
    }
    if (ch === '[' || ch === ']') { this.pos += 1; return { t: ch }; }
    if (ch === '{' || ch === '}' || ch === ')') { this.pos += 1; return this.next(); }
    let end = this.pos;
    while (end < s.length) {
      const c = s.charCodeAt(end);
      if (WHITESPACE.has(c) || DELIMITERS.has(c)) break;
      end += 1;
    }
    const word = s.slice(this.pos, end);
    this.pos = end;
    if (code === 43 || code === 45 || code === 46 || (code >= 48 && code <= 57)) {
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: 'num', v: Number(word) };
    }
    return { t: 'kw', v: word };
  }

  #literalString() {
    const s = this.s;
    let depth = 0;
    let out = '';
    this.pos += 1;
    depth = 1;
    while (this.pos < s.length) {
      const ch = s[this.pos];
      this.pos += 1;
      if (ch === '\\') {
        const escaped = s[this.pos]; this.pos += 1;
        if (escaped === 'n') out += '\n';
        else if (escaped === 'r') out += '\r';
        else if (escaped === 't') out += '\t';
        else if (escaped === 'b') out += '\b';
        else if (escaped === 'f') out += '\f';
        else if (escaped >= '0' && escaped <= '7') {
          let octal = escaped;
          while (octal.length < 3 && s[this.pos] >= '0' && s[this.pos] <= '7') { octal += s[this.pos]; this.pos += 1; }
          out += String.fromCharCode(parseInt(octal, 8) & 0xff);
        } else if (escaped === '\r') { if (s[this.pos] === '\n') this.pos += 1; }
        else if (escaped === '\n') { /* line continuation */ }
        else if (escaped !== undefined) out += escaped;
      } else if (ch === '(') { depth += 1; out += ch; }
      else if (ch === ')') { depth -= 1; if (depth === 0) break; out += ch; }
      else out += ch;
    }
    return out;
  }

  #hexString() {
    const s = this.s;
    this.pos += 1;
    let hex = '';
    while (this.pos < s.length && s[this.pos] !== '>') {
      if (/[0-9a-fA-F]/.test(s[this.pos])) hex += s[this.pos];
      this.pos += 1;
    }
    this.pos += 1;
    if (hex.length % 2) hex += '0';
    let out = '';
    for (let index = 0; index < hex.length; index += 2) out += String.fromCharCode(parseInt(hex.slice(index, index + 2), 16));
    return out;
  }
}

// Reads one object from the lexer. `refs` controls "N G R" recognition (off in content streams).
function readValue(lexer, token = lexer.next(), refs = true, depth = 0) {
  if (depth > 60) return null;
  switch (token.t) {
    case 'num': {
      if (refs && Number.isInteger(token.v) && token.v >= 0) {
        const save = lexer.pos;
        const generation = lexer.next();
        if (generation.t === 'num' && Number.isInteger(generation.v)) {
          const marker = lexer.next();
          if (marker.t === 'kw' && marker.v === 'R') return new Ref(token.v, generation.v);
        }
        lexer.pos = save;
      }
      return token.v;
    }
    case 'name': case 'str': return token.v;
    case '[': {
      const list = [];
      for (;;) {
        const item = lexer.next();
        if (item.t === ']' || item.t === 'eof') break;
        list.push(readValue(lexer, item, refs, depth + 1));
      }
      return list;
    }
    case '<<': {
      const dict = Object.create(null);
      for (;;) {
        const key = lexer.next();
        if (key.t === '>>' || key.t === 'eof') break;
        if (key.t !== 'name') continue;
        const value = lexer.next();
        if (value.t === '>>' || value.t === 'eof') break;
        dict[key.v.n] = readValue(lexer, value, refs, depth + 1);
      }
      return dict;
    }
    case 'kw':
      if (token.v === 'true') return true;
      if (token.v === 'false') return false;
      return null;
    default: return null;
  }
}

// ------------------------------------------------------------------------ stream filters

function pngUnfilter(data, { Columns = 1, Colors = 1, BitsPerComponent = 8 }) {
  const bytesPerPixel = Math.max(1, Math.ceil((Colors * BitsPerComponent) / 8));
  const rowLength = Math.ceil((Columns * Colors * BitsPerComponent) / 8);
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = Buffer.alloc(rows * rowLength);
  for (let row = 0; row < rows; row += 1) {
    const filter = data[row * (rowLength + 1)];
    const source = row * (rowLength + 1) + 1;
    const target = row * rowLength;
    for (let index = 0; index < rowLength; index += 1) {
      const raw = data[source + index];
      const left = index >= bytesPerPixel ? out[target + index - bytesPerPixel] : 0;
      const up = row > 0 ? out[target - rowLength + index] : 0;
      const upLeft = row > 0 && index >= bytesPerPixel ? out[target - rowLength + index - bytesPerPixel] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + ((left + up) >> 1);
      else {
        const estimate = left + up - upLeft;
        const dl = Math.abs(estimate - left); const du = Math.abs(estimate - up); const dul = Math.abs(estimate - upLeft);
        value = raw + (dl <= du && dl <= dul ? left : du <= dul ? up : upLeft);
      }
      out[target + index] = value & 0xff;
    }
  }
  return out;
}

function ascii85(data) {
  const text = data.toString('latin1').replace(/\s+/g, '').replace(/^<~/, '');
  const end = text.indexOf('~>');
  const body = end >= 0 ? text.slice(0, end) : text;
  const out = [];
  let group = [];
  const flush = (count) => {
    const padded = group.concat(Array(5 - group.length).fill(84));
    let value = 0;
    for (const digit of padded) value = value * 85 + digit;
    const bytes = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    out.push(...bytes.slice(0, count));
  };
  for (const ch of body) {
    if (ch === 'z' && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) { flush(4); group = []; }
  }
  if (group.length > 1) flush(group.length - 1);
  return Buffer.from(out);
}

function lzw(data, earlyChange = 1) {
  const out = [];
  let table = [];
  const reset = () => { table = []; for (let code = 0; code < 256; code += 1) table.push([code]); table.push(null, null); };
  reset();
  let bits = 9; let buffer = 0; let bitCount = 0; let previous = null;
  for (const byte of data) {
    buffer = (buffer << 8) | byte; bitCount += 8;
    while (bitCount >= bits) {
      const code = (buffer >> (bitCount - bits)) & ((1 << bits) - 1);
      bitCount -= bits;
      buffer &= (1 << bitCount) - 1;
      if (code === 256) { reset(); bits = 9; previous = null; continue; }
      if (code === 257) return Buffer.from(out);
      let entry;
      if (code < table.length) entry = table[code];
      else if (previous) entry = [...previous, previous[0]];
      else return Buffer.from(out);
      out.push(...entry);
      if (previous) table.push([...previous, entry[0]]);
      previous = entry;
      const size = table.length + earlyChange;
      bits = size >= 4096 ? 12 : size >= 2048 ? 12 : size >= 1024 ? 11 : size >= 512 ? 10 : 9;
    }
  }
  return Buffer.from(out);
}

function inflate(data) {
  try { return zlib.inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES }); } catch { /* fall through to a lenient pass */ }
  try { return zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_STREAM_BYTES }); } catch { return Buffer.alloc(0); }
}


// ---------------------------------------------------------------------------- encryption
// The standard security handler with the EMPTY user password — which is what "owner-password
// only" PDFs (copy/print restrictions, no password to open) use. Only streams are decrypted:
// text lives in content streams, and strings in dictionaries are names/numbers for our purposes.

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part))))).digest();

function rc4(key, data) {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  for (let index = 0, j = 0; index < 256; index += 1) {
    j = (j + state[index] + key[index % key.length]) & 255;
    [state[index], state[j]] = [state[j], state[index]];
  }
  const out = Buffer.alloc(data.length);
  for (let index = 0, i = 0, j = 0; index < data.length; index += 1) {
    i = (i + 1) & 255; j = (j + state[i]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
    out[index] = data[index] ^ state[(state[i] + state[j]) & 255];
  }
  return out;
}

function aesCbcDecrypt(key, data) {
  if (data.length < 32) return Buffer.alloc(0);
  const body = data.subarray(16, data.length - ((data.length - 16) % 16));
  const decipher = crypto.createDecipheriv(key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc', key, data.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  const pad = plain[plain.length - 1];
  return pad >= 1 && pad <= 16 ? plain.subarray(0, plain.length - pad) : plain;
}

function hashR6(password, salt, udata) {
  let k = crypto.createHash('sha256').update(Buffer.concat([password, salt, udata])).digest();
  for (let round = 0; ; round += 1) {
    const block = Buffer.concat([password, k, udata]);
    const k1 = Buffer.concat(Array(64).fill(block));
    const cipher = crypto.createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
    cipher.setAutoPadding(false);
    const e = Buffer.concat([cipher.update(k1), cipher.final()]);
    let mod = 0;
    for (let index = 0; index < 16; index += 1) mod += e[index];
    k = crypto.createHash(['sha256', 'sha384', 'sha512'][mod % 3]).update(e).digest();
    if (round + 1 >= 64 && e[e.length - 1] <= round + 1 - 32) break;
  }
  return k.subarray(0, 32);
}

/** Returns { decrypt(bytes, num, gen) } for an empty user password, or throws PDF_ENCRYPTED. */
function buildDecryptor(doc, encrypt, ids) {
  const fail = (why) => {
    const error = new Error(`This PDF is encrypted and ${why}, so its text cannot be extracted.`);
    error.code = 'PDF_ENCRYPTED';
    return error;
  };
  const get = (key) => doc.resolve(encrypt[key]);
  if (!isName(get('Filter'), 'Standard')) throw fail('uses a non-standard security handler');
  const V = Number(get('V')) || 0; const R = Number(get('R')) || 2;
  const O = Buffer.from(get('O')?.s ?? '', 'latin1'); const U = Buffer.from(get('U')?.s ?? '', 'latin1');
  const P = Number(get('P')) | 0;
  const encryptMetadata = get('EncryptMetadata') !== false;
  let method = 'RC4';
  if (V >= 4) {
    const filters = get('CF');
    const named = isName(get('StmF')) ? get('StmF').n : 'Identity';
    const cf = named === 'Identity' ? null : doc.resolve(filters?.[named]);
    const cfm = cf && isName(doc.resolve(cf.CFM)) ? doc.resolve(cf.CFM).n : 'None';
    if (named === 'Identity' || cfm === 'None') method = 'None';
    else if (cfm === 'AESV2') method = 'AES128';
    else if (cfm === 'AESV3') method = 'AES256';
    else if (cfm !== 'V2') throw fail(`uses an unsupported cipher (${cfm})`);
  }
  const empty = Buffer.alloc(0);
  let fileKey;
  if (V >= 5) {
    const UE = Buffer.from(get('UE')?.s ?? '', 'latin1');
    const hash = (salt) => (R === 5
      ? crypto.createHash('sha256').update(Buffer.concat([empty, salt])).digest()
      : hashR6(empty, salt, Buffer.alloc(0)));
    if (!hash(U.subarray(32, 40)).equals(U.subarray(0, 32))) throw fail('requires a password to open');
    const decipher = crypto.createDecipheriv('aes-256-cbc', hash(U.subarray(40, 48)), Buffer.alloc(16));
    decipher.setAutoPadding(false);
    fileKey = Buffer.concat([decipher.update(UE.subarray(0, 32)), decipher.final()]);
  } else {
    const keyLength = R === 2 ? 5 : Math.max(5, Math.floor((Number(get('Length')) || 40) / 8));
    const pBytes = Buffer.alloc(4); pBytes.writeInt32LE(P);
    let key = md5(PAD, O.subarray(0, 32), pBytes, ids[0] ?? '', R >= 4 && !encryptMetadata ? Buffer.from('ffffffff', 'hex') : Buffer.alloc(0));
    if (R >= 3) for (let round = 0; round < 50; round += 1) key = md5(key.subarray(0, keyLength));
    fileKey = key.subarray(0, keyLength);
    // Verify the empty password against /U so a real password gives a clear error, not garbage.
    let check;
    if (R === 2) check = rc4(fileKey, PAD);
    else {
      check = rc4(fileKey, md5(PAD, ids[0] ?? ''));
      for (let round = 1; round <= 19; round += 1) check = rc4(Buffer.from(fileKey.map((byte) => byte ^ round)), check);
    }
    if (!check.subarray(0, R === 2 ? 32 : 16).equals(U.subarray(0, R === 2 ? 32 : 16))) throw fail('requires a password to open');
  }
  return {
    metadataEncrypted: encryptMetadata,
    decrypt(data, num, gen) {
      if (method === 'None') return data;
      if (method === 'AES256') return aesCbcDecrypt(fileKey, data);
      const suffix = Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
      const objectKey = md5(fileKey, suffix, method === 'AES128' ? Buffer.from('sAlT') : Buffer.alloc(0)).subarray(0, Math.min(fileKey.length + 5, 16));
      return method === 'AES128' ? aesCbcDecrypt(objectKey, data) : rc4(objectKey, data);
    },
  };
}

// ------------------------------------------------------------------------------ document

class PdfDocument {
  constructor(buffer) {
    if (buffer.length > MAX_PDF_BYTES) throw new Error(`PDF is too large to parse (${buffer.length} bytes)`);
    this.buffer = buffer;
    this.source = buffer.toString('latin1');
    this.objects = new Map();   // num -> { value, streamStart, streamEnd }
    this.fontCache = new Map();
    this.cmapCache = new Map();
    this.unmappedCodes = 0;
    this.decryptor = null;
    this.#scan();
    this.trailer = this.#findTrailer();
    const encrypt = this.resolve(this.trailer?.Encrypt);
    if (encrypt && typeof encrypt === 'object') {
      const ids = (this.resolve(this.trailer.ID) || []).map((item) => this.resolve(item)?.s ?? '');
      this.decryptor = buildDecryptor(this, encrypt, ids);
      this.encryptNum = this.trailer.Encrypt instanceof Ref ? this.trailer.Encrypt.num : -1;
    }
    this.#expandObjectStreams();
  }

  #scan() {
    const source = this.source;
    const header = /(\d+)\s+(\d+)\s+obj\b/g;
    let match;
    while ((match = header.exec(source)) !== null) {
      const num = Number(match[1]);
      const lexer = new Lexer(source, match.index + match[0].length);
      const value = readValue(lexer);
      let streamStart = -1; let streamEnd = -1;
      lexer.skipSpace();
      if (source.startsWith('stream', lexer.pos) && value && typeof value === 'object' && !Array.isArray(value)) {
        let start = lexer.pos + 6;
        if (source[start] === '\r') start += 1;
        if (source[start] === '\n') start += 1;
        let end = -1;
        if (typeof value.Length === 'number') {
          const probe = start + value.Length;
          if (/^\s*endstream/.test(source.slice(probe, probe + 12))) end = probe;
        }
        if (end < 0) {
          end = source.indexOf('endstream', start);
          if (end < 0) end = source.length;
          if (source[end - 1] === '\n') end -= 1;
          if (source[end - 1] === '\r') end -= 1;
        }
        streamStart = start; streamEnd = end;
        header.lastIndex = Math.max(header.lastIndex, end);
      } else {
        header.lastIndex = Math.max(header.lastIndex, lexer.pos);
      }
      this.objects.set(num, { num, gen: Number(match[2]), value, streamStart, streamEnd });
    }
  }

  #expandObjectStreams() {
    for (const [, object] of [...this.objects]) {
      const dict = object.value;
      if (!dict || typeof dict !== 'object' || !isName(dict.Type, 'ObjStm') || object.streamStart < 0) continue;
      let data;
      try { data = this.streamData(object).toString('latin1'); } catch { continue; }
      const count = Number(this.resolve(dict.N)) || 0;
      const first = Number(this.resolve(dict.First)) || 0;
      const header = new Lexer(data, 0);
      const entries = [];
      for (let index = 0; index < count; index += 1) {
        const num = header.next(); const offset = header.next();
        if (num.t !== 'num' || offset.t !== 'num') break;
        entries.push([num.v, offset.v]);
      }
      for (const [num, offset] of entries) {
        if (this.objects.has(num)) continue; // a plain object definition wins over a packed one
        const value = readValue(new Lexer(data, first + offset));
        this.objects.set(num, { num, gen: 0, value, streamStart: -1, streamEnd: -1, packed: true });
      }
    }
  }

  #findTrailer() {
    let trailer = null;
    const pattern = /trailer\s*/g;
    let match;
    while ((match = pattern.exec(this.source)) !== null) {
      const value = readValue(new Lexer(this.source, match.index + match[0].length));
      if (value && typeof value === 'object' && value.Root) trailer = { ...(trailer || {}), ...value };
    }
    for (const object of this.objects.values()) {
      const dict = object.value;
      if (dict && typeof dict === 'object' && isName(dict.Type, 'XRef') && dict.Root) trailer = { ...(trailer || {}), ...dict };
    }
    return trailer;
  }

  resolve(value, depth = 0) {
    let current = value;
    while (current instanceof Ref && depth < 20) { current = this.objects.get(current.num)?.value ?? null; depth += 1; }
    return current;
  }

  streamData(object) {
    const dict = object.value;
    let data = this.buffer.subarray(object.streamStart, object.streamEnd);
    if (this.decryptor && !object.packed && !isName(dict.Type, 'XRef') && object.num !== this.encryptNum
      && !(isName(dict.Type, 'Metadata') && !this.decryptor.metadataEncrypted)) {
      data = this.decryptor.decrypt(data, object.num, object.gen);
    }
    const filters = [].concat(this.resolve(dict.Filter) ?? []).map((item) => this.resolve(item));
    const params = [].concat(this.resolve(dict.DecodeParms ?? dict.DP) ?? []).map((item) => this.resolve(item));
    filters.forEach((filter, index) => {
      const name = filter instanceof Name ? filter.n : '';
      const parm = params[index] && typeof params[index] === 'object' ? params[index] : {};
      if (name === 'FlateDecode' || name === 'Fl') {
        data = inflate(data);
        if (Number(this.resolve(parm.Predictor)) >= 10) {
          data = pngUnfilter(data, {
            Columns: Number(this.resolve(parm.Columns)) || 1,
            Colors: Number(this.resolve(parm.Colors)) || 1,
            BitsPerComponent: Number(this.resolve(parm.BitsPerComponent)) || 8,
          });
        }
      } else if (name === 'LZWDecode' || name === 'LZW') {
        data = lzw(data, parm.EarlyChange === undefined ? 1 : Number(this.resolve(parm.EarlyChange)));
      } else if (name === 'ASCII85Decode' || name === 'A85') data = ascii85(data);
      else if (name === 'ASCIIHexDecode' || name === 'AHx') {
        let hex = data.toString('latin1').replace(/>.*$/s, '').replace(/[^0-9a-fA-F]/g, '');
        if (hex.length % 2) hex += '0';
        data = Buffer.from(hex, 'hex');
      }
      else if (name) data = Buffer.alloc(0); // image/crypto filters carry no text
    });
    return data;
  }

  streamOf(value) {
    const reference = value instanceof Ref ? this.objects.get(value.num) : null;
    if (!reference || reference.streamStart < 0) return null;
    return this.streamData(reference);
  }

  pages() {
    const root = this.resolve(this.trailer?.Root);
    const pages = [];
    const seen = new Set();
    const walk = (nodeRef, inherited) => {
      const node = this.resolve(nodeRef);
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      const resources = node.Resources !== undefined ? node.Resources : inherited;
      const kids = this.resolve(node.Kids);
      if (Array.isArray(kids) && !isName(node.Type, 'Page')) kids.forEach((kid) => walk(kid, resources));
      else pages.push({ dict: node, resources });
    };
    if (root && root.Pages) walk(root.Pages, undefined);
    if (pages.length === 0) {
      [...this.objects.entries()]
        .filter(([, object]) => object.value && typeof object.value === 'object' && isName(object.value.Type, 'Page'))
        .sort((a, b) => a[0] - b[0])
        .forEach(([, object]) => pages.push({ dict: object.value, resources: object.value.Resources }));
    }
    return pages;
  }

  // ---------------------------------------------------------------------------- fonts

  cmap(ref) {
    if (!(ref instanceof Ref)) return null;
    if (this.cmapCache.has(ref.num)) return this.cmapCache.get(ref.num);
    const data = this.streamOf(ref);
    const parsed = data ? parseToUnicode(data.toString('latin1')) : null;
    this.cmapCache.set(ref.num, parsed);
    return parsed;
  }

  font(ref) {
    const key = ref instanceof Ref ? ref.num : null;
    if (key !== null && this.fontCache.has(key)) return this.fontCache.get(key);
    const dict = this.resolve(ref);
    const font = dict && typeof dict === 'object' ? this.#buildFont(dict) : { glyphs: () => [] };
    if (key !== null) this.fontCache.set(key, font);
    return font;
  }

  #buildFont(dict) {
    const subtype = this.resolve(dict.Subtype);
    const isType0 = isName(subtype, 'Type0');
    const toUnicode = this.cmap(dict.ToUnicode);
    const encoding = this.resolve(dict.Encoding);
    let baseEncoding = null;
    const differences = new Map();
    if (encoding instanceof Name) baseEncoding = encoding.n;
    else if (encoding && typeof encoding === 'object') {
      const base = this.resolve(encoding.BaseEncoding);
      if (base instanceof Name) baseEncoding = base.n;
      const list = this.resolve(encoding.Differences);
      if (Array.isArray(list)) {
        let code = 0;
        for (const item of list.map((entry) => this.resolve(entry))) {
          if (typeof item === 'number') code = item;
          else if (item instanceof Name) { differences.set(code, glyphToUnicode(item.n)); code += 1; }
        }
      }
    }
    const twoByte = isType0 && toUnicode?.codeBytes !== 1;
    const identity = baseEncoding === 'Identity-H' || baseEncoding === 'Identity-V';
    const doc = this;

    // Advance widths (1/1000 em) are what let the interpreter tell a word gap from kerning.
    let widthOf;
    if (isType0) {
      const descendant = this.resolve([].concat(this.resolve(dict.DescendantFonts) ?? [])[0]) || {};
      const defaultWidth = Number(this.resolve(descendant.DW)) || 1000;
      const widths = new Map();
      const list = (this.resolve(descendant.W) || []).map((item) => this.resolve(item));
      for (let index = 0; index < list.length;) {
        const first = list[index]; const second = list[index + 1];
        if (Array.isArray(second)) {
          second.forEach((width, offset) => widths.set(first + offset, Number(this.resolve(width)) || 0));
          index += 2;
        } else if (typeof second === 'number' && typeof list[index + 2] === 'number') {
          for (let cid = first; cid <= second && cid - first < 0x10000; cid += 1) widths.set(cid, list[index + 2]);
          index += 3;
        } else break;
      }
      widthOf = (code) => widths.get(code) ?? defaultWidth;
    } else {
      const firstChar = Number(this.resolve(dict.FirstChar)) || 0;
      const widths = (this.resolve(dict.Widths) || []).map((item) => Number(this.resolve(item)));
      const missing = Number(this.resolve(this.resolve(dict.FontDescriptor)?.MissingWidth)) || 0;
      widthOf = (code) => {
        const width = widths[code - firstChar];
        if (Number.isFinite(width) && width > 0) return width;
        if (missing) return missing;
        return code >= 32 && code <= 126 ? HELVETICA[code - 32] : 556;
      };
    }

    return {
      // [[unicode, width], ...] for one shown string.
      glyphs(text) {
        const out = [];
        if (twoByte) {
          for (let index = 0; index + 1 < text.length; index += 2) {
            const code = (text.charCodeAt(index) << 8) | text.charCodeAt(index + 1);
            const mapped = toUnicode?.map.get(code);
            if (mapped !== undefined) out.push([mapped, widthOf(code)]);
            else if (!toUnicode && !identity && code >= 32 && code < 0xd800) out.push([String.fromCharCode(code), widthOf(code)]);
            else { if (code !== 0) doc.unmappedCodes += 1; out.push(['', widthOf(code)]); }
          }
          return out;
        }
        for (let index = 0; index < text.length; index += 1) {
          const code = text.charCodeAt(index);
          const mapped = toUnicode?.map.get(code);
          let unicode = '';
          if (mapped !== undefined) unicode = mapped;
          else if (differences.has(code) && differences.get(code)) unicode = differences.get(code);
          else if (baseEncoding === 'MacRomanEncoding') unicode = MAC_ROMAN_HIGH[code - 128] ?? (code >= 32 ? String.fromCharCode(code) : '');
          else if (code >= 128 && code <= 159) unicode = CP1252_HIGH[code - 128] ?? '';
          else if (code >= 32) unicode = String.fromCharCode(code);
          else if (code === 9 || code === 10) unicode = ' ';
          out.push([unicode, widthOf(code)]);
        }
        return out;
      },
    };
  }

  // ----------------------------------------------------------------- content streams

  pageText(page) {
    const content = this.resolve(page.dict.Contents);
    const parts = [];
    for (const piece of Array.isArray(content) ? content : [page.dict.Contents]) {
      const data = this.streamOf(piece);
      if (data) parts.push(data.toString('latin1'));
    }
    return this.#interpret(parts.join('\n'), page.resources, 0, new Set());
  }

  #interpret(stream, resourcesRef, depth, activeForms) {
    const resources = this.resolve(resourcesRef) || {};
    const fonts = this.resolve(resources.Font) || {};
    const xobjects = this.resolve(resources.XObject) || {};
    const lexer = new Lexer(stream);
    let out = '';
    let font = null; let fontSize = 1;
    let tlm = [1, 0, 0, 1, 0, 0]; let tm = tlm;
    let leading = 0; let charSpace = 0; let wordSpace = 0; let hScale = 1;
    let endX = null; let lastY = null;   // where the previous text ended, in user space
    const operands = [];

    const effectiveSize = () => Math.abs(fontSize * (tm[0] || tm[3] || 1)) || 1;
    // Called before the first glyph of a shown string: decide newline / space / nothing from
    // how far the cursor is from where the previous text actually ended.
    const place = () => {
      if (lastY === null) return;
      const size = effectiveSize();
      if (Math.abs(tm[5] - lastY) > Math.abs(fontSize * (tm[3] || 1)) * 0.3 + 0.01) { if (!out.endsWith('\n')) out += '\n'; }
      else {
        const gap = tm[4] - endX;
        if ((gap > size * 0.2 || gap < -size * 0.5) && out && !/\s$/.test(out)) out += ' ';
      }
    };
    const advance = (amount) => { tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + amount * tm[0], tm[5] + amount * tm[1]]; };
    const show = (text) => {
      if (!font) return;
      const glyphs = font.glyphs(text);
      if (!glyphs.length) return;
      if (glyphs.some(([unicode]) => unicode !== '')) place();
      for (const [unicode, width] of glyphs) {
        out += unicode;
        advance(((width / 1000) * fontSize + charSpace + (unicode === ' ' ? wordSpace : 0)) * hScale);
      }
      endX = tm[4]; lastY = tm[5];
    };
    const move = (tx, ty) => {
      tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tx * tlm[0] + ty * tlm[2] + tlm[4], tx * tlm[1] + ty * tlm[3] + tlm[5]];
      tm = tlm;
    };
    const stringOf = (value) => (value instanceof Str ? value.s : '');

    for (;;) {
      const token = lexer.next();
      if (token.t === 'eof') break;
      if (token.t === 'kw' && token.v !== 'true' && token.v !== 'false' && token.v !== 'null') {
        const op = token.v;
        const [a, b, c, d, e, f] = operands;
        switch (op) {
          case 'BT': tlm = [1, 0, 0, 1, 0, 0]; tm = tlm; break;
          case 'Tf': {
            const name = a instanceof Name ? a.n : '';
            font = fonts[name] !== undefined ? this.font(fonts[name]) : null;
            fontSize = typeof b === 'number' ? b : 1;
            break;
          }
          case 'Td': if (typeof a === 'number' && typeof b === 'number') move(a, b); break;
          case 'TD': if (typeof a === 'number' && typeof b === 'number') { leading = -b; move(a, b); } break;
          case 'TL': if (typeof a === 'number') leading = a; break;
          case 'Tc': if (typeof a === 'number') charSpace = a; break;
          case 'Tw': if (typeof a === 'number') wordSpace = a; break;
          case 'Tz': if (typeof a === 'number') hScale = a / 100; break;
          case 'T*': move(0, -leading); break;
          case 'Tm': if ([a, b, c, d, e, f].every((n) => typeof n === 'number')) { tlm = [a, b, c, d, e, f]; tm = tlm; } break;
          case 'Tj': show(stringOf(a)); break;
          case "'": move(0, -leading); show(stringOf(a)); break;
          case '"': move(0, -leading); show(stringOf(c)); break;
          case 'TJ':
            if (Array.isArray(a)) {
              for (const item of a) {
                if (item instanceof Str) show(item.s);
                else if (typeof item === 'number') advance((-item / 1000) * fontSize * hScale);
              }
            }
            break;
          case 'Do': {
            const name = a instanceof Name ? a.n : '';
            const target = xobjects[name];
            const object = target instanceof Ref ? this.objects.get(target.num) : null;
            const dict = object?.value;
            if (depth < 4 && dict && isName(this.resolve(dict.Subtype), 'Form') && object.streamStart >= 0 && !activeForms.has(target.num)) {
              activeForms.add(target.num);
              const inner = this.#interpret(this.streamData(object).toString('latin1'), dict.Resources ?? resourcesRef, depth + 1, activeForms);
              activeForms.delete(target.num);
              if (inner.trim()) { if (out && !out.endsWith('\n')) out += '\n'; out += inner; lastY = null; endX = null; }
            }
            break;
          }
          case 'BI': {
            const end = stream.indexOf('EI', lexer.pos);
            lexer.pos = end < 0 ? stream.length : end + 2;
            break;
          }
          default: break;
        }
        operands.length = 0;
        continue;
      }
      operands.push(readValue(lexer, token, false));
      if (operands.length > 64) operands.shift();
    }
    return out;
  }
}

// ------------------------------------------------------------------------ CMap / glyphs

function utf16BeHex(hex) {
  let out = '';
  for (let index = 0; index + 3 < hex.length + 1; index += 4) out += String.fromCharCode(parseInt(hex.slice(index, index + 4), 16));
  return out;
}

function parseToUnicode(text) {
  const map = new Map();
  let codeBytes = 2;
  const space = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text);
  if (space) codeBytes = Math.max(1, Math.round(space[1].length / 2));
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const entry of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(entry[1], 16), utf16BeHex(entry[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const lexer = new Lexer(block[1]);
    for (;;) {
      const lo = lexer.next(); const hi = lexer.next();
      if (lo.t !== 'str' || hi.t !== 'str') break;
      const first = hexOf(lo.v.s); const last = hexOf(hi.v.s);
      const dest = lexer.next();
      if (dest.t === 'str') {
        const base = dest.v.s;
        for (let code = first; code <= last && code - first < 0x10000; code += 1) {
          const offset = code - first;
          const units = bytesToUnits(base);
          units[units.length - 1] += offset;
          map.set(code, String.fromCharCode(...units));
        }
      } else if (dest.t === '[') {
        for (let code = first; code <= last; code += 1) {
          const item = lexer.next();
          if (item.t === ']') break;
          if (item.t === 'str') map.set(code, String.fromCharCode(...bytesToUnits(item.v.s)));
        }
        // consume the closing bracket if the loop ended on a code
        const save = lexer.pos; const maybe = lexer.next(); if (maybe.t !== ']') lexer.pos = save;
      } else break;
    }
  }
  return { map, codeBytes };
}

function hexOf(bytes) { let value = 0; for (const ch of bytes) value = value * 256 + ch.charCodeAt(0); return value; }
function bytesToUnits(bytes) {
  const units = [];
  for (let index = 0; index + 1 < bytes.length; index += 2) units.push((bytes.charCodeAt(index) << 8) | bytes.charCodeAt(index + 1));
  return units.length ? units : [bytes.charCodeAt(0) || 0];
}

// Helvetica advance widths for ASCII 32-126, the fallback for fonts that carry no /Widths.
const HELVETICA = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const CP1252_HIGH = [
  '€', '', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '', 'Ž', '',
  '', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '', 'ž', 'Ÿ',
];
const MAC_ROMAN_HIGH = Array.from('ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ');

const GLYPHS = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'",
  parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '−', period: '.', slash: '/',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\',
  bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  endash: '–', emdash: '—', quoteleft: '‘', quoteright: '’', quotedblleft: '“', quotedblright: '”', quotesinglbase: '‚',
  quotedblbase: '„', bullet: '•', ellipsis: '…', fi: 'ﬁ', fl: 'ﬂ', ff: 'ﬀ', ffi: 'ﬃ', ffl: 'ﬄ', degree: '°', copyright: '©',
  registered: '®', trademark: '™', section: '§', paragraph: '¶', dagger: '†', daggerdbl: '‡', currency: '¤', sterling: '£',
  yen: '¥', Euro: '€', cent: '¢', multiply: '×', divide: '÷', plusminus: '±', guillemotleft: '«', guillemotright: '»',
  germandbls: 'ß', nbspace: ' ', nonbreakingspace: ' ', periodcentered: '·', exclamdown: '¡', questiondown: '¿',
  ae: 'æ', AE: 'Æ', oslash: 'ø', Oslash: 'Ø', aring: 'å', Aring: 'Å', ccedilla: 'ç', Ccedilla: 'Ç', ntilde: 'ñ', Ntilde: 'Ñ',
  dotlessi: 'ı', oe: 'œ', OE: 'Œ', scaron: 'š', Scaron: 'Š', zcaron: 'ž', Zcaron: 'Ž', ydieresis: 'ÿ', Ydieresis: 'Ÿ',
};
const ACCENTS = { grave: '̀', acute: '́', circumflex: '̂', tilde: '̃', dieresis: '̈', ring: '̊', caron: '̌', macron: '̄' };

function glyphToUnicode(name) {
  if (GLYPHS[name] !== undefined) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  let match = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (match) return String.fromCharCode(parseInt(match[1], 16));
  match = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (match) return String.fromCodePoint(parseInt(match[1], 16));
  match = /^([A-Za-z])(grave|acute|circumflex|tilde|dieresis|ring|caron|macron)$/.exec(name);
  if (match) return (match[1] + ACCENTS[match[2]]).normalize('NFC');
  match = /^[A-Za-z]\.\w+$/.exec(name);
  if (match) return name[0];
  return '';
}

// -------------------------------------------------------------------------------- API

const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl' };

function tidy(text) {
  return text
    .replace(/[ﬀ-ﬄ]/g, (ch) => LIGATURES[ch])
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extracts text from a PDF buffer. `firstPage`/`lastPage` are 1-based and inclusive. */
export function extractPdf(buffer, { firstPage, lastPage } = {}) {
  if (buffer.subarray(0, 1024).indexOf('%PDF-') < 0) throw new Error('Not a PDF file (missing %PDF- header)');
  const doc = new PdfDocument(buffer);
  const pages = doc.pages();
  const start = Math.max(1, firstPage || 1);
  const end = Math.min(pages.length, lastPage || pages.length);
  const out = [];
  let characters = 0;
  for (let index = start - 1; index < end; index += 1) {
    let text = '';
    try { text = tidy(doc.pageText(pages[index])); } catch { text = ''; }
    characters += text.length;
    out.push({ page: index + 1, text });
  }
  const notes = [];
  if (doc.unmappedCodes > 0) notes.push(`${doc.unmappedCodes} glyphs use a font encoding with no Unicode map and were skipped; some text may be missing.`);
  return {
    totalPages: pages.length,
    pages: out,
    characters,
    text: out.map((page) => `--- Page ${page.page} ---\n${page.text}`).join('\n\n'),
    notes,
    scannedLikely: pages.length > 0 && characters < (end - start + 1) * 20,
  };
}
