import path from 'node:path';
import { createMcpClient } from './jsonrpc-client.mjs';
import { curatedMcpCatalog, discoverMcpServers } from './discovery.mjs';
import { McpRegistryClient } from './registry.mjs';
import { textScore, truncate } from '../core/utils.mjs';

function toolName(server, tool) {
  const sanitize = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  return `mcp__${sanitize(server)}__${sanitize(tool)}`.slice(0, 96);
}

export class McpManager {
  constructor({ config, logger, eventBus, workspaceManager }) {
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
    this.workspaceManager = workspaceManager;
    this.definitions = new Map();
    this.connections = new Map();
    this.toolCache = new Map();
    this.toolAliases = new Map();
    this.registry = new McpRegistryClient({ logger });
  }

  async init(workspacePath = process.cwd()) {
    await this.refreshDefinitions(workspacePath);
    return this;
  }

  async refreshDefinitions(workspacePath = process.cwd()) {
    const discovered = await discoverMcpServers(workspacePath);
    const configured = Object.entries(this.config.get().mcpServers || {}).map(([name, definition]) => ({ name, ...definition, source: definition.source || 'maskshift-config' }));
    const values = [...curatedMcpCatalog, ...discovered, ...configured];
    const map = new Map();
    for (const definition of values) {
      const existing = map.get(definition.name);
      const priority = definition.source === 'maskshift-config' ? 3 : definition.source === 'curated' ? 1 : 2;
      if (!existing || priority >= existing.__priority) map.set(definition.name, { ...definition, __priority: priority });
    }
    this.definitions = map;
    this.eventBus.emit('mcp.catalog.updated', { servers: this.definitions.size, discovered: discovered.length, configured: configured.length });
    return this.listServers();
  }

  definition(name) {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`Unknown MCP server: ${name}`);
    const { __priority, ...clean } = definition;
    return clean;
  }

  connectionKey(name, workspaceId) {
    return `${workspaceId || 'global'}:${name}`;
  }

  workspaceRoot(workspaceId) {
    return workspaceId ? this.workspaceManager.get(workspaceId).path : process.cwd();
  }

  listServers(workspaceId = null) {
    return [...this.definitions.values()].map(({ __priority, ...definition }) => {
      const key = this.connectionKey(definition.name, workspaceId);
      const client = this.connections.get(key);
      const tools = this.toolCache.get(key) || [];
      return {
        ...definition,
        status: client?.connected ? 'connected' : client ? 'disconnected' : definition.enabled === false ? 'disabled' : 'available',
        protocol: client?.protocolVersion || null,
        era: client?.era || null,
        serverInfo: client?.serverInfo || null,
        toolCount: tools.length,
      };
    }).sort((a, b) => {
      const order = { connected: 0, available: 1, disabled: 2, disconnected: 3 };
      return order[a.status] - order[b.status] || a.name.localeCompare(b.name);
    });
  }

  search(query, { limit = 20, workspaceId = null } = {}) {
    const serverResults = this.listServers(workspaceId).map((server) => ({
      kind: 'mcp-server',
      name: server.name,
      title: server.title || server.name,
      description: server.description || '',
      status: server.status,
      score: textScore(query, `${server.name} ${server.title || ''} ${server.description || ''}`, server.keywords || []),
    }));
    const toolResults = [];
    for (const [key, tools] of this.toolCache) {
      if (workspaceId && !key.startsWith(`${workspaceId}:`)) continue;
      for (const tool of tools) {
        toolResults.push({
          kind: 'mcp-tool', name: tool.qualifiedName, title: tool.title || tool.name,
          description: tool.description || '', server: tool.server,
          score: textScore(query, `${tool.name} ${tool.title || ''} ${tool.description || ''}`),
        });
      }
    }
    return [...serverResults, ...toolResults].filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
  }

  async connect(name, { workspaceId = null, force = false } = {}) {
    const definition = this.definition(name);
    if (definition.enabled === false && !force) throw new Error(`MCP server is disabled: ${name}`);
    const key = this.connectionKey(name, workspaceId);
    const existing = this.connections.get(key);
    if (existing?.connected) return this.status(name, workspaceId);
    if (existing) await existing.close().catch(() => {});
    const workspaceRoot = this.workspaceRoot(workspaceId);
    const resolved = {
      ...definition,
      args: (definition.args || []).map((arg) => String(arg).replaceAll('${workspace}', workspaceRoot)),
      cwd: definition.cwd ? String(definition.cwd).replaceAll('${workspace}', workspaceRoot) : workspaceRoot,
    };
    const client = createMcpClient(resolved, {
      logger: this.logger,
      eventBus: this.eventBus,
      workspaceRoot,
      requestHandler: (request) => this.#handleClientRequest(request, { workspaceId, server: name }),
    });
    this.connections.set(key, client);
    this.eventBus.emit('mcp.connecting', { server: name, transport: resolved.transport }, { workspaceId });
    try {
      await client.start();
      const tools = await client.listTools();
      const normalized = tools.map((tool) => ({
        ...tool,
        server: name,
        qualifiedName: toolName(name, tool.name),
        inputSchema: tool.inputSchema || tool.input_schema || { type: 'object', properties: {} },
      }));
      this.toolCache.set(key, normalized);
      for (const tool of normalized) this.toolAliases.set(`${workspaceId || 'global'}:${tool.qualifiedName}`, { server: name, tool: tool.name });
      this.eventBus.emit('mcp.connected', {
        server: name, protocol: client.protocolVersion, era: client.era, tools: normalized.length,
      }, { workspaceId });
      this.logger.audit('mcp.connect', { server: name, workspaceId, tools: normalized.length, protocol: client.protocolVersion });
      return this.status(name, workspaceId);
    } catch (error) {
      this.eventBus.emit('mcp.error', { server: name, error: error.message, authRequired: error.status === 401 || error.status === 403 }, { workspaceId });
      this.logger.warn('MCP connection failed', { server: name, workspaceId, error: error.message });
      throw error;
    }
  }

  status(name, workspaceId = null) {
    const key = this.connectionKey(name, workspaceId);
    const client = this.connections.get(key);
    return {
      ...this.definition(name),
      status: client?.connected ? 'connected' : client ? 'disconnected' : 'available',
      protocol: client?.protocolVersion || null,
      era: client?.era || null,
      serverInfo: client?.serverInfo || null,
      capabilities: client?.capabilities || {},
      instructions: client?.instructions || '',
      tools: this.toolCache.get(key) || [],
    };
  }

  async disconnect(name, workspaceId = null) {
    const key = this.connectionKey(name, workspaceId);
    const client = this.connections.get(key);
    if (client) await client.close();
    this.connections.delete(key);
    this.toolCache.delete(key);
    for (const alias of [...this.toolAliases.keys()]) {
      if (alias.startsWith(`${workspaceId || 'global'}:mcp__${name.replace(/[^a-zA-Z0-9_-]/g, '_')}__`)) this.toolAliases.delete(alias);
    }
    this.eventBus.emit('mcp.disconnected', { server: name }, { workspaceId });
  }

  async tools(name, workspaceId = null) {
    const key = this.connectionKey(name, workspaceId);
    if (!this.connections.get(key)?.connected) await this.connect(name, { workspaceId });
    return this.toolCache.get(key) || [];
  }

  async allConnectedTools(workspaceId = null) {
    const tools = [];
    for (const server of this.listServers(workspaceId).filter((item) => item.status === 'connected')) {
      tools.push(...await this.tools(server.name, workspaceId));
    }
    return tools;
  }

  async callQualified(qualifiedName, args = {}, { workspaceId = null, signal } = {}) {
    let alias = this.toolAliases.get(`${workspaceId || 'global'}:${qualifiedName}`);
    if (!alias) {
      const match = qualifiedName.match(/^mcp__([^_].*?)__(.+)$/);
      if (match) {
        const serverCandidate = [...this.definitions.keys()].find((name) => name.replace(/[^a-zA-Z0-9_-]/g, '_') === match[1]);
        if (serverCandidate) {
          const tools = await this.tools(serverCandidate, workspaceId);
          const tool = tools.find((candidate) => candidate.qualifiedName === qualifiedName || candidate.name === match[2]);
          if (tool) alias = { server: serverCandidate, tool: tool.name };
        }
      }
    }
    if (!alias) throw new Error(`Unknown MCP tool: ${qualifiedName}`);
    const key = this.connectionKey(alias.server, workspaceId);
    if (!this.connections.get(key)?.connected) await this.connect(alias.server, { workspaceId });
    const client = this.connections.get(key);
    this.eventBus.emit('mcp.tool.started', { server: alias.server, tool: alias.tool, args }, { workspaceId });
    const started = Date.now();
    try {
      const result = await client.callTool(alias.tool, args, { signal, timeoutMs: this.config.get().mcpTimeoutMs });
      this.eventBus.emit('mcp.tool.completed', { server: alias.server, tool: alias.tool, durationMs: Date.now() - started }, { workspaceId });
      return result;
    } catch (error) {
      this.eventBus.emit('mcp.tool.failed', { server: alias.server, tool: alias.tool, durationMs: Date.now() - started, error: error.message }, { workspaceId });
      throw error;
    }
  }

  async resources(name, workspaceId = null) {
    const key = this.connectionKey(name, workspaceId);
    if (!this.connections.get(key)?.connected) await this.connect(name, { workspaceId });
    return this.connections.get(key).listResources();
  }

  async readResource(name, uri, workspaceId = null) {
    const key = this.connectionKey(name, workspaceId);
    if (!this.connections.get(key)?.connected) await this.connect(name, { workspaceId });
    return this.connections.get(key).readResource(uri);
  }

  async prompts(name, workspaceId = null) {
    const key = this.connectionKey(name, workspaceId);
    if (!this.connections.get(key)?.connected) await this.connect(name, { workspaceId });
    return this.connections.get(key).listPrompts();
  }

  async registrySearch(query, limit = 30) {
    return this.registry.search(query, limit);
  }

  async installRegistry(item, options = {}) {
    const definition = this.registry.toDefinition(item, options);
    await this.config.addMcpServer(definition.name, definition);
    await this.refreshDefinitions(options.workspacePath || process.cwd());
    this.logger.audit('mcp.install', { name: definition.name, registryName: definition.registryName, source: definition.source });
    return definition;
  }

  async add(name, definition, workspacePath = process.cwd()) {
    await this.config.addMcpServer(name, { ...definition, source: 'maskshift-config' });
    await this.refreshDefinitions(workspacePath);
    return this.definition(name);
  }

  async remove(name, workspacePath = process.cwd()) {
    for (const key of [...this.connections.keys()]) {
      if (key.endsWith(`:${name}`)) await this.disconnect(name, key.slice(0, -name.length - 1) === 'global' ? null : key.slice(0, -name.length - 1));
    }
    await this.config.removeMcpServer(name);
    await this.refreshDefinitions(workspacePath);
  }

  async #handleClientRequest(request, context) {
    this.eventBus.emit('mcp.client-request', { server: context.server, method: request.method, params: request.params }, { workspaceId: context.workspaceId });
    if (request.method === 'elicitation/create') {
      return { action: 'decline', content: { reason: 'Interactive MCP elicitation is not configured for this run.' } };
    }
    if (request.method === 'sampling/createMessage') {
      const error = new Error('MCP server-initiated sampling is disabled until a run-scoped model is available');
      error.code = -32601;
      throw error;
    }
    const error = new Error(`Unsupported MCP client request: ${request.method}`);
    error.code = -32601;
    throw error;
  }

  async close() {
    await Promise.allSettled([...this.connections.values()].map((client) => client.close()));
    this.connections.clear();
  }
}
