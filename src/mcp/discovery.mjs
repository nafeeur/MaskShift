import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { absolutePath, expandHome, readJson, safeJsonParse } from '../core/utils.mjs';

function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
}

async function readJsonish(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return safeJsonParse(stripJsonComments(text), null);
  } catch {
    return null;
  }
}

function normalizeServer(name, raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const transport = raw.transport || raw.type || (raw.url ? 'http' : 'stdio');
  if (transport === 'local') {
    return {
      name,
      transport: 'stdio',
      command: Array.isArray(raw.command) ? raw.command[0] : raw.command,
      args: Array.isArray(raw.command) ? raw.command.slice(1) : (raw.args || []),
      env: raw.environment || raw.env || {},
      cwd: raw.cwd,
      enabled: raw.enabled !== false,
      lazy: true,
      source,
    };
  }
  if (transport === 'remote' || ['http', 'streamable-http', 'sse'].includes(transport)) {
    return {
      name,
      transport: transport === 'remote' || transport === 'streamable-http' ? 'http' : transport,
      url: raw.url,
      headers: raw.headers || {},
      enabled: raw.enabled !== false,
      lazy: true,
      source,
    };
  }
  if (raw.command) {
    return {
      name,
      transport: 'stdio',
      command: raw.command,
      args: raw.args || [],
      env: raw.env || {},
      cwd: raw.cwd,
      enabled: raw.disabled !== true && raw.enabled !== false,
      lazy: true,
      source,
    };
  }
  return null;
}

function collectServers(container, source) {
  if (!container || typeof container !== 'object') return [];
  const values = container.mcpServers || container.servers || container.mcp || {};
  const results = [];
  for (const [name, raw] of Object.entries(values)) {
    const normalized = normalizeServer(name, raw, source);
    if (normalized) results.push(normalized);
  }
  return results;
}

function parseCodexToml(text, source) {
  const servers = [];
  const lines = text.split('\n');
  let current = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const section = line.match(/^\[mcp_servers\."?([^"\]]+)"?\]$/);
    if (section) {
      current = { name: section[1], transport: 'stdio', args: [], env: {}, enabled: true, lazy: true, source };
      servers.push(current);
      continue;
    }
    if (!current) continue;
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    let value = rawValue.trim();
    if (value.startsWith('[')) {
      try { value = JSON.parse(value.replace(/'/g, '"')); } catch { value = []; }
    } else if (/^(true|false)$/.test(value)) value = value === 'true';
    else value = value.replace(/^['"]|['"]$/g, '');
    if (key === 'url') { current.url = value; current.transport = 'http'; }
    else if (key === 'command') current.command = value;
    else if (key === 'args') current.args = value;
    else if (key === 'enabled') current.enabled = value;
    else current[key] = value;
  }
  return servers.filter((server) => server.url || server.command);
}

export async function discoverMcpServers(workspacePath = process.cwd()) {
  const home = os.homedir();
  const candidates = [
    { file: path.join(workspacePath, '.mcp.json'), type: 'json' },
    { file: path.join(workspacePath, '.vscode', 'mcp.json'), type: 'json' },
    { file: path.join(workspacePath, 'opencode.json'), type: 'json' },
    { file: path.join(workspacePath, 'opencode.jsonc'), type: 'json' },
    { file: path.join(workspacePath, '.cursor', 'mcp.json'), type: 'json' },
    { file: path.join(home, '.claude.json'), type: 'json' },
    { file: path.join(home, '.claude', 'settings.json'), type: 'json' },
    { file: path.join(home, '.cursor', 'mcp.json'), type: 'json' },
    { file: path.join(home, '.config', 'opencode', 'opencode.json'), type: 'json' },
    { file: path.join(home, '.config', 'opencode', 'opencode.jsonc'), type: 'json' },
    { file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), type: 'json' },
    { file: path.join(home, '.copilot', 'mcp-config.json'), type: 'json' },
    { file: path.join(home, '.codex', 'config.toml'), type: 'toml' },
  ];

  const discovered = [];
  for (const candidate of candidates) {
    try {
      if (candidate.type === 'toml') {
        const text = await fsp.readFile(candidate.file, 'utf8');
        discovered.push(...parseCodexToml(text, candidate.file));
      } else {
        const data = await readJsonish(candidate.file);
        discovered.push(...collectServers(data, candidate.file));
      }
    } catch { /* absent or malformed config */ }
  }

  const unique = new Map();
  for (const server of discovered) {
    let name = server.name;
    let suffix = 2;
    while (unique.has(name) && JSON.stringify(unique.get(name)) !== JSON.stringify(server)) name = `${server.name}-${suffix++}`;
    unique.set(name, { ...server, name });
  }
  return [...unique.values()];
}

export const curatedMcpCatalog = [
  {
    name: 'openai-docs',
    title: 'OpenAI Developer Docs',
    description: 'Search and read official OpenAI developer documentation.',
    transport: 'http',
    url: 'https://developers.openai.com/mcp',
    keywords: ['openai', 'api', 'codex', 'chatgpt', 'responses', 'models', 'documentation'],
    enabled: true,
    lazy: true,
    source: 'curated',
  },
  {
    name: 'context7',
    title: 'Context7 Library Documentation',
    description: 'Current library and framework documentation with version-aware examples.',
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    keywords: ['docs', 'library', 'framework', 'api', 'examples', 'npm', 'python'],
    enabled: true,
    lazy: true,
    source: 'curated',
  },
  {
    name: 'playwright',
    title: 'Playwright Browser Automation',
    description: 'Browser navigation, interaction, screenshots, accessibility snapshots, and UI testing.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--headless'],
    keywords: ['browser', 'web', 'playwright', 'screenshot', 'ui', 'test', 'automation'],
    enabled: true,
    lazy: true,
    source: 'curated',
  },
  {
    name: 'filesystem-mcp',
    title: 'MCP Filesystem',
    description: 'Standard MCP filesystem server. MaskShift already has native host filesystem tools; use for compatibility tests.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
    keywords: ['filesystem', 'files', 'directories', 'mcp compatibility'],
    enabled: false,
    lazy: true,
    source: 'curated',
  },
  {
    name: 'memory-mcp',
    title: 'MCP Knowledge Graph Memory',
    description: 'Standard persistent knowledge graph memory server.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    keywords: ['memory', 'knowledge graph', 'entities', 'relations'],
    enabled: true,
    lazy: true,
    source: 'curated',
  },
  {
    name: 'sequential-thinking',
    title: 'Sequential Thinking',
    description: 'Structured multi-step reasoning tool for complex planning and revision.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    keywords: ['reasoning', 'planning', 'thinking', 'analysis'],
    enabled: true,
    lazy: true,
    source: 'curated',
  },
  {
    name: 'git-mcp',
    title: 'MCP Git',
    description: 'Git repository inspection and operations through the standard Python MCP server.',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git'],
    keywords: ['git', 'history', 'branch', 'commit', 'diff'],
    enabled: false,
    lazy: true,
    source: 'curated',
  },
  {
    name: 'fetch-mcp',
    title: 'MCP Fetch',
    description: 'Retrieve and convert web content for language models.',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    keywords: ['fetch', 'web', 'url', 'http', 'content'],
    enabled: true,
    lazy: true,
    source: 'curated',
  },
];
