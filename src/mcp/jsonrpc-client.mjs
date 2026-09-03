import { spawn } from 'node:child_process';
import path from 'node:path';
import { id, safeJsonParse, truncate, VERSION } from '../core/utils.mjs';

const MODERN_PROTOCOL = '2026-07-28';
const LEGACY_PROTOCOL = '2025-11-25';

function expandEnv(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, b) => process.env[a || b] || '');
}

function clientInfo() {
  return { name: 'MaskShift', title: 'MaskShift Coding Harness', version: VERSION };
}

function modernMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL,
    'io.modelcontextprotocol/clientCapabilities': {
      roots: {},
      elicitation: {},
      experimental: {},
    },
    'io.modelcontextprotocol/clientInfo': clientInfo(),
    'io.modelcontextprotocol/logLevel': 'info',
  };
}

function normalizeMcpError(error, context = '') {
  if (error instanceof Error) return error;
  const message = error?.message || JSON.stringify(error);
  const wrapped = new Error(context ? `${context}: ${message}` : message);
  if (error?.code !== undefined) wrapped.code = error.code;
  if (error?.data !== undefined) wrapped.data = error.data;
  return wrapped;
}

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs) : null;
  timer?.unref();
  const abort = () => controller.abort(signal.reason || new Error('Aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

async function parseSseResponse(response) {
  const text = await response.text();
  let selected = null;
  let eventName = 'message';
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    const parsed = safeJsonParse(data, null);
    if (parsed && (eventName === 'message' || parsed.jsonrpc)) selected = parsed;
    dataLines = [];
    eventName = 'message';
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line) { flush(); continue; }
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  flush();
  return selected;
}

export class BaseMcpClient {
  constructor(definition, { logger, eventBus, workspaceRoot, requestHandler } = {}) {
    this.definition = definition;
    this.logger = logger;
    this.eventBus = eventBus;
    this.workspaceRoot = workspaceRoot || process.cwd();
    this.requestHandler = requestHandler;
    this.era = null;
    this.protocolVersion = null;
    this.serverInfo = null;
    this.capabilities = {};
    this.instructions = '';
    this.connected = false;
  }

  paramsFor(method, params = {}) {
    if (this.era !== 'modern') return params;
    return { ...params, _meta: { ...(params?._meta || {}), ...modernMeta() } };
  }

  async initialize() {
    try {
      const discovered = await this.request('server/discover', {}, { forceModern: true, timeoutMs: 8_000 });
      this.era = 'modern';
      this.protocolVersion = MODERN_PROTOCOL;
      this.serverInfo = discovered?.serverInfo || discovered?.server || null;
      this.capabilities = discovered?.capabilities || {};
      this.instructions = discovered?.instructions || '';
      this.connected = true;
      return this.summary();
    } catch (modernError) {
      this.logger?.debug('MCP modern probe failed; trying legacy initialization', {
        server: this.definition.name,
        error: modernError.message,
      });
    }

    const initialized = await this.request('initialize', {
      protocolVersion: LEGACY_PROTOCOL,
      capabilities: {
        roots: { listChanged: false },
        sampling: {},
        elicitation: {},
      },
      clientInfo: clientInfo(),
    }, { forceLegacy: true, timeoutMs: 20_000 });
    this.era = 'legacy';
    this.protocolVersion = initialized?.protocolVersion || LEGACY_PROTOCOL;
    this.serverInfo = initialized?.serverInfo || null;
    this.capabilities = initialized?.capabilities || {};
    this.instructions = initialized?.instructions || '';
    await this.notify('notifications/initialized', {}, { forceLegacy: true });
    this.connected = true;
    return this.summary();
  }

  summary() {
    return {
      connected: this.connected,
      era: this.era,
      protocolVersion: this.protocolVersion,
      serverInfo: this.serverInfo,
      capabilities: this.capabilities,
      instructions: this.instructions,
    };
  }

  async listAll(method, key, params = {}, maxPages = 100) {
    const all = [];
    let cursor;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.request(method, { ...params, ...(cursor ? { cursor } : {}) });
      all.push(...(result?.[key] || []));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return all;
  }

  async listTools() { return this.listAll('tools/list', 'tools'); }
  async callTool(name, args = {}, options = {}) {
    return this.request('tools/call', { name, arguments: args }, options);
  }
  async listResources() { return this.listAll('resources/list', 'resources'); }
  async readResource(uri) { return this.request('resources/read', { uri }); }
  async listPrompts() { return this.listAll('prompts/list', 'prompts'); }
  async getPrompt(name, args = {}) { return this.request('prompts/get', { name, arguments: args }); }

  async handleServerRequest(message) {
    const { method, params = {} } = message;
    if (method === 'ping') return {};
    if (method === 'roots/list') {
      return { roots: [{ uri: `file://${this.workspaceRoot}`, name: path.basename(this.workspaceRoot) || this.workspaceRoot }] };
    }
    if (this.requestHandler) return this.requestHandler(message, this);
    const error = new Error(`MaskShift does not expose client method ${method} to this MCP server`);
    error.code = -32601;
    throw error;
  }
}

export class StdioMcpClient extends BaseMcpClient {
  constructor(definition, options = {}) {
    super(definition, options);
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
  }

  async start() {
    if (this.child && !this.closed) return this.summary();
    const command = expandEnv(this.definition.command);
    const args = (this.definition.args || []).map(expandEnv);
    if (!command) throw new Error(`MCP stdio server ${this.definition.name} has no command`);
    this.closed = false;
    this.child = spawn(command, args, {
      cwd: expandEnv(this.definition.cwd || this.workspaceRoot),
      env: { ...process.env, ...Object.fromEntries(Object.entries(this.definition.env || {}).map(([k, v]) => [k, expandEnv(v)])) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.child.stdout.on('data', (chunk) => this.#consume(chunk));
    this.child.stderr.on('data', (chunk) => {
      const text = truncate(chunk.toString(), 8000);
      this.eventBus?.emit('mcp.stderr', { server: this.definition.name, text });
      this.logger?.debug(`MCP ${this.definition.name} stderr`, { text });
    });
    this.child.once('error', (error) => this.#failAll(error));
    this.child.once('close', (code, signal) => {
      this.closed = true;
      this.connected = false;
      this.#failAll(new Error(`MCP server ${this.definition.name} exited (${code ?? signal ?? 'unknown'})`));
      this.eventBus?.emit('mcp.disconnected', { server: this.definition.name, code, signal });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 40);
      this.child.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    return this.initialize();
  }

  #consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const asText = this.buffer.toString('utf8');
      if (/^Content-Length:/i.test(asText)) {
        const headerEnd = asText.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = asText.slice(0, headerEnd);
        const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
        if (!Number.isFinite(length)) {
          this.buffer = this.buffer.subarray(headerEnd + 4);
          continue;
        }
        const bodyStart = Buffer.byteLength(asText.slice(0, headerEnd + 4));
        if (this.buffer.length < bodyStart + length) return;
        const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
        this.buffer = this.buffer.subarray(bodyStart + length);
        this.#handleLine(body);
        continue;
      }
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline).toString('utf8').trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line) this.#handleLine(line);
    }
  }

  #handleLine(line) {
    const message = safeJsonParse(line, null);
    if (!message || message.jsonrpc !== '2.0') {
      this.logger?.debug(`Ignored non-JSON MCP stdout from ${this.definition.name}`, { line: truncate(line, 2000) });
      return;
    }
    this.#handleMessage(message).catch((error) => this.logger?.warn('MCP message handling failed', {
      server: this.definition.name, error: error.message,
    }));
  }

  async #handleMessage(message) {
    if ('id' in message && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(normalizeMcpError(message.error, `${this.definition.name}:${pending.method}`));
      else pending.resolve(message.result);
      return;
    }
    if ('id' in message && message.method) {
      try {
        const result = await this.handleServerRequest(message);
        this.#write({ jsonrpc: '2.0', id: message.id, result: result || {} });
      } catch (error) {
        this.#write({ jsonrpc: '2.0', id: message.id, error: { code: error.code || -32603, message: error.message } });
      }
      return;
    }
    if (message.method) this.eventBus?.emit('mcp.notification', { server: this.definition.name, message });
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new Error(`MCP server ${this.definition.name} stdin is not writable`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, { timeoutMs = 60_000, signal, forceModern = false, forceLegacy = false } = {}) {
    if (!this.child || this.closed) return Promise.reject(new Error(`MCP server ${this.definition.name} is not running`));
    const requestId = this.nextId++;
    const useModern = forceModern || (!forceLegacy && this.era === 'modern');
    const finalParams = useModern ? { ...params, _meta: { ...(params._meta || {}), ...modernMeta() } } : params;
    const message = { jsonrpc: '2.0', id: requestId, method, params: finalParams };
    return new Promise((resolve, reject) => {
      const finishAbort = () => {
        this.pending.delete(String(requestId));
        reject(signal.reason || new Error(`MCP request aborted: ${method}`));
      };
      const timer = setTimeout(() => {
        this.pending.delete(String(requestId));
        try { this.#write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: 'timeout' } }); } catch { /* closed */ }
        reject(new Error(`MCP request timed out after ${timeoutMs} ms: ${this.definition.name}:${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(String(requestId), {
        method,
        timer,
        resolve: (value) => { signal?.removeEventListener('abort', finishAbort); resolve(value); },
        reject: (error) => { signal?.removeEventListener('abort', finishAbort); reject(error); },
      });
      signal?.addEventListener('abort', finishAbort, { once: true });
      try { this.#write(message); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(requestId));
        signal?.removeEventListener('abort', finishAbort);
        reject(error);
      }
    });
  }

  async notify(method, params = {}, { forceModern = false, forceLegacy = false } = {}) {
    const useModern = forceModern || (!forceLegacy && this.era === 'modern');
    this.#write({ jsonrpc: '2.0', method, params: useModern ? { ...params, _meta: { ...(params._meta || {}), ...modernMeta() } } : params });
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    if (!this.child || this.closed) return;
    this.closed = true;
    this.connected = false;
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child?.kill('SIGTERM');
        resolve();
      }, 1000);
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
}

export class HttpMcpClient extends BaseMcpClient {
  constructor(definition, options = {}) {
    super(definition, options);
    this.sessionId = null;
    this.nextId = 1;
    this.closed = false;
  }

  async start() {
    this.closed = false;
    return this.initialize();
  }

  headers({ modern = false } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...Object.fromEntries(Object.entries(this.definition.headers || {}).map(([key, value]) => [key, expandEnv(value)])),
    };
    if (modern) headers['MCP-Protocol-Version'] = MODERN_PROTOCOL;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const bearer = expandEnv(this.definition.bearerToken || '');
    if (bearer && !headers.Authorization) headers.Authorization = `Bearer ${bearer}`;
    return headers;
  }

  async request(method, params = {}, { timeoutMs = 60_000, signal, forceModern = false, forceLegacy = false } = {}) {
    if (this.closed) throw new Error(`MCP server ${this.definition.name} is closed`);
    const useModern = forceModern || (!forceLegacy && this.era === 'modern');
    const requestId = this.nextId++;
    const body = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params: useModern ? { ...params, _meta: { ...(params._meta || {}), ...modernMeta() } } : params,
    };
    const timeout = withTimeout(signal, timeoutMs);
    let response;
    try {
      response = await fetch(this.definition.url, {
        method: 'POST',
        headers: this.headers({ modern: useModern }),
        body: JSON.stringify(body),
        signal: timeout.signal,
        redirect: 'follow',
      });
    } catch (error) {
      timeout.cleanup();
      throw new Error(`MCP HTTP request failed for ${this.definition.name}: ${error.message}`);
    }
    timeout.cleanup();
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (response.status === 401 || response.status === 403) {
      const error = new Error(`MCP authentication required for ${this.definition.name} (${response.status})`);
      error.status = response.status;
      error.wwwAuthenticate = response.headers.get('www-authenticate');
      error.resourceMetadata = response.headers.get('mcp-resource-metadata');
      throw error;
    }
    const type = response.headers.get('content-type') || '';
    let message;
    if (type.includes('text/event-stream')) message = await parseSseResponse(response);
    else {
      const text = await response.text();
      message = safeJsonParse(text, null);
      if (!message && response.ok && !text.trim()) return {};
      if (!message) throw new Error(`Invalid MCP response from ${this.definition.name}: ${truncate(text, 2000)}`);
    }
    if (!response.ok && !message?.error) throw new Error(`MCP HTTP ${response.status}: ${JSON.stringify(message)}`);
    if (message?.error) throw normalizeMcpError(message.error, `${this.definition.name}:${method}`);
    return message?.result ?? message ?? {};
  }

  async notify(method, params = {}, { forceModern = false, forceLegacy = false } = {}) {
    const useModern = forceModern || (!forceLegacy && this.era === 'modern');
    const timeout = withTimeout(null, 20_000);
    try {
      await fetch(this.definition.url, {
        method: 'POST',
        headers: this.headers({ modern: useModern }),
        body: JSON.stringify({
          jsonrpc: '2.0', method,
          params: useModern ? { ...params, _meta: { ...(params._meta || {}), ...modernMeta() } } : params,
        }),
        signal: timeout.signal,
      });
    } finally {
      timeout.cleanup();
    }
  }

  async close() {
    this.closed = true;
    this.connected = false;
    if (this.sessionId) {
      try {
        await fetch(this.definition.url, { method: 'DELETE', headers: this.headers({ modern: false }) });
      } catch { /* best effort */ }
    }
  }
}

export function createMcpClient(definition, options = {}) {
  if (definition.transport === 'stdio' || definition.command) return new StdioMcpClient(definition, options);
  if (definition.transport === 'http' || definition.transport === 'streamable-http' || definition.url) return new HttpMcpClient(definition, options);
  throw new Error(`Unsupported MCP transport for ${definition.name}: ${definition.transport}`);
}
