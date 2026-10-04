// Text extraction for Word / Excel / PowerPoint (OOXML), OpenDocument, EPUB, RTF and HTML.
// These are ZIP+XML (or plain markup) formats, so a ZIP reader and a few careful regexes over
// the XML are enough — no XML library. The readers target the readable content (text, tables,
// sheets, slides, notes), not layout fidelity.

import { ZipArchive } from './zip.mjs';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    return ENTITIES[body] ?? whole;
  });
}

const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const clean = (text) => text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

function renderTable(rows) {
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (!width) return '';
  const lines = rows.map((row) => `| ${Array.from({ length: width }, (_, index) => (row[index] ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')).join(' | ')} |`);
  lines.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
  return lines.join('\n');
}

// ------------------------------------------------------------------------------ DOCX

function docxBody(xml) {
  const blocks = [];
  const tables = [];       // stack of { rows, row, cell }
  let paragraph = '';
  let style = '';
  let listLevel = null;
  let inText = false;
  const token = /<(\/?)(w:[A-Za-z]+)((?:\s[^>]*?)?)(\/?)>|([^<]+)/g;
  const emit = (text, list = false) => {
    const table = tables[tables.length - 1];
    if (table) table.cell.push(text);
    else blocks.push({ text, list });
  };
  let match;
  while ((match = token.exec(xml)) !== null) {
    if (match[5] !== undefined) { if (inText) paragraph += decodeEntities(match[5]); continue; }
    const closing = match[1] === '/'; const tag = match[2]; const attrs = match[3]; const selfClosing = match[4] === '/';
    if (tag === 'w:t' || tag === 'w:delText' || tag === 'w:instrText') { inText = !closing && !selfClosing && tag !== 'w:instrText' && tag !== 'w:delText'; continue; }
    if (closing) {
      if (tag === 'w:p') {
        const heading = /^(?:Heading|heading)\s*(\d)/.exec(style) || (style === 'Title' ? [null, '1'] : null);
        let text = paragraph.replace(/ /g, ' ');
        if (text.trim()) {
          if (heading) text = `${'#'.repeat(Math.min(6, Number(heading[1])))} ${text.trim()}`;
          else if (listLevel !== null) text = `${'  '.repeat(listLevel)}- ${text.trim()}`;
          emit(text, !heading && listLevel !== null);
        }
        paragraph = ''; style = ''; listLevel = null;
      } else if (tag === 'w:tc') {
        const table = tables[tables.length - 1];
        if (table) { table.row.push(table.cell.join('\n')); table.cell = []; }
      } else if (tag === 'w:tr') {
        const table = tables[tables.length - 1];
        if (table) { table.rows.push(table.row); table.row = []; }
      } else if (tag === 'w:tbl') {
        const table = tables.pop();
        if (table) emit(renderTable(table.rows));
      }
      continue;
    }
    if (tag === 'w:tbl') tables.push({ rows: [], row: [], cell: [] });
    else if (tag === 'w:pStyle') style = attr(attrs, 'w:val') || '';
    else if (tag === 'w:ilvl') listLevel = Number(attr(attrs, 'w:val')) || 0;
    else if (tag === 'w:numPr' && listLevel === null) listLevel = 0;
    else if (tag === 'w:tab') paragraph += '\t';
    else if (tag === 'w:br' || tag === 'w:cr') paragraph += '\n';
  }
  return blocks.map((block, index) => (index === 0 ? '' : block.list && blocks[index - 1].list ? '\n' : '\n\n') + block.text).join('');
}

function readDocx(zip) {
  const sections = [];
  const main = zip.readTextIfPresent('word/document.xml');
  if (main === null) throw new Error('Not a Word document (word/document.xml is missing)');
  sections.push(docxBody(main));
  const footnotes = zip.readTextIfPresent('word/footnotes.xml');
  if (footnotes) { const text = docxBody(footnotes); if (text.trim()) sections.push(`## Footnotes\n\n${text}`); }
  const comments = zip.readTextIfPresent('word/comments.xml');
  if (comments) { const text = docxBody(comments); if (text.trim()) sections.push(`## Comments\n\n${text}`); }
  const headers = zip.names().filter((name) => /^word\/(header|footer)\d*\.xml$/.test(name)).map((name) => docxBody(zip.readText(name)).trim()).filter(Boolean);
  if (headers.length) sections.push(`## Headers and footers\n\n${[...new Set(headers)].join('\n')}`);
  return { format: 'docx', text: sections.join('\n\n') };
}

// ------------------------------------------------------------------------------ XLSX

const columnIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((item) => decodeEntities(
    [...item[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => part[1]).join(''),
  ));
}

function readXlsx(zip, { maxRows = 2000 } = {}) {
  const workbook = zip.readTextIfPresent('xl/workbook.xml');
  if (workbook === null) throw new Error('Not an Excel workbook (xl/workbook.xml is missing)');
  const rels = new Map([...(zip.readTextIfPresent('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b([^>]*)\/?>/g)]
    .map((m) => [attr(m[1], 'Id'), attr(m[1], 'Target')]));
  const strings = sharedStrings(zip.readTextIfPresent('xl/sharedStrings.xml'));
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m, index) => {
    const target = rels.get(attr(m[1], 'r:id')) || `worksheets/sheet${index + 1}.xml`;
    return { name: decodeEntities(attr(m[1], 'name') || `Sheet${index + 1}`), file: target.startsWith('/') ? target.slice(1) : `xl/${target}` };
  });
  const out = [];
  let truncated = false;
  for (const sheet of sheets) {
    if (!zip.has(sheet.file)) continue;
    const xml = zip.readText(sheet.file);
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= maxRows) { truncated = true; break; }
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(cellMatch[1], 'r'); const type = attr(cellMatch[1], 't'); const body = cellMatch[2] || '';
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value = '';
        if (type === 's') value = strings[Number(raw)] ?? '';
        else if (type === 'inlineStr') value = decodeEntities([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((p) => p[1]).join(''));
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else if (raw !== undefined) value = decodeEntities(raw);
        const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body)?.[1];
        if (!value && formula) value = `=${decodeEntities(formula)}`;
        if (ref) cells[columnIndex(ref)] = value; else cells.push(value);
      }
      if (cells.some((cell) => cell !== undefined && cell !== '')) rows.push(Array.from(cells, (cell) => cell ?? ''));
    }
    out.push(`## Sheet: ${sheet.name} (${rows.length} row${rows.length === 1 ? '' : 's'}${truncated ? '+, truncated' : ''})\n\n${rows.length ? renderTable(rows) : '(empty)'}`);
  }
  return { format: 'xlsx', text: out.join('\n\n'), sheets: sheets.length, truncated };
}

// ------------------------------------------------------------------------------ PPTX

function paragraphsOf(xml) {
  return [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
    .map((p) => decodeEntities([...p[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)].map((t) => (t[1] === undefined ? '\n' : t[1])).join('')))
    .filter((line) => line.trim());
}

function readPptx(zip) {
  const presentation = zip.readTextIfPresent('ppt/presentation.xml');
  if (presentation === null) throw new Error('Not a PowerPoint file (ppt/presentation.xml is missing)');
  const rels = new Map([...(zip.readTextIfPresent('ppt/_rels/presentation.xml.rels') || '').matchAll(/<Relationship\b([^>]*)\/?>/g)]
    .map((m) => [attr(m[1], 'Id'), attr(m[1], 'Target')]));
  let slides = [...presentation.matchAll(/<p:sldId\b([^>]*)\/?>/g)].map((m) => rels.get(attr(m[1], 'r:id'))).filter(Boolean)
    .map((target) => (target.startsWith('/') ? target.slice(1) : `ppt/${target}`));
  if (!slides.length) {
    slides = zip.names().filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => parseInt(a.match(/(\d+)\.xml$/)[1], 10) - parseInt(b.match(/(\d+)\.xml$/)[1], 10));
  }
  const out = slides.filter((name) => zip.has(name)).map((name, index) => {
    const lines = paragraphsOf(zip.readText(name));
    const slideRels = zip.readTextIfPresent(name.replace(/slides\/([^/]+)$/, 'slides/_rels/$1.rels')) || '';
    const notesTarget = /Target="[^"]*notesSlides\/([^"]+)"/.exec(slideRels)?.[1];
    const notes = notesTarget && zip.has(`ppt/notesSlides/${notesTarget}`) ? paragraphsOf(zip.readText(`ppt/notesSlides/${notesTarget}`)).filter((line) => !/^\d+$/.test(line.trim())) : [];
    const [title, ...body] = lines;
    return [`## Slide ${index + 1}${title ? `: ${title}` : ''}`, ...body, ...(notes.length ? ['', '_Speaker notes:_', ...notes] : [])].join('\n');
  });
  return { format: 'pptx', text: out.join('\n\n'), slides: out.length };
}

// -------------------------------------------------------------------------- OpenDocument

const stripTags = (xml) => decodeEntities(xml
  .replace(/<text:tab\s*\/>/g, '\t')
  .replace(/<text:line-break\s*\/>/g, '\n')
  .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_, count) => ' '.repeat(Number(count) || 1))
  .replace(/<\/text:p>/g, ' ')
  .replace(/<[^>]+>/g, '')).trim();

// Tables become markdown tables; empty repeated cells/rows (spreadsheet padding) are dropped.
function odfTable(xml, maxRows = 2000) {
  const rows = [];
  for (const row of xml.matchAll(/<table:table-row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)) {
    const repeat = Math.min(Number(attr(row[1], 'table:number-rows-repeated')) || 1, 50);
    const cells = [];
    for (const cell of (row[2] || '').matchAll(/<table:(?:covered-)?table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g)) {
      const value = stripTags(cell[2] || '');
      const times = value ? Math.min(Number(attr(cell[1], 'table:number-columns-repeated')) || 1, 20) : 1;
      for (let index = 0; index < times; index += 1) cells.push(value);
    }
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (!cells.length) continue;
    for (let index = 0; index < repeat && rows.length < maxRows; index += 1) rows.push(cells);
  }
  return rows;
}

function odfBlocks(xml, maxRows) {
  const out = [];
  const token = /<table:table\b([^>]*)>([\s\S]*?)<\/table:table>|<text:h\b([^>]*)>([\s\S]*?)<\/text:h>|<text:list-item\b[^>]*>([\s\S]*?)<\/text:list-item>|<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g;
  let match;
  while ((match = token.exec(xml)) !== null) {
    if (match[2] !== undefined) {
      const rows = odfTable(match[2], maxRows);
      if (rows.length) out.push({ text: renderTable(rows), name: decodeEntities(attr(match[1], 'table:name') || '') });
    } else if (match[4] !== undefined) {
      const level = Number(attr(match[3], 'text:outline-level')) || 1;
      const text = stripTags(match[4]);
      if (text) out.push({ text: `${'#'.repeat(Math.min(6, level))} ${text}` });
    } else if (match[5] !== undefined) {
      const text = stripTags(match[5]);
      if (text) out.push({ text: `- ${text}`, list: true });
    } else {
      const text = stripTags(match[6]);
      if (text) out.push({ text });
    }
  }
  return out;
}

const joinBlocks = (blocks) => blocks.map((block, index) => (index === 0 ? '' : block.list && blocks[index - 1].list ? '\n' : '\n\n') + block.text).join('');

function readOpenDocument(zip, format, { maxRows = 2000 } = {}) {
  const xml = zip.readTextIfPresent('content.xml');
  if (xml === null) throw new Error('Not an OpenDocument file (content.xml is missing)');
  if (format === 'ods') {
    const sheets = [...xml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)].map((sheet) => {
      const rows = odfTable(sheet[2], maxRows);
      return `## Sheet: ${decodeEntities(attr(sheet[1], 'table:name') || 'Sheet')} (${rows.length} row${rows.length === 1 ? '' : 's'})\n\n${rows.length ? renderTable(rows) : '(empty)'}`;
    });
    return { format, text: sheets.join('\n\n'), sheets: sheets.length };
  }
  if (format === 'odp') {
    const pages = [...xml.matchAll(/<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/g)].map((page, index) => {
      const notes = /<presentation:notes\b[^>]*>([\s\S]*?)<\/presentation:notes>/.exec(page[1]);
      const body = joinBlocks(odfBlocks(notes ? page[1].replace(notes[0], '') : page[1], maxRows));
      const noteText = notes ? joinBlocks(odfBlocks(notes[1], maxRows)) : '';
      const [title, ...rest] = body.split('\n').filter((line) => line.trim());
      return [`## Slide ${index + 1}${title ? `: ${title.replace(/^[-#\s]+/, '')}` : ''}`, ...rest, ...(noteText ? ['', '_Speaker notes:_', noteText] : [])].join('\n');
    });
    return { format, text: pages.join('\n\n'), slides: pages.length };
  }
  return { format, text: clean(joinBlocks(odfBlocks(xml, maxRows)).replace(/^(\|.*\|)$/gm, '$1')) };
}

function readEpub(zip) {
  const container = zip.readTextIfPresent('META-INF/container.xml') || '';
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  const opf = opfPath ? zip.readTextIfPresent(opfPath) : null;
  const base = opfPath ? opfPath.replace(/[^/]*$/, '') : '';
  let files = [];
  if (opf) {
    const manifest = new Map([...opf.matchAll(/<item\b([^>]*)\/?>/g)].map((m) => [attr(m[1], 'id'), attr(m[1], 'href')]));
    files = [...opf.matchAll(/<itemref\b([^>]*)\/?>/g)].map((m) => manifest.get(attr(m[1], 'idref'))).filter(Boolean).map((href) => base + decodeURIComponent(href));
  }
  if (!files.length) files = zip.names().filter((name) => /\.(x?html?)$/i.test(name));
  const chapters = files.filter((name) => zip.has(name)).map((name) => htmlToText(zip.readText(name))).filter((text) => text.trim());
  return { format: 'epub', text: chapters.join('\n\n---\n\n') };
}

// --------------------------------------------------------------------------- HTML / RTF

export function htmlToText(html) {
  const text = html
    .replace(/<(script|style|head|noscript|svg)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:p|div|tr|h[1-6]|ul|ol|table|section|article|blockquote)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  return clean(decodeEntities(text).replace(/[ \t]{2,}/g, ' '));
}

const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'headerl', 'headerr', 'footerl', 'footerr', 'footnote', 'generator', 'listtable', 'listoverridetable', 'rsidtbl', 'themedata', 'datastore', 'latentstyles', 'fldinst', 'private', 'xmlnstbl', 'colorschememapping', 'filetbl', 'revtbl', 'pgptbl', 'listtext', 'pnseclvl', 'bkmkstart', 'bkmkend']);
const RTF_CHARS = { emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', tab: '\t', cell: '\t', nestcell: '\t', row: '\n', nestrow: '\n', par: '\n', line: '\n', sect: '\n', page: '\n' };

function rtfToText(source) {
  let out = '';
  const groups = [];          // saved { skipping, unicodeSkip } per open brace
  let skipping = false;
  let unicodeSkip = 1;
  let ignore = 0;             // fallback characters to drop after a \uN escape
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '{') { groups.push({ skipping, unicodeSkip }); index += 1; continue; }
    if (ch === '}') { ({ skipping, unicodeSkip } = groups.pop() || { skipping: false, unicodeSkip: 1 }); index += 1; continue; }
    if (ch === '\\') {
      const next = source[index + 1];
      if (next === '\\' || next === '{' || next === '}') { if (!skipping) out += next; index += 2; continue; }
      if (next === '*') { skipping = true; index += 2; continue; }
      if (next === "'") {
        if (!skipping) { if (ignore) ignore -= 1; else out += Buffer.from([parseInt(source.slice(index + 2, index + 4), 16) || 63]).toString('latin1'); }
        index += 4; continue;
      }
      if (next === '~') { if (!skipping) out += ' '; index += 2; continue; }
      if (next === '-' || next === '_') { index += 2; continue; }
      const word = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(source.slice(index, index + 40));
      if (!word) { index += 2; continue; }
      index += word[0].length;
      const [, name, value] = word;
      if (RTF_SKIP.has(name)) skipping = true;
      else if (skipping) continue;
      else if (name === 'uc') unicodeSkip = Number(value) || 0;
      else if (name === 'u') { const code = Number(value); out += String.fromCharCode(code < 0 ? code + 65536 : code); ignore = unicodeSkip; }
      else if (RTF_CHARS[name] !== undefined) out += RTF_CHARS[name];
      continue;
    }
    index += 1;
    if (ch === '\n' || ch === '\r' || skipping) continue;
    if (ignore) { ignore -= 1; continue; }
    out += ch;
  }
  return clean(out.replace(/\t+\n/g, '\n'));
}

// ---------------------------------------------------------------------------- dispatcher

export function readZipDocument(buffer, extension, options = {}) {
  const zip = new ZipArchive(buffer);
  switch (extension) {
    case '.docx': case '.docm': case '.dotx': return readDocx(zip);
    case '.xlsx': case '.xlsm': case '.xltx': return readXlsx(zip, options);
    case '.pptx': case '.pptm': case '.potx': case '.ppsx': return readPptx(zip);
    case '.odt': case '.ott': return readOpenDocument(zip, 'odt', options);
    case '.ods': case '.ots': return readOpenDocument(zip, 'ods', options);
    case '.odp': case '.otp': return readOpenDocument(zip, 'odp', options);
    case '.epub': return readEpub(zip);
    default: throw new Error(`Unsupported container format: ${extension}`);
  }
}

export function readRtf(buffer) { return { format: 'rtf', text: rtfToText(buffer.toString('latin1')) }; }
export function readHtml(buffer) { return { format: 'html', text: htmlToText(buffer.toString('utf8')) }; }
