import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EventBus } from '../src/core/events.mjs';
import { StdioMcpClient } from '../src/mcp/jsonrpc-client.mjs';
import { createProject, runtimeForTest } from './helpers.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures-mcp-server.mjs');
const logger = { debug() {}, warn() {}, audit() {} };

for (const mode of ['modern', 'legacy']) {
  test(`stdio MCP client negotiates ${mode} protocol and exposes all primitives`, async (t) => {
    const client = new StdioMcpClient({ name: `${mode}-fixture`, command: process.execPath, args: [fixture, mode] }, {
      logger, eventBus: new EventBus(), workspaceRoot: process.cwd(),
    });
    t.after(async () => client.close());
    const summary = await client.start();
    assert.equal(summary.era, mode);
    assert.equal(summary.protocolVersion, mode === 'modern' ? '2026-07-28' : '2025-11-25');
    assert.equal((await client.listTools())[0].name, 'echo');
    assert.deepEqual((await client.callTool('echo', { speed: 9000 })).structuredContent, { speed: 9000 });
    assert.equal((await client.listResources())[0].uri, 'fixture://status');
    assert.equal((await client.readResource('fixture://status')).contents[0].text, 'MCP_RESOURCE_OK');
    assert.equal((await client.listPrompts())[0].name, 'verify');
    assert.equal((await client.getPrompt('verify')).messages[0].content.text, 'VERIFY_OK');
  });
}

test('MCP manager lazily connects and dispatches qualified tools', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    mcpServers: {
      fixture: {
        title: 'Fixture MCP',
        transport: 'stdio',
        command: process.execPath,
        args: [fixture, 'modern'],
        enabled: true,
        lazy: true,
      },
    },
  });
  const workspace = await runtime.workspaceManager.open(project);
  const before = runtime.mcpManager.status('fixture', workspace.id);
  assert.notEqual(before.status, 'connected');
  const connected = await runtime.mcpManager.connect('fixture', { workspaceId: workspace.id });
  assert.equal(connected.status, 'connected');
  const qualified = connected.tools[0].qualifiedName;
  assert.equal(qualified, 'mcp__fixture__echo');
  const value = await runtime.mcpManager.callQualified(qualified, { rpm: 12000 }, { workspaceId: workspace.id });
  assert.deepEqual(value.structuredContent, { rpm: 12000 });
});
