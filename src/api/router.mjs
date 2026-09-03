import { parseBool, readRequestBody, redactSecrets, sendJson } from '../core/utils.mjs';

function number(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function match(pathname, pattern) {
  const names = [];
  const expression = pattern.replace(/:[A-Za-z0-9_]+/g, (token) => {
    names.push(token.slice(1));
    return '([^/]+)';
  });
  const found = pathname.match(new RegExp(`^${expression}$`));
  if (!found) return null;
  return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(found[index + 1])]));
}

function contextFor(runtime, { workspaceId, sessionId, runId, signal } = {}) {
  const workspacePath = workspaceId ? runtime.workspaceManager.get(workspaceId).path : process.cwd();
  const scope = { workspaceId, sessionId, runId };
  return {
    workspaceId, workspacePath, sessionId, runId, signal, scope,
    eventBus: runtime.eventBus, store: runtime.store,
    capabilityState: runtime.capabilityController.createState({ runId, workspaceId }),
    planState: { summary: '', steps: [] },
  };
}

export function createApiRouter(runtime) {
  return async function route(request, response, url) {
    const method = request.method || 'GET';
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) return false;

    try {
      if (method === 'GET' && pathname === '/api/health') {
        sendJson(response, 200, { ok: true, name: 'MaskShift', version: '1.0.0', time: new Date().toISOString(), uptime: process.uptime() });
        return true;
      }

      if (method === 'GET' && pathname === '/api/events') {
        const runId = url.searchParams.get('runId');
        const sessionId = url.searchParams.get('sessionId');
        const workspaceId = url.searchParams.get('workspaceId');
        const filter = (event) => (!runId || event.runId === runId) && (!sessionId || event.sessionId === sessionId) && (!workspaceId || event.workspaceId === workspaceId);
        runtime.eventBus.connect(request, response, filter);
        return true;
      }

      if (method === 'GET' && pathname === '/api/events/recent') {
        const limit = number(url.searchParams.get('limit'), 200, 1, 5000);
        const runId = url.searchParams.get('runId');
        sendJson(response, 200, runtime.eventBus.recent(limit, runId ? (event) => event.runId === runId : null));
        return true;
      }

      if (method === 'GET' && pathname === '/api/state') {
        const lastWorkspaceId = runtime.store.getSetting('lastWorkspaceId', null);
        const workspaces = runtime.store.listWorkspaces();
        sendJson(response, 200, {
          version: '1.0.0', config: runtime.config.publicView(), lastWorkspaceId,
          workspaces, sessions: runtime.store.listSessions({ limit: 80 }),
          activeRuns: runtime.engine.listActiveRuns(), providers: runtime.providerManager.listProviders(),
          toolCount: runtime.toolRegistry.list({ includeSchema: false }).length,
          skills: runtime.skillManager.list(), mcpServers: redactSecrets(runtime.mcpManager.listServers(lastWorkspaceId)),
          plugins: runtime.pluginManager.list(), automations: runtime.automationScheduler.list({ limit: 100 }),
          browserInstances: runtime.browserManager.list(), languageServers: runtime.lspManager.list(),
          processes: runtime.processManager.list({}),
        });
        return true;
      }

      if (pathname === '/api/config') {
        if (method === 'GET') sendJson(response, 200, runtime.config.publicView());
        else if (method === 'PATCH' || method === 'PUT') sendJson(response, 200, await runtime.config.update(await readRequestBody(request) || {}));
        else return methodNotAllowed(response);
        return true;
      }

      if (method === 'GET' && pathname === '/api/logs') {
        sendJson(response, 200, await runtime.logger.tail(number(url.searchParams.get('limit'), 300, 1, 5000)));
        return true;
      }

      if (pathname === '/api/workspaces') {
        if (method === 'GET') sendJson(response, 200, runtime.store.listWorkspaces());
        else if (method === 'POST') {
          const body = await readRequestBody(request) || {};
          const workspace = await runtime.workspaceManager.open(body.path || process.cwd());
          await runtime.mcpManager.refreshDefinitions(workspace.path);
          await runtime.skillManager.setWorkspace(workspace.path);
          runtime.pluginManager.workspacePath = workspace.path;
          await runtime.pluginManager.scan({ activate: true });
          if (runtime.config.get().autoIndex && body.index !== false) void runtime.indexer.index(workspace.id).catch((error) => runtime.logger.warn('Workspace auto-index failed', { error: error.message }));
          sendJson(response, 201, workspace);
        } else return methodNotAllowed(response);
        return true;
      }

      let params = match(pathname, '/api/workspaces/:workspaceId');
      if (params && method === 'GET') {
        sendJson(response, 200, runtime.workspaceManager.get(params.workspaceId));
        return true;
      }

      params = match(pathname, '/api/workspaces/:workspaceId/inspect');
      if (params && method === 'GET') {
        sendJson(response, 200, await runtime.workspaceManager.inspect(params.workspaceId));
        return true;
      }

      params = match(pathname, '/api/workspaces/:workspaceId/tree');
      if (params && method === 'GET') {
        sendJson(response, 200, await runtime.workspaceManager.listFiles(params.workspaceId, {
          target: url.searchParams.get('path') || '.', depth: number(url.searchParams.get('depth'), 4, 0, 100),
          includeHidden: parseBool(url.searchParams.get('hidden'), false), maxEntries: number(url.searchParams.get('limit'), 5000, 1, 50000),
        }));
        return true;
      }

      params = match(pathname, '/api/workspaces/:workspaceId/file');
      if (params && method === 'GET') {
        const filePath = url.searchParams.get('path');
        if (!filePath) throw badRequest('Missing path query parameter');
        const result = await runtime.toolRegistry.execute('fs_read', {
          path: filePath, startLine: number(url.searchParams.get('startLine'), 1, 1),
          endLine: url.searchParams.has('endLine') ? number(url.searchParams.get('endLine'), undefined, 1) : undefined,
          withLineNumbers: parseBool(url.searchParams.get('lineNumbers'), true),
        }, contextFor(runtime, { workspaceId: params.workspaceId }));
        sendJson(response, 200, result);
        return true;
      }

      params = match(pathname, '/api/workspaces/:workspaceId/index');
      if (params) {
        if (method === 'GET') sendJson(response, 200, runtime.indexer.stats(params.workspaceId));
        else if (method === 'POST') sendJson(response, 202, await runtime.indexer.index(params.workspaceId, { force: true }));
        else return methodNotAllowed(response);
        return true;
      }

      params = match(pathname, '/api/workspaces/:workspaceId/search');
      if (params && method === 'GET') {
        const query = url.searchParams.get('q') || '';
        sendJson(response, 200, await runtime.indexer.search(params.workspaceId, query, number(url.searchParams.get('limit'), 20, 1, 100)));
        return true;
      }

      params = match(pathname, '/api/workspaces/:workspaceId/checkpoints');
      if (params) {
        if (method === 'GET') sendJson(response, 200, runtime.store.listCheckpoints(params.workspaceId, number(url.searchParams.get('limit'), 100, 1, 1000)));
        else if (method === 'POST') {
          const body = await readRequestBody(request) || {};
          sendJson(response, 201, await runtime.workspaceManager.createCheckpoint(params.workspaceId, { label: body.label || 'manual' }));
        } else return methodNotAllowed(response);
        return true;
      }

      params = match(pathname, '/api/workspaces/:workspaceId/checkpoints/:checkpointId/restore');
      if (params && method === 'POST') {
        const checkpoint = runtime.store.listCheckpoints(params.workspaceId, 5000).find((item) => item.id === params.checkpointId);
        if (!checkpoint) throw notFound('Checkpoint not found');
        sendJson(response, 200, await runtime.workspaceManager.restoreCheckpoint(params.workspaceId, checkpoint));
        return true;
      }

      if (pathname === '/api/sessions') {
        if (method === 'GET') sendJson(response, 200, runtime.store.listSessions({ workspaceId: url.searchParams.get('workspaceId') || undefined, limit: number(url.searchParams.get('limit'), 100, 1, 1000) }));
        else if (method === 'POST') {
          const body = await readRequestBody(request) || {};
          sendJson(response, 201, runtime.engine.createSession({ workspaceId: body.workspaceId || null, title: body.title || 'New run', modelRef: body.modelRef || null, meta: body.meta || {} }));
        } else return methodNotAllowed(response);
        return true;
      }

      params = match(pathname, '/api/sessions/:sessionId');
      if (params) {
        if (method === 'GET') {
          const session = runtime.store.getSession(params.sessionId);
          if (!session) throw notFound('Session not found');
          sendJson(response, 200, session);
        } else if (method === 'PATCH') {
          const session = runtime.store.updateSession(params.sessionId, await readRequestBody(request) || {});
          sendJson(response, 200, session);
        } else if (method === 'DELETE') {
          runtime.store.deleteSession(params.sessionId); response.writeHead(204); response.end();
        } else return methodNotAllowed(response);
        return true;
      }

      params = match(pathname, '/api/sessions/:sessionId/messages');
      if (params && method === 'GET') {
        sendJson(response, 200, runtime.store.listMessages(params.sessionId, number(url.searchParams.get('limit'), 1000, 1, 5000)));
        return true;
      }

      params = match(pathname, '/api/sessions/:sessionId/runs');
      if (params && method === 'GET') {
        sendJson(response, 200, runtime.store.listRuns({ sessionId: params.sessionId, limit: number(url.searchParams.get('limit'), 100, 1, 1000) }));
        return true;
      }

      if (pathname === '/api/runs' && method === 'POST') {
        const body = await readRequestBody(request) || {};
        const run = await runtime.engine.startRun({
          sessionId: body.sessionId || null, workspaceId: body.workspaceId || null,
          prompt: body.prompt, modelRef: body.modelRef || null, options: body.options || {},
        });
        sendJson(response, 202, run);
        return true;
      }

      if (pathname === '/api/runs/active' && method === 'GET') {
        sendJson(response, 200, runtime.engine.listActiveRuns());
        return true;
      }

      params = match(pathname, '/api/runs/:runId');
      if (params && method === 'GET') {
        const state = runtime.engine.getRunState(params.runId);
        if (!state) throw notFound('Run not found');
        sendJson(response, 200, state);
        return true;
      }

      params = match(pathname, '/api/runs/:runId/cancel');
      if (params && method === 'POST') {
        sendJson(response, 200, runtime.engine.cancel(params.runId));
        return true;
      }

      params = match(pathname, '/api/runs/:runId/events');
      if (params && method === 'GET') {
        sendJson(response, 200, runtime.store.listRunEvents(params.runId, number(url.searchParams.get('limit'), 2000, 1, 10000)));
        return true;
      }

      if (pathname === '/api/providers') {
        if (method !== 'GET') return methodNotAllowed(response);
        const discover = parseBool(url.searchParams.get('discover'), false);
        sendJson(response, 200, discover ? await runtime.providerManager.discoverAll({ force: true }) : runtime.providerManager.listProviders());
        return true;
      }

      params = match(pathname, '/api/providers/:providerId/discover');
      if (params && method === 'POST') {
        sendJson(response, 200, await runtime.providerManager.discover(params.providerId, { force: true }));
        return true;
      }

      if (pathname === '/api/tools' && method === 'GET') {
        const query = url.searchParams.get('q');
        sendJson(response, 200, query ? runtime.toolRegistry.search(query, { limit: number(url.searchParams.get('limit'), 50, 1, 500), category: url.searchParams.get('category') || null }) : runtime.toolRegistry.list({ category: url.searchParams.get('category') || null }));
        return true;
      }

      if (pathname === '/api/tools/execute' && method === 'POST') {
        const body = await readRequestBody(request) || {};
        const result = await runtime.toolRegistry.execute(body.name, body.arguments || {}, contextFor(runtime, body));
        sendJson(response, 200, result);
        return true;
      }

      if (pathname === '/api/skills' && method === 'GET') {
        const query = url.searchParams.get('q');
        sendJson(response, 200, query ? runtime.skillManager.search(query, number(url.searchParams.get('limit'), 50, 1, 500)) : runtime.skillManager.list());
        return true;
      }

      params = match(pathname, '/api/skills/:name');
      if (params && method === 'GET') {
        sendJson(response, 200, await runtime.skillManager.load(params.name));
        return true;
      }

      if (pathname === '/api/mcp/servers' && method === 'GET') {
        sendJson(response, 200, redactSecrets(runtime.mcpManager.listServers(url.searchParams.get('workspaceId') || null)));
        return true;
      }

      params = match(pathname, '/api/mcp/servers/:name/connect');
      if (params && method === 'POST') {
        const body = await readRequestBody(request) || {};
        sendJson(response, 200, redactSecrets(await runtime.mcpManager.connect(params.name, { workspaceId: body.workspaceId || null, force: Boolean(body.force) })));
        return true;
      }

      params = match(pathname, '/api/mcp/servers/:name/disconnect');
      if (params && method === 'POST') {
        const body = await readRequestBody(request) || {};
        await runtime.mcpManager.disconnect(params.name, body.workspaceId || null);
        sendJson(response, 200, { disconnected: true, name: params.name });
        return true;
      }

      params = match(pathname, '/api/mcp/servers/:name');
      if (params && method === 'DELETE') {
        await runtime.mcpManager.remove(params.name, process.cwd());
        response.writeHead(204); response.end();
        return true;
      }

      if (pathname === '/api/mcp/servers' && method === 'POST') {
        const body = await readRequestBody(request) || {};
        if (!body.name || !body.definition) throw badRequest('name and definition are required');
        sendJson(response, 201, redactSecrets(await runtime.mcpManager.add(body.name, body.definition, body.workspacePath || process.cwd())));
        return true;
      }

      if (pathname === '/api/mcp/registry' && method === 'GET') {
        sendJson(response, 200, await runtime.mcpManager.registrySearch(url.searchParams.get('q') || '', number(url.searchParams.get('limit'), 30, 1, 100)));
        return true;
      }

      if (pathname === '/api/mcp/registry/install' && method === 'POST') {
        const body = await readRequestBody(request) || {};
        const candidates = await runtime.mcpManager.registrySearch(body.registryName || '', 100);
        const item = candidates.find((candidate) => candidate.name === body.registryName) || body.item;
        if (!item) throw notFound('Registry server not found');
        sendJson(response, 201, redactSecrets(await runtime.mcpManager.installRegistry(item, { prefer: body.prefer || 'remote', workspacePath: body.workspacePath || process.cwd() })));
        return true;
      }

      if (pathname === '/api/lsp' && method === 'GET') {
        sendJson(response, 200, {
          discovered: await runtime.lspManager.discover(parseBool(url.searchParams.get('force'), false)),
          active: runtime.lspManager.list(url.searchParams.get('workspaceId') || null),
        });
        return true;
      }

      if (pathname === '/api/bridges' && method === 'GET') {
        sendJson(response, 200, await runtime.bridgeManager.discover({ force: parseBool(url.searchParams.get('force'), false) }));
        return true;
      }

      if (pathname === '/api/plugins') {
        if (method === 'GET') sendJson(response, 200, runtime.pluginManager.list());
        else if (method === 'POST') {
          const body = await readRequestBody(request) || {};
          sendJson(response, 201, await runtime.pluginManager.install(body.source, body));
        } else return methodNotAllowed(response);
        return true;
      }

      params = match(pathname, '/api/plugins/:name/:action');
      if (params && method === 'POST') {
        if (params.action === 'activate') sendJson(response, 200, await runtime.pluginManager.activate(params.name));
        else if (params.action === 'deactivate') sendJson(response, 200, await runtime.pluginManager.deactivate(params.name));
        else if (params.action === 'reload') sendJson(response, 200, await runtime.pluginManager.reload(params.name));
        else throw notFound('Plugin action not found');
        return true;
      }

      if (pathname === '/api/automations') {
        if (method === 'GET') {
          const enabled = url.searchParams.has('enabled') ? parseBool(url.searchParams.get('enabled')) : undefined;
          sendJson(response, 200, runtime.automationScheduler.list({ workspaceId: url.searchParams.get('workspaceId') || undefined, enabled, limit: number(url.searchParams.get('limit'), 500, 1, 5000) }));
        } else if (method === 'POST') {
          const body = await readRequestBody(request) || {};
          sendJson(response, 201, runtime.automationScheduler.create(body));
        } else return methodNotAllowed(response);
        return true;
      }

      params = match(pathname, '/api/automations/:automationId');
      if (params) {
        if (method === 'GET') {
          const automation = runtime.automationScheduler.get(params.automationId);
          if (!automation) throw notFound('Automation not found');
          sendJson(response, 200, automation);
        } else if (method === 'PATCH') sendJson(response, 200, runtime.automationScheduler.update(params.automationId, await readRequestBody(request) || {}));
        else if (method === 'DELETE') { runtime.automationScheduler.remove(params.automationId); response.writeHead(204); response.end(); }
        else return methodNotAllowed(response);
        return true;
      }

      params = match(pathname, '/api/automations/:automationId/run');
      if (params && method === 'POST') {
        sendJson(response, 200, await runtime.automationScheduler.execute(params.automationId, { manual: true }));
        return true;
      }

      if (pathname === '/api/browser/instances') {
        if (method === 'GET') sendJson(response, 200, runtime.browserManager.list());
        else if (method === 'POST') sendJson(response, 201, await runtime.browserManager.launch(await readRequestBody(request) || {}));
        else return methodNotAllowed(response);
        return true;
      }

      params = match(pathname, '/api/browser/instances/:instanceId');
      if (params && method === 'DELETE') {
        sendJson(response, 200, await runtime.browserManager.close(params.instanceId));
        return true;
      }

      params = match(pathname, '/api/browser/instances/:instanceId/tabs');
      if (params) {
        if (method === 'GET') sendJson(response, 200, await runtime.browserManager.tabs(params.instanceId));
        else if (method === 'POST') {
          const body = await readRequestBody(request) || {};
          sendJson(response, 201, await runtime.browserManager.newTab(params.instanceId, body.url || 'about:blank'));
        } else return methodNotAllowed(response);
        return true;
      }

      if (pathname === '/api/processes' && method === 'GET') {
        sendJson(response, 200, runtime.processManager.list({ workspaceId: url.searchParams.get('workspaceId') || undefined, runningOnly: parseBool(url.searchParams.get('runningOnly'), false) }));
        return true;
      }

      params = match(pathname, '/api/processes/:processId');
      if (params && method === 'GET') {
        sendJson(response, 200, runtime.processManager.read(params.processId, { stdoutFrom: number(url.searchParams.get('stdoutFrom'), 0), stderrFrom: number(url.searchParams.get('stderrFrom'), 0) }));
        return true;
      }

      params = match(pathname, '/api/processes/:processId/input');
      if (params && method === 'POST') {
        const body = await readRequestBody(request) || {};
        sendJson(response, 200, runtime.processManager.write(params.processId, body.input || ''));
        return true;
      }

      params = match(pathname, '/api/processes/:processId/stop');
      if (params && method === 'POST') {
        const body = await readRequestBody(request) || {};
        sendJson(response, 200, runtime.processManager.stop(params.processId, body.signal || 'SIGTERM'));
        return true;
      }

      if (pathname === '/api/terminal/exec' && method === 'POST') {
        const body = await readRequestBody(request) || {};
        const result = await runtime.toolRegistry.execute('shell_exec', {
          command: body.command, cwd: body.cwd || '.', timeoutMs: body.timeoutMs || runtime.config.get().commandTimeoutMs,
        }, contextFor(runtime, body));
        sendJson(response, 200, result);
        return true;
      }

      sendJson(response, 404, { error: 'API route not found', path: pathname });
      return true;
    } catch (error) {
      runtime.logger.warn('API request failed', { method, pathname, error: error.message });
      sendJson(response, error.statusCode || 500, { error: error.message, code: error.code || null });
      return true;
    }
  };
}

function methodNotAllowed(response) {
  sendJson(response, 405, { error: 'Method not allowed' });
  return true;
}

function withStatus(message, statusCode) {
  const error = new Error(message); error.statusCode = statusCode; return error;
}
function badRequest(message) { return withStatus(message, 400); }
function notFound(message) { return withStatus(message, 404); }
