export function registerPluginTools(registry, { pluginManager }) {
  registry.register({
    name: 'plugin_list', title: 'List MaskShift plugins', description: 'List discovered runtime plugins, their status, tools, and skill directories.',
    category: 'plugins', readOnly: true, keywords: ['plugin', 'extension', 'capability pack'],
    inputSchema: { type: 'object', properties: {} }, execute: async () => pluginManager.list(),
  });
  registry.register({
    name: 'plugin_scan', title: 'Scan plugins', description: 'Rescan user and workspace plugin directories and activate newly discovered plugins.',
    category: 'plugins', risk: 'host-exec', inputSchema: { type: 'object', properties: { activate: { type: 'boolean', default: true } } },
    execute: async (args) => pluginManager.scan({ activate: args.activate !== false }),
  });
  registry.register({
    name: 'plugin_activate', title: 'Activate plugin', description: 'Load a plugin directly into the MaskShift process with full tool registration access.',
    category: 'plugins', risk: 'host-exec', inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    execute: async (args) => pluginManager.activate(args.name),
  });
  registry.register({
    name: 'plugin_deactivate', title: 'Deactivate plugin', description: 'Run a plugin cleanup hook and remove its registered tools.',
    category: 'plugins', risk: 'process', inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    execute: async (args) => pluginManager.deactivate(args.name),
  });
  registry.register({
    name: 'plugin_reload', title: 'Hot reload plugin', description: 'Deactivate and re-import one plugin, or every discovered plugin, without restarting MaskShift.',
    category: 'plugins', risk: 'host-exec', inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    execute: async (args) => pluginManager.reload(args.name || null),
  });
  registry.register({
    name: 'plugin_install', title: 'Install plugin', description: 'Install a plugin from a local directory, Git repository, or npm package and activate it.',
    category: 'plugins', risk: 'host-exec', inputSchema: { type: 'object', required: ['source'], properties: { source: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string', enum: ['auto', 'local', 'git', 'npm'], default: 'auto' } } },
    execute: async (args) => pluginManager.install(args.source, args),
  });
  registry.register({
    name: 'plugin_scaffold', title: 'Create plugin', description: 'Generate and activate a complete single-tool MaskShift plugin scaffold.',
    category: 'plugins', risk: 'write', inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, directory: { type: 'string' }, description: { type: 'string' } } },
    execute: async (args) => pluginManager.scaffold(args),
  });
}
