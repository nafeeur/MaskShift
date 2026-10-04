import assert from 'node:assert/strict';
import test from 'node:test';
import { elideStaleToolResults } from '../src/agent/context-budget.mjs';
import {
  DEFAULT_CONTEXT_WINDOW, familyContextWindow, outputTokensFor, parameterBillions, parseContextOverflow, tierFor,
} from '../src/agent/model-profile.mjs';
import {
  createProject, isDiscoveryProbe, jsonServer, readJsonBody, respondJson, respondOpenAIChatSSE, runtimeForTest, waitFor,
} from './helpers.mjs';

test('parseContextOverflow reads the limit from each provider\'s wording', () => {
  const cases = [
    ["This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.", 8192],
    ['prompt is too long: 210432 tokens > 200000 maximum', 200000],
    ['input length and `max_tokens` exceed context limit: 187254 + 20000 > 200000, decrease input length', 200000],
    ['The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).', 1048576],
    ['the request exceeds the available context size (4096 tokens), try increasing it', 4096],
    ['Trying to keep the first 5000 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens', 4096],
  ];
  for (const [message, limit] of cases) assert.equal(parseContextOverflow(new Error(message))?.limit, limit, message);
  assert.deepEqual(parseContextOverflow(new Error('context_length_exceeded')), { limit: null });
  assert.equal(parseContextOverflow(new Error('Rate limit reached for requests')), null);
  assert.equal(parseContextOverflow(new Error('401 Unauthorized')), null);
});

test('family table, size hints, parameter counts and tiers', () => {
  assert.equal(familyContextWindow('claude-sonnet-5'), 200_000);
  assert.equal(familyContextWindow('phi-3-mini-128k-instruct'), 131_072);
  assert.equal(familyContextWindow('some-brand-new-model'), null);
  assert.equal(parameterBillions('qwen2.5-coder:7b'), 7);
  assert.equal(parameterBillions('mixtral-8x7b'), 56);
  assert.equal(parameterBillions('70.6B'), 70.6);
  assert.equal(tierFor({ contextWindow: 8_192, parameters: null }), 'small');
  assert.equal(tierFor({ contextWindow: 32_768, parameters: 7 }), 'small');
  assert.equal(tierFor({ contextWindow: 32_768, parameters: 32 }), 'medium');
  assert.equal(tierFor({ contextWindow: 200_000, parameters: null }), 'large');
  assert.equal(outputTokensFor({ contextWindow: 8_192, configured: 16_384 }), 2_048);
  assert.equal(outputTokensFor({ contextWindow: 200_000, configured: null, declaredOutput: 8_000 }), 8_000);
});

test('elideStaleToolResults stubs large old tool output and keeps recent turns intact', () => {
  const big = 'x'.repeat(5_000);
  const history = [];
  for (let i = 0; i < 6; i++) {
    history.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'fs_read', args: {} }] });
    history.push({ role: 'tool', toolCallId: `c${i}`, toolName: 'fs_read', content: big });
  }
  const replaced = [];
  const out = elideStaleToolResults(history, { keepRecentTurns: 2, onReplace: (a, b) => replaced.push([a, b]) });
  assert.equal(out.length, history.length);
  assert.equal(replaced.length, 4);
  assert.match(out[1].content, /^\[Older fs_read result elided/);
  assert.equal(out.at(-1).content, big);
  assert.equal(history[1].content, big, 'the input history is not mutated');
});

function fixtureProvider(url, models = [{ id: 'mystery-model' }]) {
  return { id: 'fx', name: 'Fixture', type: 'openai-compatible', baseUrl: url, apiKey: 'k', enabled: true, models, timeoutMs: 15_000 };
}

test('modelProfile uses what the provider reports, then a default, and learns from overflow', async (t) => {
  const server = await jsonServer(t, (request, response) => {
    if (request.method === 'GET') return respondJson(response, 200, { data: [{ id: 'reported-model', context_length: 65_536 }, { id: 'mystery-model' }] });
    return respondJson(response, 404, {});
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, { providers: [fixtureProvider(server.url, [])] });
  const reported = await runtime.providerManager.modelProfile('fx:reported-model');
  assert.equal(reported.contextWindow, 65_536);
  assert.equal(reported.source, 'provider');
  const unknown = await runtime.providerManager.modelProfile('fx:mystery-model');
  assert.equal(unknown.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(unknown.source, 'default');

  const learned = await runtime.providerManager.learnContextWindow('fx:mystery-model', 8_192);
  assert.equal(learned.contextWindow, 8_192);
  assert.equal(learned.source, 'learned');
  assert.equal(learned.tier, 'small');
  assert.equal(runtime.store.getSetting('modelContextLimits')['fx:mystery-model'], 8_192);
});

test('a run that overflows learns the real window and retries instead of failing', async (t) => {
  let chatCalls = 0;
  const server = await jsonServer(t, async (request, response) => {
    if (isDiscoveryProbe(request)) return respondJson(response, 404, {});
    await readJsonBody(request);
    chatCalls += 1;
    if (chatCalls === 1) return respondJson(response, 400, { error: { message: "This model's maximum context length is 16384 tokens. Please reduce the length of the messages." } });
    return respondOpenAIChatSSE(response, { content: 'Done.', finishReason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 2 } });
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, { defaultModel: 'fx:mystery-model', providers: [fixtureProvider(server.url)] });
  const workspace = await runtime.workspaceManager.open(project);
  const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'What is 2+2?', modelRef: 'fx:mystery-model' });
  const done = await waitFor(async () => {
    const value = runtime.store.getRun(run.id);
    return ['completed', 'failed', 'cancelled', 'max_steps'].includes(value.status) ? value : null;
  }, { timeoutMs: 15_000, message: 'overflow run' });
  assert.equal(done.status, 'completed', done.error);
  assert.equal(chatCalls, 2);
  const learned = runtime.store.listRunEvents(run.id).find((event) => event.type === 'context-window-learned');
  assert.equal(learned.payload.next, 16_384);
  assert.equal(runtime.store.getSetting('modelContextLimits')['fx:mystery-model'], 16_384);
});

test('the compaction summary survives into the next prompt of the same session', async (t) => {
  const bodies = [];
  const server = await jsonServer(t, async (request, response) => {
    if (isDiscoveryProbe(request)) return respondJson(response, 404, {});
    const body = await readJsonBody(request);
    bodies.push(body);
    const isSummary = body.messages[0]?.role !== 'system';
    return respondOpenAIChatSSE(response, { content: isSummary ? '## Goal\n- SESSION-SUMMARY-MARKER' : 'Done.', finishReason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 2 } });
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fx:tiny', providers: [fixtureProvider(server.url, [{ id: 'tiny', contextWindow: 60_000 }])],
  });
  const workspace = await runtime.workspaceManager.open(project);
  const session = runtime.engine.createSession({ workspaceId: workspace.id });
  for (let i = 0; i < 150; i++) {
    runtime.store.addMessage({ sessionId: session.id, role: 'user', content: `Old message ${i} `.repeat(150) });
    runtime.store.addMessage({ sessionId: session.id, role: 'assistant', content: `Old reply ${i} `.repeat(150) });
  }
  const finish = async (run) => waitFor(async () => {
    const value = runtime.store.getRun(run.id);
    return ['completed', 'failed', 'cancelled', 'max_steps'].includes(value.status) ? value : null;
  }, { timeoutMs: 15_000, message: 'session run' });

  const first = await finish(await runtime.engine.startRun({ sessionId: session.id, workspaceId: workspace.id, prompt: 'first question', modelRef: 'fx:tiny', options: { maxTokens: 512 } }));
  assert.equal(first.status, 'completed', first.error);
  const saved = runtime.store.getSession(session.id).meta.compaction;
  assert.match(saved.summary, /SESSION-SUMMARY-MARKER/);
  assert.ok(saved.throughMessageId);

  const summaryCallsBefore = bodies.filter((body) => body.messages[0]?.role !== 'system').length;
  const second = await finish(await runtime.engine.startRun({ sessionId: session.id, workspaceId: workspace.id, prompt: 'second question', modelRef: 'fx:tiny', options: { maxTokens: 512 } }));
  assert.equal(second.status, 'completed', second.error);
  const lastTurn = bodies.filter((body) => body.messages[0]?.role === 'system').at(-1);
  assert.ok(lastTurn.messages.some((message) => /SESSION-SUMMARY-MARKER/.test(String(message.content))), 'second prompt carries the saved summary');
  // Turns already folded into the saved summary are not summarized a second time.
  const summaryCallsAfter = bodies.filter((body) => body.messages[0]?.role !== 'system').length;
  assert.ok(summaryCallsAfter - summaryCallsBefore <= 1);
});

test('a small model gets a compact system prompt; a large one the full contract', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const session = runtime.engine.createSession({ workspaceId: workspace.id });
  const workspaceContext = { workspace: { path: project }, text: '## Workspace snapshot\n{}' };
  const capabilityState = runtime.capabilityController.createState({ workspaceId: workspace.id });
  const args = { workspaceContext, capabilityState, planState: { steps: [] }, run: { id: 'r', workspace_id: workspace.id }, session };
  const large = runtime.promptBuilder.system({ ...args, modelProfile: { tier: 'large' } });
  const small = runtime.promptBuilder.system({ ...args, modelProfile: { tier: 'small' } });
  assert.match(large.text, /Run independent read-only calls in parallel/);
  assert.doesNotMatch(small.text, /Parallelize independent read-only discovery/);
  assert.match(small.text, /Finish the task end to end/);
  assert.ok(small.text.length < large.text.length);
});

test('an overflow at the assumed limit still shrinks the working window', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, { providers: [{ id: 'fx', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', enabled: true, models: [{ id: 'm', contextWindow: 20_000 }] }] });
  const learned = await runtime.providerManager.learnContextWindow('fx:m', 20_000);
  assert.equal(learned.contextWindow, 17_000);
});
