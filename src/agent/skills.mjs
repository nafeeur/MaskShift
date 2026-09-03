import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, nowIso, textScore, truncate } from '../core/utils.mjs';

const BUNDLED_SKILLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills');

function parseScalar(value) {
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/^['"]|['"]$/g, '');
}

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return { meta: {}, body: content };
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) return { meta: {}, body: content };
  const raw = content.slice(4, end);
  const meta = {};
  let current = null;
  for (const line of raw.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      current = keyMatch[1];
      meta[current] = keyMatch[2] ? parseScalar(keyMatch[2]) : {};
      continue;
    }
    const nested = line.match(/^\s{2,}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nested && current && typeof meta[current] === 'object') meta[current][nested[1]] = parseScalar(nested[2]);
  }
  return { meta, body: content.slice(end + 5) };
}

export class SkillManager {
  constructor({ config, logger, eventBus }) {
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
    this.skills = new Map();
    this.workspacePath = process.cwd();
  }

  directories() {
    return [...new Set([
      BUNDLED_SKILLS,
      ...this.config.get().skillsDirs,
      path.join(this.workspacePath, '.maskshift', 'skills'),
      path.join(this.workspacePath, '.agents', 'skills'),
      path.join(this.workspacePath, '.claude', 'skills'),
    ])];
  }

  async setWorkspace(workspacePath) {
    this.workspacePath = path.resolve(workspacePath || process.cwd());
    return this.scan();
  }

  async scan() {
    const found = new Map();
    for (const base of this.directories()) {
      await this.#scanDirectory(base, found, 0);
    }
    this.skills = found;
    this.eventBus.emit('skills.scanned', { count: found.size, directories: this.directories() });
    return this.list();
  }

  async #scanDirectory(directory, found, depth) {
    if (depth > 5) return;
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const skillFile = path.join(full, 'SKILL.md');
        try {
          const content = await fsp.readFile(skillFile, 'utf8');
          const { meta, body } = parseFrontmatter(content);
          const name = meta.name || entry.name;
          const existing = found.get(name);
          const priority = directory === BUNDLED_SKILLS ? 0 : 1;
          if (!existing || priority >= existing.priority) {
            found.set(name, {
              name,
              description: meta.description || body.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '') || name,
              path: full,
              file: skillFile,
              source: directory === BUNDLED_SKILLS ? 'bundled' : 'local',
              meta,
              priority,
              bodyChars: body.length,
              updatedAt: (await fsp.stat(skillFile)).mtime.toISOString(),
            });
          }
          continue;
        } catch { /* not a skill root */ }
        await this.#scanDirectory(full, found, depth + 1);
      }
    }
  }

  list() {
    return [...this.skills.values()]
      .map(({ priority, ...skill }) => skill)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name) {
    return this.skills.get(name) || null;
  }

  search(query, limit = 12) {
    return this.list()
      .map((skill) => ({ ...skill, score: textScore(query, `${skill.name} ${skill.description}`, skill.meta?.keywords || []) }))
      .filter((skill) => skill.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  async load(name, { maxChars = 100_000 } = {}) {
    const skill = this.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    const content = await fsp.readFile(skill.file, 'utf8');
    const parsed = parseFrontmatter(content);
    const references = [];
    const referenceDir = path.join(skill.path, 'references');
    const referenceEntries = await fsp.readdir(referenceDir, { withFileTypes: true }).catch(() => []);
    for (const entry of referenceEntries.slice(0, 100)) {
      if (entry.isFile()) references.push({ name: entry.name, path: path.join(referenceDir, entry.name) });
    }
    this.eventBus.emit('skill.loaded', { name, source: skill.source });
    return {
      ...skill,
      body: truncate(parsed.body, maxChars),
      references,
      scriptsDir: path.join(skill.path, 'scripts'),
      assetsDir: path.join(skill.path, 'assets'),
    };
  }

  async readReference(name, reference, maxChars = 120_000) {
    const skill = this.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    const full = path.resolve(skill.path, 'references', reference);
    const root = path.resolve(skill.path, 'references');
    if (full !== root && !full.startsWith(`${root}${path.sep}`)) throw new Error('Reference path escapes skill directory');
    return truncate(await fsp.readFile(full, 'utf8'), maxChars);
  }

  async create({ name, description, body, metadata = {}, overwrite = false }) {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) throw new Error('Skill name must be lowercase kebab-case');
    const root = path.join(this.config.get().home, 'skills', name);
    const file = path.join(root, 'SKILL.md');
    if (!overwrite) {
      try { await fsp.access(file); throw new Error(`Skill already exists: ${name}`); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await ensureDir(root);
    const frontmatter = [
      '---',
      `name: ${name}`,
      `description: ${description.replace(/\n/g, ' ')}`,
      ...Object.entries(metadata).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`),
      '---',
      '',
    ].join('\n');
    await fsp.writeFile(file, `${frontmatter}${body.trim()}\n`, 'utf8');
    await this.scan();
    this.logger.audit('skill.create', { name, path: root });
    return this.get(name);
  }

  async improve({ name, addition, rationale = '' }) {
    const skill = this.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    if (skill.source === 'bundled') {
      const loaded = await this.load(name);
      return this.create({
        name,
        description: skill.description,
        body: `${loaded.body.trim()}\n\n## Learned refinement (${nowIso()})\n\n${addition.trim()}\n\nRationale: ${rationale}`,
        overwrite: true,
      });
    }
    const original = await fsp.readFile(skill.file, 'utf8');
    await fsp.writeFile(skill.file, `${original.trim()}\n\n## Learned refinement (${nowIso()})\n\n${addition.trim()}\n\nRationale: ${rationale}\n`, 'utf8');
    await this.scan();
    this.logger.audit('skill.improve', { name, rationale });
    return this.get(name);
  }
}
