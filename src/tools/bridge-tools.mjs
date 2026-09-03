function scope(context) {
  return { workspaceId: context.workspaceId || null, sessionId: context.sessionId || null, runId: context.runId || null };
}

export function registerBridgeTools(registry, { bridgeManager }) {
  registry.register({
    name: 'agent_bridge_discover', title: 'Discover external coding agents',
    description: 'Detect locally installed Claude Code, Codex, OpenCode, Copilot, Hermes, Aider, and configured coding-agent CLIs.',
    category: 'agent-bridge', readOnly: true,
    keywords: ['claude code', 'codex', 'opencode', 'copilot', 'hermes', 'aider', 'delegate'],
    inputSchema: { type: 'object', properties: { force: { type: 'boolean', default: false } } },
    execute: async (args) => bridgeManager.discover({ force: Boolean(args.force) }),
  });

  registry.register({
    name: 'agent_bridge_help', title: 'Inspect coding-agent CLI',
    description: 'Read the installed command help for an external coding-agent bridge before delegating.',
    category: 'agent-bridge', readOnly: true,
    inputSchema: { type: 'object', required: ['bridge'], properties: { bridge: { type: 'string' } } },
    execute: async (args) => bridgeManager.help(args.bridge),
  });

  registry.register({
    name: 'agent_bridge_run', title: 'Delegate to external coding agent',
    description: 'Run an installed Claude Code, Codex, OpenCode, Copilot, Hermes, Aider, or configured agent against the current workspace. Can wait or return a persistent process.',
    category: 'agent-bridge', risk: 'host-exec',
    keywords: ['delegate', 'second opinion', 'external agent', 'parallel agent'],
    inputSchema: {
      type: 'object', required: ['bridge', 'prompt'],
      properties: {
        bridge: { type: 'string' }, prompt: { type: 'string' }, cwd: { type: 'string' },
        model: { type: 'string' }, extraArgs: { type: 'array', items: { type: 'string' }, default: [] },
        env: { type: 'object', additionalProperties: { type: 'string' } },
        wait: { type: 'boolean', default: true }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 7200000 },
      },
    },
    execute: async (args, context) => bridgeManager.run(args.bridge, { ...args, ...scope(context) }),
  });

  registry.register({
    name: 'external_agent_run', title: 'Run arbitrary external agent',
    description: 'Execute any configured or ad-hoc coding-agent command with placeholder arguments such as {prompt}, {cwd}, and {workspace}.',
    category: 'agent-bridge', risk: 'host-exec',
    inputSchema: {
      type: 'object', required: ['command'], properties: {
        command: { type: 'string' }, args: { type: 'array', items: { type: 'string' }, default: [] },
        prompt: { type: 'string', default: '' }, cwd: { type: 'string' }, wait: { type: 'boolean', default: true },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 7200000 }, env: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
    execute: async (args, context) => bridgeManager.runCustom({ ...args, ...scope(context) }),
  });
}
