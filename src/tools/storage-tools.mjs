export function registerStorageTools(registry, { storageManager }) {
  registry.register({
    name: 'storage_status', title: 'Show MaskShift disk use',
    description: 'Report how much disk MaskShift uses (database, checkpoints, browser profiles, logs), the budget derived from this machine\'s disk and memory, and advice when it is over budget.',
    category: 'storage', readOnly: true,
    keywords: ['disk space', 'storage', 'database size', 'checkpoints size', 'cleanup'],
    inputSchema: { type: 'object', properties: {} },
    execute: async () => storageManager.status(),
  });

  registry.register({
    name: 'storage_prune', title: 'Free MaskShift disk space',
    description: 'Delete old checkpoints, stale search indexes, old run events and oversized logs according to the host-derived retention. Never deletes chats, memory or workspace files. Defaults to a dry run that only lists what would go.',
    category: 'storage', risk: 'state',
    inputSchema: { type: 'object', properties: { dryRun: { type: 'boolean', default: true } } },
    execute: async (args) => storageManager.prune({ dryRun: args.dryRun !== false }),
  });
}
