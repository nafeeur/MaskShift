const HARNESS_HINT = 'claude, codex, opencode, hermes, copilot, aider, any configured custom bridge, or maskshift (the built-in engine)';

export function registerFleetTools(registry, { fleetManager }) {
  registry.register({
    name: 'fleet_harnesses', title: 'List fleet harnesses',
    description: `List the agent harnesses a fleet member can run on (${HARNESS_HINT}) and whether each is installed.`,
    category: 'fleet', readOnly: true,
    keywords: ['fleet', 'harness', 'claude code', 'codex', 'hermes', 'opencode', 'installed agents'],
    inputSchema: { type: 'object', properties: { force: { type: 'boolean', default: false } } },
    execute: async (args) => fleetManager.harnesses({ force: Boolean(args.force) }),
  });

  registry.register({
    name: 'fleet_suggest', title: 'Which harness suits this task',
    description: 'Rank the installed agent harnesses (Claude Code, Codex, OpenCode, Hermes, …) for a task by how each has actually done on similar tasks before, with the evidence behind the ranking.',
    category: 'fleet', readOnly: true,
    keywords: ['fleet', 'choose harness', 'which agent', 'assign task', 'routing'],
    inputSchema: { type: 'object', required: ['task'], properties: { task: { type: 'string' } } },
    execute: async (args) => fleetManager.suggest(args.task),
  });

  registry.register({
    name: 'fleet_spawn', title: 'Add an agent to the fleet',
    description: `Create a persistent, named fleet member backed by ${HARNESS_HINT}. Several members may share a harness. Members keep their history and inbox between turns and can message each other. Use isolated=true to give an editing member its own Git worktree.`,
    category: 'fleet', risk: 'agent',
    keywords: ['fleet', 'spawn agent', 'team', 'multi agent', 'claude code', 'codex', 'hermes', 'opencode'],
    inputSchema: {
      type: 'object', required: ['harness'], properties: {
        harness: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', description: 'What this member is for, e.g. "reviews diffs for security problems".' },
        mode: { type: 'string', enum: ['inspect', 'edit'], default: 'inspect' }, model: { type: 'string' }, cwd: { type: 'string' },
        isolated: { type: 'boolean', default: false },
        fallbacks: { type: 'array', items: { type: 'string' }, description: 'Harnesses to use instead if this one is not installed.' },
      },
    },
    execute: async (args, context) => fleetManager.spawn({ ...args, workspaceId: context.workspaceId || null }),
  });

  registry.register({
    name: 'fleet_list', title: 'List fleet members',
    description: 'List the fleet members with their harness, role, status, unread mail and last reply. Pass name for one member\'s full history.',
    category: 'fleet', readOnly: true,
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    execute: async (args) => (args.name ? fleetManager.details(args.name) : fleetManager.list()),
  });

  registry.register({
    name: 'fleet_ask', title: 'Ask a fleet member',
    description: 'Give one member a task or question and wait for its reply. Its inbox is delivered with it. Any [[send]] messages it writes are queued for the teammates it addresses (use fleet_relay to have them acted on).',
    category: 'fleet', risk: 'agent',
    keywords: ['fleet', 'ask agent', 'delegate', 'claude code', 'codex'],
    inputSchema: {
      type: 'object', required: ['to', 'message'], properties: { to: { type: 'string' }, message: { type: 'string' } },
    },
    execute: async (args, context) => fleetManager.ask(args.to, { message: args.message, from: 'maskshift', signal: context.signal }),
  });

  registry.register({
    name: 'fleet_send', title: 'Message a fleet member',
    description: 'Queue a message from one member (or you) to another, or to="*" for everyone, without running anyone yet. It is delivered the next time the recipient takes a turn.',
    category: 'fleet', risk: 'state',
    inputSchema: {
      type: 'object', required: ['to', 'message'], properties: { to: { type: 'string' }, message: { type: 'string' }, from: { type: 'string', default: 'maskshift' } },
    },
    execute: async (args) => fleetManager.send({ from: args.from || 'maskshift', to: args.to, body: args.message }),
  });

  registry.register({
    name: 'fleet_relay', title: 'Run the fleet on a task',
    description: 'Hand a task to the fleet and let its members work it out together: the lead gets the task, members message each other with [[send]] blocks, and rounds continue until someone writes [[done]], everyone falls quiet, or the round/time limit is reached. Returns the outcome and a per-turn trace.',
    category: 'fleet', risk: 'agent',
    keywords: ['fleet', 'swarm', 'multi agent', 'collaborate', 'orchestrate', 'team'],
    inputSchema: {
      type: 'object', required: ['task'], properties: {
        task: { type: 'string' }, lead: { type: 'string', description: 'Member that receives the task first; defaults to the first member.' },
        members: { type: 'array', items: { type: 'string' }, description: 'Restrict to these members; defaults to the whole fleet.' },
        maxRounds: { type: 'integer', minimum: 1, maximum: 50 }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 21600000 },
      },
    },
    execute: async (args, context) => fleetManager.relay({ ...args, signal: context.signal }),
  });

  registry.register({
    name: 'fleet_messages', title: 'Read fleet conversation',
    description: 'Read the recent messages passed between fleet members (optionally just those to or from one member).',
    category: 'fleet', readOnly: true,
    inputSchema: { type: 'object', properties: { member: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 300, default: 50 } } },
    execute: async (args) => fleetManager.conversation({ member: args.member, limit: args.limit || 50 }),
  });

  registry.register({
    name: 'fleet_stop', title: 'Stop or remove a fleet member',
    description: 'Cancel a member\'s current turn, optionally removing it from the fleet. With no name, cancels every member and running relay.',
    category: 'fleet', risk: 'agent',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, remove: { type: 'boolean', default: false } } },
    execute: async (args) => {
      if (!args.name) return fleetManager.stopAll();
      return args.remove ? fleetManager.remove(args.name) : fleetManager.stop(args.name);
    },
  });
}
