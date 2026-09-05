import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { id, truncate } from '../core/utils.mjs';

function languageId(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact',
    '.ts': 'typescript', '.tsx': 'typescriptreact', '.py': 'python', '.rs': 'rust', '.go': 'go',
    '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
    '.java': 'java', '.kt': 'kotlin', '.swift': 'swift', '.rb': 'ruby', '.php': 'php',
    '.cs': 'csharp', '.lua': 'lua', '.json': 'json', '.html': 'html', '.css': 'css',
    '.scss': 'scss', '.vue': 'vue', '.svelte': 'svelte', '.yaml': 'yaml', '.yml': 'yaml',
  })[ext] || 'plaintext';
}

function offsetAt(text, position) {
  const lines = text.split('\n');
  let offset = 0;
  for (let index = 0; index < Math.min(position.line, lines.length); index += 1) offset += lines[index].length + 1;
  return offset + Math.min(position.character, lines[position.line]?.length || 0);
}

export class LanguageServerClient {
  constructor({ command, args = [], cwd, root, logger, eventBus, workspaceId, serverId }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.root = root;
    this.logger = logger;
    this.eventBus = eventBus;
    this.workspaceId = workspaceId;
    this.serverId = serverId;
    this.process = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.sequence = 0;
    this.openDocuments = new Map();
    this.diagnostics = new Map();
    this.capabilities = {};
    this.serverInfo = null;
    this.started = false;
  }

  async start() {
    if (this.started) return this.status();
    this.process = spawn(this.command, this.args, {
      cwd: this.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    this.process.stdout.on('data', (chunk) => this.#data(chunk));
    this.process.stderr.on('data', (chunk) => this.eventBus?.emit('lsp.stderr', { server: this.serverId, text: truncate(chunk.toString(), 8000) }, { workspaceId: this.workspaceId }));
    this.process.once('error', (error) => this.#failAll(error));
    this.process.once('close', (code, signal) => {
      this.started = false;
      this.#failAll(new Error(`Language server ${this.serverId} exited (${code ?? signal})`));
      this.eventBus?.emit('lsp.exited', { server: this.serverId, code, signal }, { workspaceId: this.workspaceId });
    });
    const initialized = await this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'MaskShift', version: '1.0.0' },
      locale: 'en',
      rootPath: this.root,
      rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }],
      capabilities: {
        workspace: { applyEdit: true, workspaceFolders: true, configuration: true },
        textDocument: {
          synchronization: { dynamicRegistration: true, willSave: false, didSave: true },
          completion: { completionItem: { snippetSupport: false, documentationFormat: ['markdown', 'plaintext'] } },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true }, references: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          rename: { prepareSupport: true }, formatting: {}, publishDiagnostics: { relatedInformation: true },
        },
      },
      initializationOptions: {},
      trace: 'off',
    }, { timeoutMs: 30_000 });
    this.capabilities = initialized?.capabilities || {};
    this.serverInfo = initialized?.serverInfo || null;
    this.started = true;
    this.notify('initialized', {});
    // Servers that gate analysis on initial configuration (pyright among them) stay idle
    // until this arrives, so every later request would time out. Editors always send it.
    this.notify('workspace/didChangeConfiguration', { settings: {} });
    this.eventBus?.emit('lsp.started', { server: this.serverId, serverInfo: this.serverInfo, capabilities: Object.keys(this.capabilities) }, { workspaceId: this.workspaceId });
    return this.status();
  }

  status() {
    return { serverId: this.serverId, command: this.command, args: this.args, pid: this.process?.pid || null, started: this.started, serverInfo: this.serverInfo, capabilities: Object.keys(this.capabilities || {}), openDocuments: this.openDocuments.size };
  }

  send(message) {
    if (!this.process?.stdin?.writable) throw new Error(`Language server ${this.serverId} is not writable`);
    const json = JSON.stringify({ jsonrpc: '2.0', ...message });
    this.process.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }

  request(method, params = {}, { timeoutMs = 20_000 } = {}) {
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`LSP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer, method });
      this.send({ id: requestId, method, params });
    });
  }

  notify(method, params = {}) { this.send({ method, params }); }

  async open(file) {
    const full = path.resolve(file);
    const uri = pathToFileURL(full).href;
    const text = await fsp.readFile(full, 'utf8');
    const current = this.openDocuments.get(uri);
    if (!current) {
      this.openDocuments.set(uri, { file: full, text, version: 1, languageId: languageId(full) });
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: languageId(full), version: 1, text } });
    } else if (current.text !== text) {
      current.text = text; current.version += 1;
      this.notify('textDocument/didChange', { textDocument: { uri, version: current.version }, contentChanges: [{ text }] });
    }
    return { uri, text, languageId: languageId(full) };
  }

  async documentRequest(method, file, extra = {}, options) {
    const document = await this.open(file);
    return this.request(method, { textDocument: { uri: document.uri }, ...extra }, options);
  }

  async applyTextEdits(file, edits) {
    const full = path.resolve(file);
    let text = await fsp.readFile(full, 'utf8');
    const sorted = [...(edits || [])].sort((a, b) => offsetAt(text, b.range.start) - offsetAt(text, a.range.start));
    for (const edit of sorted) {
      const start = offsetAt(text, edit.range.start);
      const end = offsetAt(text, edit.range.end);
      text = text.slice(0, start) + (edit.newText || '') + text.slice(end);
    }
    await fsp.writeFile(full, text, 'utf8');
    await this.open(full);
    this.notify('textDocument/didSave', { textDocument: { uri: pathToFileURL(full).href }, text });
    return { path: full, edits: sorted.length, bytes: Buffer.byteLength(text) };
  }

  async applyWorkspaceEdit(edit) {
    const applied = [];
    const changes = edit?.changes || {};
    for (const [uri, edits] of Object.entries(changes)) {
      const file = new URL(uri);
      if (file.protocol !== 'file:') continue;
      applied.push(await this.applyTextEdits(fileURLToPath(file), edits));
    }
    for (const change of edit?.documentChanges || []) {
      if (!change.textDocument?.uri || !change.edits) continue;
      const file = new URL(change.textDocument.uri);
      if (file.protocol === 'file:') applied.push(await this.applyTextEdits(fileURLToPath(file), change.edits));
    }
    return applied;
  }

  #data(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const headers = this.buffer.subarray(0, headerEnd).toString('ascii');
      const length = Number(headers.match(/Content-Length:\s*(\d+)/i)?.[1]);
      if (!Number.isFinite(length)) { this.buffer = this.buffer.subarray(headerEnd + 4); continue; }
      const end = headerEnd + 4 + length;
      if (this.buffer.length < end) return;
      const body = this.buffer.subarray(headerEnd + 4, end).toString('utf8');
      this.buffer = this.buffer.subarray(end);
      try { this.#message(JSON.parse(body)); } catch (error) { this.logger?.warn('Invalid LSP message', { server: this.serverId, error: error.message }); }
    }
  }

  async #message(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || `LSP error ${message.error.code}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      this.diagnostics.set(message.params.uri, message.params.diagnostics || []);
      this.eventBus?.emit('lsp.diagnostics', { server: this.serverId, uri: message.params.uri, diagnostics: message.params.diagnostics || [] }, { workspaceId: this.workspaceId });
      return;
    }
    if (message.id !== undefined && message.method) {
      try {
        let result = null;
        if (message.method === 'workspace/configuration') result = (message.params?.items || []).map(() => null);
        else if (message.method === 'workspace/workspaceFolders') result = [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }];
        else if (message.method === 'workspace/applyEdit') result = { applied: true, details: await this.applyWorkspaceEdit(message.params?.edit) };
        else if (message.method === 'window/workDoneProgress/create' || message.method === 'client/registerCapability' || message.method === 'client/unregisterCapability') result = null;
        else throw Object.assign(new Error(`Unsupported client request ${message.method}`), { code: -32601 });
        this.send({ id: message.id, result });
      } catch (error) {
        this.send({ id: message.id, error: { code: error.code || -32603, message: error.message } });
      }
    }
  }

  #failAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  async close() {
    if (!this.process) return;
    try { if (this.started) await this.request('shutdown', {}, { timeoutMs: 3000 }); } catch { /* best effort */ }
    try { this.notify('exit', {}); } catch { /* closed */ }
    try {
      if (process.platform !== 'win32') process.kill(-this.process.pid, 'SIGTERM');
      else this.process.kill('SIGTERM');
    } catch { this.process.kill('SIGTERM'); }
    this.started = false;
  }
}

export { languageId };
