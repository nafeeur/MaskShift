import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandExists } from '../core/utils.mjs';
import { LanguageServerClient, languageId } from './client.mjs';

const SERVERS = [
  { id: 'typescript', languages: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'], candidates: [{ command: 'typescript-language-server', args: ['--stdio'] }, { command: 'vtsls', args: ['--stdio'] }] },
  { id: 'python', languages: ['python'], candidates: [{ command: 'pyright-langserver', args: ['--stdio'] }, { command: 'basedpyright-langserver', args: ['--stdio'] }, { command: 'pylsp', args: [] }] },
  { id: 'clangd', languages: ['c', 'cpp'], candidates: [{ command: 'clangd', args: ['--background-index', '--clang-tidy'] }] },
  { id: 'rust-analyzer', languages: ['rust'], candidates: [{ command: 'rust-analyzer', args: [] }] },
  { id: 'gopls', languages: ['go'], candidates: [{ command: 'gopls', args: ['serve'] }] },
  { id: 'lua', languages: ['lua'], candidates: [{ command: 'lua-language-server', args: [] }] },
  { id: 'ruby', languages: ['ruby'], candidates: [{ command: 'ruby-lsp', args: [] }, { command: 'solargraph', args: ['stdio'] }] },
  { id: 'java', languages: ['java'], candidates: [{ command: 'jdtls', args: [] }] },
  { id: 'json', languages: ['json'], candidates: [{ command: 'vscode-json-language-server', args: ['--stdio'] }] },
  { id: 'html', languages: ['html'], candidates: [{ command: 'vscode-html-language-server', args: ['--stdio'] }] },
  { id: 'css', languages: ['css', 'scss'], candidates: [{ command: 'vscode-css-language-server', args: ['--stdio'] }] },
  { id: 'yaml', languages: ['yaml'], candidates: [{ command: 'yaml-language-server', args: ['--stdio'] }] },
];

export class LspManager {
  constructor({ workspaceManager, logger, eventBus }) {
    this.workspaceManager = workspaceManager;
    this.logger = logger;
    this.eventBus = eventBus;
    this.clients = new Map();
    this.availability = null;
  }

  key(workspaceId, serverId) { return `${workspaceId}:${serverId}`; }

  async discover(force = false) {
    if (this.availability && !force) return this.availability;
    const values = [];
    for (const server of SERVERS) {
      let selected = null;
      for (const candidate of server.candidates) {
        const executable = await commandExists(candidate.command);
        if (executable) { selected = { ...candidate, executable }; break; }
      }
      values.push({ id: server.id, languages: server.languages, available: Boolean(selected), selected, candidates: server.candidates.map((item) => item.command) });
    }
    this.availability = values;
    return values;
  }

  async definitionFor(file, serverId = null) {
    const language = languageId(file);
    const discovered = await this.discover();
    const server = discovered.find((item) => serverId ? item.id === serverId : item.languages.includes(language));
    if (!server) throw new Error(`No language server mapping for ${language}`);
    if (!server.available) throw new Error(`Language server '${server.id}' is not installed. Tried: ${server.candidates.join(', ')}`);
    return { ...server, language };
  }

  async ensure(workspaceId, file, serverId = null) {
    const workspace = this.workspaceManager.get(workspaceId);
    const full = path.isAbsolute(file) ? file : path.resolve(workspace.path, file);
    const definition = await this.definitionFor(full, serverId);
    const key = this.key(workspaceId, definition.id);
    let client = this.clients.get(key);
    if (!client?.started) {
      if (client) await client.close().catch(() => {});
      client = new LanguageServerClient({
        command: definition.selected.executable || definition.selected.command,
        args: definition.selected.args, cwd: workspace.path, root: workspace.meta?.gitRoot || workspace.path,
        logger: this.logger, eventBus: this.eventBus, workspaceId, serverId: definition.id,
      });
      this.clients.set(key, client);
      await client.start();
    }
    await client.open(full);
    return { client, file: full, definition };
  }

  list(workspaceId = null) {
    return [...this.clients.entries()].filter(([key]) => !workspaceId || key.startsWith(`${workspaceId}:`)).map(([, client]) => client.status());
  }

  async hover(workspaceId, file, line, character, serverId) {
    const { client, file: full } = await this.ensure(workspaceId, file, serverId);
    return client.documentRequest('textDocument/hover', full, { position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) } });
  }

  async definition(workspaceId, file, line, character, serverId) {
    const { client, file: full } = await this.ensure(workspaceId, file, serverId);
    return client.documentRequest('textDocument/definition', full, { position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) } });
  }

  async references(workspaceId, file, line, character, includeDeclaration = true, serverId) {
    const { client, file: full } = await this.ensure(workspaceId, file, serverId);
    return client.documentRequest('textDocument/references', full, { position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) }, context: { includeDeclaration } });
  }

  async symbols(workspaceId, file, serverId) {
    const { client, file: full } = await this.ensure(workspaceId, file, serverId);
    return client.documentRequest('textDocument/documentSymbol', full);
  }

  async diagnostics(workspaceId, file, waitMs = 500, serverId) {
    const { client, file: full } = await this.ensure(workspaceId, file, serverId);
    const uri = pathToFileURL(full).href;
    if (client.capabilities.diagnosticProvider) {
      try { return await client.documentRequest('textDocument/diagnostic', full, { identifier: null, previousResultId: null }); } catch { /* push diagnostics fallback */ }
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return client.diagnostics.get(uri) || [];
  }

  async rename(workspaceId, file, line, character, newName, apply = true, serverId) {
    const { client, file: full } = await this.ensure(workspaceId, file, serverId);
    const edit = await client.documentRequest('textDocument/rename', full, { position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) }, newName });
    return { edit, applied: apply ? await client.applyWorkspaceEdit(edit) : [] };
  }

  async format(workspaceId, file, apply = true, options = {}, serverId) {
    const { client, file: full } = await this.ensure(workspaceId, file, serverId);
    if (!client.capabilities?.documentFormattingProvider) {
      throw new Error(`Language server ${client.serverId} does not provide document formatting; format ${path.basename(full)} with a dedicated formatter instead`);
    }
    const edits = await client.documentRequest('textDocument/formatting', full, { options: { tabSize: options.tabSize || 2, insertSpaces: options.insertSpaces !== false, trimTrailingWhitespace: true, insertFinalNewline: true } });
    return { edits, applied: apply ? await client.applyTextEdits(full, edits || []) : null };
  }

  async close(workspaceId = null, serverId = null) {
    for (const [key, client] of [...this.clients]) {
      if (workspaceId && !key.startsWith(`${workspaceId}:`)) continue;
      if (serverId && !key.endsWith(`:${serverId}`)) continue;
      await client.close(); this.clients.delete(key);
    }
  }
}
