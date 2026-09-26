export function registerAgentTools(registry, { getEngine, config, personaManager }) {
  registry.register({
    name: 'agent_delegate',
    title: 'Delegate to subagent',
    description: 'Run a focused subagent with its own session and capability context. Optionally give it a named persona (see agent_persona_list) to frame its system prompt, and optionally isolate editing in a Git worktree and branch.',
    category: 'orchestration', risk: 'agent',
    keywords: ['subagent', 'delegate', 'parallel', 'specialist', 'worktree', 'persona'],
    inputSchema: {
      type: 'object', required: ['task'], properties: {
        task: { type: 'string' }, model: { type: 'string' },
        persona: { type: 'string', description: 'Name of a bundled or project persona (from agent_persona_list) whose system prompt frames this subagent, e.g. "code-reviewer" or "security-reviewer".' },
        isolated: { type: 'boolean', default: false }, name: { type: 'string' },
        mode: { type: 'string', enum: ['inspect', 'edit'], default: 'inspect' },
      },
    },
    execute: async (args, context) => getEngine().delegate(args, context),
  });

  registry.register({
    name: 'agent_parallel',
    title: 'Run parallel subagents',
    description: 'Delegate multiple independent research, review, test, or implementation tasks concurrently and aggregate their final results. Each task may set its own persona.',
    category: 'orchestration', risk: 'agent',
    keywords: ['swarm', 'parallel agents', 'reviewers', 'fan out', 'persona'],
    inputSchema: {
      type: 'object', required: ['tasks'], properties: {
        tasks: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', required: ['task'], properties: { task: { type: 'string' }, model: { type: 'string' }, persona: { type: 'string' }, isolated: { type: 'boolean', default: false }, name: { type: 'string' }, mode: { type: 'string', enum: ['inspect', 'edit'], default: 'inspect' } } } },
      },
    },
    execute: async (args, context) => {
      const maximum = Math.min(args.tasks.length, config.get().maxParallelSubagents);
      const selected = args.tasks.slice(0, maximum);
      return Promise.all(selected.map((task) => getEngine().delegate(task, context).catch((error) => ({ task: task.task, error: error.message }))));
    },
  });

  registry.register({
    name: 'agent_persona_list',
    title: 'List subagent personas',
    description: 'List named personas (bundled and project-defined) that can be passed as agent_delegate\'s persona argument to frame a subagent\'s system prompt for a specific role, such as reviewing code or resolving a build failure.',
    category: 'orchestration', readOnly: true, alwaysAvailable: true,
    keywords: ['persona', 'subagent', 'role', 'reviewer'],
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    execute: async (args) => (args.query ? personaManager.search(args.query) : personaManager.list()),
  });

  registry.register({
    name: 'agent_run_status',
    title: 'Inspect agent runs',
    description: 'Inspect active and recent agent runs, including parent/subagent relationships.',
    category: 'orchestration', readOnly: true,
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } } },
    execute: async (args) => args.runId ? getEngine().getRunState(args.runId) : getEngine().listActiveRuns(),
  });

  registry.register({
    name: 'agent_cancel',
    title: 'Cancel agent run',
    description: 'Cancel a running subagent or other active MaskShift run.',
    category: 'orchestration', risk: 'agent',
    inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' } } },
    execute: async (args) => getEngine().cancel(args.runId),
  });
}
