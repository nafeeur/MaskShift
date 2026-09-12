// Runs MaskShift itself as a Model Context Protocol server over stdio, so any MCP-speaking
// client (Claude Desktop, Claude Code, an IDE extension, another MaskShift instance) can
// drive the whole native tool catalog against one workspace — the same tool registry the
// TUI and CLI already use, just reached from outside the process instead of from inside it.
//
// stdout carries only JSON-RPC frames, one per line. Every diagnostic goes through the
// logger (file plus stderr on error), never console.log, or it would corrupt the transport.

import readline from 'node:readline';
import { VERSION } from '../core/utils.mjs';

const DEFAULT_PROTOCOL_VERSION = '2025-11-25';

function methodError(message, code = -32601) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toolDescriptor(tool) {
  return {
    name: tool.name,
    description: tool.description || tool.title || '',
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
  };
}

function toContent(result) {
  if (typeof result === 'string') return [{ type: 'text', text: result }];
  return [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }];
}

export class McpServer {
  constructor({ toolRegistry, buildContext, logger, tools = null, readOnly = false }) {
    this.toolRegistry = toolRegistry;
    this.buildContext = buildContext;
    this.logger = logger;
    this.allow = tools?.length ? new Set(tools) : null;
    this.readOnly = Boolean(readOnly);
  }

  exposedTools() {
    return this.toolRegistry.list({ includeSchema: true })
      .filter((tool) => !this.allow || this.allow.has(tool.name))
      .filter((tool) => !this.readOnly || tool.readOnly);
  }

  isExposed(name) {
    const tool = this.toolRegistry.get(name);
    if (!tool) return false;
    if (this.allow && !this.allow.has(name)) return false;
    if (this.readOnly && !tool.readOnly) return false;
    return true;
  }

  async callTool({ name, arguments: args } = {}) {
    if (!name) throw methodError('tools/call requires a tool name', -32602);
    if (!this.isExposed(name)) throw methodError(`Tool not exposed by this server: ${name}`);
    try {
      const result = await this.toolRegistry.execute(name, args || {}, this.buildContext());
      return { content: toContent(result) };
    } catch (error) {
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  }

  async dispatch(method, params = {}) {
    switch (method) {
      // `server/discover` is how MaskShift's own MCP client probes first; answering it too
      // means one MaskShift instance can drive another over the same handshake it already
      // speaks, on top of the standard `initialize` every other client uses.
      case 'initialize':
      case 'server/discover':
        return {
          protocolVersion: params.protocolVersion || DEFAULT_PROTOCOL_VERSION,
          serverInfo: { name: 'maskshift', title: 'MaskShift', version: VERSION },
          server: { name: 'maskshift', title: 'MaskShift', version: VERSION },
          capabilities: { tools: { listChanged: false } },
          instructions: 'MaskShift’s native tool catalog for one workspace. Call tools/list, then tools/call.',
        };
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: this.exposedTools().map(toolDescriptor) };
      case 'tools/call':
        return this.callTool(params);
      case 'resources/list':
        return { resources: [] };
      case 'prompts/list':
        return { prompts: [] };
      default:
        throw methodError(`Unknown method: ${method}`);
    }
  }

  async handle(message) {
    const { id, method, params } = message;
    try {
      const result = await this.dispatch(method, params || {});
      if (id === undefined) return null;
      return { jsonrpc: '2.0', id, result: result ?? {} };
    } catch (error) {
      if (id === undefined) {
        this.logger?.warn('MCP server notification failed', { method, error: error.message });
        return null;
      }
      return { jsonrpc: '2.0', id, error: { code: error.code || -32603, message: error.message } };
    }
  }

  /** One JSON-RPC message per line in, one per line out — the transport MaskShift's own client speaks. */
  listen(input = process.stdin, output = process.stdout) {
    this.rl = readline.createInterface({ input, terminal: false });
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try { message = JSON.parse(trimmed); } catch {
        this.logger?.warn('MCP server received a non-JSON line', { line: trimmed.slice(0, 500) });
        return;
      }
      if (!message || message.jsonrpc !== '2.0') return;
      this.handle(message)
        .then((reply) => { if (reply) output.write(`${JSON.stringify(reply)}\n`); })
        .catch((error) => this.logger?.warn('MCP server failed to handle a message', { error: error.message }));
    });
    return new Promise((resolve) => {
      this.rl.once('close', resolve);
      input.once('end', resolve);
    });
  }

  /** Release the stdin listener so nothing keeps the process alive after a caller stops waiting. */
  close() {
    this.rl?.close();
  }
}
