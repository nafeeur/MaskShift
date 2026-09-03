export function registerMemorySkillTools(registry, { store, skillManager }) {
  registry.register({
    name: 'memory_search', title: 'Search persistent memory',
    description: 'Search project and global long-term memory using SQLite full-text ranking.',
    category: 'memory', readOnly: true, alwaysAvailable: true,
    keywords: ['remember', 'prior decision', 'history', 'preference', 'knowledge'],
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 12 } } },
    execute: async (args, context) => store.searchMemories(args.query, { workspaceId: context.workspaceId, limit: args.limit || 12 }),
  });

  registry.register({
    name: 'memory_save', title: 'Save persistent memory',
    description: 'Save a durable project or global fact, architectural decision, convention, result, or reusable lesson.',
    category: 'memory', risk: 'write',
    inputSchema: {
      type: 'object', required: ['title', 'content'], properties: {
        id: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' },
        scope: { type: 'string', enum: ['workspace', 'global', 'session'], default: 'workspace' },
        tags: { type: 'array', items: { type: 'string' } }, importance: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
      },
    },
    execute: async (args, context) => store.saveMemory({
      id: args.id, workspaceId: args.scope === 'global' ? null : context.workspaceId,
      scope: args.scope || 'workspace', title: args.title, content: args.content,
      tags: args.tags || [], importance: args.importance ?? 0.5,
      meta: { source: 'agent', runId: context.runId, sessionId: context.sessionId },
    }),
  });

  registry.register({
    name: 'memory_list', title: 'List persistent memories',
    description: 'List the highest-priority project and global memories.',
    category: 'memory', readOnly: true,
    inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['workspace', 'global', 'session'] }, limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } } },
    execute: async (args, context) => store.listMemories({ workspaceId: context.workspaceId, scope: args.scope, limit: args.limit || 100 }),
  });

  registry.register({
    name: 'memory_delete', title: 'Delete persistent memory',
    description: 'Delete a memory by ID.',
    category: 'memory', risk: 'write',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    execute: async (args) => { store.deleteMemory(args.id); return { deleted: true, id: args.id }; },
  });

  registry.register({
    name: 'skill_search', title: 'Search agent skills',
    description: 'Search all bundled, project, Claude, Codex, Copilot, and user skill catalogs. Skill bodies are loaded only when selected.',
    category: 'skills', readOnly: true, alwaysAvailable: true,
    keywords: ['workflow', 'playbook', 'instructions', 'capability'],
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 12 } } },
    execute: async (args) => skillManager.search(args.query, args.limit || 12),
  });

  registry.register({
    name: 'skill_load', title: 'Load agent skill',
    description: 'Load the full instructions and metadata for a selected skill into the current run.',
    category: 'skills', readOnly: true,
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    execute: async (args, context) => {
      const skill = await skillManager.load(args.name);
      if (context.capabilityState) context.capabilityState.skills.set(skill.name, skill);
      return skill;
    },
  });

  registry.register({
    name: 'skill_read_reference', title: 'Read skill reference',
    description: 'Read a file referenced by a skill while preventing path escape from the skill directory.',
    category: 'skills', readOnly: true,
    inputSchema: { type: 'object', required: ['name', 'reference'], properties: { name: { type: 'string' }, reference: { type: 'string' } } },
    execute: async (args) => skillManager.readReference(args.name, args.reference),
  });

  registry.register({
    name: 'skill_create', title: 'Create reusable skill',
    description: 'Create a durable user skill from a successful workflow so future runs can discover it automatically.',
    category: 'skills', risk: 'write',
    inputSchema: { type: 'object', required: ['name', 'description', 'body'], properties: { name: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' }, metadata: { type: 'object' }, overwrite: { type: 'boolean', default: false } } },
    execute: async (args) => skillManager.create(args),
  });

  registry.register({
    name: 'skill_improve', title: 'Improve reusable skill',
    description: 'Append a validated lesson or refinement to an existing skill.',
    category: 'skills', risk: 'write',
    inputSchema: { type: 'object', required: ['name', 'addition'], properties: { name: { type: 'string' }, addition: { type: 'string' }, rationale: { type: 'string' } } },
    execute: async (args) => skillManager.improve(args),
  });
}
