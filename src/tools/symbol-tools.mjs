import fsp from 'node:fs/promises';
import path from 'node:path';
import { absolutePath, id, sha256 } from '../core/utils.mjs';
import { replaceLines } from './edit-match.mjs';
import { findSymbol, listSymbols } from './symbols.mjs';

async function writeAtomic(target, content, tag) {
  const temp = `${target}.${process.pid}.${id(tag)}.tmp`;
  await fsp.writeFile(temp, content, 'utf8');
  await fsp.rename(temp, target);
}

const resolveTarget = (input, context) => absolutePath(input || '.', context.workspacePath || process.cwd());

export function registerSymbolTools(registry) {
  registry.register({
    name: 'symbol_read',
    title: 'Read a function, class or method',
    description: 'Return one definition (function, class, method as Class.method) with its line range, without reading the whole file. With no symbol, list the definitions in the file.',
    category: 'filesystem', readOnly: true, alwaysAvailable: true,
    keywords: ['function body', 'class', 'method', 'definition', 'outline', 'symbols'],
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, symbol: { type: 'string' } } },
    execute: async (args, context) => {
      const target = resolveTarget(args.path, context);
      const content = await fsp.readFile(target, 'utf8');
      if (!args.symbol) return { path: target, symbols: listSymbols(content) };
      const found = findSymbol(content, args.symbol, { file: target });
      return { path: target, ...found, content: found.text.split('\n').map((line, index) => `${String(found.startLine + index).padStart(6)} | ${line}`).join('\n') };
    },
  });

  registry.register({
    name: 'symbol_replace',
    title: 'Replace a whole function, class or method',
    description: 'Replace one definition by name with new source. You supply only the new text; the old text is located for you, so it never has to be reproduced exactly. Use Class.method for methods.',
    category: 'filesystem', risk: 'write', alwaysAvailable: true,
    keywords: ['rewrite function', 'replace function', 'replace method', 'refactor'],
    inputSchema: {
      type: 'object', required: ['path', 'symbol', 'newText'],
      properties: { path: { type: 'string' }, symbol: { type: 'string' }, newText: { type: 'string', description: 'Complete new definition, including its signature, at its own indentation level' } },
    },
    execute: async (args, context) => {
      const target = resolveTarget(args.path, context);
      const content = await fsp.readFile(target, 'utf8');
      const found = findSymbol(content, args.symbol, { file: target });
      const base = found.text.split('\n').find((line) => line.trim() !== '') || '';
      const indent = base.match(/^[ \t]*/)[0];
      const incoming = String(args.newText).replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
      const first = incoming.find((line) => line.trim() !== '') || '';
      const given = first.match(/^[ \t]*/)[0];
      // New text written flush-left is moved to the definition's own indentation.
      const adjusted = given === indent ? incoming : incoming.map((line) => (line.trim() === '' ? line : (line.startsWith(given) ? indent + line.slice(given.length) : line)));
      const result = replaceLines(content, found.startLine, found.endLine, adjusted.join('\n'));
      await writeAtomic(target, result.content, 'symbol');
      return { path: target, symbol: args.symbol, kind: found.kind, replacedLines: [found.startLine, found.endLine], insertedLines: result.insertedLines, sha256: sha256(result.content) };
    },
  });

  registry.register({
    name: 'fs_replace_lines',
    title: 'Replace a range of lines',
    description: 'Replace lines startLine..endLine (1-based, inclusive, as shown by fs_read) with new text. Pass expect (the first old line) to refuse the edit if the file has moved. Use an empty newText to delete lines, or endLine = startLine - 1 style ranges via fs_patch to insert.',
    category: 'filesystem', risk: 'write', alwaysAvailable: true,
    keywords: ['line range', 'replace lines', 'edit by line number', 'delete lines'],
    inputSchema: {
      type: 'object', required: ['path', 'startLine', 'endLine', 'newText'],
      properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, newText: { type: 'string' }, expect: { type: 'string', description: 'Trimmed text the first replaced line must currently have' } },
    },
    execute: async (args, context) => {
      const target = resolveTarget(args.path, context);
      const content = await fsp.readFile(target, 'utf8');
      const result = replaceLines(content, args.startLine, args.endLine, args.newText, { expect: args.expect ?? null });
      await writeAtomic(target, result.content, 'lines');
      return { path: path.resolve(target), replacedLines: result.replacedLines, insertedLines: result.insertedLines, sha256: sha256(result.content) };
    },
  });
}
