function requireWorkspace(context) {
  if (!context.workspaceId) throw new Error('LSP operation requires a workspace');
  return context.workspaceId;
}

const positionSchema = { file: { type: 'string' }, line: { type: 'integer', minimum: 1 }, character: { type: 'integer', minimum: 1, default: 1 }, server: { type: 'string' } };

export function registerLspTools(registry, { lspManager }) {
  registry.register({
    name: 'lsp_discover', title: 'Discover language servers',
    description: 'Detect installed language servers for TypeScript, Python, C/C++, Rust, Go, Java, Ruby, Lua, JSON, HTML, CSS, and YAML.',
    category: 'code-intelligence', readOnly: true,
    keywords: ['lsp', 'language server', 'code intelligence', 'diagnostics'],
    inputSchema: { type: 'object', properties: { force: { type: 'boolean', default: false } } },
    execute: async (args) => lspManager.discover(Boolean(args.force)),
  });

  registry.register({
    name: 'lsp_status', title: 'Language server status',
    description: 'List active workspace language server processes and capabilities.',
    category: 'code-intelligence', readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args, context) => lspManager.list(context.workspaceId),
  });

  registry.register({
    name: 'lsp_hover', title: 'LSP hover',
    description: 'Get type, signature, and documentation information at a 1-based source position.',
    category: 'code-intelligence', readOnly: true,
    keywords: ['type info', 'signature', 'documentation'],
    inputSchema: { type: 'object', required: ['file', 'line'], properties: positionSchema },
    execute: async (args, context) => lspManager.hover(requireWorkspace(context), args.file, args.line, args.character || 1, args.server),
  });

  registry.register({
    name: 'lsp_definition', title: 'Go to definition',
    description: 'Resolve the definition location for a symbol at a source position.',
    category: 'code-intelligence', readOnly: true,
    inputSchema: { type: 'object', required: ['file', 'line'], properties: positionSchema },
    execute: async (args, context) => lspManager.definition(requireWorkspace(context), args.file, args.line, args.character || 1, args.server),
  });

  registry.register({
    name: 'lsp_references', title: 'Find semantic references',
    description: 'Find language-aware references for a symbol at a source position.',
    category: 'code-intelligence', readOnly: true,
    inputSchema: { type: 'object', required: ['file', 'line'], properties: { ...positionSchema, includeDeclaration: { type: 'boolean', default: true } } },
    execute: async (args, context) => lspManager.references(requireWorkspace(context), args.file, args.line, args.character || 1, args.includeDeclaration !== false, args.server),
  });

  registry.register({
    name: 'lsp_symbols', title: 'Document symbols',
    description: 'Return language-server document symbols and hierarchy for a source file.',
    category: 'code-intelligence', readOnly: true,
    inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, server: { type: 'string' } } },
    execute: async (args, context) => lspManager.symbols(requireWorkspace(context), args.file, args.server),
  });

  registry.register({
    name: 'lsp_diagnostics', title: 'Language diagnostics',
    description: 'Return language-server errors, warnings, hints, and related information for a file.',
    category: 'code-intelligence', readOnly: true,
    inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, waitMs: { type: 'integer', minimum: 0, maximum: 10000, default: 500 }, server: { type: 'string' } } },
    execute: async (args, context) => lspManager.diagnostics(requireWorkspace(context), args.file, args.waitMs || 500, args.server),
  });

  registry.register({
    name: 'lsp_rename', title: 'Semantic rename',
    description: 'Compute and optionally apply a workspace-wide language-aware symbol rename.',
    category: 'code-intelligence', risk: 'write',
    inputSchema: { type: 'object', required: ['file', 'line', 'newName'], properties: { ...positionSchema, newName: { type: 'string' }, apply: { type: 'boolean', default: true } } },
    execute: async (args, context) => lspManager.rename(requireWorkspace(context), args.file, args.line, args.character || 1, args.newName, args.apply !== false, args.server),
  });

  registry.register({
    name: 'lsp_code_actions', title: 'Language-server refactors and quick fixes',
    description: 'List the refactors and quick fixes the language server offers at a position or range (fix this error, extract a function, add a missing import…) and optionally apply one by index, by title, or the preferred one. Prefer this over hand-editing for mechanical refactors.',
    category: 'code-intelligence', risk: 'write',
    keywords: ['refactor', 'quick fix', 'extract function', 'add import', 'code action', 'organize imports'],
    inputSchema: {
      type: 'object', required: ['file', 'line'], properties: {
        ...positionSchema, endLine: { type: 'integer', minimum: 1 }, endCharacter: { type: 'integer', minimum: 1 },
        kinds: { type: 'array', items: { type: 'string' }, description: 'Only these kinds, e.g. ["quickfix"], ["refactor.extract"], ["source.organizeImports"].' },
        apply: { type: 'boolean', default: false }, index: { type: 'integer', minimum: 0 }, title: { type: 'string' },
      },
    },
    execute: async (args, context) => lspManager.codeActions(requireWorkspace(context), args.file, { line: args.line, character: args.character || 1, endLine: args.endLine, endCharacter: args.endCharacter, kinds: args.kinds || [], apply: Boolean(args.apply), index: args.index, title: args.title }, args.server),
  });

  registry.register({
    name: 'lsp_organize_imports', title: 'Organize imports',
    description: 'Sort and prune a file\'s imports with the language server.',
    category: 'code-intelligence', risk: 'write',
    inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, server: { type: 'string' } } },
    execute: async (args, context) => lspManager.organizeImports(requireWorkspace(context), args.file, args.server),
  });

  registry.register({
    name: 'lsp_format', title: 'Language-aware format',
    description: 'Ask the language server to format a document and optionally apply the edits.',
    category: 'code-intelligence', risk: 'write',
    inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, apply: { type: 'boolean', default: true }, tabSize: { type: 'integer', minimum: 1, maximum: 16, default: 2 }, insertSpaces: { type: 'boolean', default: true }, server: { type: 'string' } } },
    execute: async (args, context) => lspManager.format(requireWorkspace(context), args.file, args.apply !== false, args, args.server),
  });

  registry.register({
    name: 'lsp_stop', title: 'Stop language servers',
    description: 'Stop one or all lazy language server processes for the workspace.',
    category: 'code-intelligence', risk: 'process',
    inputSchema: { type: 'object', properties: { server: { type: 'string' }, allWorkspaces: { type: 'boolean', default: false } } },
    execute: async (args, context) => { await lspManager.close(args.allWorkspaces ? null : context.workspaceId, args.server || null); return { stopped: true }; },
  });
}
