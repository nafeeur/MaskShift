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

  /**
   * Refactors and quick fixes the language server offers for a range: organize imports, fix this error, extract a function.
   * Lists them, and applies one when asked (by index, by title, or the server's preferred one). Where a rename needs the
   * symbol's name, this needs only the place.
   */
  async codeActions(workspaceId, file, { line, character = 1, endLine = null, endCharacter = null, kinds = [], apply = false, index = null, title = null } = {}, serverId) {
    const { client, file: full } = await this.ensure(workspaceId, file, serverId);
    if (!client.capabilities?.codeActionProvider) throw new Error(`Language server ${client.serverId} does not offer code actions`);
    const range = {
      start: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
      end: { line: Math.max(0, (endLine || line) - 1), character: endCharacter ? Math.max(0, endCharacter - 1) : 10_000 },
    };
    const uri = pathToFileURL(full).href;
    const diagnostics = (client.diagnostics.get(uri) || []).filter((item) => item.range && item.range.start.line <= range.end.line && item.range.end.line >= range.start.line);
    const raw = (await client.documentRequest('textDocument/codeAction', full, { range, context: { diagnostics, ...(kinds.length ? { only: kinds } : {}) } })) || [];
    const actions = raw.map((action, position) => ({
      index: position, title: action.title, kind: action.kind || null, preferred: Boolean(action.isPreferred),
      disabled: action.disabled?.reason || null, hasEdit: Boolean(action.edit), command: action.command?.command || action.command || null,
    }));
    if (!apply) return { actions };
    const pick = index !== null && index !== undefined ? raw[index] : title ? raw.find((action) => action.title === title) : (raw.find((action) => action.isPreferred) || raw.find((action) => !action.disabled));
    if (!pick) throw new Error(actions.length ? 'No code action matched; list them first and choose by index or title' : 'The language server offers no code actions here');
    if (pick.disabled) throw new Error(`That code action is not available: ${pick.disabled.reason}`);
    let action = pick;
    if (!action.edit && !action.command?.command && client.capabilities.codeActionProvider?.resolveProvider) action = await client.request('codeAction/resolve', action);
    const applied = [];
    if (action.edit) applied.push(...await client.applyWorkspaceEdit(action.edit));
    // A server that does the work itself (and asks the client to apply the result) is run through its own command.
    else if (action.command?.command) await client.request('workspace/executeCommand', { command: action.command.command, arguments: action.command.arguments || [] });
    return { actions, chosen: { title: action.title, kind: action.kind || null }, applied };
  }

  async organizeImports(workspaceId, file, serverId) {
    const result = await this.codeActions(workspaceId, file, { line: 1, kinds: ['source.organizeImports'], apply: true }, serverId);
    return result;
  }

  async close(workspaceId = null, serverId = null) {
    for (const [key, client] of [...this.clients]) {
      if (workspaceId && !key.startsWith(`${workspaceId}:`)) continue;
      if (serverId && !key.endsWith(`:${serverId}`)) continue;
      await client.close(); this.clients.delete(key);
    }
  }
}
