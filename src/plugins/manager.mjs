import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { absolutePath, ensureDir, readJson, runCommand, shellQuote, writeJsonAtomic } from '../core/utils.mjs';

async function exists(file) {
  try { await fsp.access(file); return true; } catch { return false; }
}

async function copyTree(source, destination) {
  await fsp.cp(source, destination, { recursive: true, force: true, errorOnExist: false });
}

function safeName(value) {
  return String(value || 'plugin').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'plugin';
}

function packageNameFromSpec(spec) {
  const value = String(spec || '').replace(/^npm:/, '');
  if (value.startsWith('@')) {
    const slash = value.indexOf('/');
    const version = slash >= 0 ? value.indexOf('@', slash) : -1;
    return version >= 0 ? value.slice(0, version) : value;
  }
  const version = value.indexOf('@');
  return version > 0 ? value.slice(0, version) : value;
}

function exportedEntry(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  for (const key of ['import', 'node', 'default', 'require']) {
    const found = exportedEntry(value[key]);
    if (found) return found;
  }
  for (const nested of Object.values(value)) {
    const found = exportedEntry(nested);
    if (found) return found;
  }
  return null;
}

export class PluginManager {
  constructor({ config, logger, eventBus, toolRegistry, skillManager, mcpManager, dependencies = {} }) {
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
    this.toolRegistry = toolRegistry;
    this.skillManager = skillManager;
    this.mcpManager = mcpManager;
    this.dependencies = dependencies;
    this.plugins = new Map();
    this.workspacePath = process.cwd();
  }

  roots(workspacePath = this.workspacePath) {
    return [...new Set([
      ...(this.config.get().pluginDirs || []),
      path.join(workspacePath || process.cwd(), '.maskshift', 'plugins'),
    ].map((item) => absolutePath(item, workspacePath || process.cwd())))];
  }

  async init(workspacePath = process.cwd()) {
    this.workspacePath = absolutePath(workspacePath);
    for (const root of this.roots()) await ensureDir(root);
    await this.scan({ activate: true });
    return this.list();
  }

  async manifestFor(candidate) {
    const stat = await fsp.stat(candidate);
    if (stat.isFile() && candidate.endsWith('.mjs')) {
      return {
        name: safeName(path.basename(candidate, '.mjs')),
        version: '0.0.0', entry: candidate, root: path.dirname(candidate),
        description: 'Single-file MaskShift plugin', enabled: true,
      };
    }
    if (!stat.isDirectory()) return null;
    const explicit = path.join(candidate, 'maskshift.plugin.json');
    const packageFile = path.join(candidate, 'package.json');
    let manifest = await readJson(explicit, null);
    const packageJson = await readJson(packageFile, null);
    if (!manifest && packageJson?.maskshift) manifest = { ...packageJson.maskshift, name: packageJson.name, version: packageJson.version, description: packageJson.description };
    if (!manifest) {
      for (const entry of ['index.mjs', 'plugin.mjs', 'src/index.mjs']) {
        if (await exists(path.join(candidate, entry))) {
          manifest = { name: path.basename(candidate), version: packageJson?.version || '0.0.0', description: packageJson?.description || '', entry };
          break;
        }
      }
    }
    if (!manifest) return null;
    return {
      enabled: true,
      ...manifest,
      name: safeName(manifest.name || path.basename(candidate)),
      root: candidate,
      entry: path.resolve(candidate, manifest.entry || 'index.mjs'),
    };
  }

  async scan({ activate = true } = {}) {
    const found = new Map();
    for (const root of this.roots()) {
      let entries = [];
      try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const candidate = path.join(root, entry.name);
        try {
          const manifest = await this.manifestFor(candidate);
          if (manifest) found.set(manifest.name, manifest);
        } catch (error) {
          this.logger?.warn('Plugin discovery failed', { candidate, error: error.message });
        }
      }
    }
    for (const manifest of found.values()) {
      const existing = this.plugins.get(manifest.name);
      this.plugins.set(manifest.name, { ...manifest, status: existing?.status || 'discovered', error: existing?.error || null, registrations: existing?.registrations || [], cleanup: existing?.cleanup || [] });
      if (activate && manifest.enabled !== false && this.plugins.get(manifest.name).status !== 'active') {
        await this.activate(manifest.name).catch(() => {});
      }
    }
    return this.list();
  }

  list() {
    return [...this.plugins.values()].map((item) => ({
      name: item.name, version: item.version || '0.0.0', description: item.description || '',
      root: item.root, entry: item.entry, status: item.status, error: item.error,
      tools: item.registrations || [], skills: item.skillDirs || [],
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name) { return this.plugins.get(name) || null; }

  async activate(name) {
    const state = this.plugins.get(name);
    if (!state) throw new Error(`Unknown plugin: ${name}`);
    if (state.status === 'active') return this.list().find((item) => item.name === name);
    if (!await exists(state.entry)) throw new Error(`Plugin entry does not exist: ${state.entry}`);
    state.status = 'loading'; state.error = null; state.registrations = []; state.cleanup = []; state.skillDirs = [];
    try {
      const stat = await fsp.stat(state.entry);
      const module = await import(`${pathToFileURL(state.entry).href}?maskshift=${stat.mtimeMs}`);
      const activate = module.activate || module.default;
      if (typeof activate !== 'function') throw new Error('Plugin must export activate(api) or a default function');
      const api = {
        name: state.name,
        root: state.root,
        config: this.config,
        logger: this.logger,
        events: this.eventBus,
        managers: this.dependencies,
        registerTool: (tool) => {
          this.toolRegistry.register({ ...tool, plugin: state.name });
          state.registrations.push(tool.name);
          return tool.name;
        },
        registerSkillDirectory: async (directory) => {
          const full = absolutePath(directory, state.root);
          if (!this.config.get().skillsDirs.includes(full)) this.config.get().skillsDirs.push(full);
          state.skillDirs.push(full);
          await this.skillManager.scan();
          return full;
        },
        registerMcpServer: async (serverName, definition) => this.mcpManager.add(serverName, definition, this.workspacePath),
        onEvent: (listener) => {
          const unsubscribe = this.eventBus.subscribe(listener);
          state.cleanup.push(unsubscribe);
          return unsubscribe;
        },
      };
      const result = await activate(api);
      state.deactivate = typeof result === 'function' ? result : module.deactivate;
      state.status = 'active';
      this.eventBus?.emit('plugin.activated', { name, tools: state.registrations, skills: state.skillDirs });
      return this.list().find((item) => item.name === name);
    } catch (error) {
      for (const toolName of state.registrations) this.toolRegistry.unregister(toolName);
      for (const cleanup of state.cleanup) { try { cleanup(); } catch { /* isolated */ } }
      state.status = 'failed'; state.error = error.message;
      this.logger?.warn('Plugin activation failed', { name, error: error.stack || error.message });
      this.eventBus?.emit('plugin.failed', { name, error: error.message });
      throw error;
    }
  }

  async deactivate(name) {
    const state = this.plugins.get(name);
    if (!state) throw new Error(`Unknown plugin: ${name}`);
    if (typeof state.deactivate === 'function') await state.deactivate().catch((error) => this.logger?.warn('Plugin deactivate hook failed', { name, error: error.message }));
    for (const cleanup of state.cleanup || []) { try { cleanup(); } catch { /* isolated */ } }
    for (const toolName of state.registrations || []) this.toolRegistry.unregister(toolName);
    state.registrations = []; state.cleanup = []; state.status = 'inactive';
    this.eventBus?.emit('plugin.deactivated', { name });
    return this.list().find((item) => item.name === name);
  }

  async reload(name = null) {
    const targets = name ? [name] : [...this.plugins.keys()];
    const results = [];
    for (const target of targets) {
      const state = this.plugins.get(target);
      if (!state) continue;
      if (state.status === 'active') await this.deactivate(target);
      results.push(await this.activate(target));
    }
    return results;
  }

  async install(source, { name = null, kind = 'auto' } = {}) {
    if (!source) throw new Error('Plugin source is required');
    const root = this.roots()[0];
    await ensureDir(root);
    const inferred = safeName(name || source.split('/').pop()?.replace(/\.git$/, '') || 'plugin');
    const destination = path.join(root, inferred);
    const isGit = kind === 'git' || /^(https?:\/\/|ssh:\/\/|git@).+\.git(?:#.*)?$/.test(source);
    const isLocal = kind === 'local' || await exists(absolutePath(source));
    if (isLocal) {
      await fsp.rm(destination, { recursive: true, force: true });
      await copyTree(absolutePath(source), destination);
    } else if (isGit) {
      await fsp.rm(destination, { recursive: true, force: true });
      const result = await runCommand(`git clone --depth 1 ${shellQuote(source)} ${shellQuote(destination)}`, { timeoutMs: 300_000, maxOutputChars: 30_000 });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || `git clone exited ${result.code}`);
    } else {
      await ensureDir(destination);
      const packageFile = path.join(destination, 'package.json');
      await writeJsonAtomic(packageFile, { private: true, type: 'module' });
      const result = await runCommand(`npm install --omit=dev --ignore-scripts=false ${shellQuote(source)}`, { cwd: destination, timeoutMs: 600_000, maxOutputChars: 60_000 });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || `npm install exited ${result.code}`);
      const packageName = packageNameFromSpec(source);
      const packagePath = path.join(destination, 'node_modules', packageName);
      const packageJson = await readJson(path.join(packagePath, 'package.json'), {});
      const entry = packageJson.maskshift?.entry || exportedEntry(packageJson.exports?.['.'] ?? packageJson.exports) || packageJson.module || packageJson.main || 'index.mjs';
      if (typeof entry !== 'string') throw new Error(`Could not resolve an executable entry for npm plugin ${packageName}`);
      await writeJsonAtomic(path.join(destination, 'maskshift.plugin.json'), {
        name: inferred, version: packageJson.version || '0.0.0', description: packageJson.description || '', entry: path.relative(destination, path.resolve(packagePath, entry)),
      });
    }
    await this.scan({ activate: false });
    const plugin = this.plugins.get(inferred) || [...this.plugins.values()].find((item) => item.root === destination);
    if (!plugin) throw new Error(`Installed source did not contain a valid MaskShift plugin: ${destination}`);
    return this.activate(plugin.name);
  }

  async scaffold({ name, directory = null, description = '' }) {
    const pluginName = safeName(name);
    // `directory` names the parent to create the plugin in, so it never collides with a
    // sibling plugin and never scatters manifest files loose across a plugin root.
    const parent = directory ? absolutePath(directory, this.workspacePath) : this.roots()[0];
    const root = path.join(parent, pluginName);
    await ensureDir(root);
    await writeJsonAtomic(path.join(root, 'maskshift.plugin.json'), { name: pluginName, version: '0.1.0', description, entry: 'index.mjs' });
    await fsp.writeFile(path.join(root, 'index.mjs'), `export async function activate(api) {\n  api.registerTool({\n    name: '${pluginName.replaceAll('-', '_')}_hello',\n    title: '${pluginName} hello',\n    description: 'Example tool from ${pluginName}.',\n    category: 'plugin',\n    readOnly: true,\n    inputSchema: { type: 'object', properties: { name: { type: 'string', default: 'MaskShift' } } },\n    execute: async ({ name = 'MaskShift' }) => ({ message: \`Hello, \${name}\` }),\n  });\n}\n`, 'utf8');
    await this.scan({ activate: false });
    // A scaffold written outside a configured plugin root is invisible to scan(), so
    // register it directly rather than failing activation with "Unknown plugin".
    if (!this.plugins.has(pluginName)) {
      const manifest = await this.manifestFor(root);
      if (!manifest) throw new Error(`Scaffolded plugin is not loadable: ${root}`);
      this.plugins.set(manifest.name, { ...manifest, status: 'discovered', error: null, registrations: [], cleanup: [] });
    }
    return { root, plugin: await this.activate(pluginName) };
  }

  async close() {
    for (const item of [...this.plugins.values()]) {
      if (item.status === 'active') await this.deactivate(item.name).catch(() => {});
    }
  }
}
