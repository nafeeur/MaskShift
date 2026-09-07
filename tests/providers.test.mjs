import assert from 'node:assert/strict';
import test from 'node:test';
import { createProject, runtimeForTest, jsonServer, respondJson } from './helpers.mjs';

// A provider fixture whose responses are scripted per attempt, so a test can assert exactly
// how many times MaskShift called the endpoint.
async function scriptedProvider(t, script, providerOverrides = {}) {
  const state = { attempts: 0, retryEvents: [] };
  const server = await jsonServer(t, (request, response) => {
    const step = script[Math.min(state.attempts, script.length - 1)];
    state.attempts += 1;
    if (step.destroy) { request.destroy(); response.destroy(); return; }
    respondJson(response, step.status, step.body ?? { error: { message: 'scripted failure' } }, step.headers || {});
  });
  const project = await createProject(t, { git: false });
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture:local',
    // Keep backoff sub-millisecond: this asserts retry policy, not wall-clock patience.
    providerRetry: { attempts: 3, baseMs: 1, maxMs: 4 },
    providers: [{
      id: 'fixture', name: 'Fixture', type: 'openai-responses', baseUrl: server.url,
      apiKeyEnv: null, enabled: true, models: [{ id: 'local' }], timeoutMs: 5000,
      ...providerOverrides,
    }],
  });
  runtime.eventBus.subscribe((event) => { if (event.type === 'model.request.retrying') state.retryEvents.push(event.payload); });
  return { state, runtime, server };
}

const OK_BODY = { id: 'fixture', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'RETRY_OK' }] }] };
const ask = (runtime) => runtime.providerManager.complete({
  modelRef: 'fixture:local', messages: [{ role: 'user', content: 'ping' }], tools: [], maxTokens: 32,
});

test('provider retry', { timeout: 30_000 }, async (suite) => {
  await suite.test('retries a 503 and returns the eventual success', async (t) => {
    const { state, runtime } = await scriptedProvider(t, [
      { status: 503 },
      { status: 200, body: OK_BODY },
    ]);
    const result = await ask(runtime);
    assert.equal(result.content, 'RETRY_OK');
    assert.equal(state.attempts, 2);
  });

  await suite.test('retries a 429 and honours Retry-After', async (t) => {
    const { state, runtime } = await scriptedProvider(t, [
      { status: 429, headers: { 'Retry-After': '0' } },
      { status: 200, body: OK_BODY },
    ]);
    assert.equal((await ask(runtime)).content, 'RETRY_OK');
    assert.equal(state.attempts, 2);
    assert.equal(state.retryEvents.length, 1);
    assert.equal(state.retryEvents[0].status, 429);
    assert.equal(state.retryEvents[0].waitMs, 0);
  });

  await suite.test('retries a dropped connection', async (t) => {
    const { state, runtime } = await scriptedProvider(t, [
      { destroy: true },
      { status: 200, body: OK_BODY },
    ]);
    assert.equal((await ask(runtime)).content, 'RETRY_OK');
    assert.equal(state.attempts, 2);
    assert.equal(state.retryEvents[0].status, null);
  });

  await suite.test('never retries a 401', async (t) => {
    const { state, runtime } = await scriptedProvider(t, [{ status: 401, body: { error: { message: 'bad key' } } }]);
    await assert.rejects(ask(runtime), /401/);
    assert.equal(state.attempts, 1);
    assert.equal(state.retryEvents.length, 0);
  });

  // The tool-protocol downgrade reads a 400 body, so retrying one would delay the recovery
  // it depends on by the full backoff budget.
  await suite.test('never retries a 400', async (t) => {
    const { state, runtime } = await scriptedProvider(t, [{ status: 400, body: { error: { message: 'malformed' } } }]);
    await assert.rejects(ask(runtime), /400/);
    assert.equal(state.attempts, 1);
  });

  await suite.test('gives up after the configured attempt budget', async (t) => {
    const { state, runtime } = await scriptedProvider(t, [{ status: 500 }]);
    await assert.rejects(ask(runtime), /500/);
    assert.equal(state.attempts, 3);
    assert.equal(state.retryEvents.length, 2);
  });

  await suite.test('a per-provider retry setting overrides the global default', async (t) => {
    const { state, runtime } = await scriptedProvider(t, [{ status: 500 }], { retry: { attempts: 1 } });
    await assert.rejects(ask(runtime), /500/);
    assert.equal(state.attempts, 1);
  });

  await suite.test('a cancelled run stops retrying instead of waiting out the backoff', async (t) => {
    const { state, runtime } = await scriptedProvider(t, [{ status: 503 }], { retry: { attempts: 5, baseMs: 10_000, maxMs: 10_000 } });
    const controller = new AbortController();
    const pending = runtime.providerManager.complete({
      modelRef: 'fixture:local', messages: [{ role: 'user', content: 'ping' }], tools: [], maxTokens: 32,
      signal: controller.signal,
    });
    // Let the first attempt land and enter its backoff, then cancel.
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort(new Error('Run cancelled'));
    await assert.rejects(pending, /cancelled/i);
    assert.equal(state.attempts, 1);
  });

  await suite.test('model listing probes stay single-shot', async (t) => {
    const { state, runtime } = await scriptedProvider(t, [{ status: 503 }]);
    await runtime.providerManager.discover('fixture', { force: true }).catch(() => {});
    assert.equal(state.attempts, 1);
  });
});
