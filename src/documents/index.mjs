// One entry point for "give me the readable text of this file", used by the doc_read tool,
// pdf_read and fs_read (so the Files preview and anything that opens a path understand
// documents too). Zero runtime dependencies: everything here is Node built-ins.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { extractPdf } from './pdf.mjs';
import { readHtml, readRtf, readZipDocument } from './office.mjs';

const ZIP_FORMATS = new Set(['.docx', '.docm', '.dotx', '.xlsx', '.xlsm', '.xltx', '.pptx', '.pptm', '.potx', '.ppsx', '.odt', '.ott', '.ods', '.ots', '.odp', '.otp', '.epub']);
const LEGACY_BINARY = new Map([['.doc', 'Word 97-2003'], ['.xls', 'Excel 97-2003'], ['.ppt', 'PowerPoint 97-2003']]);
export const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.rtf', '.html', '.htm', ...ZIP_FORMATS, ...LEGACY_BINARY.keys()]);
/** Extensions fs_read hands to the document reader rather than decoding as UTF-8 text. HTML is
 *  left out on purpose: it is source code as often as it is a document. */
export const BINARY_DOCUMENT_EXTENSIONS = new Set(['.pdf', '.rtf', ...ZIP_FORMATS, ...LEGACY_BINARY.keys()]);

export const isDocumentPath = (file) => BINARY_DOCUMENT_EXTENSIONS.has(path.extname(file).toLowerCase());

const MAX_DOCUMENT_BYTES = 200 * 1024 * 1024;

/**
 * Reads a document's text. Returns { path, format, text, truncated, notes, ...format extras }.
 * Throws a plain-language Error for formats it cannot read (legacy binary Office, encrypted).
 */
export async function readDocument(file, { maxChars = 500_000, firstPage, lastPage, maxRows } = {}) {
  const extension = path.extname(file).toLowerCase();
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
  if (stat.size > MAX_DOCUMENT_BYTES) throw new Error(`Document is ${stat.size} bytes; the limit is ${MAX_DOCUMENT_BYTES}`);
  if (LEGACY_BINARY.has(extension)) {
    throw new Error(`${path.basename(file)} is a legacy ${LEGACY_BINARY.get(extension)} binary file, which cannot be read without a converter. Re-save it as ${extension}x (or ask for a conversion with LibreOffice: soffice --headless --convert-to ${extension}x).`);
  }
  const buffer = await fsp.readFile(file);
  let result;
  if (extension === '.pdf' || buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    const pdf = extractPdf(buffer, { firstPage, lastPage });
    result = { format: 'pdf', text: pdf.text, totalPages: pdf.totalPages, scannedLikely: pdf.scannedLikely, notes: pdf.notes };
  } else if (extension === '.rtf') result = readRtf(buffer);
  else if (extension === '.html' || extension === '.htm') result = readHtml(buffer);
  else if (ZIP_FORMATS.has(extension)) result = readZipDocument(buffer, extension, { maxRows });
  else throw new Error(`Unsupported document type: ${extension || '(no extension)'}`);
  const text = result.text || '';
  return {
    path: file,
    ...result,
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    totalChars: text.length,
    truncated: Boolean(result.truncated) || text.length > maxChars,
    notes: [...(result.notes || []), ...(result.truncated ? ['Some spreadsheet rows were omitted; raise maxRows to see more.'] : [])],
  };
}
