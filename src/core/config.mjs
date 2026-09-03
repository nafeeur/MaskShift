import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { absolutePath, ensureDir, expandHome, readJson, redactSecrets, writeJsonAtomic } from './utils.mjs';

const defaultHome = expandHome(process.env.MASKSHIFT_HOME || '~/.maskshift');

function envProviderDefaults() {
  return [
    {
      id: 'ollama',
      name: 'Ollama',
      type: 'ollama',
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
      apiKeyEnv: null,
      enabled: true,
      autoDiscover: true,
      models: [],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      type: 'openai-responses',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
      enabled: true,
      autoDiscover: true,
      models: [],
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      type: 'anthropic',
      baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      enabled: true,
      autoDiscover: false,
      models: [],
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      type: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      enabled: true,
      autoDiscover: true,
      models: [],
      headers: {
        'HTTP-Referer': 'http://127.0.0.1:4242',
        'X-Title': 'MaskShift',
      },
    },
    {
      id: 'gemini',
      name: 'Google Gemini',
      type: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKeyEnv: 'GEMINI_API_KEY',
      enabled: true,
      autoDiscover: true,
      models: [],
    },
    {
      id: 'lmstudio',
      name: 'LM Studio',
      type: 'openai-compatible',
      baseUrl: process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1',
      apiKeyEnv: null,
      enabled: true,
      autoDiscover: true,
      models: [],
    },
    {
      id: 'vllm',
      name: 'vLLM / OpenAI-compatible',
      type: 'openai-compatible',
      baseUrl: process.env.VLLM_BASE_URL || 'http://127.0.0.1:8000/v1',
      apiKeyEnv: 'VLLM_API_KEY',
      enabled: Boolean(process.env.VLLM_BASE_URL),
      autoDiscover: true,
      models: [],
    },
  ];
}

export function defaultConfig() {
  const home = defaultHome;
  return {
    version: 1,
    home,
    host: process.env.MASKSHIFT_HOST || '127.0.0.1',
    port: Number(process.env.MASKSHIFT_PORT || 4242),
    autoOpen: true,
    permissionMode: 'overdrive',
    filesystemScope: 'host',
    networkAccess: 'unrestricted',
    maxAgentSteps: 96,
    maxSubagentDepth: 3,
    maxParallelSubagents: 6,
    maxToolOutputChars: 60_000,
    maxContextChars: 420_000,
    maxFileReadChars: 240_000,
    commandTimeoutMs: 300_000,
    mcpTimeoutMs: 60_000,
    autoIndex: true,
    autoCheckpoint: true,
    autoLoadCapabilities: true,
    autoConnectMcp: true,
    pluginDirs: [path.join(home, 'plugins')],
    agentBridges: {},
    automations: {
      enabled: true,
      pollIntervalMs: 1000,
      maxPerTick: 10,
    },
    browser: {
      executable: null,
      profilesDir: path.join(home, 'browser', 'profiles'),
      args: [],
    },
    indexing: {
      embeddings: true,
      embedModel: process.env.MASKSHIFT_EMBED_MODEL || 'nomic-embed-text',
      embedBatchSize: 32,
      embedMaxChunks: 4000,
    },
    defaultModel: process.env.MASKSHIFT_MODEL || 'ollama:auto',
    dataFile: path.join(home, 'maskshift.sqlite'),
    logFile: path.join(home, 'logs', 'maskshift.log'),
    auditFile: path.join(home, 'logs', 'audit.jsonl'),
    skillsDirs: [
      path.join(home, 'skills'),
      path.join(process.cwd(), '.maskshift', 'skills'),
      path.join(process.cwd(), '.agents', 'skills'),
      path.join(process.cwd(), '.claude', 'skills'),
      path.join(os.homedir(), '.codex', 'skills'),
      path.join(os.homedir(), '.claude', 'skills'),
      path.join(os.homedir(), '.copilot', 'skills'),
    ],
    contextFiles: [
      'AGENTS.md',
      'CLAUDE.md',
      'MASKSHIFT.md',
      '.github/copilot-instructions.md',
      '.cursorrules',
    ],
    providers: envProviderDefaults(),
    mcpServers: {},
    hooks: {},
    ui: {
      density: 'maximal',
      motion: true,
      telemetry: true,
      terminalHeight: 260,
    },
  };
}

function mergeById(defaultItems = [], overrideItems = []) {
  const map = new Map(defaultItems.map((item) => [item.id, { ...item }]));
  for (const item of overrideItems || []) {
    map.set(item.id, { ...(map.get(item.id) || {}), ...item });
  }
  return [...map.values()];
}

function mergeConfig(base, override) {
  const merged = { ...base, ...(override || {}) };
  merged.ui = { ...base.ui, ...(override?.ui || {}) };
  merged.hooks = { ...base.hooks, ...(override?.hooks || {}) };
  merged.mcpServers = { ...base.mcpServers, ...(override?.mcpServers || {}) };
  merged.agentBridges = { ...base.agentBridges, ...(override?.agentBridges || {}) };
  merged.automations = { ...base.automations, ...(override?.automations || {}) };
  merged.browser = { ...base.browser, ...(override?.browser || {}) };
  merged.indexing = { ...base.indexing, ...(override?.indexing || {}) };
  merged.providers = mergeById(base.providers, override?.providers);

  const baseHome = absolutePath(base.home);
  merged.home = absolutePath(override?.home || base.home);
  const homeChanged = merged.home !== baseHome;
  const explicit = (object, key) => Boolean(object && Object.hasOwn(object, key));
  const rebase = (value, suffix) => {
    const resolved = absolutePath(value);
    return homeChanged && resolved === path.join(baseHome, suffix) ? path.join(merged.home, suffix) : resolved;
  };

  merged.dataFile = absolutePath(override?.dataFile || path.join(merged.home, 'maskshift.sqlite'));
  merged.logFile = absolutePath(override?.logFile || path.join(merged.home, 'logs', 'maskshift.log'));
  merged.auditFile = absolutePath(override?.auditFile || path.join(merged.home, 'logs', 'audit.jsonl'));
  const skills = explicit(override, 'skillsDirs') ? override.skillsDirs : base.skillsDirs;
  const plugins = explicit(override, 'pluginDirs') ? override.pluginDirs : base.pluginDirs;
  merged.skillsDirs = [...new Set((skills || []).map((item) => rebase(item, 'skills')))];
  merged.pluginDirs = [...new Set((plugins || []).map((item) => rebase(item, 'plugins')))];
  const profileExplicit = explicit(override?.browser, 'profilesDir');
  const profileValue = profileExplicit ? override.browser.profilesDir : (base.browser?.profilesDir || path.join(baseHome, 'browser', 'profiles'));
  merged.browser.profilesDir = profileExplicit
    ? absolutePath(profileValue)
    : rebase(profileValue, path.join('browser', 'profiles'));
  return merged;
}

export class ConfigManager {
  constructor({ configPath, overrides = {} } = {}) {
    this.overrides = overrides || {};
    const initialHome = absolutePath(this.overrides.home || defaultHome);
    this.path = absolutePath(configPath || process.env.MASKSHIFT_CONFIG || path.join(initialHome, 'config.json'));
    this.config = null;
  }

  async load() {
    const defaults = defaultConfig();
    const existing = await readJson(this.path, {});
    this.config = mergeConfig(mergeConfig(defaults, existing), this.overrides);
    await ensureDir(this.config.home);
    await ensureDir(path.join(this.config.home, 'logs'));
    await ensureDir(path.join(this.config.home, 'skills'));
    await ensureDir(path.join(this.config.home, 'checkpoints'));
    await ensureDir(path.join(this.config.home, 'worktrees'));
    await ensureDir(path.join(this.config.home, 'cache'));
    await ensureDir(path.join(this.config.home, 'plugins'));
    await ensureDir(path.join(this.config.home, 'artifacts'));
    await ensureDir(this.config.browser.profilesDir);
    for (const directory of this.config.pluginDirs) await ensureDir(directory);
    if (!Object.keys(existing).length) await this.save();
    return this.config;
  }

  get() {
    if (!this.config) throw new Error('Configuration has not been loaded');
    return this.config;
  }

  publicView() {
    return redactSecrets(this.get());
  }

  async update(patch) {
    this.config = mergeConfig(this.get(), patch);
    await this.save();
    return this.publicView();
  }

  async save() {
    const config = this.get();
    const portable = {
      ...config,
      home: config.home,
      dataFile: config.dataFile,
      logFile: config.logFile,
      auditFile: config.auditFile,
    };
    await writeJsonAtomic(this.path, portable);
  }

  async addMcpServer(name, definition) {
    const config = this.get();
    config.mcpServers[name] = definition;
    await this.save();
    return config.mcpServers[name];
  }

  async removeMcpServer(name) {
    delete this.get().mcpServers[name];
    await this.save();
  }

  resolveSecret(providerOrServer, key = 'apiKey') {
    const value = providerOrServer?.[key];
    if (value) return value;
    const envName = providerOrServer?.[`${key}Env`] || providerOrServer?.apiKeyEnv;
    return envName ? process.env[envName] : undefined;
  }

  async reset() {
    await fs.rm(this.path, { force: true });
    return this.load();
  }
}
