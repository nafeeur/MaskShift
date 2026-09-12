export function registerCodeIntelligenceTools(registry, { codeGraph, contextBuilder }) {
  registry.register({
    name: 'code_graph_build', title: 'Build code knowledge graph',
    description: 'Build a persistent repository graph of files, symbols, imports, containment, and likely calls for dependency-aware navigation.',
    category: 'project', risk: 'state', keywords: ['architecture graph', 'symbols', 'dependencies', 'call graph'],
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args, context) => {
      if (!context.workspaceId) throw new Error('Code graph requires a workspace');
      return codeGraph.build(context.workspaceId);
    },
  });

  registry.register({
    name: 'code_graph_query', title: 'Query code knowledge graph',
    description: 'Find files and symbols in the persistent code graph, including incoming and outgoing relationship counts.',
    category: 'project', readOnly: true, keywords: ['symbol search', 'architecture', 'references'],
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, kind: { type: 'string', enum: ['file', 'function', 'class', 'interface', 'type'] }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 } } },
    execute: async (args, context) => {
      if (!context.workspaceId) throw new Error('Code graph query requires a workspace');
      return codeGraph.query(context.workspaceId, args.query, { kind: args.kind, limit: args.limit || 50 });
    },
  });

  registry.register({
    name: 'change_impact', title: 'Analyze change impact',
    description: 'Walk reverse imports and call relationships before an edit to identify affected symbols, modules, and likely tests.',
    category: 'project', readOnly: true, alwaysAvailable: true,
    keywords: ['blast radius', 'what breaks', 'affected tests', 'dependency impact'],
    inputSchema: { type: 'object', required: ['targets'], properties: { targets: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } }, depth: { type: 'integer', minimum: 1, maximum: 10, default: 3 }, limit: { type: 'integer', minimum: 1, maximum: 2000, default: 200 }, rebuild: { type: 'boolean', default: false } } },
    execute: async (args, context) => {
      if (!context.workspaceId) throw new Error('Change impact requires a workspace');
      if (args.rebuild || !codeGraph.stats(context.workspaceId).nodes) await codeGraph.build(context.workspaceId);
      return codeGraph.impact(context.workspaceId, args.targets, { depth: args.depth || 3, limit: args.limit || 200 });
    },
  });

  registry.register({
    name: 'context_plan_explain', title: 'Explain context selection',
    description: 'Build a dry context plan and report budgets, selected source files, retrieval reasons, and excluded stale memories.',
    category: 'project', readOnly: true, keywords: ['context budget', 'retrieval reason', 'why file'],
    inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } },
    execute: async (args, context) => {
      if (!context.workspaceId) throw new Error('Context planning requires a workspace');
      const built = await contextBuilder.build({ workspaceId: context.workspaceId, prompt: args.prompt, sessionId: context.sessionId });
      return { plan: built.contextPlan, impact: built.impact, index: built.indexStats, graph: built.graphStats };
    },
  });
}
