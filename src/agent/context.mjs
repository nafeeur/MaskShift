import path from 'node:path';
import { truncate } from '../core/utils.mjs';

function renderTree(entries) {
  return entries.map((item) => `${'  '.repeat(Math.max(0, item.depth || 0))}${item.type === 'directory' ? '▸' : '·'} ${item.path}`).join('\n');
}

function renderHits(hits) {
  return hits.map((hit) => `### ${hit.path}:${hit.startLine}-${hit.endLine} (${hit.language})\n\n\`\`\`${hit.language || ''}\n${hit.content}\n\`\`\``).join('\n\n');
}

export class ContextBuilder {
  constructor({ workspaceManager, indexer, codeGraph, contextPlanner, store, config, logger }) {
    this.workspaceManager = workspaceManager;
    this.indexer = indexer;
    this.codeGraph = codeGraph;
    this.contextPlanner = contextPlanner;
    this.store = store;
    this.config = config;
    this.logger = logger;
  }

  async build({ workspaceId, prompt, sessionId }) {
    if (!workspaceId) {
      return { workspace: null, text: `No workspace is open. Host current directory: ${process.cwd()}` };
    }
    const workspace = this.workspaceManager.get(workspaceId);
    let indexStats = this.indexer.stats(workspaceId);
    if (this.config.get().autoIndex && !indexStats?.chunks) {
      try {
        await this.indexer.index(workspaceId);
        indexStats = this.indexer.stats(workspaceId);
      } catch (error) {
        this.logger.warn('Initial repository indexing failed', { workspaceId, error: error.message });
      }
    }
    const graphEnabled = this.config.get().codeGraph?.enabled !== false;
    if (graphEnabled && !this.codeGraph?.stats(workspaceId)?.nodes) {
      try { await this.codeGraph?.build(workspaceId); }
      catch (error) { this.logger.warn('Initial code graph build failed', { workspaceId, error: error.message }); }
    }

    const budgets = this.contextPlanner.budgets();
    const [inspection, tree, instructions, rawRepoHits, rawMemories] = await Promise.all([
      this.workspaceManager.inspect(workspaceId).catch((error) => ({ error: error.message, workspace })),
      this.workspaceManager.listFiles(workspaceId, { depth: 3, maxEntries: 1600, includeHidden: false }).catch(() => ({ entries: [], truncated: false })),
      this.workspaceManager.loadContextFiles(workspace.path).catch(() => []),
      indexStats?.chunks ? this.indexer.contextFor(workspaceId, prompt, { limit: 40, maxChars: budgets.source * 2 }).catch(() => []) : [],
      this.store.searchMemories(prompt, { workspaceId, limit: 30, decayHalfLifeDays: this.config.get().memory?.decayHalfLifeDays || 30 }),
    ]);
    const validatedMemories = await this.contextPlanner.validateMemories(rawMemories, workspace.path);
    const planned = this.contextPlanner.select({ prompt, repoHits: rawRepoHits, memories: validatedMemories, budgets });
    const repoHits = planned.repoHits;
    const memories = planned.memories;
    const graphStats = graphEnabled ? this.codeGraph?.stats(workspaceId) : { enabled: false, nodes: 0, edges: 0 };
    let impact = null;
    if (graphEnabled && graphStats?.nodes) {
      const likelyTargets = this.codeGraph.query(workspaceId, prompt, { limit: 6 }).filter((node) => node.score > 0).map((node) => node.name);
      if (likelyTargets.length) impact = this.codeGraph.impact(workspaceId, likelyTargets, { depth: 2, limit: 60 });
    }

    const snapshot = `## Workspace snapshot\n${JSON.stringify({
        path: workspace.path,
        git: inspection.git,
        files: inspection.files,
        languages: inspection.languages,
        projectFiles: inspection.projectFiles,
        index: indexStats,
      }, null, 2)}`;
    const treeSection = `## Source tree\n${renderTree(tree.entries)}${tree.truncated ? '\n… tree truncated' : ''}`;
    const sections = [
      truncate(snapshot, budgets.snapshot),
      truncate(treeSection, budgets.tree),
    ];
    if (instructions.length) sections.push(truncate(`## Hierarchical repository instructions\n${instructions.map((item) => `### ${path.relative(workspace.path, item.path) || path.basename(item.path)}\n${item.content}`).join('\n\n')}`, budgets.instructions));
    if (memories.length) sections.push(`## Relevant persistent memory\n${memories.map((item) => `### ${item.title} [${item.scope}]\n${item.content}\nTags: ${(item.tags || []).join(', ')}`).join('\n\n')}`);
    if (impact?.files?.length) sections.push(`## Predicted change impact\nTargets: ${impact.targets.join(', ')}\nAffected files: ${impact.files.slice(0, 40).join(', ')}\nLikely tests: ${impact.tests.join(', ') || '(none identified)'}`);
    if (repoHits.length) sections.push(`## Retrieved source context\n${renderHits(repoHits)}`);
    sections.push(`## Session metadata\nSession ID: ${sessionId}\nCurrent time: ${new Date().toISOString()}`);

    return { workspace, inspection, tree, instructions, repoHits, memories, impact, indexStats, graphStats, contextPlan: planned.report, text: truncate(sections.join('\n\n'), Math.floor(this.config.get().maxContextChars * 0.72)) };
  }
}
