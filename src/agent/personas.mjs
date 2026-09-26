import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { textScore, truncate } from '../core/utils.mjs';
import { parseFrontmatter } from './skills.mjs';

const BUNDLED_AGENTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../agents');

// A persona is a named, reusable system-prompt for a delegated subagent — the
// counterpart to a skill, but describing *who* runs the task rather than
// *how*. Each is one flat `<name>.md` file with a YAML frontmatter header
// (name, description, tools, model), mirroring the agents/*.md convention
// used by Claude Code and other harnesses so a persona file can be dropped in
// unmodified from either ecosystem.
export class PersonaManager {
  constructor({ config, logger, eventBus }) {
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
    this.personas = new Map();
    this.workspacePath = process.cwd();
  }

  directories() {
    return [...new Set([BUNDLED_AGENTS, ...this.config.get().agentsDirs])];
  }

  async setWorkspace(workspacePath) {
    this.workspacePath = path.resolve(workspacePath || process.cwd());
    return this.scan();
  }

  async scan() {
    const found = new Map();
    for (const directory of this.directories()) {
      const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const file = path.join(directory, entry.name);
        const content = await fsp.readFile(file, 'utf8').catch(() => null);
        if (content == null) continue;
        const { meta, body } = parseFrontmatter(content);
        const name = meta.name || entry.name.replace(/\.md$/, '');
        const priority = directory === BUNDLED_AGENTS ? 0 : 1;
        const existing = found.get(name);
        if (existing && priority < existing.priority) continue;
        found.set(name, {
          name,
          description: meta.description || body.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '') || name,
          tools: meta.tools ? String(meta.tools).split(',').map((tool) => tool.trim()).filter(Boolean) : null,
          model: meta.model || null,
          file,
          source: directory === BUNDLED_AGENTS ? 'bundled' : 'local',
          priority,
        });
      }
    }
    this.personas = found;
    this.eventBus.emit('personas.scanned', { count: found.size, directories: this.directories() });
    return this.list();
  }

  list() {
    return [...this.personas.values()].map(({ priority, ...persona }) => persona).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name) {
    return this.personas.get(name) || null;
  }

  search(query, limit = 12) {
    return this.list()
      .map((persona) => ({ ...persona, score: textScore(query, `${persona.name} ${persona.description}`, persona.tools || []) }))
      .filter((persona) => persona.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  async load(name, { maxChars = 40_000 } = {}) {
    const persona = this.get(name);
    if (!persona) throw new Error(`Unknown persona: ${name}`);
    const content = await fsp.readFile(persona.file, 'utf8');
    const { body } = parseFrontmatter(content);
    return { ...persona, body: truncate(body.trim(), maxChars) };
  }
}
