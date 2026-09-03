import { ConfigManager } from './core/config.mjs';
import { EventBus } from './core/events.mjs';
import { Logger } from './core/logger.mjs';
import { Store } from './core/store.mjs';
import { HookManager } from './hooks/manager.mjs';
import { WorkspaceManager } from './workspace/manager.mjs';
import { RepositoryIndexer } from './indexer/repository-indexer.mjs';
import { SkillManager } from './agent/skills.mjs';
import { ProviderManager } from './agent/providers.mjs';
import { McpManager } from './mcp/manager.mjs';
import { LspManager } from './lsp/manager.mjs';
import { BridgeManager } from './bridges/manager.mjs';
import { PluginManager } from './plugins/manager.mjs';
import { AutomationScheduler } from './automations/scheduler.mjs';
import { BrowserManager } from './browser/manager.mjs';
import { ToolRegistry } from './tools/registry.mjs';
import { ProcessManager } from './tools/process-manager.mjs';
import { CapabilityController } from './agent/capabilities.mjs';
import { ContextBuilder } from './agent/context.mjs';
import { PromptBuilder } from './agent/prompt.mjs';
import { AgentEngine } from './agent/engine.mjs';
import { registerAllTools } from './tools/register-all.mjs';

export async function createRuntime({ configPath, configOverrides = {}, workspacePath = process.cwd() } = {}) {
  const config = new ConfigManager({ configPath, overrides: configOverrides });
  await config.load();
  const eventBus = new EventBus({ historyLimit: 5000 });
  const logger = new Logger({ logFile: config.get().logFile, auditFile: config.get().auditFile, eventBus });
  await logger.init();
  const store = new Store(config.get().dataFile);
  await store.init();
  const hooks = new HookManager({ config, logger, eventBus });
  const workspaceManager = new WorkspaceManager({ store, config, logger, eventBus });
  const indexer = new RepositoryIndexer({ store, workspaceManager, config, logger, eventBus });
  const skillManager = new SkillManager({ config, logger, eventBus });
  await skillManager.setWorkspace(workspacePath);
  const providerManager = new ProviderManager({ config, logger, eventBus });
  const mcpManager = new McpManager({ config, logger, eventBus, workspaceManager });
  await mcpManager.init(workspacePath);
  const lspManager = new LspManager({ config, logger, eventBus, workspaceManager });
  const processManager = new ProcessManager({ eventBus, logger, config });
  const bridgeManager = new BridgeManager({ config, logger, eventBus, processManager, workspaceManager });
  const browserManager = new BrowserManager({ config, logger, eventBus, workspaceManager });
  const toolRegistry = new ToolRegistry({ logger, eventBus, hooks, config });
  const capabilityController = new CapabilityController({ toolRegistry, skillManager, mcpManager, config, eventBus });
  let engine;
  const managerDependencies = {
    config, store, logger, eventBus, hooks, workspaceManager, indexer, skillManager,
    providerManager, mcpManager, lspManager, processManager, bridgeManager, browserManager,
    toolRegistry, capabilityController, getEngine: () => engine,
  };
  const pluginManager = new PluginManager({
    config, logger, eventBus, toolRegistry, skillManager, mcpManager,
    dependencies: managerDependencies,
  });
  const automationScheduler = new AutomationScheduler({
    store, config, eventBus, logger, toolRegistry, workspaceManager, getEngine: () => engine,
  });
  managerDependencies.pluginManager = pluginManager;
  managerDependencies.automationScheduler = automationScheduler;
  registerAllTools(toolRegistry, {
    config, store, logger, eventBus, hooks, workspaceManager, indexer, skillManager,
    providerManager, mcpManager, lspManager, processManager, bridgeManager, browserManager,
    pluginManager, automationScheduler, capabilityController,
    getEngine: () => engine,
  });
  await pluginManager.init(workspacePath);
  const contextBuilder = new ContextBuilder({ workspaceManager, indexer, store, config, logger });
  const promptBuilder = new PromptBuilder({ config, capabilityController });
  engine = new AgentEngine({
    store, config, logger, eventBus, hooks, providerManager, workspaceManager,
    indexer, toolRegistry, capabilityController, promptBuilder, contextBuilder, mcpManager,
  });
  automationScheduler.start();

  const runtime = {
    config, eventBus, logger, store, hooks, workspaceManager, indexer, skillManager,
    providerManager, mcpManager, lspManager, bridgeManager, browserManager, pluginManager,
    automationScheduler, processManager, toolRegistry, capabilityController,
    contextBuilder, promptBuilder, engine,
    async close() {
      await engine.close();
      await automationScheduler.close();
      await pluginManager.close();
      await browserManager.closeAll();
      await processManager.close();
      await lspManager.close();
      await mcpManager.close();
      store.close();
      logger.close();
    },
  };
  return runtime;
}
