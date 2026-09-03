export function registerCapabilityTools(registry, { capabilityController }) {
  registry.register({
    name: 'capability_search',
    title: 'Search all capabilities',
    description: 'Search local tools, reusable skills, imported MCP servers, and discovered MCP tools. Use this whenever the current tool set is insufficient.',
    category: 'orchestration', readOnly: true, alwaysAvailable: true,
    keywords: ['find tool', 'load capability', 'skill', 'mcp', 'tool search'],
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 24 } } },
    execute: async (args, context) => capabilityController.search(args.query, { workspaceId: context.workspaceId, limit: args.limit || 24 }),
  });

  registry.register({
    name: 'capability_activate',
    title: 'Activate tools, skills, or MCP',
    description: 'Load selected capabilities into the current model context. Local tools add schemas, skills add instructions, and MCP servers connect lazily and expose their tools.',
    category: 'orchestration', risk: 'dynamic-load', alwaysAvailable: true,
    keywords: ['enable', 'load', 'connect', 'activate'],
    inputSchema: {
      type: 'object', required: ['names'], properties: {
        names: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } },
        kind: { type: 'string', enum: ['auto', 'tool', 'skill', 'mcp-server', 'mcp-tool'], default: 'auto' },
      },
    },
    execute: async (args, context) => {
      if (!context.capabilityState) throw new Error('No capability state is attached to this run');
      return capabilityController.activate(context.capabilityState, args.names, { kind: args.kind || 'auto' });
    },
  });

  registry.register({
    name: 'capability_state',
    title: 'Inspect active capabilities',
    description: 'Show the exact tools, skills, and MCP servers currently loaded for this run.',
    category: 'orchestration', readOnly: true, alwaysAvailable: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args, context) => context.capabilityState ? capabilityController.snapshot(context.capabilityState) : {},
  });
}
