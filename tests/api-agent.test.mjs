import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { startServer } from '../src/server.mjs';
import { createProject, jsonServer, readJsonBody, respondJson, runtimeForTest, waitFor } from './helpers.mjs';

test('HTTP cockpit API and OpenAI Responses agent loop operate end to end', async (t) => {
  let modelTurns = 0;
  const modelServer = await jsonServer(t, async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      return respondJson(response, 200, { data: [{ id: 'fixture-coder', owned_by: 'maskshift-tests' }] });
    }
    if (request.method === 'POST' && request.url === '/v1/responses') {
      const body = await readJsonBody(request);
      modelTurns += 1;
      assert.equal(body.model, 'fixture-coder');
      assert.ok(Array.isArray(body.tools) && body.tools.some((tool) => tool.name === 'fs_write'));
      const hasToolOutput = body.input.some((item) => item.type === 'function_call_output');
      if (!hasToolOutput) {
        return respondJson(response, 200, {
          id: 'resp_tool', status: 'completed',
          output: [{
            type: 'function_call', id: 'fc_1', call_id: 'call_write', name: 'fs_write',
            arguments: JSON.stringify({ path: 'generated-by-agent.txt', content: 'MASKSHIFT_AGENT_OK\n' }),
          }],
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        });
      }
      const output = body.input.find((item) => item.type === 'function_call_output');
      assert.equal(output.call_id, 'call_write');
      return respondJson(response, 200, {
        id: 'resp_final', status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Implemented and verified generated-by-agent.txt.' }] }],
        usage: { input_tokens: 120, output_tokens: 12, total_tokens: 132 },
      });
    }
    respondJson(response, 404, { error: { message: 'not found' } });
  });

  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture:fixture-coder',
    providers: [{
      id: 'fixture', name: 'Fixture Responses', type: 'openai-responses',
      baseUrl: `${modelServer.url}/v1`, apiKeyEnv: null, enabled: true,
      autoDiscover: true, models: [{ id: 'fixture-coder' }], timeoutMs: 15_000,
    }],
  });
  const started = await startServer(runtime, { host: '127.0.0.1', port: 0, autoOpen: false });
  t.after(async () => new Promise((resolve) => started.server.close(resolve)));

  const healthResponse = await fetch(`${started.url}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).name, 'MaskShift');

  const head = await fetch(`${started.url}/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.match(head.headers.get('content-type'), /text\/html/);
  assert.equal(await head.text(), '');

  const state = await (await fetch(`${started.url}/api/state`)).json();
  assert.ok(state.toolCount >= 140);
  assert.ok(state.skills.length >= 36);
  assert.equal(state.config.permissionMode, 'overdrive');

  const workspaceResponse = await fetch(`${started.url}/api/workspaces`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: project, index: false }),
  });
  assert.equal(workspaceResponse.status, 201);
  const workspace = await workspaceResponse.json();

  const runResponse = await fetch(`${started.url}/api/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: workspace.id,
      prompt: 'Create generated-by-agent.txt and verify its contents.',
      modelRef: 'fixture:fixture-coder',
    }),
  });
  assert.equal(runResponse.status, 202);
  const run = await runResponse.json();

  const completed = await waitFor(async () => {
    const value = await (await fetch(`${started.url}/api/runs/${run.id}`)).json();
    return ['completed', 'failed', 'cancelled', 'max_steps'].includes(value.status) ? value : null;
  }, { timeoutMs: 15_000, message: 'agent completion' });
  assert.equal(completed.status, 'completed', completed.error || 'agent should complete');
  assert.equal(modelTurns, 2);
  assert.equal(await fsp.readFile(path.join(project, 'generated-by-agent.txt'), 'utf8'), 'MASKSHIFT_AGENT_OK\n');

  const messages = await (await fetch(`${started.url}/api/sessions/${run.session_id}/messages`)).json();
  assert.ok(messages.some((message) => message.role === 'tool' && message.meta.toolName === 'fs_write'));
  assert.ok(messages.some((message) => message.role === 'assistant' && /Implemented and verified/.test(message.content)));

  const terminal = await fetch(`${started.url}/api/terminal/exec`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id, command: 'printf API_TERMINAL_OK' }),
  });
  assert.equal(terminal.status, 200);
  assert.equal((await terminal.json()).stdout, 'API_TERMINAL_OK');

  const malformed = await fetch(`${started.url}/%zz.js`);
  assert.equal(malformed.status, 404);
});
