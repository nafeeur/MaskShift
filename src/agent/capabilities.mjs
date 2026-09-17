import { truncate } from '../core/utils.mjs';

function cleanSearchItem(item, kind) {
  return {
    kind,
    name: item.name,
    title: item.title || item.name,
    description: item.description || '',
    category: item.category,
    readOnly: item.readOnly,
    risk: item.risk,
    status: item.status,
    server: item.server,
    score: item.score || 0,
  };
}

export class CapabilityController {
  constructor({ toolRegistry, skillManager, mcpManager, config, eventBus }) {
    this.toolRegistry = toolRegistry;
    this.skillManager = skillManager;
    this.mcpManager = mcpManager;
    this.config = config;
    this.eventBus = eventBus;
  }

  createState({ runId, workspaceId } = {}) {
    const state = {
      runId, workspaceId,
      tools: new Set(this.toolRegistry.list().filter((tool) => tool.alwaysAvailable).map((tool) => tool.name)),
      skills: new Map(),
      mcpServers: new Set(),
      activated: [],
    };
    return state;
  }

  search(query, { workspaceId = null, limit = 24 } = {}) {
    const local = this.toolRegistry.search(query, { limit: Math.max(limit, 30) }).map((item) => cleanSearchItem(item, 'tool'));
    const skills = this.skillManager.search(query, Math.max(limit, 20)).map((item) => cleanSearchItem(item, 'skill'));
    const mcp = this.mcpManager.search(query, { limit: Math.max(limit, 30), workspaceId }).map((item) => cleanSearchItem(item, item.kind));
    return [...local, ...skills, ...mcp]
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  async autoPrime(state, prompt) {
    if (!this.config.get().autoLoadCapabilities) return this.snapshot(state);
    const local = this.toolRegistry.search(prompt, { limit: 12 }).filter((item) => !item.alwaysAvailable).slice(0, 5);
    for (const item of local) state.tools.add(item.name);
    const skillHits = this.skillManager.search(prompt, 3);
    for (const hit of skillHits) {
      try {
        // Capped far below capability_activate's full-body load (skills.mjs's default 100k):
        // this fires on every run's first turn from a lexical `score > 0` match against a broad,
        // often generic prompt, so it easily grabs skills only loosely related to the task — a
        // full skill body (some run tens of thousands of characters) blindly spent on a guess
        // was the single largest source of wasted tokens in the whole system prompt. This still
        // gives the model enough of the skill to judge relevance and ask for the rest via
        // capability_activate, which is exactly the lazy-loading contract the rest of the system
        // prompt already tells it to follow.
        const skill = await this.skillManager.load(hit.name, { maxChars: 2_000 });
        state.skills.set(hit.name, skill);
      } catch { /* lazy load is best effort */ }
    }
    this.eventBus.emit('capabilities.primed', {
      tools: [...state.tools], skills: [...state.skills.keys()], mcpServers: [],
    }, { runId: state.runId, workspaceId: state.workspaceId });
    return this.snapshot(state);
  }

  async activate(state, names, { kind = 'auto' } = {}) {
    const requested = Array.isArray(names) ? names : [names];
    const results = [];
    for (const name of requested.filter(Boolean)) {
      if ((kind === 'auto' || kind === 'tool') && this.toolRegistry.has(name)) {
        state.tools.add(name);
        results.push({ kind: 'tool', name, activated: true });
        continue;
      }
      if ((kind === 'auto' || kind === 'skill') && this.skillManager.get(name)) {
        const skill = await this.skillManager.load(name);
        state.skills.set(name, skill);
        results.push({ kind: 'skill', name, activated: true, description: skill.description });
        continue;
      }
      const server = this.mcpManager.listServers(state.workspaceId).find((item) => item.name === name);
      if ((kind === 'auto' || kind === 'mcp-server') && server) {
        const status = await this.mcpManager.connect(name, { workspaceId: state.workspaceId });
        state.mcpServers.add(name);
        for (const tool of status.tools || []) state.tools.add(tool.qualifiedName);
        results.push({ kind: 'mcp-server', name, activated: true, tools: (status.tools || []).map((tool) => tool.qualifiedName) });
        continue;
      }
      if (name.startsWith('mcp__')) {
        const connectedTools = await this.mcpManager.allConnectedTools(state.workspaceId);
        let tool = connectedTools.find((item) => item.qualifiedName === name);
        if (!tool) {
          const serverHit = this.mcpManager.search(name, { workspaceId: state.workspaceId, limit: 100 }).find((item) => item.kind === 'mcp-tool' && item.name === name);
          if (serverHit?.server) {
            await this.mcpManager.connect(serverHit.server, { workspaceId: state.workspaceId });
            tool = (await this.mcpManager.tools(serverHit.server, state.workspaceId)).find((item) => item.qualifiedName === name);
          }
        }
        if (tool) {
          state.tools.add(tool.qualifiedName);
          state.mcpServers.add(tool.server);
          results.push({ kind: 'mcp-tool', name, activated: true, server: tool.server });
          continue;
        }
      }
      results.push({ kind, name, activated: false, error: 'Capability not found' });
    }
    state.activated.push(...results.filter((item) => item.activated).map((item) => ({ ...item, at: new Date().toISOString() })));
    this.eventBus.emit('capabilities.activated', { results, snapshot: this.snapshot(state) }, { runId: state.runId, workspaceId: state.workspaceId });
    return { results, state: this.snapshot(state) };
  }

  async descriptors(state) {
    const descriptors = [];
    for (const name of state.tools) {
      const local = this.toolRegistry.descriptor(name);
      if (local) { descriptors.push(local); continue; }
      if (name.startsWith('mcp__')) {
        const connected = await this.mcpManager.allConnectedTools(state.workspaceId);
        const mcp = connected.find((item) => item.qualifiedName === name);
        if (mcp) descriptors.push({
          name: mcp.qualifiedName,
          title: mcp.title || mcp.name,
          description: truncate(`[MCP:${mcp.server}] ${mcp.description || ''}`, 1200),
          inputSchema: mcp.inputSchema || { type: 'object', properties: {} },
          category: 'mcp', readOnly: false, risk: 'external-tool',
        });
      }
    }
    return descriptors;
  }

  snapshot(state) {
    return {
      tools: [...state.tools],
      skills: [...state.skills.keys()],
      mcpServers: [...state.mcpServers],
      activated: state.activated.slice(-100),
    };
  }

  /**
   * Names only, grouped by category — not the full one-line description every entry used to
   * carry. This renders into the system prompt on *every* turn of *every* run, whether or not
   * the task touches any of it, so a description per entry was several thousand tokens spent
   * on text describing tools that were never going to be used. Full descriptions still exist
   * one call away: capability_search / skill_search return them, and the system prompt's own
   * operating contract already tells the model to search before activating anything, so nothing
   * becomes less discoverable — the index just stops being priced like the documentation.
   */
  catalogSummary({ workspaceId = null, maxChars = 6_000 } = {}) {
    const grouped = new Map();
    for (const tool of this.toolRegistry.list({ includeSchema: false })) {
      const values = grouped.get(tool.category) || [];
      values.push(tool.name);
      grouped.set(tool.category, values);
    }
    const local = [...grouped].map(([category, names]) => `### ${category}\n${names.join(', ')}`).join('\n\n');
    const skills = this.skillManager.list().map((skill) => skill.name).join(', ');
    const mcp = this.mcpManager.listServers(workspaceId).map((server) => `${server.name} [${server.status}]`).join(', ');
    return truncate(`## Local tool catalog (names only — capability_search for what each does)\n${local}\n\n## Skill catalog (names only, bodies lazy — skill_search for what each does)\n${skills}\n\n## MCP catalog (connections lazy)\n${mcp}`, maxChars);
  }
}
