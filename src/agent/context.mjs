import path from 'node:path';
import { truncate } from '../core/utils.mjs';

function renderTree(entries) {
  return entries.map((item) => `${'  '.repeat(Math.max(0, item.depth || 0))}${item.type === 'directory' ? '▸' : '·'} ${item.path}`).join('\n');
}

function renderHits(hits) {
  return hits.map((hit) => `### ${hit.path}:${hit.startLine}-${hit.endLine} (${hit.language})\n\n\`\`\`${hit.language || ''}\n${hit.content}\n\`\`\``).join('\n\n');
}

export class ContextBuilder {
  constructor({ workspaceManager, indexer, store, config, logger }) {
    this.workspaceManager = workspaceManager;
    this.indexer = indexer;
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

    const [inspection, tree, instructions, repoHits, memories] = await Promise.all([
      this.workspaceManager.inspect(workspaceId).catch((error) => ({ error: error.message, workspace })),
      this.workspaceManager.listFiles(workspaceId, { depth: 3, maxEntries: 1600, includeHidden: false }).catch(() => ({ entries: [], truncated: false })),
      this.workspaceManager.loadContextFiles(workspace.path).catch(() => []),
      indexStats?.chunks ? this.indexer.contextFor(workspaceId, prompt, { limit: 14, maxChars: 100_000 }).catch(() => []) : [],
      this.store.searchMemories(prompt, { workspaceId, limit: 10, decayHalfLifeDays: this.config.get().memory?.decayHalfLifeDays || 30 }),
    ]);

    const sections = [
      `## Workspace snapshot\n${JSON.stringify({
        path: workspace.path,
        git: inspection.git,
        files: inspection.files,
        languages: inspection.languages,
        projectFiles: inspection.projectFiles,
        index: indexStats,
      }, null, 2)}`,
      `## Source tree\n${renderTree(tree.entries)}${tree.truncated ? '\n… tree truncated' : ''}`,
    ];
    if (instructions.length) sections.push(`## Hierarchical repository instructions\n${instructions.map((item) => `### ${path.relative(workspace.path, item.path) || path.basename(item.path)}\n${item.content}`).join('\n\n')}`);
    if (memories.length) sections.push(`## Relevant persistent memory\n${memories.map((item) => `### ${item.title} [${item.scope}]\n${item.content}\nTags: ${(item.tags || []).join(', ')}`).join('\n\n')}`);
    if (repoHits.length) sections.push(`## Retrieved source context\n${renderHits(repoHits)}`);
    sections.push(`## Session metadata\nSession ID: ${sessionId}\nCurrent time: ${new Date().toISOString()}`);

    return { workspace, inspection, tree, instructions, repoHits, memories, indexStats, text: truncate(sections.join('\n\n'), Math.floor(this.config.get().maxContextChars * 0.72)) };
  }
}
