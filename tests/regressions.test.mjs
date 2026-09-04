import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { commandExists } from '../src/core/utils.mjs';
import { createProject, jsonServer, runtimeForTest } from './helpers.mjs';

function contextFor(runtime, workspace, project) {
  return { workspaceId: workspace.id, workspacePath: project, eventBus: runtime.eventBus, scope: { workspaceId: workspace.id } };
}

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
