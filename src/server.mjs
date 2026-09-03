import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRuntime } from './runtime.mjs';
import { createApiRouter } from './api/router.mjs';
import { commandExists, contentType, parseArgs, VERSION } from './core/utils.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

function printHelp() {
  console.log(`
MASKSHIFT ${VERSION} // MAXIMALIST CODING HARNESS

Usage:
  maskshift [serve] [--workspace PATH] [--host HOST] [--port PORT] [--no-open]
  maskshift run "PROMPT" [--workspace PATH] [--model PROVIDER:MODEL]
  maskshift doctor [--json]

Environment:
  MASKSHIFT_HOME, MASKSHIFT_CONFIG, MASKSHIFT_HOST, MASKSHIFT_PORT, MASKSHIFT_MODEL
  OLLAMA_BASE_URL, OPENAI_BASE_URL, OPENAI_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY
  OPENROUTER_API_KEY, GEMINI_API_KEY, LMSTUDIO_BASE_URL, VLLM_BASE_URL, VLLM_API_KEY
`);
}

async function openBrowser(url) {
  const commands = process.platform === 'win32'
    ? [['cmd', ['/c', 'start', '', url]]]
    : process.platform === 'darwin'
      ? [['open', [url]]]
      : [['xdg-open', [url]], ['gio', ['open', url]]];
  for (const [command, args] of commands) {
    if (process.platform !== 'win32' && !await commandExists(command)) continue;
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    } catch { /* try next */ }
  }
  return false;
}

async function staticFile(response, pathname, method = 'GET') {
  const requested = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try { decoded = decodeURIComponent(requested); } catch { return false; }
  const file = path.resolve(PUBLIC, `.${decoded}`);
  if (file !== PUBLIC && !file.startsWith(`${PUBLIC}${path.sep}`)) return false;
  let stat;
  try { stat = await fsp.stat(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const body = await fsp.readFile(file);
  response.writeHead(200, {
    'Content-Type': contentType(file),
    'Content-Length': body.length,
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(method === 'HEAD' ? undefined : body);
  return true;
}

export async function startServer(runtime, { host, port, autoOpen = true } = {}) {
  const api = createApiRouter(runtime);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      if (await api(request, response, url)) return;
      if (['GET', 'HEAD'].includes(request.method) && await staticFile(response, url.pathname, request.method)) return;
      if (request.method === 'GET' && !path.extname(url.pathname) && await staticFile(response, '/index.html', request.method)) return;
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('MaskShift route not found');
    } catch (error) {
      runtime.logger.error('HTTP handler failed', { error: error.stack || error.message });
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });

  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  server.requestTimeout = 0;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${browserHost}:${actualPort}`;
  runtime.logger.info('MaskShift server started', { host, port: actualPort, url });
  console.log(`\n  MASKSHIFT // OVERDRIVE ONLINE\n  ${url}\n  tools=${runtime.toolRegistry.list().length} skills=${runtime.skillManager.list().length} mcp=${runtime.mcpManager.listServers().length}\n`);
  if (autoOpen) void openBrowser(url);
  return { server, url, port: actualPort };
}

async function doctor(runtime, json = false) {
  const commands = ['git', 'rg', 'node', 'npm', 'python3', 'docker', 'podman', 'npx', 'uvx', 'gh'];
  const commandMap = Object.fromEntries(await Promise.all(commands.map(async (command) => [command, await commandExists(command)])));
  const providers = await runtime.providerManager.discoverAll({ force: true });
  const report = {
    ok: true,
    version: VERSION,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    home: runtime.config.get().home,
    database: runtime.config.get().dataFile,
    permissionMode: runtime.config.get().permissionMode,
    commands: commandMap,
    providers,
    tools: runtime.toolRegistry.list({ includeSchema: false }).length,
    skills: runtime.skillManager.list().length,
    mcpServers: runtime.mcpManager.listServers().length,
  };
  report.ok = Boolean(commandMap.git && commandMap.node) && providers.some((provider) => provider.status === 'online');
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`MASKSHIFT DOCTOR ${report.ok ? 'PASS' : 'ATTENTION'}\n`);
    console.log(`Node: ${report.node} | ${report.platform}`);
    console.log(`Home: ${report.home}`);
    console.log(`Mode: ${report.permissionMode}`);
    console.log(`Tools: ${report.tools} | Skills: ${report.skills} | MCP catalog: ${report.mcpServers}`);
    console.log('\nCommands:');
    for (const [name, value] of Object.entries(commandMap)) console.log(`  ${value ? '✓' : '·'} ${name}${value ? ` -> ${value}` : ''}`);
    console.log('\nProviders:');
    for (const provider of providers) console.log(`  ${provider.status === 'online' ? '✓' : '·'} ${provider.id}: ${provider.status}${provider.error ? ` (${provider.error})` : ''}`);
  }
  return report;
}

async function runHeadless(runtime, args) {
  const prompt = args._.slice(1).join(' ') || args.prompt;
  if (!prompt) throw new Error('Headless run requires a prompt');
  const workspace = await runtime.workspaceManager.open(args.workspace || process.cwd());
  const session = runtime.engine.createSession({ workspaceId: workspace.id, title: prompt.slice(0, 78), modelRef: args.model || null });
  const run = await runtime.engine.startRun({ sessionId: session.id, workspaceId: workspace.id, prompt, modelRef: args.model || null, options: { source: 'cli' } });
  console.log(`MaskShift run ${run.id} started with ${run.model_id}`);
  const completed = await runtime.engine.waitForRun(run.id);
  const final = [...runtime.store.listMessages(session.id, 1000)].reverse().find((message) => message.role === 'assistant' && message.content);
  if (final?.content) console.log(`\n${final.content}\n`);
  if (completed.status !== 'completed') {
    console.error(`Run ended with status ${completed.status}: ${completed.error || ''}`);
    process.exitCode = 1;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || 'serve';
  if (args.help || args.h || command === 'help') { printHelp(); return; }
  if (args.version || args.v) { console.log(VERSION); return; }

  const workspacePath = args.workspace || process.cwd();
  const runtime = await createRuntime({ configPath: args.config, workspacePath });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await runtime.close().catch(() => {});
  };

  if (command === 'doctor') {
    try { await doctor(runtime, Boolean(args.json)); } finally { await close(); }
    return;
  }
  if (command === 'run') {
    try { await runHeadless(runtime, args); } finally { await close(); }
    return;
  }
  if (!['serve', 'start'].includes(command)) {
    await close();
    throw new Error(`Unknown command: ${command}`);
  }

  let workspace = null;
  try { workspace = await runtime.workspaceManager.open(workspacePath); } catch (error) { runtime.logger.warn('Startup workspace could not be opened', { error: error.message }); }
  if (workspace && runtime.config.get().autoIndex) void runtime.indexer.index(workspace.id).catch(() => {});
  const host = args.host || runtime.config.get().host;
  const port = Number(args.port || runtime.config.get().port);
  const autoOpen = !args['no-open'] && runtime.config.get().autoOpen !== false;
  const { server } = await startServer(runtime, { host, port, autoOpen });

  const shutdown = async (signal) => {
    console.log(`\nMaskShift received ${signal}; shutting down.`);
    await new Promise((resolve) => server.close(resolve));
    await close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
