import fsp from 'node:fs/promises';
import path from 'node:path';
import { runCommand, shellQuote, truncate } from '../core/utils.mjs';

function rootFor(args, context) {
  const base = context.workspacePath || process.cwd();
  return path.resolve(base, args.path || args.cwd || '.');
}

function parseRipgrep(text, maxResults) {
  return String(text || '').split('\n').filter(Boolean).slice(0, maxResults).map((line) => {
    const match = line.match(/^(.*?):(\d+):(\d+):(.*)$/s) || line.match(/^(.*?):(\d+):(.*)$/s);
    if (!match) return { raw: line };
    return match.length === 5
      ? { path: match[1], line: Number(match[2]), column: Number(match[3]), text: match[4] }
      : { path: match[1], line: Number(match[2]), text: match[3] };
  });
}

function importCandidates(content, language) {
  const results = [];
  const patterns = language === 'python'
    ? [/^\s*from\s+([\w.]+)\s+import\s+/gm, /^\s*import\s+([\w.]+)/gm]
    : language === 'go'
      ? [/^\s*import\s+(?:\w+\s+)?["`]([^"`]+)["`]/gm]
      : language === 'rust'
        ? [/^\s*use\s+([\w:]+)/gm, /^\s*mod\s+(\w+)/gm]
        : [/\bfrom\s+["']([^"']+)["']/g, /\brequire\(\s*["']([^"']+)["']\s*\)/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) results.push(match[1]);
  }
  return [...new Set(results)];
}

export function registerSearchTools(registry, { indexer, workspaceManager, config }) {
  registry.register({
    name: 'search_text',
    title: 'Search repository text',
    description: 'Fast recursive source search using ripgrep when available, with regex, glob, case, hidden-file, and context controls.',
    category: 'search', readOnly: true, alwaysAvailable: true,
    keywords: ['ripgrep', 'grep', 'find references', 'search code', 'symbol'],
    inputSchema: {
      type: 'object', required: ['query'],
      properties: {
        query: { type: 'string' }, path: { type: 'string', default: '.' },
        regex: { type: 'boolean', default: false }, caseSensitive: { type: 'boolean', default: false },
        hidden: { type: 'boolean', default: true }, glob: { type: 'string' },
        contextLines: { type: 'integer', minimum: 0, maximum: 20, default: 0 },
        maxResults: { type: 'integer', minimum: 1, maximum: 5000, default: 300 },
      },
    },
    execute: async (args, context) => {
      const root = rootFor(args, context);
      const flags = ['--line-number', '--column', '--no-heading', '--color', 'never', '--with-filename'];
      if (!args.regex) flags.push('--fixed-strings');
      if (!args.caseSensitive) flags.push('--ignore-case');
      if (args.hidden !== false) flags.push('--hidden', '-g', '!.git/**');
      if (args.glob) flags.push('-g', args.glob);
      if (args.contextLines) flags.push('-C', String(args.contextLines));
      const maxResults = args.maxResults || 300;
      const command = `rg ${flags.map(shellQuote).join(' ')} -- ${shellQuote(args.query)} ${shellQuote(root)}`;
      const result = await runCommand(command, {
        cwd: context.workspacePath || process.cwd(), timeoutMs: 60_000,
        maxOutputChars: Math.min(config.get().maxToolOutputChars * 4, 1_000_000), signal: context.signal,
      });
      if (![0, 1].includes(result.code)) throw new Error(result.stderr || `ripgrep exited ${result.code}`);
      return { query: args.query, root, matches: parseRipgrep(result.stdout, maxResults), truncated: result.stdout.split('\n').length > maxResults };
    },
  });

  registry.register({
    name: 'search_files',
    title: 'Find files',
    description: 'Find files by fuzzy substring or glob across a workspace while respecting common repository ignores.',
    category: 'search', readOnly: true, alwaysAvailable: true,
    keywords: ['filename', 'glob', 'find path', 'locate file'],
    inputSchema: {
      type: 'object', properties: {
        query: { type: 'string', default: '' }, path: { type: 'string', default: '.' }, glob: { type: 'string' },
        hidden: { type: 'boolean', default: true }, maxResults: { type: 'integer', minimum: 1, maximum: 10000, default: 1000 },
      },
    },
    execute: async (args, context) => {
      const root = rootFor(args, context);
      const flags = ['--files'];
      if (args.hidden !== false) flags.push('--hidden', '-g', '!.git/**');
      if (args.glob) flags.push('-g', args.glob);
      const result = await runCommand(`rg ${flags.map(shellQuote).join(' ')} ${shellQuote(root)}`, {
        cwd: context.workspacePath || process.cwd(), timeoutMs: 60_000, maxOutputChars: 2_000_000, signal: context.signal,
      });
      if (![0, 1].includes(result.code)) throw new Error(result.stderr || `rg --files exited ${result.code}`);
      const query = String(args.query || '').toLowerCase();
      let files = result.stdout.split('\n').filter(Boolean);
      if (query) files = files.filter((file) => file.toLowerCase().includes(query));
      const limit = args.maxResults || 1000;
      return { root, files: files.slice(0, limit), total: files.length, truncated: files.length > limit };
    },
  });

  registry.register({
    name: 'repo_index',
    title: 'Index repository',
    description: 'Build or refresh MaskShift’s local SQLite FTS code index for structure-aware context retrieval.',
    category: 'search', risk: 'local-index',
    keywords: ['index', 'rag', 'codebase context', 'fts'],
    inputSchema: { type: 'object', properties: { force: { type: 'boolean', default: true } } },
    execute: async (args, context) => {
      if (!context.workspaceId) throw new Error('Repository indexing requires a workspace');
      return indexer.index(context.workspaceId, { force: args.force !== false });
    },
  });

  registry.register({
    name: 'repo_search',
    title: 'Search indexed code context',
    description: 'Search the local repository index using full-text ranking, blended with embedding-based semantic similarity when a local Ollama embedding model is available, and return bounded source chunks.',
    category: 'search', readOnly: true, alwaysAvailable: true,
    keywords: ['rag', 'context', 'indexed search', 'architecture', 'similar code', 'semantic', 'embeddings'],
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } },
    execute: async (args, context) => {
      if (!context.workspaceId) throw new Error('Repository search requires a workspace');
      let stats = indexer.stats(context.workspaceId);
      if (!stats?.chunks && config.get().autoIndex) {
        await indexer.index(context.workspaceId);
        stats = indexer.stats(context.workspaceId);
      }
      return { stats, hits: await indexer.search(context.workspaceId, args.query, args.limit || 20) };
    },
  });

  registry.register({
    name: 'symbol_outline',
    title: 'Extract file symbols',
    description: 'Extract a lightweight outline of classes, functions, interfaces, structs, methods, and test blocks from source files.',
    category: 'search', readOnly: true,
    keywords: ['symbols', 'outline', 'ast', 'classes', 'functions'],
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, maxSymbols: { type: 'integer', minimum: 1, maximum: 5000, default: 500 } } },
    execute: async (args, context) => {
      const file = path.resolve(context.workspacePath || process.cwd(), args.path);
      const content = await fsp.readFile(file, 'utf8');
      const lines = content.split('\n');
      const patterns = [
        /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|trait|def|fn|func)\s+([A-Za-z_$][\w$]*)/,
        /^\s*(?:public|private|protected|static|async|virtual|inline|constexpr|const|override|final|pub|export|abstract|readonly|\s)+\s*[\w:<>,\[\]*&?]+\s+([A-Za-z_$][\w$]*)\s*\(/,
        /^\s*(?:describe|it|test)\s*\(\s*['"`]([^'"`]+)/,
      ];
      const symbols = [];
      for (let index = 0; index < lines.length && symbols.length < (args.maxSymbols || 500); index += 1) {
        for (const pattern of patterns) {
          const match = lines[index].match(pattern);
          if (match) { symbols.push({ name: match[1], line: index + 1, signature: lines[index].trim() }); break; }
        }
      }
      return { path: file, totalLines: lines.length, symbols };
    },
  });

  registry.register({
    name: 'dependency_scan',
    title: 'Scan source dependencies',
    description: 'Inspect imports across selected source files and return a compact file-to-dependency graph without installing parsers.',
    category: 'search', readOnly: true,
    keywords: ['imports', 'dependency graph', 'modules', 'architecture'],
    inputSchema: { type: 'object', properties: { path: { type: 'string', default: '.' }, maxFiles: { type: 'integer', minimum: 1, maximum: 10000, default: 1500 } } },
    execute: async (args, context) => {
      if (!context.workspaceId) throw new Error('Dependency scan requires a workspace');
      const listing = await workspaceManager.listFiles(context.workspaceId, { target: args.path || '.', depth: 100, maxEntries: (args.maxFiles || 1500) * 2 });
      const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs']);
      const graph = [];
      for (const item of listing.entries.filter((entry) => entry.type === 'file' && sourceExtensions.has(path.extname(entry.path))).slice(0, args.maxFiles || 1500)) {
        const content = await fsp.readFile(path.join(context.workspacePath, item.path), 'utf8').catch(() => '');
        const language = path.extname(item.path) === '.py' ? 'python' : path.extname(item.path) === '.go' ? 'go' : path.extname(item.path) === '.rs' ? 'rust' : 'javascript';
        const imports = importCandidates(content, language);
        if (imports.length) graph.push({ path: item.path, imports });
      }
      return { files: graph.length, graph };
    },
  });
}
