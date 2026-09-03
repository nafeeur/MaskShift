export function registerPlanTools(registry) {
  registry.register({
    name: 'plan_update', title: 'Update execution plan',
    description: 'Create or update the run plan with concise steps and statuses. Use it for multi-step work and keep it synchronized with actual progress.',
    category: 'orchestration', risk: 'state', alwaysAvailable: true,
    keywords: ['todo', 'progress', 'steps', 'task list'],
    inputSchema: {
      type: 'object', required: ['steps'], properties: {
        summary: { type: 'string' },
        steps: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', required: ['text', 'status'], properties: { id: { type: 'string' }, text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] }, detail: { type: 'string' } } } },
      },
    },
    execute: async (args, context) => {
      if (!context.planState) throw new Error('No plan state attached to this run');
      context.planState.summary = args.summary || context.planState.summary || '';
      context.planState.steps = args.steps.map((step, index) => ({ id: step.id || `step-${index + 1}`, ...step }));
      context.planState.updatedAt = new Date().toISOString();
      context.eventBus?.emit('run.plan', context.planState, context.scope);
      context.store?.addRunEvent(context.runId, 'plan', context.planState);
      return context.planState;
    },
  });

  registry.register({
    name: 'plan_get', title: 'Read execution plan',
    description: 'Return the current run plan and progress.',
    category: 'orchestration', readOnly: true, alwaysAvailable: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args, context) => context.planState || { summary: '', steps: [] },
  });
}
