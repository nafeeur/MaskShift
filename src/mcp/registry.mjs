import { truncate } from '../core/utils.mjs';

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers';

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizeHeaderSpec(headers = []) {
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map((item) => [item.name, item.isSecret ? `\${${item.name}}` : (item.value || '')]));
  }
  return headers || {};
}

export class McpRegistryClient {
  constructor({ logger } = {}) {
    this.logger = logger;
    this.cache = new Map();
  }

  async search(query = '', limit = 30) {
    const key = `${query}:${limit}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
    const url = new URL(REGISTRY_URL);
    if (query) url.searchParams.set('search', query);
    url.searchParams.set('version', 'latest');
    url.searchParams.set('limit', String(Math.min(100, Math.max(1, limit))));
    const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'MaskShift/1.0' } });
    if (!response.ok) throw new Error(`MCP Registry returned HTTP ${response.status}`);
    const data = await response.json();
    const values = (data.servers || []).map((entry) => this.normalize(entry)).filter(Boolean);
    this.cache.set(key, { at: Date.now(), value: values });
    return values;
  }

  normalize(entry) {
    const server = entry.server || entry;
    if (!server?.name) return null;
    const metadata = entry._meta?.['io.modelcontextprotocol.registry/official'] || entry._meta || {};
    return {
      name: server.name,
      title: server.title || server.name,
      description: server.description || '',
      version: server.version || metadata.version || 'latest',
      websiteUrl: server.websiteUrl || server.repository?.url || null,
      icons: server.icons || [],
      remotes: server.remotes || [],
      packages: server.packages || [],
      status: metadata.status || 'active',
      publishedAt: metadata.publishedAt || null,
      updatedAt: metadata.updatedAt || null,
      raw: entry,
    };
  }

  toDefinition(item, { prefer = 'remote' } = {}) {
    const slug = item.name.split('/').pop().replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
    const remote = item.remotes?.find((candidate) => ['streamable-http', 'http'].includes(candidate.type)) || item.remotes?.[0];
    const pkg = item.packages?.[0];
    if (remote && (prefer === 'remote' || !pkg)) {
      return {
        name: slug,
        title: item.title,
        description: item.description,
        transport: remote.type === 'sse' ? 'sse' : 'http',
        url: remote.url,
        headers: normalizeHeaderSpec(remote.headers),
        enabled: true,
        lazy: true,
        source: 'official-registry',
        registryName: item.name,
        registryVersion: item.version,
      };
    }
    if (!pkg) throw new Error(`Registry entry ${item.name} has no installable package or remote endpoint`);
    const type = first(pkg.registryType, pkg.registry, pkg.type, '').toLowerCase();
    const identifier = first(pkg.identifier, pkg.name, pkg.package, pkg.url);
    const version = first(pkg.version, item.version, 'latest');
    const runtimeArgs = (pkg.runtimeArguments || pkg.packageArguments || pkg.arguments || [])
      .map((arg) => typeof arg === 'string' ? arg : first(arg.value, arg.default, arg.name))
      .filter(Boolean);
    const env = Object.fromEntries((pkg.environmentVariables || pkg.env || []).map((item) => [
      item.name,
      item.default || `\${${item.name}}`,
    ]));

    let command;
    let args;
    if (type.includes('npm') || String(identifier).startsWith('npm:')) {
      const packageName = String(identifier).replace(/^npm:/, '');
      command = 'npx'; args = ['-y', `${packageName}@${version}`, ...runtimeArgs];
    } else if (type.includes('pypi') || type.includes('python') || String(identifier).startsWith('pypi:')) {
      const packageName = String(identifier).replace(/^pypi:/, '');
      command = 'uvx'; args = [`${packageName}==${version}`, ...runtimeArgs];
    } else if (type.includes('oci') || type.includes('docker')) {
      command = 'docker'; args = ['run', '--rm', '-i', `${identifier}${version && version !== 'latest' ? `:${version}` : ''}`, ...runtimeArgs];
    } else if (type.includes('nuget')) {
      command = 'dnx'; args = [`${identifier}@${version}`, ...runtimeArgs];
    } else {
      throw new Error(`Unsupported registry package type '${type || 'unknown'}' for ${item.name}`);
    }
    return {
      name: slug,
      title: item.title,
      description: item.description,
      transport: 'stdio',
      command,
      args,
      env,
      enabled: true,
      lazy: true,
      source: 'official-registry',
      registryName: item.name,
      registryVersion: item.version,
    };
  }
}
