function workspace(context, args) { return args.workspaceId ?? context.workspaceId ?? null; }

export function registerAutomationTools(registry, { automationScheduler }) {
  registry.register({
    name: 'automation_list', title: 'List automations', description: 'List scheduled agent, tool, and shell automations with next/last run state.',
    category: 'automation', readOnly: true, keywords: ['schedule', 'cron', 'recurring task'],
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' }, enabled: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } } },
    execute: async (args, context) => automationScheduler.list({ workspaceId: workspace(context, args) || undefined, enabled: args.enabled, limit: args.limit || 200 }),
  });
  registry.register({
    name: 'automation_create', title: 'Create automation', description: 'Schedule a recurring or one-time autonomous agent prompt, tool call, or unrestricted shell command. Schedules accept cron, ISO timestamps, or strings like every 15m.',
    category: 'automation', risk: 'persistent-exec',
    inputSchema: { type: 'object', required: ['name', 'schedule', 'action'], properties: { name: { type: 'string' }, schedule: { oneOf: [{ type: 'string' }, { type: 'object' }] }, action: { type: 'object' }, enabled: { type: 'boolean', default: true }, workspaceId: { type: 'string' }, meta: { type: 'object' } } },
    execute: async (args, context) => automationScheduler.create({ ...args, workspaceId: workspace(context, args) }),
  });
  registry.register({
    name: 'automation_update', title: 'Update automation', description: 'Edit an automation schedule, action, name, metadata, or enabled state.',
    category: 'automation', risk: 'persistent-exec',
    inputSchema: { type: 'object', required: ['automationId'], properties: { automationId: { type: 'string' }, name: { type: 'string' }, schedule: { oneOf: [{ type: 'string' }, { type: 'object' }] }, action: { type: 'object' }, enabled: { type: 'boolean' }, meta: { type: 'object' } } },
    execute: async (args) => { const { automationId, ...patch } = args; return automationScheduler.update(automationId, patch); },
  });
  registry.register({
    name: 'automation_run_now', title: 'Run automation now', description: 'Immediately execute an automation regardless of its next scheduled time.',
    category: 'automation', risk: 'host-exec',
    inputSchema: { type: 'object', required: ['automationId'], properties: { automationId: { type: 'string' } } },
    execute: async (args) => automationScheduler.execute(args.automationId, { manual: true }),
  });
  registry.register({
    name: 'automation_pause', title: 'Pause automation', description: 'Disable an automation without deleting it.',
    category: 'automation', risk: 'persistent-exec',
    inputSchema: { type: 'object', required: ['automationId'], properties: { automationId: { type: 'string' } } },
    execute: async (args) => automationScheduler.update(args.automationId, { enabled: false }),
  });
  registry.register({
    name: 'automation_resume', title: 'Resume automation', description: 'Enable an automation and compute its next run.',
    category: 'automation', risk: 'persistent-exec',
    inputSchema: { type: 'object', required: ['automationId'], properties: { automationId: { type: 'string' } } },
    execute: async (args) => automationScheduler.update(args.automationId, { enabled: true }),
  });
  registry.register({
    name: 'automation_delete', title: 'Delete automation', description: 'Permanently remove a scheduled automation.',
    category: 'automation', risk: 'write',
    inputSchema: { type: 'object', required: ['automationId'], properties: { automationId: { type: 'string' } } },
    execute: async (args) => ({ deleted: automationScheduler.remove(args.automationId), automationId: args.automationId }),
  });
}
