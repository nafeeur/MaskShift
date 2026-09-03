export async function activate(api) {
  let observedEvents = 0;
  const unsubscribe = api.onEvent(() => { observedEvents += 1; });

  api.registerTool({
    name: 'race_telemetry_snapshot',
    title: 'Race telemetry snapshot',
    description: 'Return a compact snapshot of the live MaskShift capability platform.',
    category: 'telemetry',
    readOnly: true,
    risk: 'normal',
    inputSchema: {
      type: 'object',
      properties: {
        includeProcesses: { type: 'boolean', default: false }
      }
    },
    execute: async ({ includeProcesses = false } = {}) => {
      const managers = api.managers;
      return {
        plugin: api.name,
        observedEvents,
        tools: managers.toolRegistry.list({ includeSchema: false }).length,
        skills: managers.skillManager.list().length,
        mcpServers: managers.mcpManager.listServers().length,
        plugins: managers.pluginManager?.list().length || 0,
        automations: managers.automationScheduler?.list({ limit: 1000 }).length || 0,
        browsers: managers.browserManager?.list().length || 0,
        processes: includeProcesses ? managers.processManager?.list({}) || [] : undefined
      };
    }
  });

  return () => unsubscribe();
}
