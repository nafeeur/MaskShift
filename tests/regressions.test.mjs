import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandExists } from '../src/core/utils.mjs';
import { createProject, jsonServer, runtimeForTest, tempDir } from './helpers.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const bin = path.join(repoRoot, 'bin', 'maskshift.mjs');

function run(args, options) {
  return new Promise((resolve, reject) => {
    execFile('node', ['--no-warnings', bin, ...args], options, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(error, { stdout, stderr }));
      resolve({ stdout, stderr });
    });
  });
}

function contextFor(runtime, workspace, project) {
  return { workspaceId: workspace.id, workspacePath: project, eventBus: runtime.eventBus, scope: { workspaceId: workspace.id } };
}

test('maskshift daemon stays resident until signalled, instead of exiting immediately', async (t) => {
  const project = await createProject(t);
  const home = await tempDir(t, 'maskshift-daemon-home-');
  const child = spawn('node', ['--no-warnings', bin, 'daemon', '--workspace', project], {
    env: { ...process.env, MASKSHIFT_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  try {
    // The scheduler's own poll timer is deliberately unref()'d (correct for every other, one-shot
    // command), which used to mean nothing kept the daemon's event loop open either — it printed
    // its banner and exited within milliseconds despite claiming to stay resident. Waiting here
    // and asserting the process is still alive is exactly the regression check for that: on the
    // old code this would already have exited by the time this fires.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(child.exitCode, null, 'expected the daemon to still be running, not to have exited already');
    assert.match(stdout, /Daemon resident/);
    assert.match(stdout, /Press ctrl\+c to stop/);
  } finally {
    child.kill('SIGTERM');
  }

  const { code, signal } = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('daemon did not exit within 5s of SIGTERM')), 5000)),
  ]);
  assert.equal(signal, null, 'expected a clean voluntary exit, not the process being force-killed');
  assert.equal(code, 0);
});

test('shell_exec_parallel accepts plain command strings as well as objects', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const context = contextFor(runtime, workspace, project);

  const strings = await runtime.toolRegistry.execute('shell_exec_parallel', { commands: ['echo alpha', 'echo beta'] }, context);
  assert.equal(strings.length, 2);
  assert.match(strings[0].stdout, /alpha/);
  assert.match(strings[1].stdout, /beta/);

  const objects = await runtime.toolRegistry.execute('shell_exec_parallel', { commands: [{ command: 'echo gamma' }] }, context);
  assert.match(objects[0].stdout, /gamma/);

  await assert.rejects(
    runtime.toolRegistry.execute('shell_exec_parallel', { commands: [{ cwd: '.' }] }, context),
    /must be a command string/,
  );
});

test('plugin_scaffold creates a named subdirectory and activates it from any parent directory', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const context = contextFor(runtime, workspace, project);

  // An explicit directory is the parent, so the plugin lands in <directory>/<name>.
  const custom = path.join(project, 'custom-plugins');
  const scaffolded = await runtime.toolRegistry.execute('plugin_scaffold', { name: 'audit-explicit', directory: custom }, context);
  assert.equal(scaffolded.root, path.join(custom, 'audit-explicit'));
  assert.equal(scaffolded.plugin.status, 'active');

  // Activation must survive the plugin living outside any configured plugin root.
  assert.ok(runtime.toolRegistry.has('audit_explicit_hello'));
  const greeting = await runtime.toolRegistry.execute('audit_explicit_hello', { name: 'MaskShift' }, context);
  assert.match(JSON.stringify(greeting), /Hello, MaskShift/);

  // Passing the plugins root itself must not scatter a manifest loose inside it.
  const root = path.join(project, '.maskshift', 'plugins');
  const nested = await runtime.toolRegistry.execute('plugin_scaffold', { name: 'audit-nested', directory: root }, context);
  assert.equal(nested.root, path.join(root, 'audit-nested'));
  assert.equal(nested.plugin.status, 'active');
  await assert.rejects(fsp.access(path.join(root, 'maskshift.plugin.json')));

  const bare = await runtime.toolRegistry.execute('plugin_scaffold', { name: 'audit-default' }, context);
  assert.equal(bare.plugin.status, 'active');
});

test('automation schemas describe the action and schedule shapes they require', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const context = contextFor(runtime, workspace, project);

  // The schema is the only contract a model sees, so it must name the variants.
  for (const tool of ['automation_create', 'automation_update']) {
    const { inputSchema } = runtime.toolRegistry.descriptor(tool);
    assert.deepEqual(inputSchema.properties.action.required, ['type']);
    assert.deepEqual(inputSchema.properties.action.properties.type.enum, ['agent', 'tool', 'shell']);
    assert.ok(inputSchema.properties.action.properties.name.description.startsWith('tool:'));
    assert.equal(inputSchema.properties.schedule.oneOf.length, 4);
  }

  const created = await runtime.toolRegistry.execute('automation_create', {
    name: 'audit', schedule: 'every 1h', action: { type: 'tool', name: 'system_info', arguments: {} },
  }, context);
  assert.ok(created.id);
  const ran = await runtime.toolRegistry.execute('automation_run_now', { automationId: created.id }, context);
  assert.equal(ran.result.type, 'tool');
  await runtime.toolRegistry.execute('automation_delete', { automationId: created.id }, context);
});

test('language server requests resolve instead of timing out after the initialize handshake', async (t) => {
  if (!(await commandExists('pyright-langserver'))) {
    t.skip('pyright-langserver is not installed on this host');
    return;
  }
  const project = await createProject(t);
  await fsp.writeFile(path.join(project, 'main.py'), 'def velocity(distance, time):\n    return distance / time\n\n\nresult = velocity(10, 2)\n');
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const context = contextFor(runtime, workspace, project);

  // Servers that gate analysis on initial configuration used to leave every request
  // hanging until its 20s timeout, which made most LSP tools unusable.
  const symbols = await runtime.toolRegistry.execute('lsp_symbols', { file: 'main.py' }, context);
  assert.ok(Array.isArray(symbols) && symbols.length > 0);
  assert.equal(symbols[0].name, 'velocity');

  const hover = await runtime.toolRegistry.execute('lsp_hover', { file: 'main.py', line: 1, character: 5 }, context);
  assert.match(JSON.stringify(hover), /velocity/);

  const references = await runtime.toolRegistry.execute('lsp_references', { file: 'main.py', line: 1, character: 5 }, context);
  assert.ok(Array.isArray(references) && references.length > 0);

  // Pyright has no formatting provider; that must read as a clear message, not a raw JSON-RPC error.
  await assert.rejects(
    runtime.toolRegistry.execute('lsp_format', { file: 'main.py', apply: false }, context),
    /does not provide document formatting/,
  );
});

test('every bundled skill parses, loads, and is discoverable by name', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const context = contextFor(runtime, await runtime.workspaceManager.open(project), project);

  const bundled = runtime.skillManager.list().filter((skill) => skill.source === 'bundled');
  assert.ok(bundled.length >= 36, `expected the bundled skill pack, saw ${bundled.length}`);

  for (const skill of bundled) {
    assert.equal(skill.name, path.basename(skill.path), `${skill.name} declares a name that differs from its directory`);
    assert.ok(skill.description.length > 24, `${skill.name} has no usable description`);

    const loaded = await runtime.toolRegistry.execute('skill_load', { name: skill.name }, context);
    assert.ok(loaded.body.trim().length > 200, `${skill.name} has an unusably thin body`);

    for (const reference of new Set([...loaded.body.matchAll(/references\/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)/g)].map((match) => match[1]))) {
      await fsp.access(path.join(skill.path, 'references', reference));
    }

    const hits = await runtime.toolRegistry.execute('skill_search', { query: skill.name.replace(/-/g, ' ') }, context);
    assert.ok(hits.some((hit) => hit.name === skill.name), `${skill.name} is not discoverable by its own name`);
  }
});

test('the Apache-licensed Anthropic skill pack ships as lazy bundled skills', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const expected = [
    'academy-guide', 'algorithmic-art', 'brand-guidelines', 'canvas-design',
    'claude-api', 'discernment-nudge', 'frontend-design', 'internal-comms',
    'mcp-builder', 'skill-creator', 'slack-gif-creator', 'theme-factory',
    'web-artifacts-builder', 'webapp-testing',
  ];

  for (const name of expected) {
    const bundledPath = path.resolve('skills', name);
    await fsp.access(path.join(bundledPath, 'SKILL.md'));
    const skill = runtime.skillManager.get(name);
    if (skill?.source === 'bundled') assert.ok(skill.description.length > 24, `${name} has no usable description`);
    assert.match(await fsp.readFile(path.join(bundledPath, 'LICENSE.txt'), 'utf8'), /Apache License/);
  }

  for (const name of ['docx', 'pdf', 'pptx', 'xlsx']) {
    await assert.rejects(fsp.access(path.resolve('skills', name)), `${name} must not be bundled`);
  }
});

test('skill references cannot escape the skill directory', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const context = contextFor(runtime, await runtime.workspaceManager.open(project), project);

  await runtime.toolRegistry.execute('skill_create', {
    name: 'audit-fixture', description: 'Fixture skill used to check reference sandboxing.', body: '# Fixture\n\nBody.',
  }, context);

  await assert.rejects(
    runtime.toolRegistry.execute('skill_read_reference', { name: 'audit-fixture', reference: '../../../etc/passwd' }, context),
    /escapes skill directory/,
  );
});

test('browser artifacts resolve inside the workspace, not the server working directory', async (t) => {
  const project = await createProject(t);
  // Honour an out-of-PATH Chromium (a Playwright download, say) so this still runs in CI images.
  const probe = await runtimeForTest(t, project);
  let executable = (await probe.browserManager.discover(true)).executable;
  for (const candidate of [process.env.MASKSHIFT_TEST_BROWSER, '/opt/pw-browsers/chromium']) {
    if (executable || !candidate) continue;
    if (await fsp.access(candidate).then(() => true).catch(() => false)) executable = candidate;
  }
  if (!executable) {
    t.skip('no Chromium/Chrome executable is installed on this host');
    return;
  }
  const runtime = await runtimeForTest(t, project, { browser: { executable } });
  const workspace = await runtime.workspaceManager.open(project);
  const context = contextFor(runtime, workspace, project);

  const page = await jsonServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<html><head><title>Fixture</title></head><body><h1>Fixture Page</h1></body></html>');
  });

  const before = await fsp.readdir(process.cwd());
  const instance = await runtime.toolRegistry.execute('browser_launch', { headless: true }, context);
  t.after(async () => runtime.toolRegistry.execute('browser_close', { instanceId: instance.instanceId }, context).catch(() => {}));
  await runtime.toolRegistry.execute('browser_navigate', { instanceId: instance.instanceId, url: page.url }, context);

  // A relative file used to resolve against process.cwd(), dropping artifacts into the repo.
  const shot = await runtime.toolRegistry.execute('browser_screenshot', { file: 'shot.png' }, context);
  assert.equal(shot.file, path.join(project, 'shot.png'));
  const pdf = await runtime.toolRegistry.execute('browser_print_pdf', { file: 'page.pdf' }, context);
  assert.equal(pdf.file, path.join(project, 'page.pdf'));

  const generated = await runtime.toolRegistry.execute('browser_screenshot', {}, context);
  assert.ok(generated.file.startsWith(`${project}${path.sep}`));

  assert.deepEqual((await fsp.readdir(process.cwd())).filter((entry) => !before.includes(entry)), []);
});

test('the 07 BROWSER live view can capture, click, type into, and scroll a real page', async (t) => {
  const project = await createProject(t);
  const probe = await runtimeForTest(t, project);
  let executable = (await probe.browserManager.discover(true)).executable;
  for (const candidate of [process.env.MASKSHIFT_TEST_BROWSER, '/opt/pw-browsers/chromium']) {
    if (executable || !candidate) continue;
    if (await fsp.access(candidate).then(() => true).catch(() => false)) executable = candidate;
  }
  if (!executable) {
    t.skip('no Chromium/Chrome executable is installed on this host');
    return;
  }
  const runtime = await runtimeForTest(t, project, { browser: { executable } });
  const page = await jsonServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<html><body style="margin:0;height:3000px">
      <input id="box" style="position:absolute;top:200px;left:20px;width:300px;height:40px">
      <button id="btn" style="position:absolute;top:260px;left:20px;width:150px;height:40px"
        onclick="document.title='CLICKED'">Click me</button>
    </body></html>`);
  });

  const instance = await runtime.browserManager.launch({ headless: true, url: page.url, executable, extraArgs: ['--window-size=800,600'] });
  t.after(() => runtime.browserManager.close(instance.id).catch(() => {}));
  const tabs = await runtime.browserManager.tabs(instance.id);
  const tabId = tabs[0].id;

  // captureFrame: a real, decodable PNG at the viewport's own CSS size.
  const frame = await runtime.browserManager.captureFrame({ instanceId: instance.id, tabId });
  assert.ok(frame.buffer.length > 100, 'expected a non-trivial PNG payload');
  assert.equal(frame.buffer[0], 0x89, 'captureFrame should return PNG bytes'); // PNG signature's first byte
  assert.ok(frame.cssWidth > 0 && frame.cssHeight > 0);

  // mouseEvent(click): the same CSS-pixel click the live view computes from
  // a terminal cell actually reaches the page and fires its handler.
  const buttonRect = await runtime.browserManager.evaluate({
    instanceId: instance.id, tabId,
    expression: '(() => { const r = document.getElementById("btn").getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()',
  });
  await runtime.browserManager.mouseEvent({ instanceId: instance.id, tabId, kind: 'click', ...buttonRect.value });
  const titleAfterClick = await runtime.browserManager.evaluate({ instanceId: instance.id, tabId, expression: 'document.title' });
  assert.equal(titleAfterClick.value, 'CLICKED');

  // mouseEvent(click) + keyEvent(text): focus the input, then type into it —
  // the two calls the live view's typing mode chains together.
  const inputRect = await runtime.browserManager.evaluate({
    instanceId: instance.id, tabId,
    expression: '(() => { const r = document.getElementById("box").getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()',
  });
  await runtime.browserManager.mouseEvent({ instanceId: instance.id, tabId, kind: 'click', ...inputRect.value });
  for (const character of 'hi!') await runtime.browserManager.keyEvent({ instanceId: instance.id, tabId, text: character });
  const inputValue = await runtime.browserManager.evaluate({ instanceId: instance.id, tabId, expression: 'document.getElementById("box").value' });
  assert.equal(inputValue.value, 'hi!');

  // keyEvent(key): a named key with no character of its own still reaches the page.
  await runtime.browserManager.keyEvent({ instanceId: instance.id, tabId, key: 'backspace' });
  const afterBackspace = await runtime.browserManager.evaluate({ instanceId: instance.id, tabId, expression: 'document.getElementById("box").value' });
  assert.equal(afterBackspace.value, 'hi');

  // mouseEvent(wheel): a scroll actually moves the page.
  await runtime.browserManager.mouseEvent({ instanceId: instance.id, tabId, kind: 'wheel', x: 100, y: 100, deltaY: 100 });
  const scrollY = await runtime.browserManager.evaluate({ instanceId: instance.id, tabId, expression: 'window.scrollY' });
  assert.ok(scrollY.value > 0, 'expected the wheel event to scroll the page');
});

test('captureFrame caps its screenshot resolution for maxWidth/maxHeight without changing the reported CSS viewport size', async (t) => {
  const project = await createProject(t);
  const probe = await runtimeForTest(t, project);
  let executable = (await probe.browserManager.discover(true)).executable;
  for (const candidate of [process.env.MASKSHIFT_TEST_BROWSER, '/opt/pw-browsers/chromium']) {
    if (executable || !candidate) continue;
    if (await fsp.access(candidate).then(() => true).catch(() => false)) executable = candidate;
  }
  if (!executable) {
    t.skip('no Chromium/Chrome executable is installed on this host');
    return;
  }
  const runtime = await runtimeForTest(t, project, { browser: { executable } });
  const page = await jsonServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<html><body style="margin:0;height:400px;background:#123456">hi</body></html>');
  });
  const instance = await runtime.browserManager.launch({ headless: true, url: page.url, executable, extraArgs: ['--window-size=1200,800'] });
  t.after(() => runtime.browserManager.close(instance.id).catch(() => {}));
  const tabs = await runtime.browserManager.tabs(instance.id);
  const tabId = tabs[0].id;

  // The viewport can still be settling (window chrome, scrollbar) right
  // after launch — one throwaway capture lets that finish before the two
  // captures being compared below.
  await runtime.browserManager.captureFrame({ instanceId: instance.id, tabId });

  // Uncapped: this is what the fast-path terminals (Kitty passes the bytes
  // straight through; iTerm2 only reads the header) get — no reason to pay
  // for a smaller screenshot when nothing here decodes it.
  const full = await runtime.browserManager.captureFrame({ instanceId: instance.id, tabId });
  const { decodePng } = await import('../src/tui/image/png.mjs');
  const fullDecoded = decodePng(full.buffer);
  assert.ok(fullDecoded.width > 300, `expected an uncapped screenshot, got ${fullDecoded.width}px wide`);

  // Capped: what the half-block fallback asks for — it has to decode this
  // buffer itself on every poll, so a smaller capture keeps that fast (see
  // app.mjs's pollBrowserFrame). The CSS viewport size it reports back —
  // what click-coordinate mapping actually uses — must stay the real one.
  const capped = await runtime.browserManager.captureFrame({ instanceId: instance.id, tabId, maxWidth: 100, maxHeight: 60 });
  const cappedDecoded = decodePng(capped.buffer);
  assert.ok(cappedDecoded.width <= 100, `expected a capped screenshot, got ${cappedDecoded.width}px wide`);
  assert.equal(capped.cssWidth, full.cssWidth);
  assert.equal(capped.cssHeight, full.cssHeight);
});

test('bin/maskshift.mjs loads a .env file from the working directory on startup', async (t) => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'maskshift-env-'));
  t.after(() => fsp.rm(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home');
  await fsp.writeFile(
    path.join(temp, '.env'),
    `MASKSHIFT_HOME=${home}\nMASKSHIFT_MODEL=lmstudio:regression-model\n`,
  );

  const { stdout } = await run(['config', 'get', 'defaultModel', '--json'], { cwd: temp, env: { PATH: process.env.PATH } });
  assert.deepEqual(JSON.parse(stdout), { defaultModel: 'lmstudio:regression-model' });
});
