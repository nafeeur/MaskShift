import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { absolutePath, commandExists, runCommand, shellQuote, truncate } from '../core/utils.mjs';

// Renders a PDF page range to images and OCRs them, for PDFs with little or no extractable
// text layer (scans, photographed pages). Bounded to maxPages so one huge scan can't hang.
async function ocrScannedPdf(target, { firstPage, lastPage, totalPages, maxPages, signal }) {
  const start = firstPage || 1;
  const end = Math.min(lastPage || totalPages || start + maxPages - 1, start + maxPages - 1, totalPages || Infinity);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maskshift-pdf-ocr-'));
  try {
    const prefix = path.join(tempDir, 'page');
    const render = await runCommand(
      `pdftoppm -png -r 200 -f ${start} -l ${end} ${shellQuote(target)} ${shellQuote(prefix)}`,
      { timeoutMs: 120_000, signal },
    );
    if (render.code !== 0) throw new Error(`pdftoppm failed (${render.code}): ${render.stderr || 'unknown error'}`);
    const files = (await fsp.readdir(tempDir)).filter((file) => file.startsWith('page') && file.endsWith('.png')).sort();
    const pages = [];
    for (const file of files) {
      const ocr = await runCommand(`tesseract ${shellQuote(path.join(tempDir, file))} stdout`, { timeoutMs: 60_000, signal });
      pages.push(ocr.stdout.trim());
    }
    return pages.join('\n\n');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readNotebook(target) {
  const raw = await fsp.readFile(target, 'utf8');
  let notebook;
  try { notebook = JSON.parse(raw); } catch { throw new Error(`${target} is not valid JSON`); }
  if (!Array.isArray(notebook.cells)) throw new Error(`${target} has no cells array; it is not a Jupyter notebook`);
  return notebook;
}

function cellSource(cell) {
  return Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
}

function summarizeOutputs(outputs = []) {
  return outputs.map((output) => {
    if (output.output_type === 'stream') {
      return { type: 'stream', name: output.name, text: truncate(Array.isArray(output.text) ? output.text.join('') : String(output.text || ''), 4000) };
    }
    if (output.output_type === 'error') return { type: 'error', ename: output.ename, evalue: output.evalue };
    const data = output.data || {};
    if (data['text/plain'] !== undefined) {
      const text = Array.isArray(data['text/plain']) ? data['text/plain'].join('') : String(data['text/plain']);
      return { type: output.output_type, text: truncate(text, 4000) };
    }
    const mimeKeys = Object.keys(data);
    return { type: output.output_type, mime: mimeKeys[0] || null, omitted: mimeKeys.length > 0 };
  });
}

export function registerDocumentTools(registry) {
  registry.register({
    name: 'pdf_read', title: 'Extract PDF text',
    description: 'Extract text from a PDF using pdftotext (poppler-utils), with optional page range and layout preservation. Falls back to rendering pages and running OCR when the PDF has little or no extractable text layer (scans, photographed pages).',
    category: 'documents', readOnly: true,
    keywords: ['pdf', 'document', 'extract text', 'poppler', 'scanned', 'ocr'],
    inputSchema: {
      type: 'object', required: ['path'],
      properties: {
        path: { type: 'string' },
        firstPage: { type: 'integer', minimum: 1 },
        lastPage: { type: 'integer', minimum: 1 },
        layout: { type: 'boolean', default: true },
        maxChars: { type: 'integer', minimum: 1000, maximum: 2000000, default: 500000 },
        ocrFallback: { type: 'boolean', default: true, description: 'Render and OCR pages when the PDF looks scanned (little/no extractable text).' },
        maxOcrPages: { type: 'integer', minimum: 1, maximum: 50, default: 15 },
      },
    },
    execute: async (args, context) => {
      const target = absolutePath(args.path, context.workspacePath || process.cwd());
      if (!(await commandExists('pdftotext'))) {
        throw new Error('pdftotext (poppler-utils) is not installed on this host. Install poppler-utils to enable pdf_read.');
      }
      const maxChars = args.maxChars || 500_000;
      const flags = [];
      if (args.firstPage) flags.push('-f', String(args.firstPage));
      if (args.lastPage) flags.push('-l', String(args.lastPage));
      if (args.layout !== false) flags.push('-layout');
      const command = `pdftotext ${flags.join(' ')} ${shellQuote(target)} -`;
      const result = await runCommand(command, { timeoutMs: 60_000, maxOutputChars: maxChars, signal: context.signal });
      if (result.code !== 0) throw new Error(`pdftotext failed (${result.code}): ${result.stderr || 'unknown error'}`);
      const info = await runCommand(`pdfinfo ${shellQuote(target)}`, { timeoutMs: 10_000 }).catch(() => null);
      const totalPages = Number(info?.stdout?.match(/^Pages:\s+(\d+)/m)?.[1]) || null;

      const rawText = result.stdout || '';
      let text = rawText;
      let ocrFallbackUsed = false;
      let note = null;
      const looksScanned = rawText.trim().length < (totalPages || 1) * 20;

      if (looksScanned && args.ocrFallback !== false) {
        const [tesseractAvailable, pdftoppmAvailable] = await Promise.all([commandExists('tesseract'), commandExists('pdftoppm')]);
        if (tesseractAvailable && pdftoppmAvailable) {
          try {
            const ocrText = await ocrScannedPdf(target, {
              firstPage: args.firstPage, lastPage: args.lastPage, totalPages,
              maxPages: args.maxOcrPages || 15, signal: context.signal,
            });
            if (ocrText.trim().length > rawText.trim().length) {
              text = ocrText;
              ocrFallbackUsed = true;
            }
          } catch (error) {
            note = `OCR fallback failed: ${error.message}`;
          }
        } else {
          note = 'This PDF looks scanned (little or no extractable text); install tesseract and poppler-utils (pdftoppm) to enable OCR fallback.';
        }
      }

      return {
        path: target, totalPages,
        text: truncate(text, maxChars),
        truncated: text.length > maxChars,
        ocrFallbackUsed,
        ...(note ? { note } : {}),
      };
    },
  });

  registry.register({
    name: 'notebook_read', title: 'Read Jupyter notebook',
    description: 'Read a Jupyter (.ipynb) notebook and return each cell\'s index, type, source, and a bounded summary of its outputs.',
    category: 'documents', readOnly: true,
    keywords: ['jupyter', 'ipynb', 'notebook', 'data science', 'cell'],
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    execute: async (args, context) => {
      const target = absolutePath(args.path, context.workspacePath || process.cwd());
      const notebook = await readNotebook(target);
      return {
        path: target,
        nbformat: `${notebook.nbformat ?? '?'}.${notebook.nbformat_minor ?? '?'}`,
        cellCount: notebook.cells.length,
        cells: notebook.cells.map((cell, index) => ({
          index,
          cellType: cell.cell_type,
          executionCount: cell.execution_count ?? null,
          source: cellSource(cell),
          outputs: cell.cell_type === 'code' ? summarizeOutputs(cell.outputs) : undefined,
        })),
      };
    },
  });

  registry.register({
    name: 'notebook_edit', title: 'Edit Jupyter notebook cell',
    description: 'Replace, insert, or delete one cell in a Jupyter (.ipynb) notebook by index. Replacing or inserting a code cell clears its stale outputs and execution count.',
    category: 'documents', risk: 'write',
    keywords: ['jupyter', 'ipynb', 'notebook', 'data science', 'cell'],
    inputSchema: {
      type: 'object', required: ['path', 'cellIndex'],
      properties: {
        path: { type: 'string' },
        cellIndex: { type: 'integer', minimum: 0 },
        editMode: { type: 'string', enum: ['replace', 'insert', 'delete'], default: 'replace' },
        cellType: { type: 'string', enum: ['code', 'markdown', 'raw'] },
        source: { type: 'string' },
      },
    },
    execute: async (args, context) => {
      const target = absolutePath(args.path, context.workspacePath || process.cwd());
      const notebook = await readNotebook(target);
      const editMode = args.editMode || 'replace';

      if (editMode === 'delete') {
        if (args.cellIndex >= notebook.cells.length) throw new Error(`Cell index ${args.cellIndex} is out of range (${notebook.cells.length} cells)`);
        notebook.cells.splice(args.cellIndex, 1);
      } else {
        if (args.source === undefined) throw new Error('source is required for replace and insert edits');
        const sourceLines = args.source.split(/(?<=\n)/);

        if (editMode === 'insert') {
          if (args.cellIndex > notebook.cells.length) throw new Error(`Cell index ${args.cellIndex} is out of range (${notebook.cells.length} cells)`);
          const cellType = args.cellType || 'code';
          notebook.cells.splice(args.cellIndex, 0, {
            cell_type: cellType, metadata: {}, source: sourceLines,
            ...(cellType === 'code' ? { execution_count: null, outputs: [] } : {}),
          });
        } else {
          if (args.cellIndex >= notebook.cells.length) throw new Error(`Cell index ${args.cellIndex} is out of range (${notebook.cells.length} cells)`);
          const existing = notebook.cells[args.cellIndex];
          const cellType = args.cellType || existing.cell_type;
          notebook.cells[args.cellIndex] = {
            ...existing, cell_type: cellType, source: sourceLines,
            ...(cellType === 'code' ? { execution_count: null, outputs: [] } : { execution_count: undefined, outputs: undefined }),
          };
        }
      }

      await fsp.writeFile(target, JSON.stringify(notebook, null, 1));
      return { path: target, cellCount: notebook.cells.length, editMode };
    },
  });
}
