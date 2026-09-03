import fsp from 'node:fs/promises';
import { absolutePath, commandExists, runCommand, shellQuote, truncate } from '../core/utils.mjs';

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
    description: 'Extract text from a PDF using pdftotext (poppler-utils), with optional page range and layout preservation.',
    category: 'documents', readOnly: true,
    keywords: ['pdf', 'document', 'extract text', 'poppler'],
    inputSchema: {
      type: 'object', required: ['path'],
      properties: {
        path: { type: 'string' },
        firstPage: { type: 'integer', minimum: 1 },
        lastPage: { type: 'integer', minimum: 1 },
        layout: { type: 'boolean', default: true },
        maxChars: { type: 'integer', minimum: 1000, maximum: 2000000, default: 500000 },
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
      return {
        path: target, totalPages,
        text: truncate(result.stdout, maxChars),
        truncated: result.stdout.length > maxChars,
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
