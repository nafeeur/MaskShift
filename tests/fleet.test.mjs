import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDirectives, buildBriefing } from '../src/fleet/protocol.mjs';
import { Writable } from 'node:stream';
import { refresh as refreshFleet } from '../src/tui/views/fleet.mjs';
import { MaskShiftTui } from '../src/tui/app.mjs';
import { Theme } from '../src/tui/theme.mjs';
import { FormOverlay } from '../src/tui/overlays.mjs';
import { stripAnsi, visibleWidth } from '../src/tui/text.mjs';
import { createProject, jsonServer, readJsonBody, respondOpenAIChatSSE, runtimeForTest, tempDir, waitFor } from './helpers.mjs';

const AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
const bridge = (title) => ({ title, command: process.execPath, args: [AGENT, '{prompt}'] });

async function fleetRuntime(t, extra = {}) {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    agentBridges: { alpha: bridge('Alpha'), beta: bridge('Beta'), ghost: { title: 'Ghost', command: 'definitely-not-installed-xyz', args: ['{prompt}'] } },
    fleet: { retryDelayMs: 10, ...extra },
  });
  return { project, runtime, fleet: runtime.fleetManager };
}

test('directives are parsed leniently and removed from the reply', () => {
  const parsed = parseDirectives('thinking\n[[SEND to="reviewer, tester"]] check auth [[/send]]\n[[send @all]] fyi [[/send]]\n[[done]] all good [[/done]]');
  assert.deepEqual(parsed.sends, [
    { to: 'reviewer', body: 'check auth' }, { to: 'tester', body: 'check auth' }, { to: '*', body: 'fyi' },
  ]);
  assert.equal(parsed.done, 'all good');
  assert.equal(parsed.text, 'thinking');
  assert.equal(parseDirectives('\u001b[32mplain\u001b[0m').text, 'plain');
  assert.deepEqual(parseDirectives('[[send to=x]]   [[/send]]').sends, []);
});

test('the briefing names the member, the team, the objective and the mail', () => {
  const roster = [{ id: '1', name: 'lead', harness: 'alpha', role: 'plans' }, { id: '2', name: 'worker', harness: 'beta', role: '' }];
  const text = buildBriefing({ member: roster[0], roster, objective: 'ship it', inbox: [{ from: 'worker', body: 'done', kind: 'message' }], history: [{ at: '2026-01-01T10:00:00Z', reply: 'earlier' }], message: '' });
  for (const needle of ['You are "lead"', 'worker (beta)', 'Team objective:\nship it', 'from worker', 'earlier', '[[send to=worker]]']) assert.ok(text.includes(needle), needle);
});

test('members of different harnesses coexist, and the same harness can hold several seats', async (t) => {
  const { fleet } = await fleetRuntime(t);
  const harnesses = await fleet.harnesses();
  assert.equal(harnesses.find((item) => item.name === 'alpha').available, true);
  assert.equal(harnesses.find((item) => item.name === 'ghost').available, false);
  assert.equal(harnesses[0].name, 'maskshift');

  const members = await fleet.spawnMany(['alpha:lead', 'beta:worker', 'beta']);
  assert.deepEqual(members.map((member) => member.name), ['lead', 'worker', 'beta']);
  const again = await fleet.spawn({ harness: 'alpha', name: 'lead' });
  assert.equal(again.name, 'lead-2');
  await assert.rejects(fleet.spawn({ harness: 'ghost' }), /not installed/);
  await assert.rejects(fleet.spawn({ harness: 'nope' }), /Unknown harness/);
  const fallback = await fleet.spawn({ harness: 'ghost', fallbacks: ['beta'] });
  assert.equal(fallback.harness, 'beta');
  assert.equal(fallback.fellBackFrom, 'ghost');
});

test('a relay carries a task from the lead to a worker and back until the lead says done', async (t) => {
  const { fleet } = await fleetRuntime(t);
  await fleet.spawn({ harness: 'alpha', name: 'lead', role: 'plans and signs off' });
  await fleet.spawn({ harness: 'beta', name: 'worker', role: 'implements' });
  const relay = await fleet.relay({ task: 'build the feature', lead: 'lead' });
  assert.equal(relay.status, 'completed', JSON.stringify(relay));
  assert.match(relay.final, /feature implemented and reviewed/);
  assert.match(relay.reason, /done by lead/);
  assert.deepEqual(relay.turns.map((turn) => turn.name), ['lead', 'worker', 'lead']);
  // The worker never wrote a [[send]]; its plain answer was routed back to the lead as a reply.
  const kinds = fleet.conversation().map((item) => `${item.from}>${item.to}:${item.kind}`);
  assert.ok(kinds.includes('lead>worker:message'), kinds.join(' '));
  assert.ok(kinds.includes('worker>lead:reply'), kinds.join(' '));
  assert.equal(fleet.get('worker').stats.turns, 1);
});

test('a relay ends quietly with the lead\'s last reply when nobody has mail', async (t) => {
  const { fleet } = await fleetRuntime(t);
  await fleet.spawn({ harness: 'beta', name: 'solo' });
  const relay = await fleet.relay({ task: 'say hello' });
  assert.equal(relay.status, 'completed');
  assert.equal(relay.reason, 'quiet');
  assert.match(relay.final, /solo saw/);
});

test('messages are de-duplicated, hop-limited and refused for unknown members', async (t) => {
  const { fleet } = await fleetRuntime(t, { maxHops: 3 });
  await fleet.spawnMany(['alpha:a', 'beta:b']);
  const first = fleet.send({ from: 'a', to: 'b', body: 'same thing' });
  const duplicate = fleet.send({ from: 'a', to: 'b', body: '  Same   thing ' });
  assert.equal(first.status, 'queued');
  assert.equal(duplicate.status, 'dropped');
  assert.match(duplicate.dropped, /Duplicate/);
  assert.match(fleet.send({ from: 'a', to: 'b', body: 'loop', hops: 4 }).dropped, /hop limit/);
  assert.match(fleet.send({ from: 'a', to: 'nobody', body: 'hi' }).dropped, /No fleet member/);
  const notice = fleet.get('a').inbox.find((item) => item.kind === 'notice');
  assert.match(notice.body, /no such member.*b/s, 'the sender is told who it can actually reach');
  const broadcast = fleet.send({ from: 'a', to: '*', body: 'all hands' });
  assert.deepEqual(broadcast.map((item) => item.to), ['b']);
  assert.equal(fleet.get('b').inbox.length, 2);
});

test('two agents that keep pinging each other are cut off by the round limit', async (t) => {
  const { fleet } = await fleetRuntime(t, { maxRounds: 4, maxHops: 50 });
  await fleet.spawnMany(['alpha:ping', 'beta:pong']);
  process.env.FAKE_PEER = 'pong';
  t.after(() => { delete process.env.FAKE_PEER; });
  // SPAM makes the agent address the peer on every turn, and pong answers the same way, so this would never end alone.
  fleet.send({ from: 'user', to: 'ping', body: 'SPAM' });
  fleet.send({ from: 'user', to: 'pong', body: 'SPAM' });
  process.env.FAKE_PEER = 'ping';
  const relay = await fleet.relay({ task: 'SPAM please', lead: 'ping', maxRounds: 4 });
  assert.ok(relay.rounds <= 4);
  assert.ok(['incomplete', 'completed'].includes(relay.status));
});

test('a flaky harness is retried and a dead one fails with its mail preserved', async (t) => {
  const { fleet } = await fleetRuntime(t, { maxRetries: 1 });
  const dir = await tempDir(t);
  process.env.FAKE_FLAKY_MARKER = path.join(dir, 'marker');
  t.after(() => { delete process.env.FAKE_FLAKY_MARKER; });
  await fleet.spawn({ harness: 'beta', name: 'steady' });
  const result = await fleet.ask('steady', { message: 'hello' });
  assert.equal(result.ok, true);
  assert.equal(result.retries, 1);
  assert.equal(fleet.get('steady').stats.retries, 1);

  fleet.send({ from: 'user', to: 'steady', body: 'keep me' });
  fleet.get('steady').harness = 'ghost';
  fleet.get('steady').fallbacks = [];
  const failed = await fleet.ask('steady', {});
  assert.equal(failed.ok, false);
  assert.match(failed.error, /not available/);
  assert.equal(fleet.get('steady').status, 'failed');
  assert.equal(fleet.get('steady').inbox.length, 1, 'unread mail survives a failed turn');
});

test('a vanished harness falls back to a declared alternative mid-flight', async (t) => {
  const { fleet } = await fleetRuntime(t);
  await fleet.spawn({ harness: 'alpha', name: 'mover', fallbacks: ['beta'] });
  fleet.get('mover').harness = 'ghost';
  const result = await fleet.ask('mover', { message: 'hello' });
  assert.equal(result.ok, true);
  assert.equal(result.fellBackTo, 'beta');
  assert.equal(fleet.get('mover').harness, 'beta');
});

test('stopping a member cancels its running turn and leaves it usable', async (t) => {
  const { fleet } = await fleetRuntime(t);
  await fleet.spawn({ harness: 'alpha', name: 'sleeper' });
  const pending = fleet.ask('sleeper', { message: 'SLEEP' });
  while (fleet.get('sleeper').status !== 'running') await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fleet.stop('sleeper').stopped, true);
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(fleet.get('sleeper').status, 'stopped');
  const next = await fleet.ask('sleeper', { message: 'hello again' });
  assert.equal(next.ok, true);
  assert.equal(fleet.get('sleeper').status, 'idle');
});

test('cancelling a relay stops the members it is running', async (t) => {
  const { fleet } = await fleetRuntime(t);
  await fleet.spawn({ harness: 'alpha', name: 'sleepy' });
  const relay = await fleet.relay({ task: 'SLEEP', background: true });
  while (fleet.get('sleepy').status !== 'running') await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fleet.cancelRelay(relay.id).cancelled, true);
  while (relay.status === 'running') await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(relay.status, 'cancelled');
});

test('the roster, mail and history survive a restart', async (t) => {
  const project = await createProject(t);
  const home = await tempDir(t);
  const overrides = { home, agentBridges: { beta: bridge('Beta') }, fleet: { retryDelayMs: 10 } };
  const first = await (await import('../src/runtime.mjs')).createRuntime({ configPath: path.join(home, 'config.json'), workspacePath: project, configOverrides: { autoIndex: false, automations: { enabled: false }, ...overrides } });
  await first.fleetManager.spawn({ harness: 'beta', name: 'keeper', role: 'remembers' });
  await first.fleetManager.ask('keeper', { message: 'hello' });
  first.fleetManager.send({ from: 'user', to: 'keeper', body: 'unread' });
  await first.close();
  const second = await (await import('../src/runtime.mjs')).createRuntime({ configPath: path.join(home, 'config.json'), workspacePath: project, configOverrides: { autoIndex: false, automations: { enabled: false }, ...overrides } });
  t.after(() => second.close());
  const member = second.fleetManager.details('keeper');
  assert.equal(member.role, 'remembers');
  assert.equal(member.history.length, 1);
  assert.equal(member.unread, 1);
  assert.equal(member.status, 'idle');
});

test('fleet tools are registered for the model', async (t) => {
  const { runtime } = await fleetRuntime(t);
  const names = runtime.toolRegistry.list({}).map((tool) => tool.name);
  for (const name of ['fleet_harnesses', 'fleet_spawn', 'fleet_list', 'fleet_ask', 'fleet_send', 'fleet_relay', 'fleet_messages', 'fleet_stop']) assert.ok(names.includes(name), name);
  const spawned = await runtime.toolRegistry.execute('fleet_spawn', { harness: 'alpha', name: 'tooled' }, {});
  assert.equal(spawned.name ?? spawned.result?.name ?? spawned.output?.name, 'tooled');
});

class FakeTerminal extends Writable {
  constructor(columns = 120, rows = 34) { super(); this.columns = columns; this.rows = rows; this.isTTY = false; }
  _write(_chunk, _encoding, callback) { callback(); }
}

test('the Fleet view lists members, runs a relay from the keyboard and renders at every size', async (t) => {
  const { project, runtime, fleet } = await fleetRuntime(t);
  const theme = new Theme({ depth: 24, unicode: true });
  const app = new MaskShiftTui(runtime, { workspacePath: project, output: new FakeTerminal(120, 34), headless: true, theme });
  await app.bootstrap();

  app.onKey({ name: '7', alt: true });
  assert.equal(app.view, 'fleet');
  assert.equal(app.focus, 'fleet');
  let frame = app.snapshot().map(stripAnsi).join('\n');
  assert.match(frame, /No agents in the fleet yet/);
  assert.match(frame, /7 Fleet/);

  await waitFor(() => app.fleet.harnesses.length || null, { timeoutMs: 3000, message: 'harnesses probed' });
  // n opens the add-agent form; submitting it spawns a member through the real manager.
  app.onKey({ name: 'n', printable: true });
  assert.ok(app.overlay instanceof FormOverlay);
  app.overlay.fields.find((field) => field.name === 'harness').optionIndex = app.overlay.fields[0].options.findIndex((option) => option.value === 'alpha');
  app.overlay.fields.find((field) => field.name === 'name').editor.set('lead');
  await app.overlay.onSubmit(app.overlay.values());
  app.overlay = null;
  await fleet.spawn({ harness: 'beta', name: 'worker', role: 'implements' });
  await refreshFleet(app);
  assert.equal(app.fleet.members.length, 2);
  frame = app.snapshot().map(stripAnsi).join('\n');
  assert.match(frame, /lead/);
  assert.match(frame, /worker/);

  // g starts a relay in the background; events keep the view current and the chatter rail fills in.
  app.fleetList.setItems([{ id: 'x', kind: 'member', raw: fleet.list()[0] }]);
  app.onKey({ name: 'g', printable: true });
  assert.ok(app.overlay instanceof FormOverlay);
  app.overlay.fields.find((field) => field.name === 'task').editor.set('build the feature');
  await app.overlay.onSubmit(app.overlay.values());
  app.overlay = null;
  await waitFor(() => fleet.listRelays()[0]?.status === 'completed' || null, { timeoutMs: 15_000, message: 'relay finished' });
  await refreshFleet(app);
  assert.equal(app.fleetTab, 'relays');
  app.fleetTab = 'messages';
  app.view = 'fleet';
  app.screen.invalidate();
  frame = app.snapshot().map(stripAnsi).join('\n');
  assert.match(frame, /lead → worker/);

  for (const [columns, rows] of [[40, 12], [80, 24], [120, 34], [200, 50]]) {
    const small = new MaskShiftTui(runtime, { workspacePath: project, output: new FakeTerminal(columns, rows), headless: true, theme });
    await small.bootstrap();
    for (const tab of ['members', 'messages', 'relays', 'harnesses']) {
      small.view = 'fleet';
      small.fleetTab = tab;
      small.screen.invalidate();
      const lines = small.snapshot();
      assert.equal(lines.length, rows);
      for (const line of lines) assert.equal(visibleWidth(line), columns, `${tab} at ${columns}x${rows}`);
    }
  }
});

test('a MaskShift engine member joins a team and keeps one session across turns', async (t) => {
  const prompts = [];
  const modelServer = await jsonServer(t, async (request, response) => {
    const body = await readJsonBody(request);
    if (request.url?.includes('/chat/completions')) {
      prompts.push(JSON.stringify(body.messages));
      return respondOpenAIChatSSE(response, { content: `engine reply ${prompts.length}\n[[send to=worker]] take over [[/send]]`, finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 5 } });
    }
    response.writeHead(404).end();
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fixture:m',
    providers: [{ id: 'fixture', name: 'Fixture', type: 'openai-compatible', baseUrl: modelServer.url, apiKey: 'k', enabled: true, autoDiscover: false, models: [{ id: 'm' }], timeoutMs: 15_000 }],
    agentBridges: { beta: bridge('Beta') },
  });
  const workspace = await runtime.workspaceManager.open(project);
  const fleet = runtime.fleetManager;
  await fleet.spawn({ harness: 'maskshift', name: 'brain', workspaceId: workspace.id, mode: 'inspect', role: 'plans' });
  await fleet.spawn({ harness: 'beta', name: 'worker', workspaceId: workspace.id });
  const first = await fleet.ask('brain', { message: 'plan the work' });
  assert.equal(first.ok, true, first.error);
  assert.match(first.reply, /engine reply 1/);
  assert.equal(fleet.get('worker').inbox.length, 1, 'the engine member\'s [[send]] reached a CLI member');
  await fleet.ask('brain', { message: 'and again' });
  const sessions = new Set(runtime.store.listSessions({ workspaceId: workspace.id, limit: 50 }).filter((session) => session.title.startsWith('Fleet:')).map((session) => session.id));
  assert.equal(sessions.size, 1);
  assert.ok(prompts[1].includes('engine reply 1'), 'the second turn sees the first inside the same session');
});

test('every fleet turn is recorded, and the router then prefers the harness that has done well on that kind of task', async (t) => {
  const { runtime, fleet } = await fleetRuntime(t);
  const ledger = runtime.learningManager.ledger;
  await fleet.spawn({ harness: 'alpha', name: 'a1' });
  await fleet.ask('a1', { message: 'fix the failing parser test' });
  const recorded = runtime.store.listOutcomes({ kind: 'harness' });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].executor, 'harness:alpha');
  assert.equal(recorded[0].success, 1);

  assert.equal((await fleet.suggest('fix the failing parser test')).informed, false, 'one run is not a track record');
  for (let i = 0; i < 6; i += 1) {
    ledger.recordHarnessTurn({ harness: 'alpha', task: 'fix the failing parser test', ok: true, durationMs: 1000 });
    ledger.recordHarnessTurn({ harness: 'beta', task: 'fix the failing parser test', ok: i === 0, durationMs: 1000 });
  }
  const suggestion = await fleet.suggest('fix the failing parser bug');
  assert.equal(suggestion.informed, true);
  assert.equal(suggestion.best, 'alpha');
  assert.ok(suggestion.ranking.find((item) => item.name === 'alpha').expected > suggestion.ranking.find((item) => item.name === 'beta').expected);
  const routed = await runtime.intelligenceRouter.routeAgent('fix the failing parser bug', {});
  assert.deepEqual(routed.selected, { type: 'bridge', name: 'alpha' });
  assert.equal(routed.informed, true);
  assert.match(routed.ranking[0], /harness:alpha/);
});
