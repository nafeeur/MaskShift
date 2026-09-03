import fsp from 'node:fs/promises';
import path from 'node:path';
import { truncate } from '../core/utils.mjs';
import { estimateUsageCost, summarizeCosts } from '../core/pricing.mjs';

function treeText(entries) {
  return entries.map((item) => `${'  '.repeat(Math.max(0, item.depth || 0))}${item.type === 'directory' ? '▸' : '·'} ${item.path}${item.size ? ` (${item.size}b)` : ''}`).join('\n');
}

export function registerProjectTools(registry, { workspaceManager, indexer, store, providerManager, config }) {
  registry.register({
    name: 'project_inspect', title: 'Inspect project',
    description: 'Summarize repository shape, dominant languages, build manifests, instructions, Git state, and local index health.',
    category: 'project', readOnly: true, alwaysAvailable: true,
    keywords: ['repo map', 'project type', 'architecture', 'build system'],
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args, context) => {
      if (!context.workspaceId) throw new Error('Project inspection requires a workspace');
      const inspection = await workspaceManager.inspect(context.workspaceId);
      return { ...inspection, index: indexer.stats(context.workspaceId) };
    },
  });

  registry.register({
    name: 'project_tree', title: 'Render project tree',
    description: 'Render a bounded source tree for any workspace subdirectory.',
    category: 'project', readOnly: true, alwaysAvailable: true,
    keywords: ['directory structure', 'files', 'layout'],
    inputSchema: { type: 'object', properties: { path: { type: 'string', default: '.' }, depth: { type: 'integer', minimum: 0, maximum: 20, default: 4 }, includeHidden: { type: 'boolean', default: false }, maxEntries: { type: 'integer', minimum: 1, maximum: 50000, default: 3000 } } },
    execute: async (args, context) => {
      if (!context.workspaceId) throw new Error('Project tree requires a workspace');
      const result = await workspaceManager.listFiles(context.workspaceId, args);
      return { ...result, tree: truncate(treeText(result.entries), config.get().maxToolOutputChars) };
    },
  });

  registry.register({
    name: 'project_instructions', title: 'Load hierarchical instructions',
    description: 'Load AGENTS.md, CLAUDE.md, MASKSHIFT.md, Copilot instructions, and other configured context files from repository root through the working directory.',
    category: 'project', readOnly: true,
    inputSchema: { type: 'object', properties: { path: { type: 'string', default: '.' } } },
    execute: async (args, context) => {
      const cwd = path.resolve(context.workspacePath || process.cwd(), args.path || '.');
      return workspaceManager.loadContextFiles(cwd);
    },
  });

  registry.register({
    name: 'project_read_manifest', title: 'Read project manifest',
    description: 'Read and optionally parse a package/build manifest such as package.json, pyproject.toml, Cargo.toml, go.mod, or CMakeLists.txt.',
    category: 'project', readOnly: true,
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, parseJson: { type: 'boolean', default: true } } },
    execute: async (args, context) => {
      const file = path.resolve(context.workspacePath || process.cwd(), args.path);
      const content = await fsp.readFile(file, 'utf8');
      let parsed = null;
      if (args.parseJson !== false && path.extname(file) === '.json') {
        try { parsed = JSON.parse(content); } catch { /* return text */ }
      }
      return { path: file, content: truncate(content, 200_000), parsed };
    },
  });

  registry.register({
    name: 'project_index_status', title: 'Repository index status',
    description: 'Show local indexed file, chunk, character, and freshness statistics.',
    category: 'project', readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args, context) => {
      if (!context.workspaceId) throw new Error('Index status requires a workspace');
      return indexer.stats(context.workspaceId);
    },
  });

  registry.register({
    name: 'provider_list', title: 'List model providers',
    description: 'Inspect configured model providers, connectivity status, and discovered models.',
    category: 'project', readOnly: true,
    inputSchema: { type: 'object', properties: { discover: { type: 'boolean', default: false } } },
    execute: async (args) => args.discover ? providerManager.discoverAll({ force: true }) : providerManager.listProviders(),
  });

  registry.register({
    name: 'session_history', title: 'Read session history',
    description: 'Read messages and recent runs from the current MaskShift session.',
    category: 'project', readOnly: true,
    inputSchema: { type: 'object', properties: { messageLimit: { type: 'integer', minimum: 1, maximum: 5000, default: 300 }, runLimit: { type: 'integer', minimum: 1, maximum: 500, default: 50 } } },
    execute: async (args, context) => ({ messages: store.listMessages(context.sessionId, args.messageLimit || 300), runs: store.listRuns({ sessionId: context.sessionId, limit: args.runLimit || 50 }) }),
  });

  registry.register({
    name: 'usage_report', title: 'Report token usage and estimated cost',
    description: 'Aggregate model token usage and estimated spend across recent runs, grouped by model, using the pricing table in config. Models without a configured price are reported as token counts only (priced:false), never guessed.',
    category: 'project', readOnly: true,
    keywords: ['cost', 'spend', 'tokens', 'budget', 'usage', 'billing', 'price'],
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['workspace', 'all'], default: 'workspace' },
        sinceHours: { type: 'integer', minimum: 1, maximum: 8760 },
        limit: { type: 'integer', minimum: 1, maximum: 5000, default: 500 },
      },
    },
    execute: async (args, context) => {
      const since = args.sinceHours ? new Date(Date.now() - args.sinceHours * 3_600_000).toISOString() : undefined;
      const workspaceId = args.scope === 'all' ? undefined : context.workspaceId;
      const runs = store.listRuns({ workspaceId, since, limit: args.limit || 500 });
      const providers = config.get().providers;
      const byModel = new Map();
      const allEntries = [];
      for (const run of runs) {
        const modelRef = run.model_id || 'unknown';
        const separator = modelRef.indexOf(':');
        const providerId = separator > 0 ? modelRef.slice(0, separator) : null;
        const model = separator > 0 ? modelRef.slice(separator + 1) : modelRef;
        const providerType = providerId ? providers.find((item) => item.id === providerId)?.type : null;
        for (const usage of run.meta?.usage || []) {
          const entry = estimateUsageCost(config.get(), providerId, providerType, model, usage);
          if (!entry) continue;
          allEntries.push(entry);
          const bucket = byModel.get(modelRef) || [];
          bucket.push(entry);
          byModel.set(modelRef, bucket);
        }
      }
      return {
        runsConsidered: runs.length,
        totals: summarizeCosts(allEntries),
        byModel: Object.fromEntries([...byModel.entries()].map(([model, entries]) => [model, summarizeCosts(entries)])),
      };
    },
  });
}
