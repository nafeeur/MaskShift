import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { extractPdf } from '../src/documents/pdf.mjs';
import { ZipArchive } from '../src/documents/zip.mjs';
import { readDocument } from '../src/documents/index.mjs';
import { createProject, runtimeForTest } from './helpers.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'documents');
const fixture = (name) => path.join(fixtures, name);

// A minimal ZIP writer so OOXML fixtures can be built by hand where no producer is installed.
function zip(files, { store = false } = {}) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name); const raw = Buffer.from(text);
    const data = store ? raw : zlib.deflateRawSync(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8); local.writeUInt32LE(zlib.crc32(raw), 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(store ? 0 : 8, 10); central.writeUInt32LE(zlib.crc32(raw), 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data); centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// A small hand-written PDF: simple Helvetica font (no /Widths), page content given as text.
function pdfWith(contents) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${contents.map((_, i) => `${5 + i} 0 R`).join(' ')}] /Count ${contents.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', ''];
  contents.forEach((content, index) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + contents.length + index} 0 R >>`);
  });
  contents.forEach((content) => objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  let pdf = '%PDF-1.4\n';
  objects.forEach((body, index) => { if (body) pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  return Buffer.from(`${pdf}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

test('ZIP reader handles stored and deflated entries and rejects non-zips', () => {
  for (const store of [true, false]) {
    const archive = new ZipArchive(zip({ 'a.txt': 'hello', 'dir/b.txt': 'world'.repeat(500) }, { store }));
    assert.deepEqual(archive.names(), ['a.txt', 'dir/b.txt']);
    assert.equal(archive.readText('a.txt'), 'hello');
    assert.equal(archive.readText('dir/b.txt').length, 2500);
  }
  assert.throws(() => new ZipArchive(Buffer.from('definitely not a zip file at all, no records here')), /Not a ZIP/);
  assert.equal(new ZipArchive(zip({ 'a.txt': 'x' })).readTextIfPresent('missing'), null);
});

test('PDF: text, accents, page ranges and page headers', () => {
  const result = extractPdf(fsp_readSync('plain.pdf'));
  assert.equal(result.totalPages, 2);
  assert.match(result.text, /--- Page 1 ---\nQuarterly Report MASKSHIFT_PDF_OK/);
  assert.match(result.text, /Café naïve résumé/);
  assert.match(result.text, /Page two heading/);
  const second = extractPdf(fsp_readSync('plain.pdf'), { firstPage: 2, lastPage: 2 });
  assert.doesNotMatch(second.text, /Quarterly/);
  assert.match(second.text, /Page two heading/);
});

test('PDF: object streams and embedded Unicode (Type0 + ToUnicode) fonts', () => {
  assert.match(extractPdf(fsp_readSync('objstm.pdf')).text, /MASKSHIFT_PDF_OK/);
  assert.match(extractPdf(fsp_readSync('unicode-cid.pdf')).text, /Cyrillic Привет and Greek Ελληνικά embedded/);
});

test('PDF: RC4-128, AES-128 and AES-256 with an empty user password decrypt to the same text', () => {
  const expected = extractPdf(fsp_readSync('plain.pdf')).text;
  for (const name of ['enc-rc4-128.pdf', 'enc-aes-128.pdf', 'enc-aes-256.pdf']) {
    assert.equal(extractPdf(fsp_readSync(name)).text, expected, name);
  }
});

test('PDF: a real user password is refused with a clear error, not garbage', () => {
  assert.throws(() => extractPdf(fsp_readSync('needs-password.pdf')), (error) => error.code === 'PDF_ENCRYPTED' && /requires a password/.test(error.message));
  assert.throws(() => extractPdf(Buffer.from('<html>not a pdf</html>')), /Not a PDF/);
});

test('PDF: glyph advances decide word gaps and line breaks', () => {
  const content = [
    'BT /F1 12 Tf 72 700 Td [(Hel) -20 (lo)] TJ ET',          // tiny kern: same word
    'BT /F1 12 Tf 72 680 Td [(Two) -333 (words)] TJ ET',       // word-space kern
    'BT /F1 12 Tf 72 660 Td (a) Tj 5.5 0 Td (b) Tj ET',        // Td exactly at the glyph end: no gap
    'BT /F1 12 Tf 72 640 Td (c) Tj 30 0 Td (d) Tj ET',         // Td well past the glyph end: a space
  ].join('\n');
  const { text } = extractPdf(pdfWith([content]));
  assert.deepEqual(text.split('\n').slice(1), ['Hello', 'Two words', 'ab', 'c d']);
});

test('PDF: literal escapes, hex strings and multi-page order', () => {
  const { text, totalPages } = extractPdf(pdfWith([
    'BT /F1 12 Tf 72 700 Td (Paren \\(ok\\) \\101\\102) Tj 0 -20 Td <48656C6C6F> Tj ET',
    'BT /F1 12 Tf 72 700 Td (Second page) Tj ET',
  ]));
  assert.equal(totalPages, 2);
  assert.match(text, /Paren \(ok\) AB\nHello/);
  assert.ok(text.indexOf('Paren') < text.indexOf('Second page'));
});

test('Word, PowerPoint, OpenDocument and RTF files from a real producer', async () => {
  const docx = (await readDocument(fixture('report.docx'))).text;
  assert.match(docx, /^# Annual Plan/);
  assert.match(docx, /- Ship zero-dependency readers\n- Keep the CLI fast/);
  assert.match(docx, /\| Region \| Revenue \|\n\| --- \| --- \|\n\| EMEA \| 1200 \|/);
  const pptx = await readDocument(fixture('deck.pptx'));
  assert.equal(pptx.slides, 2);
  assert.match(pptx.text, /## Slide 1: Launch Deck[\s\S]*_Speaker notes:_\nRemember the demo[\s\S]*## Slide 2: Roadmap\nQ1 readers/);
  assert.match((await readDocument(fixture('report.odt'))).text, /\| APAC \| 3400 \|/);
  assert.match((await readDocument(fixture('deck.odp'))).text, /## Slide 2: Roadmap\n- Q1 readers/);
  const rtf = (await readDocument(fixture('report.rtf'))).text;
  assert.match(rtf, /Annual Plan\nIntro paragraph with bold text & an ampersand\./);
  assert.doesNotMatch(rtf, /\\|fonttbl|Liberation/);
});

test('Excel: shared strings, inline strings, booleans, sparse cells, formulas and multiple sheets', async (t) => {
  const project = await createProject(t);
  const file = path.join(project, 'book.xlsx');
  await fsp.writeFile(file, zip({
    'xl/workbook.xml': '<workbook xmlns:r="x"><sheets><sheet name="Sales &amp; Q1" sheetId="1" r:id="rId2"/><sheet name="Empty" sheetId="2" r:id="rId3"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId2" Type="t" Target="worksheets/data.xml"/><Relationship Id="rId3" Type="t" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Region</t></si><si><r><t>Rev</t></r><r><t xml:space="preserve">enue</t></r></si><si><t>R&amp;D</t></si></sst>',
    'xl/worksheets/data.xml': '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>41.5</v></c><c r="C2" t="b"><v>1</v></c></row>'
      + '<row r="3"><c r="A3" t="inlineStr"><is><t>inline</t></is></c><c r="B3"><f>SUM(B2:B2)</f></c></row>'
      + '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
  }));
  const result = await readDocument(file);
  assert.equal(result.sheets, 2);
  assert.match(result.text, /## Sheet: Sales & Q1 \(3 rows\)/);
  assert.match(result.text, /\| Region \|  \| Revenue \|\n\| --- \| --- \| --- \|\n\| R&D \| 41\.5 \| TRUE \|\n\| inline \| =SUM\(B2:B2\) \|  \|/);
  assert.match(result.text, /## Sheet: Empty \(0 rows\)\n\n\(empty\)/);
  const capped = await readDocument(file, { maxRows: 1 });
  assert.equal(capped.truncated, true);
});

test('Word: headings, nested tables, tracked deletions and footnotes', async (t) => {
  const project = await createProject(t);
  const file = path.join(project, 'edge.docx');
  const p = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  await fsp.writeFile(file, zip({
    'word/document.xml': `<w:document><w:body>${p('Title here', 'Heading2')}${p('Body &lt;ok&gt;')}`
      + '<w:p><w:r><w:t>kept</w:t></w:r><w:del><w:r><w:delText>removed</w:delText></w:r></w:del><w:r><w:tab/><w:t>after</w:t></w:r></w:p>'
      + `<w:tbl><w:tr><w:tc>${p('A1')}</w:tc><w:tc>${p('B1')}${p('B1 second')}</w:tc></w:tr></w:tbl></w:body></w:document>`,
    'word/footnotes.xml': `<w:footnotes>${p('A footnote')}</w:footnotes>`,
  }));
  const { text } = await readDocument(file);
  assert.match(text, /^## Title here\n\nBody <ok>\n\nkept\tafter\n\n\| A1 \| B1 B1 second \|/);
  assert.doesNotMatch(text, /removed/);
  assert.match(text, /## Footnotes\n\nA footnote/);
});

test('documents: legacy binary Office files, truncation and bad input give plain errors', async (t) => {
  const project = await createProject(t);
  await fsp.writeFile(path.join(project, 'old.doc'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  await assert.rejects(readDocument(path.join(project, 'old.doc')), /legacy Word 97-2003.*Re-save it as \.docx/);
  await fsp.writeFile(path.join(project, 'broken.docx'), 'not a zip');
  await assert.rejects(readDocument(path.join(project, 'broken.docx')), /Not a ZIP/);
  const long = await readDocument(fixture('plain.pdf'), { maxChars: 20 });
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, 20);
  assert.ok(long.totalChars > 20);
});

test('doc_read, pdf_read and fs_read open documents through the tool layer with no external tools', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const session = runtime.engine.createSession({ workspaceId: workspace.id });
  const context = { workspaceId: workspace.id, workspacePath: project, sessionId: session.id, eventBus: runtime.eventBus,
    scope: { workspaceId: workspace.id }, capabilityState: runtime.capabilityController.createState({ workspaceId: workspace.id }),
    planState: { summary: '', steps: [] } };
  for (const name of ['plain.pdf', 'report.docx', 'deck.pptx', 'enc-aes-256.pdf']) await fsp.copyFile(fixture(name), path.join(project, name));

  const docRead = await runtime.toolRegistry.execute('doc_read', { path: 'report.docx' }, context);
  assert.equal(docRead.format, 'docx');
  assert.match(docRead.text, /Annual Plan/);

  const pdfRead = await runtime.toolRegistry.execute('pdf_read', { path: 'plain.pdf' }, context);
  assert.equal(pdfRead.engine, 'builtin');
  assert.equal(pdfRead.totalPages, 2);
  assert.match(pdfRead.text, /MASKSHIFT_PDF_OK/);
  assert.match((await runtime.toolRegistry.execute('pdf_read', { path: 'enc-aes-256.pdf' }, context)).text, /MASKSHIFT_PDF_OK/);

  // fs_read is what the Files preview and any "open this file" path use.
  const viaFs = await runtime.toolRegistry.execute('fs_read', { path: 'deck.pptx', withLineNumbers: false }, context);
  assert.match(viaFs.content, /## Slide 1: Launch Deck/);
});

function fsp_readSync(name) { return fsp_sync(fixture(name)); }
import { readFileSync as fsp_sync } from 'node:fs';
