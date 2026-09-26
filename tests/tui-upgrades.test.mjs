import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Writable } from 'node:stream';
import { MaskShiftTui } from '../src/tui/app.mjs';
import { decode } from '../src/tui/input.mjs';
import { Theme } from '../src/tui/theme.mjs';
import { chip } from '../src/tui/type.mjs';
import { stripAnsi } from '../src/tui/text.mjs';
import { approvalPreview } from '../src/tui/approval.mjs';
import { commandDirectories, expandCommand, loadCustomCommands } from '../src/tui/commands.mjs';
import { visibleStreamingText } from '../src/agent/tool-protocol.mjs';
import { runCommand } from '../src/core/utils.mjs';
import {
  createProject, isDiscoveryProbe, jsonServer, readJsonBody, respondJson, respondOpenAIChatSSE, runtimeForTest, tempDir, waitFor,
} from './helpers.mjs';

const theme = new Theme({ depth: 24, unicode: true });

class FakeTerminal extends Writable {
  constructor(columns = 132, rows = 38) { super(); this.columns = columns; this.rows = rows; this.isTTY = false; }
  _write(chunk, encoding, callback) { callback(); }
}

async function tui(t, overrides = {}, { columns = 132, rows = 38 } = {}) {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, overrides);
  const app = new MaskShiftTui(runtime, { workspacePath: project, output: new FakeTerminal(columns, rows), headless: true, theme });
  await app.bootstrap();
  // Let bootstrap's own model-profile lookup land before a test sets one by hand.
  await app.refreshModelProfile();
  return { app, runtime, project };
}

const screenText = (app) => { app.screen.invalidate(); return app.snapshot().map(stripAnsi).join('\n'); };
const now = () => new Date().toISOString();

test('the status rail shows how full the model window is, and keeps it when narrow', async (t) => {
  const { app } = await tui(t);
  app.modelProfile = { contextWindow: 200_000, tier: 'large', source: 'provider', maxOutputTokens: 16_384 };
  app.contextUsed = 41_200;
  assert.match(screenText(app), /CTX .*41\.2k\/200k/);
  assert.equal(app.contextState.tone, 'success');
  app.contextUsed = 180_000;
  assert.equal(app.contextState.tone, 'danger');

  const narrow = await tui(t, {}, { columns: 80, rows: 24 });
  narrow.app.modelProfile = app.modelProfile;
  narrow.app.contextUsed = 41_200;
  const text = screenText(narrow.app);
  assert.match(text, /CTX .*41\.2k\/200k/);
  assert.doesNotMatch(text.split('\n').at(-2), /TIME/, 'lower-priority stats give way first');
});

test('the transcript marks where the saved summary ends, and s opens it', async (t) => {
  const { app } = await tui(t);
  app.messages = [
    { id: 'a', role: 'user', created_at: now(), meta: {}, content: 'first' },
    { id: 'b', role: 'assistant', created_at: now(), meta: {}, content: 'second' },
    { id: 'c', role: 'user', created_at: now(), meta: {}, content: 'third' },
  ];
  app.compaction = { summary: '## Goal\n- SUMMARY-MARKER', throughMessageId: 'b' };
  app.view = 'chat';
  const text = screenText(app);
  assert.match(text, /2 EARLIER MESSAGES SUMMARIZED/);
  assert.ok(text.indexOf('second') < text.indexOf('SUMMARIZED') && text.indexOf('SUMMARIZED') < text.indexOf('third'));
  app.openSessionSummary();
  assert.equal(app.overlay.title, 'SESSION SUMMARY');
  assert.match(screenText(app), /SUMMARY-MARKER/);
});

test('the approval dialog shows what the call does, and "always" approves the tool for the heist', async (t) => {
  const { app } = await tui(t);
  const tool = { title: 'Execute shell command', risk: 'host-exec' };
  const first = app.requestToolConfirmation({ name: 'shell_exec', tool, args: { command: 'rm -rf build && npm ci' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.overlay.title, 'APPROVE TOOL CALL');
  assert.equal(app.overlay.choice, 1, 'a host-exec call defaults to NO');
  assert.match(screenText(app), /\$ rm -rf build && npm ci/);
  app.overlay.handle(app, { name: 'a' });
  assert.equal(await first, true);
  assert.equal(await app.requestToolConfirmation({ name: 'shell_exec', tool, args: { command: 'ls' } }), true);
  assert.equal(app.overlay, null, 'no second dialog once always-approved');

  const denied = app.requestToolConfirmation({ name: 'fs_write', tool: { risk: 'write' }, args: { path: 'a', content: 'b' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.overlay.choice, 0, 'a plain write defaults to YES');
  app.overlay.handle(app, { name: 'n' });
  assert.equal(await denied, false);
});

test('approval previews render commands, edits as diffs, and file writes', () => {
  const plain = (lines) => lines.map(stripAnsi).join('\n');
  assert.match(plain(approvalPreview(theme, 'shell_exec', { command: 'make test', cwd: '/repo' })), /\$ make test[\s\S]*cwd\s+\/repo/);
  const edit = plain(approvalPreview(theme, 'fs_patch', { path: 'a.js', edits: [{ oldText: 'x = 1', newText: 'x = 2' }] }));
  assert.match(edit, /-x = 1/);
  assert.match(edit, /\+x = 2/);
  assert.match(plain(approvalPreview(theme, 'fs_write', { path: 'n.txt', content: 'hello' })), /file\s+n\.txt[\s\S]*hello/);
});

test('undo reverts a run: modified restored, created removed, deleted brought back, earlier drafts kept', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  await fsp.writeFile(path.join(project, 'draft.txt'), 'already here before the run\n');
  const checkpoint = await runtime.workspaceManager.createCheckpoint(workspace.id, { runId: 'r1' });
  await fsp.writeFile(path.join(project, 'index.js'), 'changed\n');
  await fsp.writeFile(path.join(project, 'new.js'), 'made by the run\n');
  await fsp.rm(path.join(project, 'AGENTS.md'));

  const changes = await runtime.workspaceManager.checkpointChanges(workspace.id, checkpoint);
  assert.deepEqual(changes, { modified: ['index.js'], created: ['new.js'], deleted: ['AGENTS.md'] });
  const diff = await runtime.workspaceManager.checkpointFileDiff(workspace.id, checkpoint, 'index.js');
  assert.match(diff, /\+changed/);
  assert.match(await runtime.workspaceManager.checkpointFileDiff(workspace.id, checkpoint, 'new.js'), /\+made by the run/);

  const result = await runtime.workspaceManager.undoToCheckpoint(workspace.id, checkpoint);
  assert.deepEqual(result.removed, ['new.js']);
  assert.match(await fsp.readFile(path.join(project, 'index.js'), 'utf8'), /velocity/);
  await fsp.access(path.join(project, 'AGENTS.md'));
  await assert.rejects(fsp.access(path.join(project, 'new.js')));
  await fsp.access(path.join(project, 'draft.txt'));
  assert.deepEqual(await runtime.workspaceManager.checkpointChanges(workspace.id, checkpoint), { modified: [], created: [], deleted: [] });
});

test('the changes pane lists what the last run touched and loads each diff', async (t) => {
  const { app, runtime, project } = await tui(t);
  const checkpoint = await runtime.workspaceManager.createCheckpoint(app.workspaceId, { runId: 'r1' });
  await fsp.writeFile(path.join(project, 'index.js'), 'changed\n');
  app.lastUndoableRun = () => ({ run: { id: 'r1', prompt: 'Change index' }, checkpoint });
  await app.openRunChanges();
  assert.equal(app.overlay.title, 'RUN CHANGES');
  assert.deepEqual(app.overlay.files, [{ path: 'index.js', kind: 'modified' }]);
  screenText(app);
  await waitFor(() => typeof app.overlay.diffs.get('index.js') === 'string', { timeoutMs: 5000, message: 'diff load' });
  assert.match(screenText(app), /\+changed/);
});

test('a steering message reaches the running run and is labelled in the transcript', async (t) => {
  const bodies = [];
  const server = await jsonServer(t, async (request, response) => {
    if (isDiscoveryProbe(request)) return respondJson(response, 404, {});
    const body = await readJsonBody(request);
    bodies.push(body);
    await new Promise((resolve) => setTimeout(resolve, 150));
    return respondOpenAIChatSSE(response, { content: 'ok', finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 1 } });
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fx:m', providers: [{ id: 'fx', type: 'openai-compatible', baseUrl: server.url, apiKey: 'k', enabled: true, models: [{ id: 'm', contextWindow: 32_768 }] }],
  });
  const workspace = await runtime.workspaceManager.open(project);
  const run = await runtime.engine.startRun({ workspaceId: workspace.id, prompt: 'start', modelRef: 'fx:m' });
  assert.equal(runtime.engine.steer(run.id, 'STEER-MARKER').accepted, true);
  await runtime.engine.waitForRun(run.id);
  const steered = runtime.store.listMessages(run.session_id, 50).find((message) => message.meta?.source === 'steer');
  assert.equal(steered.content, 'STEER-MARKER');
  assert.ok(bodies.some((body) => body.messages.some((message) => message.content === 'STEER-MARKER')));
  assert.equal(runtime.engine.steer(run.id, 'too late').accepted, false);
});

test('streaming a text-protocol reply shows prose and never tool-call markup', () => {
  assert.equal(visibleStreamingText('Reading the file.\n<tool'), 'Reading the file.');
  assert.equal(visibleStreamingText('Reading.\n<tool_call>\n{"name":"fs_read","arguments":{}}\n</tool_call>\nDone.'), 'Reading.\n\nDone.');
  assert.equal(visibleStreamingText('x < y holds'), 'x < y holds');
  assert.equal(visibleStreamingText('a <function=fs_read><parameter=path>x'), 'a');
});

test('the session picker previews goal, open issues and the last request', async (t) => {
  const { app, runtime } = await tui(t);
  const session = runtime.engine.createSession({ workspaceId: app.workspaceId, title: 'Summarized' });
  runtime.store.addMessage({ sessionId: session.id, role: 'user', content: 'LAST-ASK' });
  runtime.store.updateSession(session.id, { meta: { compaction: { summary: '## Goal\n- GOAL-TEXT\n## Open issues\n- ISSUE-TEXT', throughMessageId: 'x' } } });
  app.sessionId = session.id;
  app.openSessionPicker();
  const text = screenText(app);
  assert.match(text, /GOAL\s+GOAL-TEXT/);
  assert.match(text, /OPEN\s+ISSUE-TEXT/);
  assert.match(text, /LAST\s+“LAST-ASK”/);
});

test('custom commands load from .maskshift/commands and expand $ARGUMENTS', async (t) => {
  const project = await createProject(t);
  const home = await tempDir(t, 'ms-home-');
  await fsp.mkdir(path.join(project, '.maskshift', 'commands'), { recursive: true });
  await fsp.mkdir(path.join(project, '.claude', 'commands'), { recursive: true });
  await fsp.writeFile(path.join(project, '.maskshift', 'commands', 'review.md'), '---\ndescription: Review a PR\n---\nReview PR $ARGUMENTS carefully.');
  await fsp.writeFile(path.join(project, '.claude', 'commands', 'review.md'), 'shadowed');
  await fsp.writeFile(path.join(project, '.claude', 'commands', 'notes.md'), 'Draft release notes.');
  await fsp.writeFile(path.join(project, '.claude', 'commands', 'help.md'), 'must not replace the built-in');
  const commands = await loadCustomCommands(commandDirectories(project, home), new Set(['help']));
  assert.deepEqual(commands.map((command) => command.name), ['notes', 'review']);
  const review = commands.find((command) => command.name === 'review');
  assert.equal(review.hint, 'Review a PR');
  assert.equal(expandCommand(review, '42'), 'Review PR 42 carefully.');
  assert.equal(expandCommand(commands[0], 'for 1.5'), 'Draft release notes.\n\nfor 1.5');

  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, { workspacePath: project, output: new FakeTerminal(), headless: true, theme });
  await app.bootstrap();
  await app.refreshCustomCommands();
  const started = [];
  app.startPrompt = async (prompt) => { started.push(prompt); };
  await app.runSlash('/review 7');
  assert.deepEqual(started, ['Review PR 7 carefully.']);
  app.composer.set('/re');
  assert.ok(app.matchingSlashCommands().some((entry) => entry.name === 'review' && entry.custom));
});

test('/compact summarizes older turns and later runs send the summary in their place', async (t) => {
  const bodies = [];
  const server = await jsonServer(t, async (request, response) => {
    if (isDiscoveryProbe(request)) return respondJson(response, 404, {});
    const body = await readJsonBody(request);
    bodies.push(body);
    const isSummary = body.messages[0]?.role !== 'system';
    return respondOpenAIChatSSE(response, { content: isSummary ? '## Goal\n- COMPACT-SUMMARY' : 'ok', finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 1 } });
  });
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, {
    defaultModel: 'fx:m', providers: [{ id: 'fx', type: 'openai-compatible', baseUrl: server.url, apiKey: 'k', enabled: true, models: [{ id: 'm', contextWindow: 200_000 }] }],
  });
  const workspace = await runtime.workspaceManager.open(project);
  const session = runtime.engine.createSession({ workspaceId: workspace.id, modelRef: 'fx:m' });
  for (let i = 0; i < 4; i++) {
    runtime.store.addMessage({ sessionId: session.id, role: 'user', content: `OLD-${i}` });
    runtime.store.addMessage({ sessionId: session.id, role: 'assistant', content: `reply ${i}` });
  }
  const result = await runtime.engine.compactSession(session.id, { modelRef: 'fx:m', keepRecentTurns: 2 });
  assert.equal(result.compacted, true);
  assert.equal(runtime.store.getSession(session.id).meta.compaction.forced, true);

  const run = await runtime.engine.startRun({ sessionId: session.id, workspaceId: workspace.id, prompt: 'next', modelRef: 'fx:m' });
  await runtime.engine.waitForRun(run.id);
  const turn = bodies.filter((body) => body.messages[0]?.role === 'system').at(-1);
  const contents = turn.messages.map((message) => String(message.content));
  assert.ok(contents.some((content) => content.includes('COMPACT-SUMMARY')));
  assert.ok(!contents.includes('OLD-0'), 'summarized turns are not sent verbatim');
  assert.ok(contents.includes('OLD-3'), 'the most recent turns stay verbatim');
});

test('the cost report lists each run and the total', async (t) => {
  const { app, runtime } = await tui(t);
  runtime.store.listRuns = () => [
    { started_at: now(), prompt: 'second', meta: { costEstimate: { cost: 0.1, inputTokens: 1000, outputTokens: 100, pricedEntries: 1, complete: true } } },
    { started_at: now(), prompt: 'first', meta: { costEstimate: { cost: 0, inputTokens: 500, outputTokens: 50, pricedEntries: 0, complete: false } } },
  ];
  app.openCostReport();
  const text = screenText(app);
  assert.match(text, /TOTAL\s+\$0\.1000/);
  assert.match(text, /unpriced/);
  assert.match(text, /1 run has usage with no price/);
});

test('with colour off, chips and the active tab stay visible as brackets', async (t) => {
  const plain = new Theme({ depth: 0, unicode: true });
  assert.equal(chip(plain, 'YES'), '[YES]');
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const app = new MaskShiftTui(runtime, { workspacePath: project, output: new FakeTerminal(), headless: true, theme: plain });
  await app.bootstrap();
  app.screen.invalidate();
  assert.match(app.snapshot()[1], /\[01 HEIST\]/);
});

test('NO_COLOR wins over a saved colour depth preference', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project, { ui: { colorDepth: 24 } });
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  t.after(() => { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; });
  const app = new MaskShiftTui(runtime, { workspacePath: project, output: new FakeTerminal(), headless: false });
  assert.equal(app.theme.depth, 0);
});

test('alt+enter decodes as enter with alt, so the composer\'s newline binding fires', () => {
  const [event] = decode(`${String.fromCharCode(27)}\r`).events;
  assert.equal(event.name, 'enter');
  assert.equal(event.alt, true);
});

test('plain mode runs a request line by line and asks for approvals inline', { timeout: 60_000 }, async (t) => {
  const server = await jsonServer(t, async (request, response) => {
    if (isDiscoveryProbe(request)) return respondJson(response, 404, {});
    const body = await readJsonBody(request);
    if (!body.messages.some((message) => message.role === 'tool')) {
      return respondOpenAIChatSSE(response, { toolCalls: [{ id: 'c1', name: 'fs_write', args: { path: 'note.txt', content: 'hi' } }], finishReason: 'tool_calls' });
    }
    return respondOpenAIChatSSE(response, { content: 'Wrote it.', finishReason: 'stop' });
  });
  const project = await createProject(t);
  const home = await tempDir(t, 'ms-plain-');
  const config = path.join(home, 'config.json');
  await fsp.writeFile(config, JSON.stringify({
    home, autoIndex: false, autoCheckpoint: false, permissionMode: 'review', defaultModel: 'fx:m',
    providers: [{ id: 'fx', type: 'openai-compatible', baseUrl: server.url, enabled: true, models: [{ id: 'm', contextWindow: 32_768 }] }],
  }));
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--no-warnings', path.resolve('bin/maskshift.mjs'), '--plain', '--config', config, '--workspace', project], { env: { ...process.env, MASKSHIFT_HOME: home, NO_COLOR: '1' } });
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
    if (out.includes('Answer y (yes)') && !child.answered) { child.answered = true; child.stdin.write('y\n'); }
    if (out.includes('Run completed') && !child.quit) { child.quit = true; child.stdin.write('/quit\n'); }
  });
  setTimeout(() => child.stdin.write('write a note\n'), 500);
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /\x1b\[/, 'no escape codes in plain mode');
  assert.match(out, /Approve fs_write/);
  assert.equal(await fsp.readFile(path.join(project, 'note.txt'), 'utf8'), 'hi');
});
