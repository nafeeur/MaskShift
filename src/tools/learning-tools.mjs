export function registerLearningTools(registry, { learningManager, intelligenceRouter, config }) {
  registry.register({
    name: 'learn_status', title: 'What MaskShift has learned',
    description: 'Show what MaskShift has learned from its own runs on this machine: lessons from earlier runs, preferences noticed from your messages, how each model and harness has done on which kinds of task, workflows it could turn into skills, and how well context was used.',
    category: 'learning', readOnly: true, alwaysAvailable: false,
    keywords: ['lessons', 'preferences', 'learned', 'history', 'routing record', 'skills mined'],
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args, context) => learningManager.status({ workspaceId: context.workspaceId }),
  });

  registry.register({
    name: 'learn_forget', title: 'Forget a lesson or preference',
    description: 'Remove one learned lesson or preference by id (from learn_status). Use it when something MaskShift learned is wrong or no longer applies.',
    category: 'learning', risk: 'write',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    execute: async (args) => learningManager.forget(args.id),
  });

  registry.register({
    name: 'skill_mine', title: 'Find workflows worth saving as skills',
    description: 'Look through recent runs for sequences of steps repeated across several runs that mostly went well, and draft a skill for each. Nothing is installed until skill_mine_accept.',
    category: 'learning', risk: 'state',
    keywords: ['mine skills', 'repeated workflow', 'automate', 'reusable'],
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args, context) => learningManager.miner.mine({ workspaceId: context.workspaceId }),
  });

  registry.register({
    name: 'skill_mine_accept', title: 'Accept or dismiss a mined skill',
    description: 'Install a skill drafted by skill_mine (by name or id), or dismiss it so it is not suggested again.',
    category: 'learning', risk: 'write',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, dismiss: { type: 'boolean', default: false } } },
    execute: async (args, context) => (args.dismiss
      ? learningManager.miner.dismiss(context.workspaceId, args.name)
      : learningManager.miner.accept(context.workspaceId, args.name)),
  });

  registry.register({
    name: 'router_explain', title: 'Why would this task go to that model or agent',
    description: 'Show how MaskShift would route a task: the models and the installed agent harnesses ranked by how they have actually done on similar tasks (success rate, cost), and how much evidence is behind each.',
    category: 'learning', readOnly: true,
    keywords: ['routing', 'which model', 'which agent', 'explain routing'],
    inputSchema: { type: 'object', required: ['task'], properties: { task: { type: 'string' } } },
    execute: async (args, context) => ({
      model: intelligenceRouter.routeModel(args.task, { workspaceId: context.workspaceId, fallback: config.get().defaultModel }),
      agent: await intelligenceRouter.routeAgent(args.task, { workspaceId: context.workspaceId }),
    }),
  });
}
