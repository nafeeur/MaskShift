function validateDag(nodes) {
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) throw new Error('DAG node IDs must be unique');
  for (const node of nodes) for (const dependency of node.dependsOn || []) if (!ids.has(dependency)) throw new Error(`DAG node '${node.id}' depends on unknown node '${dependency}'`);
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visit = (nodeId) => {
    if (visiting.has(nodeId)) throw new Error(`DAG contains a cycle at '${nodeId}'`);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependency of byId.get(nodeId).dependsOn || []) visit(dependency);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of nodes) visit(node.id);
}

export function registerIntelligenceTools(registry, { intelligenceRouter, getEngine, config, store, skillManager }) {
  registry.register({
    name: 'model_route', title: 'Route task to model',
    description: 'Rank configured models for a task using language/domain fit and prior MaskShift outcomes.',
    category: 'orchestration', readOnly: true, alwaysAvailable: true,
    keywords: ['choose model', 'model router', 'benchmark routing'],
    inputSchema: { type: 'object', required: ['task'], properties: { task: { type: 'string' } } },
    execute: async (args, context) => intelligenceRouter.routeModel(args.task, { workspaceId: context.workspaceId, fallback: config.get().defaultModel }),
  });

  registry.register({
    name: 'agent_route', title: 'Route task to agent',
    description: 'Recommend an available external coding-agent bridge or internal subagent based on the task profile.',
    category: 'orchestration', readOnly: true,
    keywords: ['choose agent', 'meta harness', 'claude code', 'codex'],
    inputSchema: { type: 'object', required: ['task'], properties: { task: { type: 'string' } } },
    execute: async (args, context) => intelligenceRouter.routeAgent(args.task, { workspaceId: context.workspaceId }),
  });

  registry.register({
    name: 'plan_dag_update', title: 'Create executable DAG plan',
    description: 'Create a dependency-aware execution plan whose ready nodes can run concurrently and whose dependent nodes receive predecessor results.',
    category: 'orchestration', risk: 'state', alwaysAvailable: true,
    inputSchema: {
      type: 'object', required: ['nodes'], properties: {
        summary: { type: 'string' },
        nodes: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', required: ['id', 'task'], properties: {
          id: { type: 'string' }, task: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } },
          mode: { type: 'string', enum: ['inspect', 'edit'], default: 'inspect' }, model: { type: 'string' }, isolated: { type: 'boolean' },
        } } },
      },
    },
    execute: async (args, context) => {
      if (!context.planState) throw new Error('No plan state attached to this run');
      validateDag(args.nodes);
      context.planState.summary = args.summary || context.planState.summary || '';
      context.planState.dag = args.nodes.map((node) => ({ ...node, dependsOn: node.dependsOn || [], status: 'pending' }));
      context.planState.updatedAt = new Date().toISOString();
      context.eventBus?.emit('run.plan', context.planState, context.scope);
      if (context.runId && context.store?.getRun(context.runId)) context.store.addRunEvent(context.runId, 'plan-dag', context.planState);
      return context.planState;
    },
  });

  registry.register({
    name: 'agent_dag_execute', title: 'Execute DAG with subagents',
    description: 'Execute the current dependency DAG in bounded parallel waves. Edit nodes default to isolated Git worktrees; failed dependencies block downstream work.',
    category: 'orchestration', risk: 'agent',
    inputSchema: { type: 'object', properties: { maxParallel: { type: 'integer', minimum: 1, maximum: 12 }, stopOnFailure: { type: 'boolean', default: false } } },
    execute: async (args, context) => {
      const nodes = context.planState?.dag || [];
      if (!nodes.length) throw new Error('No executable DAG exists; call plan_dag_update first');
      validateDag(nodes);
      const maximum = Math.min(args.maxParallel || config.get().maxParallelSubagents, config.get().maxParallelSubagents);
      const results = new Map();
      while (nodes.some((node) => node.status === 'pending')) {
        for (const node of nodes.filter((item) => item.status === 'pending')) {
          if ((node.dependsOn || []).some((dependency) => ['failed', 'blocked'].includes(nodes.find((item) => item.id === dependency)?.status))) node.status = 'blocked';
        }
        const ready = nodes.filter((node) => node.status === 'pending' && (node.dependsOn || []).every((dependency) => nodes.find((item) => item.id === dependency)?.status === 'completed')).slice(0, maximum);
        if (!ready.length) break;
        ready.forEach((node) => { node.status = 'in_progress'; });
        context.eventBus?.emit('run.plan', context.planState, context.scope);
        await Promise.all(ready.map(async (node) => {
          const predecessorContext = (node.dependsOn || []).map((dependency) => {
            const prior = results.get(dependency);
            return prior ? `Result from ${dependency}:\n${prior.final || prior.error || ''}` : '';
          }).filter(Boolean).join('\n\n');
          const route = !node.model || node.model === 'auto'
            ? intelligenceRouter.routeModel(node.task, { workspaceId: context.workspaceId, fallback: config.get().defaultModel }) : { selected: node.model };
          const dependencyWorkspaces = [...new Set((node.dependsOn || []).map((dependency) => results.get(dependency)?.workspaceId).filter((workspaceId) => workspaceId && workspaceId !== context.workspaceId))];
          try {
            const result = await getEngine().delegate({
              task: `${node.task}${predecessorContext ? `\n\nDependency results:\n${predecessorContext}` : ''}`,
              name: node.id, mode: node.mode || 'inspect', model: route.selected,
              workspaceId: dependencyWorkspaces.length === 1 ? dependencyWorkspaces[0] : undefined,
              isolated: dependencyWorkspaces.length === 0 && (node.isolated ?? node.mode === 'edit'),
            }, context);
            results.set(node.id, result);
            node.status = result.status === 'completed' ? 'completed' : 'failed';
            node.result = { runId: result.runId, status: result.status, workspaceId: result.workspaceId, isolation: result.isolation, error: result.error,
              warning: dependencyWorkspaces.length > 1 ? 'Dependencies produced multiple worktrees; their changes were not auto-merged.' : null };
          } catch (error) {
            node.status = 'failed';
            node.result = { error: error.message };
            results.set(node.id, { error: error.message });
          }
        }));
        context.planState.updatedAt = new Date().toISOString();
        context.eventBus?.emit('run.plan', context.planState, context.scope);
        if (args.stopOnFailure && ready.some((node) => node.status === 'failed')) break;
      }
      if (context.runId && context.store?.getRun(context.runId)) context.store.addRunEvent(context.runId, 'dag-completed', context.planState);
      return { plan: context.planState, results: Object.fromEntries(results) };
    },
  });

  registry.register({
    name: 'skill_evaluate', title: 'Record skill A/B evaluation',
    description: 'Record comparable baseline and candidate outcomes for a reusable skill. This creates empirical evidence without changing the skill.',
    category: 'skills', risk: 'state',
    inputSchema: { type: 'object', required: ['skillName', 'taskKey', 'baselinePassed', 'candidatePassed'], properties: {
      skillName: { type: 'string' }, taskKey: { type: 'string' }, baselinePassed: { type: 'boolean' }, candidatePassed: { type: 'boolean' }, evidence: { type: 'object' },
    } },
    execute: async (args, context) => store.saveSkillEvaluation({ workspaceId: context.workspaceId, ...args }),
  });

  registry.register({
    name: 'skill_promote_validated', title: 'Promote validated skill improvement',
    description: 'Apply a skill improvement only when recorded A/B trials meet minimum evidence and improve success without regressions.',
    category: 'skills', risk: 'write',
    inputSchema: { type: 'object', required: ['skillName', 'addition'], properties: {
      skillName: { type: 'string' }, addition: { type: 'string' }, rationale: { type: 'string' }, minTrials: { type: 'integer', minimum: 2, maximum: 100, default: 3 },
    } },
    execute: async (args, context) => {
      const evaluations = store.listSkillEvaluations(args.skillName, { workspaceId: context.workspaceId, limit: 100 });
      const minimum = args.minTrials || 3;
      const candidatePasses = evaluations.filter((item) => item.candidate_passed).length;
      const baselinePasses = evaluations.filter((item) => item.baseline_passed).length;
      const regressions = evaluations.filter((item) => item.baseline_passed && !item.candidate_passed).length;
      const report = { trials: evaluations.length, candidatePasses, baselinePasses, regressions, uplift: evaluations.length ? (candidatePasses - baselinePasses) / evaluations.length : 0 };
      if (evaluations.length < minimum) throw new Error(`Skill needs at least ${minimum} comparable trials; found ${evaluations.length}`);
      if (regressions > 0 || candidatePasses <= baselinePasses) throw new Error(`Skill candidate is not promotable: ${JSON.stringify(report)}`);
      const skill = await skillManager.improve({ name: args.skillName, addition: args.addition, rationale: args.rationale || `Promoted after ${evaluations.length} A/B trials` });
      return { promoted: true, report, skill };
    },
  });
}
