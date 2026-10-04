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

// More public servers, each checked against its npm/PyPI package or live endpoint. They are catalogue entries only:
// nothing starts or connects until a run (or you) activates one. Servers that need a credential are disabled and say
// which environment variable to set; OAuth-only hosted servers go through `mcp-remote`, which opens a browser to sign in.
const remote = (name, title, url, description, keywords, extra = {}) => ({
  name, title, description, transport: 'http', url, keywords, enabled: extra.requires || extra.oauth ? false : true, lazy: true, source: 'curated', ...extra,
});
const stdio = (name, title, command, args, description, keywords, extra = {}) => ({
  name, title, description, transport: 'stdio', command, args, keywords, enabled: extra.requires ? false : true, lazy: true, source: 'curated', ...extra,
});
const bearer = (variable) => ({ Authorization: `Bearer \${${variable}}` });
const needs = (variables) => `Needs ${variables.join(', ')} in your environment.`;
const viaRemote = (name, title, url, description, keywords) => stdio(
  name, title, 'npx', ['-y', 'mcp-remote', url], `${description} Signs in through your browser on first connect.`, keywords, { enabled: false, oauth: true },
);

export const publicMcpCatalog = [
  // Public, no sign-in.
  remote('deepwiki', 'DeepWiki', 'https://mcp.deepwiki.com/mcp', 'Ask questions about any public GitHub repository and read its generated documentation.', ['github', 'repository', 'wiki', 'code', 'docs', 'open source']),
  remote('microsoft-learn', 'Microsoft Learn', 'https://learn.microsoft.com/api/mcp', 'Search and read official Microsoft, Azure and .NET documentation.', ['microsoft', 'azure', 'dotnet', 'windows', 'docs', 'powershell']),
  remote('huggingface', 'Hugging Face', 'https://huggingface.co/mcp', 'Search models, datasets, Spaces and papers on the Hugging Face Hub.', ['models', 'datasets', 'ml', 'ai', 'papers', 'spaces']),
  remote('cloudflare-docs', 'Cloudflare Docs', 'https://docs.mcp.cloudflare.com/mcp', 'Search the Cloudflare developer documentation.', ['cloudflare', 'workers', 'dns', 'cdn', 'docs']),
  remote('exa', 'Exa Search', 'https://mcp.exa.ai/mcp', 'Web and code search built for language models.', ['search', 'web', 'research', 'code search']),
  remote('gitmcp', 'GitMCP', 'https://gitmcp.io/docs', 'Read the docs and code of any GitHub project as context (change the URL to gitmcp.io/OWNER/REPO to pin one).', ['github', 'docs', 'repository', 'readme']),
  stdio('time-mcp', 'MCP Time', 'uvx', ['mcp-server-time'], 'Current time and timezone conversion.', ['time', 'timezone', 'date', 'clock']),
  stdio('chrome-devtools', 'Chrome DevTools', 'npx', ['-y', 'chrome-devtools-mcp@latest', '--headless'], 'Drive and debug Chrome: performance traces, network, console, DOM and screenshots.', ['chrome', 'devtools', 'performance', 'browser', 'debug', 'lighthouse']),
  stdio('markitdown', 'MarkItDown', 'uvx', ['markitdown-mcp'], 'Convert PDF, Word, Excel, PowerPoint, HTML and images to Markdown.', ['pdf', 'docx', 'xlsx', 'convert', 'markdown', 'documents']),
  stdio('duckduckgo', 'DuckDuckGo Search', 'uvx', ['duckduckgo-mcp-server'], 'Keyless web search and page fetching.', ['search', 'web', 'duckduckgo']),
  stdio('svelte', 'Svelte', 'npx', ['-y', '@sveltejs/mcp'], 'Svelte and SvelteKit documentation and code checking.', ['svelte', 'sveltekit', 'frontend', 'docs']),
  stdio('everything-mcp', 'MCP Everything (test server)', 'npx', ['-y', '@modelcontextprotocol/server-everything'], 'Reference server that exercises every MCP feature, for testing clients.', ['test', 'reference', 'compatibility'], { enabled: false }),
  stdio('docker-mcp', 'Docker', 'uvx', ['mcp-server-docker'], 'Manage Docker containers, images, volumes and networks.', ['docker', 'container', 'image', 'compose'], { enabled: false }),
  stdio('sqlite-mcp', 'SQLite', 'uvx', ['mcp-server-sqlite', '--db-path', './data.db'], 'Query and modify a SQLite database (edit the path in the definition).', ['sqlite', 'sql', 'database'], { enabled: false }),

  // Token in the environment.
  remote('github', 'GitHub', 'https://api.githubcopilot.com/mcp/', `Repositories, issues, pull requests, code search and Actions. ${needs(['GITHUB_TOKEN'])}`, ['github', 'issues', 'pull request', 'repo', 'actions', 'code review'], { headers: bearer('GITHUB_TOKEN'), requires: ['GITHUB_TOKEN'] }),
  remote('linear', 'Linear', 'https://mcp.linear.app/mcp', `Issues, projects and cycles. ${needs(['LINEAR_API_KEY'])}`, ['linear', 'issues', 'tickets', 'project management'], { headers: bearer('LINEAR_API_KEY'), requires: ['LINEAR_API_KEY'] }),
  remote('stripe', 'Stripe', 'https://mcp.stripe.com', `Customers, payments, subscriptions and docs. ${needs(['STRIPE_API_KEY'])} Use a restricted key.`, ['stripe', 'payments', 'billing', 'subscriptions'], { headers: bearer('STRIPE_API_KEY'), requires: ['STRIPE_API_KEY'] }),
  remote('supabase', 'Supabase', 'https://mcp.supabase.com/mcp', `Projects, tables, SQL, migrations and logs. ${needs(['SUPABASE_ACCESS_TOKEN'])}`, ['supabase', 'postgres', 'database', 'backend'], { headers: bearer('SUPABASE_ACCESS_TOKEN'), requires: ['SUPABASE_ACCESS_TOKEN'] }),
  remote('apify', 'Apify', 'https://mcp.apify.com', `Run thousands of web scraping and automation Actors. ${needs(['APIFY_TOKEN'])}`, ['scraping', 'apify', 'crawl', 'automation', 'web data'], { headers: bearer('APIFY_TOKEN'), requires: ['APIFY_TOKEN'] }),
  stdio('brave-search', 'Brave Search', 'npx', ['-y', '@modelcontextprotocol/server-brave-search'], `Web and local search. ${needs(['BRAVE_API_KEY'])}`, ['search', 'web', 'brave'], { env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' }, requires: ['BRAVE_API_KEY'] }),
  stdio('tavily', 'Tavily', 'npx', ['-y', 'tavily-mcp@latest'], `Search, extract and crawl the web for research. ${needs(['TAVILY_API_KEY'])}`, ['search', 'research', 'crawl', 'extract'], { env: { TAVILY_API_KEY: '${TAVILY_API_KEY}' }, requires: ['TAVILY_API_KEY'] }),
  stdio('firecrawl', 'Firecrawl', 'npx', ['-y', 'firecrawl-mcp'], `Scrape, crawl and extract structured data from websites. ${needs(['FIRECRAWL_API_KEY'])}`, ['scrape', 'crawl', 'web', 'extract'], { env: { FIRECRAWL_API_KEY: '${FIRECRAWL_API_KEY}' }, requires: ['FIRECRAWL_API_KEY'] }),
  stdio('notion-api', 'Notion (integration token)', 'npx', ['-y', '@notionhq/notion-mcp-server'], `Pages, databases and comments through a Notion integration. ${needs(['NOTION_TOKEN'])}`, ['notion', 'notes', 'wiki', 'database'], { env: { NOTION_TOKEN: '${NOTION_TOKEN}' }, requires: ['NOTION_TOKEN'] }),
  stdio('figma-api', 'Figma (access token)', 'npx', ['-y', 'figma-developer-mcp', '--stdio'], `Read Figma files, frames and styles to build UI from designs. ${needs(['FIGMA_API_KEY'])}`, ['figma', 'design', 'ui', 'frames'], { env: { FIGMA_API_KEY: '${FIGMA_API_KEY}' }, requires: ['FIGMA_API_KEY'] }),
  stdio('mapbox', 'Mapbox', 'npx', ['-y', '@mapbox/mcp-server'], `Geocoding, directions, isochrones and static maps. ${needs(['MAPBOX_ACCESS_TOKEN'])}`, ['maps', 'geocoding', 'directions', 'places'], { env: { MAPBOX_ACCESS_TOKEN: '${MAPBOX_ACCESS_TOKEN}' }, requires: ['MAPBOX_ACCESS_TOKEN'] }),

  // Hosted, OAuth sign-in in the browser.
  viaRemote('notion', 'Notion', 'https://mcp.notion.com/mcp', 'Search and edit your Notion workspace.', ['notion', 'notes', 'wiki', 'docs']),
  viaRemote('sentry', 'Sentry', 'https://mcp.sentry.dev/mcp', 'Errors, issues, releases and traces.', ['sentry', 'errors', 'monitoring', 'crash', 'traces']),
  viaRemote('atlassian', 'Atlassian (Jira & Confluence)', 'https://mcp.atlassian.com/v1/mcp', 'Jira issues and Confluence pages.', ['jira', 'confluence', 'atlassian', 'tickets', 'wiki']),
  viaRemote('asana', 'Asana', 'https://mcp.asana.com/v2/mcp', 'Tasks, projects and goals.', ['asana', 'tasks', 'projects', 'planning']),
  viaRemote('vercel', 'Vercel', 'https://mcp.vercel.com', 'Projects, deployments and logs.', ['vercel', 'deploy', 'hosting', 'logs']),
  viaRemote('figma', 'Figma', 'https://mcp.figma.com/mcp', 'Designs, components and variables.', ['figma', 'design', 'ui', 'components']),
  viaRemote('neon', 'Neon', 'https://mcp.neon.tech/mcp', 'Serverless Postgres projects, branches and SQL.', ['neon', 'postgres', 'database', 'sql']),
  viaRemote('hubspot', 'HubSpot', 'https://mcp.hubspot.com', 'CRM contacts, companies and deals.', ['hubspot', 'crm', 'sales', 'contacts']),
  viaRemote('paypal', 'PayPal', 'https://mcp.paypal.com/mcp', 'Invoices, orders and transactions.', ['paypal', 'payments', 'invoices']),
  viaRemote('canva', 'Canva', 'https://mcp.canva.com/mcp', 'Create and edit Canva designs.', ['canva', 'design', 'graphics', 'presentations']),
];

curatedMcpCatalog.push(...publicMcpCatalog);
