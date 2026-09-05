import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli/main.mjs';
import { createProject, jsonServer, readJsonBody, respondJson, runtimeForTest, waitFor } from './helpers.mjs';

function captureStdout() {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    if (typeof encoding === 'function') encoding();
    else if (typeof callback === 'function') callback();
    return true;
  };
  return {
    text: () => chunks.join(''),
    restore: () => { process.stdout.write = original; },
  };
}

async function cli(argv) {
  const capture = captureStdout();
  try {
    const code = await main(argv);
    return { code, output: capture.text() };
  } finally {
    capture.restore();
  }
}

async function fixtureModel(t, { file = 'generated-by-agent.txt', marker = 'MASKSHIFT_AGENT_OK\n' } = {}) {
  const state = { turns: 0 };
  const server = await jsonServer(t, async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      return respondJson(response, 200, { data: [{ id: 'fixture-coder', owned_by: 'maskshift-tests' }] });
    }
    if (request.method === 'POST' && request.url === '/v1/responses') {
      const body = await readJsonBody(request);
      state.turns += 1;
      assert.equal(body.model, 'fixture-coder');
      assert.ok(body.tools.some((tool) => tool.name === 'fs_write'));
      if (!body.input.some((item) => item.type === 'function_call_output')) {
        return respondJson(response, 200, {
          id: 'resp_tool', status: 'completed',
          output: [{
            type: 'function_call', id: 'fc_1', call_id: 'call_write', name: 'fs_write',
            arguments: JSON.stringify({ path: file, content: marker }),
          }],
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        });
      }
      assert.equal(body.input.find((item) => item.type === 'function_call_output').call_id, 'call_write');
      return respondJson(response, 200, {
        id: 'resp_final', status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Implemented and verified the artifact.' }] }],
        usage: { input_tokens: 120, output_tokens: 12, total_tokens: 132 },
      });
    }
    respondJson(response, 404, { error: { message: 'not found' } });
  });
  return { state, server };
}

test('maskshift run drives the agent loop and streams a JSON result', async (t) => {
  const { state, server } = await fixtureModel(t);
  const project = await createProject(t);
  const home = path.join(project, '.maskshift-home');
  const config = path.join(home, 'config.json');
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(config, `${JSON.stringify({
    home,
    autoIndex: false,
    autoCheckpoint: false,
    automations: { enabled: false, pollIntervalMs: 10_000, maxPerTick: 1 },
    defaultModel: 'fixture:fixture-coder',
    providers: [{
      id: 'fixture', name: 'Fixture Responses', type: 'openai-responses',
      baseUrl: `${server.url}/v1`, apiKeyEnv: null, enabled: true,
      autoDiscover: true, models: [{ id: 'fixture-coder' }], timeoutMs: 15_000,
    }],
  }, null, 2)}\n`);

  const { code, output } = await cli([
    'run', 'Create the artifact and verify it.',
    '--workspace', project, '--config', config, '--model', 'fixture:fixture-coder', '--json',
  ]);

  assert.equal(code, 0);
  const report = JSON.parse(output);
  assert.equal(report.status, 'completed');
  assert.match(report.final, /Implemented and verified/);
  assert.equal(state.turns, 2);
  assert.equal(await fsp.readFile(path.join(project, 'generated-by-agent.txt'), 'utf8'), 'MASKSHIFT_AGENT_OK\n');

  const transcript = await cli(['session', 'list', '--config', config, '--workspace', project, '--json']);
  const sessions = JSON.parse(transcript.output);
  assert.equal(sessions.length, 1);

  const shown = await cli(['session', 'show', sessions[0].id, '--config', config, '--workspace', project, '--json']);
  const detail = JSON.parse(shown.output);
  assert.ok(detail.messages.some((message) => message.role === 'tool' && message.meta.toolName === 'fs_write'));
  assert.ok(detail.messages.some((message) => message.role === 'assistant' && /Implemented and verified/.test(message.content)));
});

test('the CLI exposes the full capability surface without a browser', async (t) => {
  const project = await createProject(t);
  const home = path.join(project, '.maskshift-home');
  const config = path.join(home, 'config.json');
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(config, `${JSON.stringify({
    home, autoIndex: false, autoCheckpoint: false,
    automations: { enabled: false, pollIntervalMs: 10_000, maxPerTick: 1 },
  }, null, 2)}\n`);
  const base = ['--config', config, '--workspace', project, '--json'];

  const tools = JSON.parse((await cli(['tools', 'list', ...base])).output);
  assert.ok(tools.length >= 140, `expected the full tool catalogue, saw ${tools.length}`);

  const skills = JSON.parse((await cli(['skills', 'list', ...base])).output);
  assert.ok(skills.length >= 36);

  const servers = JSON.parse((await cli(['mcp', 'list', ...base])).output);
  assert.ok(servers.length >= 1);

  const descriptor = JSON.parse((await cli(['tools', 'show', 'fs_read', ...base])).output);
  assert.equal(descriptor.name, 'fs_read');
  assert.ok(descriptor.inputSchema.properties.path);

  const executed = JSON.parse((await cli(['tools', 'run', 'shell_exec', '{"command":"printf CLI_TOOL_OK"}', ...base])).output);
  assert.equal(executed.stdout, 'CLI_TOOL_OK');

  const workspace = JSON.parse((await cli(['workspace', 'open', project, ...base, '--no-index'])).output);
  assert.equal(workspace.path, project);

  const info = JSON.parse((await cli(['workspace', 'info', ...base])).output);
  assert.equal(info.workspace.path, project);
  assert.ok(info.git.root);

  const created = JSON.parse((await cli([
    'automation', 'create', 'nightly verification',
    '--schedule', 'every 6h', '--command', 'echo ok', ...base,
  ])).output);
  assert.equal(created.enabled, true);

  const automations = JSON.parse((await cli(['automation', 'list', ...base])).output);
  assert.equal(automations.length, 1);

  await cli(['automation', 'pause', created.id, ...base]);
  assert.equal(JSON.parse((await cli(['automation', 'list', ...base])).output)[0].enabled, false);

  await cli(['automation', 'delete', created.id, ...base]);
  assert.equal(JSON.parse((await cli(['automation', 'list', ...base])).output).length, 0);

  const configured = JSON.parse((await cli(['config', 'set', 'maxAgentSteps', '42', ...base])).output);
  assert.equal(configured.maxAgentSteps, 42);

  const doctorReport = JSON.parse((await cli(['doctor', ...base])).output);
  assert.equal(doctorReport.version, '1.0.0');
  assert.ok(doctorReport.tools >= 140);
  assert.ok(doctorReport.commands.node);
});

test('unknown commands fail with guidance instead of a stack trace', async () => {
  const { code, output } = await cli(['definitely-not-a-command']);
  assert.equal(code, 2);
  assert.match(output, /Unknown command/);
});

test('the interface refuses to start without a TTY', async (t) => {
  const project = await createProject(t);
  const home = path.join(project, '.maskshift-home');
  const config = path.join(home, 'config.json');
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(config, `${JSON.stringify({ home, autoIndex: false, automations: { enabled: false, pollIntervalMs: 10_000, maxPerTick: 1 } }, null, 2)}\n`);
  const { code, output } = await cli(['tui', '--config', config, '--workspace', project]);
  assert.equal(code, 2);
  assert.match(output, /interactive terminal/);
});

test('workspace search reads back what the indexer wrote', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  await runtime.indexer.index(workspace.id, { force: true });
  const hits = await waitFor(async () => {
    const found = await runtime.indexer.search(workspace.id, 'velocity distance time', 5);
    return found.length ? found : null;
  }, { message: 'index results' });
  assert.ok(hits.some((hit) => hit.path.endsWith('index.js')));
});
