function decayHalfLifeDays(config) {
  return config.get().memory?.decayHalfLifeDays || 30;
}

export function registerMemorySkillTools(registry, { store, skillManager, config }) {
  registry.register({
    name: 'memory_search', title: 'Search persistent memory',
    description: 'Search project and global long-term memory, ranked by a blend of text relevance, importance, and recency (older, untouched memories decay in rank without being deleted).',
    category: 'memory', readOnly: true, alwaysAvailable: true,
    keywords: ['remember', 'prior decision', 'history', 'preference', 'knowledge'],
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 12 } } },
    execute: async (args, context) => store.searchMemories(args.query, { workspaceId: context.workspaceId, limit: args.limit || 12, decayHalfLifeDays: decayHalfLifeDays(config) }),
  });

  registry.register({
    name: 'memory_save', title: 'Save persistent memory',
    description: 'Save a durable project or global fact, architectural decision, convention, result, or reusable lesson. Automatically merges into an existing memory with the same title in the same scope instead of creating a duplicate, unless dedupe is set to false.',
    category: 'memory', risk: 'write',
    inputSchema: {
      type: 'object', required: ['title', 'content'], properties: {
        id: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' },
        scope: { type: 'string', enum: ['workspace', 'global', 'session'], default: 'workspace' },
        tags: { type: 'array', items: { type: 'string' } }, importance: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        dedupe: { type: 'boolean', default: true },
      },
    },
    execute: async (args, context) => store.saveMemory({
      id: args.id, workspaceId: args.scope === 'global' ? null : context.workspaceId,
      scope: args.scope || 'workspace', title: args.title, content: args.content,
      tags: args.tags || [], importance: args.importance ?? 0.5, dedupe: args.dedupe !== false,
      meta: { source: 'agent', runId: context.runId, sessionId: context.sessionId },
    }),
  });

  registry.register({
    name: 'memory_list', title: 'List persistent memories',
    description: 'List memories ordered by effective importance: raw importance blended with a recency decay so stale, untouched memories sink without being deleted.',
    category: 'memory', readOnly: true,
    inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['workspace', 'global', 'session'] }, limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } } },
    execute: async (args, context) => store.listMemories({ workspaceId: context.workspaceId, scope: args.scope, limit: args.limit || 100, decayHalfLifeDays: decayHalfLifeDays(config) }),
  });

  registry.register({
    name: 'memory_delete', title: 'Delete persistent memory',
    description: 'Delete a memory by ID.',
    category: 'memory', risk: 'write',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    execute: async (args) => { store.deleteMemory(args.id); return { deleted: true, id: args.id }; },
  });

  registry.register({
    name: 'memory_optimize', title: 'Optimize persistent memory',
    description: 'Find duplicate-title memories to merge and stale, low-importance, never-accessed memories to prune. Defaults to a dry run that only reports candidates; set dryRun to false to apply the merge and prune.',
    category: 'memory', risk: 'write',
    keywords: ['cleanup', 'dedupe', 'prune', 'consolidate', 'compact'],
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['workspace', 'global', 'session'] },
        dryRun: { type: 'boolean', default: true },
        staleDays: { type: 'integer', minimum: 1, maximum: 3650, default: 90 },
        minEffectiveImportance: { type: 'number', minimum: 0, maximum: 1, default: 0.15 },
      },
    },
    execute: async (args, context) => {
      const halfLife = decayHalfLifeDays(config);
      const all = store.listMemories({ workspaceId: context.workspaceId, scope: args.scope, limit: 5000, decayHalfLifeDays: halfLife });

      const groups = new Map();
      for (const memory of all) {
        const key = `${memory.scope}::${memory.workspace_id || ''}::${String(memory.title || '').trim().toLowerCase()}`;
        const bucket = groups.get(key) || [];
        bucket.push(memory);
        groups.set(key, bucket);
      }
      const duplicateGroups = [];
      const mergedAway = new Set();
      for (const bucket of groups.values()) {
        if (bucket.length < 2) continue;
        const sorted = [...bucket].sort((a, b) => (b.importance - a.importance) || (Date.parse(b.updated_at) - Date.parse(a.updated_at)));
        const [survivor, ...extras] = sorted;
        for (const extra of extras) mergedAway.add(extra.id);
        duplicateGroups.push({ survivorId: survivor.id, title: survivor.title, mergedIds: extras.map((item) => item.id) });
      }

      const staleDays = args.staleDays || 90;
      const minEffectiveImportance = args.minEffectiveImportance ?? 0.15;
      const now = Date.now();
      const staleCandidates = all
        .filter((memory) => !mergedAway.has(memory.id))
        .filter((memory) => (memory.access_count || 0) === 0)
        .filter((memory) => (now - Date.parse(memory.updated_at)) / 86_400_000 >= staleDays)
        .filter((memory) => memory.effectiveImportance < minEffectiveImportance)
        .map((memory) => ({ id: memory.id, title: memory.title, ageDays: Math.round((now - Date.parse(memory.updated_at)) / 86_400_000), effectiveImportance: memory.effectiveImportance }));

      if (args.dryRun !== false) {
        return { dryRun: true, considered: all.length, duplicateGroups, staleCandidates };
      }

      let merged = 0;
      for (const group of duplicateGroups) {
        const survivor = store.getMemory(group.survivorId);
        if (!survivor) continue;
        const extras = group.mergedIds.map((extraId) => store.getMemory(extraId)).filter(Boolean);
        const mergedTags = [...new Set([...(survivor.tags || []), ...extras.flatMap((item) => item.tags || [])])];
        const maxImportance = Math.max(survivor.importance, ...extras.map((item) => item.importance || 0));
        store.saveMemory({
          id: survivor.id, workspaceId: survivor.workspace_id, scope: survivor.scope, title: survivor.title,
          content: survivor.content, tags: mergedTags, importance: maxImportance, meta: survivor.meta, dedupe: false,
        });
        for (const extraId of group.mergedIds) { store.deleteMemory(extraId); merged += 1; }
      }
      for (const candidate of staleCandidates) store.deleteMemory(candidate.id);

      return { dryRun: false, considered: all.length, merged, pruned: staleCandidates.length, duplicateGroups: duplicateGroups.length };
    },
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
