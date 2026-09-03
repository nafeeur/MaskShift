export function registerMcpTools(registry, { mcpManager }) {
  registry.register({
    name: 'mcp_search', title: 'Search MCP capabilities',
    description: 'Search discovered MCP servers and tools already known to MaskShift. Servers remain lazy until connected.',
    category: 'mcp', readOnly: true, alwaysAvailable: true,
    keywords: ['connector', 'external tool', 'model context protocol', 'server'],
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } },
    execute: async (args, context) => mcpManager.search(args.query, { limit: args.limit || 20, workspaceId: context.workspaceId }),
  });

  registry.register({
    name: 'mcp_list', title: 'List MCP servers',
    description: 'List curated, imported, project, and configured MCP servers with live connection status and tool counts.',
    category: 'mcp', readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args, context) => mcpManager.listServers(context.workspaceId),
  });

  registry.register({
    name: 'mcp_connect', title: 'Connect MCP server',
    description: 'Lazily start or connect an MCP server, negotiate modern or legacy protocol, and discover its tools.',
    category: 'mcp', risk: 'external-connect',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, force: { type: 'boolean', default: false } } },
    execute: async (args, context) => {
      const status = await mcpManager.connect(args.name, { workspaceId: context.workspaceId, force: Boolean(args.force) });
      if (context.capabilityState) {
        context.capabilityState.mcpServers.add(args.name);
        for (const tool of status.tools || []) context.capabilityState.tools.add(tool.qualifiedName);
      }
      return status;
    },
  });

  registry.register({
    name: 'mcp_disconnect', title: 'Disconnect MCP server',
    description: 'Close a workspace-scoped MCP connection and unload its tool schemas.',
    category: 'mcp', risk: 'external-connect',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    execute: async (args, context) => {
      await mcpManager.disconnect(args.name, context.workspaceId);
      context.capabilityState?.mcpServers.delete(args.name);
      return { disconnected: true, name: args.name };
    },
  });

  registry.register({
    name: 'mcp_call', title: 'Call MCP tool by qualified name',
    description: 'Invoke a connected MCP tool directly. Prefer activating its qualified tool so the model can call it natively on later turns.',
    category: 'mcp', risk: 'external-tool',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } } },
    execute: async (args, context) => mcpManager.callQualified(args.name, args.arguments || {}, { workspaceId: context.workspaceId, signal: context.signal }),
  });

  registry.register({
    name: 'mcp_resources', title: 'List MCP resources',
    description: 'Connect to a server and list its MCP resources.',
    category: 'mcp', readOnly: true,
    inputSchema: { type: 'object', required: ['server'], properties: { server: { type: 'string' } } },
    execute: async (args, context) => mcpManager.resources(args.server, context.workspaceId),
  });

  registry.register({
    name: 'mcp_resource_read', title: 'Read MCP resource',
    description: 'Read a URI exposed by an MCP server.',
    category: 'mcp', readOnly: true,
    inputSchema: { type: 'object', required: ['server', 'uri'], properties: { server: { type: 'string' }, uri: { type: 'string' } } },
    execute: async (args, context) => mcpManager.readResource(args.server, args.uri, context.workspaceId),
  });

  registry.register({
    name: 'mcp_prompts', title: 'List MCP prompts',
    description: 'List prompt templates provided by an MCP server.',
    category: 'mcp', readOnly: true,
    inputSchema: { type: 'object', required: ['server'], properties: { server: { type: 'string' } } },
    execute: async (args, context) => mcpManager.prompts(args.server, context.workspaceId),
  });

  registry.register({
    name: 'mcp_registry_search', title: 'Search official MCP Registry',
    description: 'Search the live official MCP Registry instead of relying on a stale built-in server list.',
    category: 'mcp', readOnly: true,
    keywords: ['install connector', 'official registry', 'catalog'],
    inputSchema: { type: 'object', properties: { query: { type: 'string', default: '' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } } },
    execute: async (args) => mcpManager.registrySearch(args.query || '', args.limit || 30),
  });

  registry.register({
    name: 'mcp_registry_install', title: 'Install MCP Registry server',
    description: 'Resolve a server from the official registry and add its remote or package transport to MaskShift configuration.',
    category: 'mcp', risk: 'install',
    inputSchema: { type: 'object', required: ['registryName'], properties: { registryName: { type: 'string' }, prefer: { type: 'string', enum: ['remote', 'package'], default: 'remote' } } },
    execute: async (args, context) => {
      const tail = args.registryName.split('/').pop();
      const candidates = await mcpManager.registrySearch(args.registryName, 100);
      const item = candidates.find((candidate) => candidate.name === args.registryName) || candidates.find((candidate) => candidate.name.endsWith(`/${tail}`));
      if (!item) throw new Error(`Server not found in official MCP Registry: ${args.registryName}`);
      return mcpManager.installRegistry(item, { prefer: args.prefer || 'remote', workspacePath: context.workspacePath });
    },
  });

  registry.register({
    name: 'mcp_add', title: 'Add arbitrary MCP server',
    description: 'Add any stdio or HTTP MCP server definition, including command, arguments, environment, URL, headers, and lazy loading settings.',
    category: 'mcp', risk: 'install',
    inputSchema: {
      type: 'object', required: ['name', 'definition'], properties: {
        name: { type: 'string' }, definition: {
          type: 'object', required: ['transport'], properties: {
            transport: { type: 'string', enum: ['stdio', 'http', 'streamable-http', 'sse'] }, command: { type: 'string' },
            args: { type: 'array', items: { type: 'string' } }, env: { type: 'object' }, cwd: { type: 'string' },
            url: { type: 'string' }, headers: { type: 'object' }, enabled: { type: 'boolean' }, lazy: { type: 'boolean' },
          },
        },
      },
    },
    execute: async (args, context) => mcpManager.add(args.name, args.definition, context.workspacePath),
  });
}
