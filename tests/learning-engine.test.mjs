import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createProject, isDiscoveryProbe, jsonServer, readJsonBody, respondJson, respondOpenAIChatSSE, runtimeForTest, waitFor } from './helpers.mjs';

const usage = { prompt_tokens: 5, completion_tokens: 2 };

/** A runtime wired to a scripted OpenAI-compatible model: `script(body, requests)` returns what the model says this turn. */
async function scripted(t, script, { overrides = {}, models = ['m'], project = null, prepare = null } = {}) {
  const requests = [];
  const server = await jsonServer(t, async (request, response) => {
    if (isDiscoveryProbe(request)) return respondJson(response, 404, { error: 'not found' });
    const body = await readJsonBody(request);
    requests.push(body);
    const turn = await script(body, requests);
    return respondOpenAIChatSSE(response, { ...turn, finishReason: turn.toolCalls?.length ? 'tool_calls' : 'stop', usage });
  });
  const dir = project || await createProject(t);
  if (prepare) await prepare(dir);
  const runtime = await runtimeForTest(t, dir, {
    defaultModel: `fx:${models[0]}`,
    providers: [{ id: 'fx', name: 'Fixture', type: 'openai-compatible', baseUrl: server.url, apiKey: 'k', enabled: true, autoDiscover: false, models: models.map((id) => ({ id })), timeoutMs: 15_000 }],
    ...overrides,
  });
  const workspace = await runtime.workspaceManager.open(dir);
  return { runtime, workspace, requests, project: dir };
}

async function runAndLearn({ runtime, workspace }, prompt, { model = 'fx:m', options = {}, sessionId = null } = {}) {
  const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt, modelRef: model, options, sessionId });
  const finished = await runtime.engine.waitForRun(run.id);
  await runtime.learningManager.idle();
  return runtime.store.getRun(finished.id);
}

const systemOf = (request) => (typeof request.messages[0].content === 'string' ? request.messages[0].content : JSON.stringify(request.messages[0].content));
const toolResults = (request) => request.messages.filter((message) => message.role === 'tool').map((message) => String(message.content));

// ----------------------------------------------------------- after a run

test('a finished run is recorded, teaches lessons, and the next similar run is shown them and credits them', async (t) => {
  let turn = 0;
  const harness = await scripted(t, (body) => {
    const mine = body.messages.filter((message) => message.role === 'tool').length;
    if (body.messages.at(-1)?.role !== 'tool' && mine === 0 && !/node --test/.test(JSON.stringify(body.messages))) turn = 0;
    turn += 1;
    return turn === 1 ? { toolCalls: [{ id: 'c1', name: 'shell_exec', args: { command: 'node --test' } }] } : { content: 'All checks pass.' };
  });
  const first = await runAndLearn(harness, 'make the failing tests in the parser pass again');
  assert.equal(first.status, 'completed');
  const outcomes = harness.runtime.store.listOutcomes({ limit: 10 });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].executor, 'model:fx:m');
  assert.equal(outcomes[0].success, 1);
  const lessons = harness.runtime.learningManager.lessons.list({ workspaceId: harness.workspace.id });
  assert.ok(lessons.some((lesson) => lesson.kind === 'fact' && /node --test/.test(lesson.text)), 'a command that passed becomes how to check the project');

  turn = 0;
  const second = await runAndLearn(harness, 'get the failing tests in the parser passing');
  assert.equal(second.status, 'completed');
  const lastSystem = systemOf(harness.requests.findLast((request) => request.messages[0]?.role === 'system'));
  assert.match(lastSystem, /## Lessons from earlier runs on this machine/);
  assert.match(lastSystem, /`node --test` works in this workspace/);
  assert.deepEqual(second.meta.learned.lessonIds.length > 0, true);
  const credited = harness.runtime.learningManager.lessons.list({ workspaceId: harness.workspace.id }).find((lesson) => lesson.kind === 'fact');
  assert.equal(credited.shown, 1);
  assert.equal(credited.helped, 1, 'a lesson shown to a run that went well gains trust');
  assert.equal(harness.runtime.store.listOutcomes({ limit: 10 }).length, 2);
});

test('standing preferences from the user\'s own words reach later runs, and the whole layer can be switched off', async (t) => {
  const harness = await scripted(t, () => ({ content: 'ok' }));
  await runAndLearn(harness, 'Always answer in one short sentence. Now list the files.');
  await runAndLearn(harness, 'what does index.js export?');
  const system = systemOf(harness.requests.at(-1));
  assert.match(system, /## What you have told me about how you like things done\n- Always answer in one short sentence\./);

  const off = await scripted(t, () => ({ content: 'ok' }), { overrides: { learning: { enabled: false } } });
  await runAndLearn(off, 'Always answer in one short sentence.');
  await runAndLearn(off, 'what does index.js export?');
  assert.equal(off.runtime.store.listOutcomes({ limit: 10 }).length, 0);
  assert.doesNotMatch(systemOf(off.requests.at(-1)), /What you have told me/);
});

test('a thin request gets a note telling the model to ask rather than guess, but not mid-conversation', async (t) => {
  const harness = await scripted(t, () => ({ content: 'ok' }));
  const first = await harness.runtime.engine.startRun({ workspaceId: harness.workspace.id, prompt: 'fix it', modelRef: 'fx:m' });
  await harness.runtime.engine.waitForRun(first.id);
  assert.match(systemOf(harness.requests[0]), /## Harness notes[\s\S]*user_ask/);
  const followUp = await harness.runtime.engine.startRun({ workspaceId: harness.workspace.id, sessionId: first.session_id, prompt: 'fix it', modelRef: 'fx:m' });
  await harness.runtime.engine.waitForRun(followUp.id);
  assert.doesNotMatch(systemOf(harness.requests.at(-1)), /## Harness notes/);
});

// ------------------------------------------------------------ ask vs. act

const risky = 'echo DROP TABLE users';

test('an unattended run is stopped before a hard-to-undo command, and told why', async (t) => {
  let turn = 0;
  const harness = await scripted(t, () => { turn += 1; return turn === 1 ? { toolCalls: [{ id: 'c1', name: 'shell_exec', args: { command: risky } }] } : { content: 'ok' }; });
  const run = await runAndLearn(harness, 'tidy the database');
  const result = toolResults(harness.requests.at(-1))[0];
  assert.match(result, /Blocked before running/);
  assert.match(result, /nobody is attached to confirm/);
  assert.ok(harness.runtime.store.listRunEvents(run.id, 200).some((event) => event.type === 'uncertain'));
  assert.doesNotMatch(result, /DROP TABLE users\\n/);
});

test('with someone attached the run asks first, and remembers a yes for the same action', async (t) => {
  let turn = 0;
  const asked = [];
  const harness = await scripted(t, () => { turn += 1; return turn <= 2 ? { toolCalls: [{ id: `c${turn}`, name: 'shell_exec', args: { command: risky } }] } : { content: 'ok' }; });
  harness.runtime.interaction.attach({ confirm: async (request) => { asked.push(request); return true; } });
  await runAndLearn(harness, 'tidy the database');
  assert.equal(asked.length, 1, 'approved once, not asked again for the identical command');
  assert.match(asked[0].message, /drops or empties database data/);
  assert.ok(asked[0].danger);
  const results = toolResults(harness.requests.at(-1));
  assert.ok(results.every((text) => /DROP TABLE users/.test(text)), 'it ran after approval');
});

test('a no is final: the model is told not to retry a variation', async (t) => {
  let turn = 0;
  const harness = await scripted(t, () => { turn += 1; return turn === 1 ? { toolCalls: [{ id: 'c1', name: 'shell_exec', args: { command: risky } }] } : { content: 'ok' }; });
  harness.runtime.interaction.attach({ confirm: async () => false });
  await runAndLearn(harness, 'tidy the database');
  const result = toolResults(harness.requests.at(-1))[0];
  assert.match(result, /The user declined this action/);
  assert.match(result, /Do not retry it or a variation/);
});

test('the guard can be relaxed, advisory, or off, and stays out of the way in the other permission modes', async (t) => {
  const attempt = async (overrides) => {
    let turn = 0;
    const harness = await scripted(t, () => { turn += 1; return turn === 1 ? { toolCalls: [{ id: 'c1', name: 'shell_exec', args: { command: risky } }] } : { content: 'ok' }; }, { overrides });
    await runAndLearn(harness, 'tidy the database');
    return toolResults(harness.requests.at(-1))[0];
  };
  assert.match(await attempt({ learning: { uncertainty: { headless: 'allow' } } }), /DROP TABLE users[\s\S]*Caution: this drops or empties database data/);
  assert.match(await attempt({ learning: { uncertainty: { mode: 'advise' } } }), /Caution: this drops or empties database data/);
  const off = await attempt({ learning: { uncertainty: { mode: 'off' } } });
  assert.match(off, /DROP TABLE users/);
  assert.doesNotMatch(off, /Caution|Blocked/);
  assert.doesNotMatch(await attempt({ permissionMode: 'balanced', learning: { uncertainty: { headless: 'allow' } } }), /Blocked before running/);
});

test('overwriting a file that was never read earns a caution, and reading it first does not', async (t) => {
  let turn = 0;
  const harness = await scripted(t, () => {
    turn += 1;
    if (turn === 1) return { toolCalls: [{ id: 'c1', name: 'fs_write', args: { path: 'notes.txt', content: 'x' } }] };
    if (turn === 2) return { toolCalls: [{ id: 'c2', name: 'fs_read', args: { path: 'notes.txt' } }] };
    if (turn === 3) return { toolCalls: [{ id: 'c3', name: 'fs_write', args: { path: 'notes.txt', content: 'y' } }] };
    return { content: 'ok' };
  });
  await runAndLearn(harness, 'update notes.txt');
  const results = toolResults(harness.requests.at(-1));
  assert.match(results[0], /Caution: this writes `notes\.txt` without having read it/);
  assert.doesNotMatch(results[2], /Caution/);
});

// ----------------------------------------------------------------- tools

test('a repeated read is answered from the cache, a write in between makes it fresh, and a batch keeps its order', async (t) => {
  let turn = 0;
  const harness = await scripted(t, () => {
    turn += 1;
    if (turn === 1) return { toolCalls: [{ id: 'r1', name: 'fs_read', args: { path: 'index.js' } }] };
    if (turn === 2) return { toolCalls: [{ id: 'r2', name: 'fs_read', args: { path: 'index.js' } }] };
    if (turn === 3) return { toolCalls: [
      { id: 'w1', name: 'fs_write', args: { path: 'fresh.txt', content: 'written in the same batch' } },
      { id: 'r3', name: 'fs_read', args: { path: 'fresh.txt' } },
      { id: 'r4', name: 'fs_read', args: { path: 'index.js' } },
    ] };
    return { content: 'ok' };
  });
  const run = await runAndLearn(harness, 'look at index.js');
  const results = toolResults(harness.requests.at(-1));
  assert.doesNotMatch(results[0], /Identical to your call/);
  assert.match(results[1], /Identical to your call at step 1, and nothing has changed since/);
  assert.match(results[1], /velocity/, 'the cached text is still given');
  assert.match(results[3], /written in the same batch/, 'a read after a write in one batch sees the write');
  assert.doesNotMatch(results[4], /Identical to your call/, 'a write invalidates what was cached before it');
  assert.equal(harness.runtime.store.listRunEvents(run.id, 300).filter((event) => event.type === 'tool-cache-hit').length, 1);
});

test('the cache and batching can be switched off', async (t) => {
  let turn = 0;
  const harness = await scripted(t, () => { turn += 1; return turn <= 2 ? { toolCalls: [{ id: `r${turn}`, name: 'fs_read', args: { path: 'index.js' } }] } : { content: 'ok' }; }, { overrides: { learning: { tools: { cache: false, batch: false } } } });
  await runAndLearn(harness, 'look at index.js');
  assert.ok(toolResults(harness.requests.at(-1)).every((text) => !/Identical to your call/.test(text)));
});

test('reading a file also says what depends on it and where its tests are, once', async (t) => {
  let turn = 0;
  const harness = await scripted(t, () => {
    turn += 1;
    return turn <= 2 ? { toolCalls: [{ id: `r${turn}`, name: 'fs_read', args: { path: 'lib.js' } }] } : { content: 'ok' };
  }, {
    prepare: async (dir) => {
      await fsp.writeFile(path.join(dir, 'lib.js'), 'export function add(a, b) { return a + b; }\n');
      await fsp.writeFile(path.join(dir, 'app.js'), "import { add } from './lib.js';\nexport const total = add(1, 2);\n");
      await fsp.writeFile(path.join(dir, 'lib.test.js'), "import { add } from './lib.js';\nimport test from 'node:test';\ntest('add', () => add(1, 2));\n");
    },
  });
  await harness.runtime.codeGraph.build(harness.workspace.id);
  await runAndLearn(harness, 'explain lib.js');
  const results = toolResults(harness.requests.at(-1));
  assert.match(results[0], /\[Harness\] Related to lib\.js: used by app\.js/);
  assert.match(results[0], /tests lib\.test\.js/);
  assert.doesNotMatch(results[1], /Related to lib\.js/, 'only on the first look');
});

// ------------------------------------------------------- stuck and escalate

const failingCalls = (turn) => ({ toolCalls: [{ id: `f${turn}`, name: 'fs_read', args: { path: `missing/${turn}.txt` } }] });
const quickProgress = { progress: { warnAfter: 3, stopAfter: 6, errorStreak: 3 } };

test('a run that only fails is nudged, then stopped with a plain report instead of burning its budget', async (t) => {
  let turn = 0;
  const harness = await scripted(t, () => { turn += 1; return turn < 40 ? failingCalls(turn) : { content: 'never' }; }, { overrides: { learning: quickProgress } });
  const run = await runAndLearn(harness, 'find the config loader');
  assert.equal(run.status, 'stagnated');
  assert.ok(turn <= 8, `stopped promptly, after ${turn} turns`);
  const events = harness.runtime.store.listRunEvents(run.id, 300);
  assert.ok(events.some((event) => event.type === 'stuck' && event.payload.level === 'warn'));
  assert.ok(events.some((event) => event.type === 'stuck' && event.payload.level === 'stop'));
  const messages = harness.runtime.store.listMessages(run.session_id, 100);
  assert.ok(messages.some((message) => /Stop and take stock/.test(message.content)), 'it was nudged first');
  const report = messages.findLast((message) => message.role === 'assistant');
  assert.match(report.content, /I stopped because I was not making progress/);
  assert.match(report.content, /missing\/\d\.txt/);
  const lessons = harness.runtime.learningManager.lessons.list({ workspaceId: harness.workspace.id });
  assert.ok(lessons.some((lesson) => /made no progress/.test(lesson.text)), 'getting stuck is itself remembered');
});

test('an automatically routed run that cannot get anywhere moves up to the next candidate and finishes', async (t) => {
  const asked = [];
  const harness = await scripted(t, (body) => {
    asked.push(body.model);
    if (body.model === 'weak') return failingCalls(asked.length);
    return { content: 'The stronger model finished it.' };
  }, { models: ['weak', 'strong'], overrides: {
    learning: quickProgress,
    routing: { models: [{ model: 'fx:weak', tags: [], priority: 5 }, { model: 'fx:strong', tags: [], priority: 1 }] },
  } });
  const run = await runAndLearn(harness, 'find the config loader', { model: 'router:auto' });
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.model_id, 'fx:strong');
  assert.equal(run.meta.escalatedFrom, 'fx:weak');
  assert.deepEqual([...new Set(asked)], ['weak', 'strong']);
  const escalated = harness.runtime.store.listRunEvents(run.id, 300).find((event) => event.type === 'escalated');
  assert.deepEqual([escalated.payload.from, escalated.payload.to], ['fx:weak', 'fx:strong']);
  const handoff = harness.requests.findLast((body) => body.model === 'strong').messages.find((message) => /continuing this task from where it stopped/.test(String(message.content)));
  assert.ok(handoff, 'the stronger model is told what happened and not to start over');
  assert.equal(harness.runtime.store.listOutcomes({ limit: 5 })[0].executor, 'model:fx:strong');
  assert.equal(harness.runtime.store.listOutcomes({ limit: 5 })[0].escalated_from, 'fx:weak');
});

test('a model the user picked is never swapped out from under them', async (t) => {
  let turn = 0;
  const harness = await scripted(t, () => { turn += 1; return turn < 40 ? failingCalls(turn) : { content: 'never' }; }, { models: ['weak', 'strong'], overrides: {
    learning: quickProgress, routing: { models: [{ model: 'fx:weak', tags: [], priority: 5 }, { model: 'fx:strong', tags: [], priority: 1 }] },
  } });
  const run = await runAndLearn(harness, 'find the config loader', { model: 'fx:weak' });
  assert.equal(run.status, 'stagnated');
  assert.equal(run.model_id, 'fx:weak');
  assert.equal(run.meta.escalatedFrom, undefined);
});

test('escalation can be turned off, leaving the run to stop as stuck', async (t) => {
  let turn = 0;
  const harness = await scripted(t, () => { turn += 1; return turn < 40 ? failingCalls(turn) : { content: 'never' }; }, { models: ['weak', 'strong'], overrides: {
    learning: { ...quickProgress, routing: { escalate: false } }, routing: { models: [{ model: 'fx:weak', tags: [], priority: 5 }, { model: 'fx:strong', tags: [], priority: 1 }] },
  } });
  const run = await runAndLearn(harness, 'find the config loader', { model: 'router:auto' });
  assert.equal(run.status, 'stagnated');
  assert.equal(run.model_id, 'fx:weak');
});

// --------------------------------------------------------- working state

test('when old turns are dropped the harness-tracked working state goes with the summary', async (t) => {
  const project = await createProject(t);
  const harness = await scripted(t, (body) => {
    if (body.messages[0]?.role !== 'system') return { content: '## Goal\nSUMMARY: seeded history' };
    return { content: 'Done.' };
  }, { project });
  // A long history whose earliest turn changed a file: after trimming, that fact must still be in front of the model.
  const session = harness.runtime.engine.createSession({ workspaceId: harness.workspace.id });
  const store = harness.runtime.store;
  store.addMessage({ sessionId: session.id, role: 'user', content: 'Original goal: rework the seeded module' });
  store.addMessage({ sessionId: session.id, role: 'assistant', content: 'On it.', meta: { toolCalls: [{ id: 't1', name: 'fs_patch', args: { path: 'src/seeded.js', edits: [] } }] } });
  store.addMessage({ sessionId: session.id, role: 'tool', content: 'ok', meta: { toolCallId: 't1', toolName: 'fs_patch' } });
  for (let i = 0; i < 150; i += 1) {
    store.addMessage({ sessionId: session.id, role: 'user', content: `Old message number ${i} `.repeat(150) });
    store.addMessage({ sessionId: session.id, role: 'assistant', content: `Old reply number ${i} `.repeat(150) });
  }
  await harness.runtime.providerManager.learnContextWindow('fx:m', 60_000);
  const run = await harness.runtime.engine.startRun({ sessionId: session.id, workspaceId: harness.workspace.id, prompt: 'continue', modelRef: 'fx:m', options: { maxTokens: 512 } });
  await harness.runtime.engine.waitForRun(run.id);
  const turn = harness.requests.findLast((body) => body.messages[0]?.role === 'system');
  const summary = turn.messages.find((message) => typeof message.content === 'string' && message.content.startsWith('[Summary of'));
  assert.ok(summary, 'older turns were summarised');
  assert.match(summary.content, /## Working state \(tracked by the harness/);
  assert.match(summary.content, /Files changed: src\/seeded\.js/);
  assert.match(summary.content, /Goal: Original goal: rework the seeded module/);
});
