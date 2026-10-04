// Every MaskShift capability, available without a terminal UI.
//
// Commands are grouped by noun ("mcp", "session", "automation"); each entry
// declares its usage so `maskshift help <noun>` stays generated, never stale.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { safeJsonParse, truncate } from '../core/utils.mjs';
import { McpServer } from '../mcp/server.mjs';
import { formatBytes } from '../storage/budget.mjs';
import { oneLine } from './ui.mjs';

const STATUS_TONE = (theme, status) => ({
  connected: theme.roles.success, available: theme.roles.info, disabled: theme.roles.muted,
  disconnected: theme.roles.warning, active: theme.roles.success, inactive: theme.roles.muted,
  failed: theme.roles.danger, error: theme.roles.danger, running: theme.roles.success,
  completed: theme.roles.success, cancelled: theme.roles.muted, queued: theme.roles.warning,
  max_steps: theme.roles.warning, stagnated: theme.roles.warning, online: theme.roles.success, offline: theme.roles.muted,
  interrupted: theme.roles.warning,
}[status] || theme.roles.text);

async function resolveWorkspace(context) {
  const { runtime, args } = context;
  if (context.workspace) return context.workspace;
  const target = args.workspace || process.cwd();
  context.workspace = await runtime.workspaceManager.open(target);
  runtime.store.setSetting('lastWorkspaceId', context.workspace.id);
  return context.workspace;
}

function toolContext(runtime, workspace) {
  return {
    workspaceId: workspace?.id || null,
    workspacePath: workspace?.path || process.cwd(),
    sessionId: null, runId: null,
    scope: { workspaceId: workspace?.id || null },
    eventBus: runtime.eventBus, store: runtime.store,
    capabilityState: runtime.capabilityController.createState({ runId: null, workspaceId: workspace?.id || null }),
    planState: { summary: '', steps: [] },
  };
}

function requirePositional(context, index, name) {
  const value = context.positional[index];
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

// ------------------------------------------------------------------ workspace

const workspaceCommands = {
  open: {
    usage: 'workspace open [PATH]',
    summary: 'Open a workspace, import its configuration and index it',
    async run(context) {
      const { runtime, ui, args } = context;
      const workspace = await runtime.workspaceManager.open(context.positional[0] || args.workspace || process.cwd());
      runtime.store.setSetting('lastWorkspaceId', workspace.id);
      await runtime.mcpManager.refreshDefinitions(workspace.path);
      await runtime.skillManager.setWorkspace(workspace.path);
      await runtime.personaManager.setWorkspace(workspace.path);
      runtime.pluginManager.workspacePath = workspace.path;
      await runtime.pluginManager.scan({ activate: true });
      if (args.index !== false && args['no-index'] !== true) await runtime.indexer.index(workspace.id, { force: true });
      if (ui.emit(workspace)) return;
      ui.ok(`Target locked: ${workspace.name}`);
      ui.fields([['id', workspace.id], ['path', workspace.path], ['git', workspace.meta?.gitRoot || 'not a repository']]);
    },
  },
  list: {
    usage: 'workspace list',
    summary: 'List every workspace MaskShift knows about',
    run(context) {
      const workspaces = context.runtime.store.listWorkspaces();
      if (context.ui.emit(workspaces)) return;
      context.ui.table([
        { key: 'name', label: 'name' },
        { key: 'path', label: 'path', max: 60 },
        { key: 'id', label: 'id' },
      ], workspaces);
    },
  },
  info: {
    usage: 'workspace info',
    summary: 'Inspect the workspace: git, languages, project and context files',
    async run(context) {
      const workspace = await resolveWorkspace(context);
      const report = await context.runtime.workspaceManager.inspect(workspace.id);
      if (context.ui.emit(report)) return;
      const { ui } = context;
      ui.heading('target intel');
      ui.fields([
        ['path', report.workspace.path],
        ['files', `${report.files.count}${report.files.truncated ? '+' : ''}`],
        ['git root', report.git?.root || 'not a repository'],
        ['clean', report.git ? String(report.git.clean) : '—'],
        ['project files', report.projectFiles.join(', ') || 'none'],
        ['context files', report.contextFiles.map((file) => file.path).join(', ') || 'none'],
      ]);
      ui.section('languages');
      ui.table([
        { key: 'extension', label: 'extension' },
        { key: 'files', label: 'files', align: 'right' },
      ], report.languages.map(([extension, files]) => ({ extension, files })));
      if (report.git?.status) { ui.section('git status'); ui.line(report.git.status); }
    },
  },
  tree: {
    usage: 'workspace tree [PATH] [--depth N] [--hidden]',
    summary: 'Print the workspace file tree',
    async run(context) {
      const workspace = await resolveWorkspace(context);
      const result = await context.runtime.workspaceManager.listFiles(workspace.id, {
        target: context.positional[0] || '.',
        depth: Number(context.args.depth || 3),
        includeHidden: Boolean(context.args.hidden),
        maxEntries: Number(context.args.limit || 4000),
      });
      if (context.ui.emit(result)) return;
      const { ui } = context;
      for (const entry of result.entries) {
        const depth = (entry.path.match(/[/\\]/g) || []).length;
        const indent = '  '.repeat(depth);
        const tone = entry.type === 'directory' ? ui.theme.roles.accent : ui.theme.roles.text;
        ui.line(ui.theme.paint(`${indent}${entry.type === 'directory' ? ui.marks.arrowDown : ui.marks.dot} ${entry.name}`, { fg: tone }));
      }
      if (result.truncated) ui.warn('Listing truncated; raise --limit for more.');
    },
  },
  search: {
    usage: 'workspace search QUERY [--limit N]',
    summary: 'Search the indexed repository (full text plus embeddings)',
    async run(context) {
      const workspace = await resolveWorkspace(context);
      const query = requirePositional(context, 0, 'QUERY');
      const hits = await context.runtime.indexer.search(workspace.id, query, Number(context.args.limit || 20));
      if (context.ui.emit(hits)) return;
      const { ui } = context;
      for (const hit of hits) {
        ui.line(ui.theme.paint(`${hit.path}${hit.startLine ? `:${hit.startLine}` : ''}`, { fg: ui.theme.roles.accent, bold: true }));
        ui.paragraph(oneLine(hit.snippet || hit.content || '', ui.width * 2));
        ui.line();
      }
      if (!hits.length) ui.warn('No matches. Run "maskshift workspace index" first.');
    },
  },
  index: {
    usage: 'workspace index [--force]',
    summary: 'Build or rebuild the local context index',
    async run(context) {
      const workspace = await resolveWorkspace(context);
      const stats = await context.runtime.indexer.index(workspace.id, { force: context.args.force !== false });
      if (context.ui.emit(stats)) return;
      context.ui.ok('Index rebuilt');
      context.ui.fields(Object.entries(stats).map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : value]));
    },
  },
  checkpoint: {
    usage: 'workspace checkpoint [LABEL]',
    summary: 'Record a restore point for the working tree',
    async run(context) {
      const workspace = await resolveWorkspace(context);
      const checkpoint = await context.runtime.workspaceManager.createCheckpoint(workspace.id, {
        label: context.positional[0] || 'manual',
      });
      if (context.ui.emit(checkpoint)) return;
      context.ui.ok(`Checkpoint ${checkpoint.kind} saved as ${checkpoint.ref || checkpoint.id}`);
    },
  },
  checkpoints: {
    usage: 'workspace checkpoints',
    summary: 'List recorded checkpoints',
    async run(context) {
      const workspace = await resolveWorkspace(context);
      const checkpoints = context.runtime.store.listCheckpoints(workspace.id, Number(context.args.limit || 50));
      if (context.ui.emit(checkpoints)) return;
      context.ui.table([
        { key: 'id', label: 'id' },
        { key: 'kind', label: 'kind' },
        { key: 'ref', label: 'ref' },
        { key: 'created_at', label: 'created' },
      ], checkpoints);
    },
  },
  restore: {
    usage: 'workspace restore CHECKPOINT_ID',
    summary: 'Restore the working tree to a checkpoint',
    async run(context) {
      const workspace = await resolveWorkspace(context);
      const checkpointId = requirePositional(context, 0, 'CHECKPOINT_ID');
      const checkpoint = context.runtime.store.listCheckpoints(workspace.id, 5000).find((item) => item.id === checkpointId);
      if (!checkpoint) throw new Error(`Unknown checkpoint: ${checkpointId}`);
      const result = await context.runtime.workspaceManager.restoreCheckpoint(workspace.id, checkpoint);
      if (context.ui.emit(result)) return;
      context.ui.ok('Checkpoint restored');
    },
  },
  read: {
    usage: 'workspace read PATH [--start N] [--end N]',
    summary: 'Read a file through the MaskShift filesystem tool',
    async run(context) {
      const workspace = await resolveWorkspace(context);
      const target = requirePositional(context, 0, 'PATH');
      const result = await context.runtime.toolRegistry.execute('fs_read', {
        path: target,
        startLine: Number(context.args.start || 1),
        endLine: context.args.end ? Number(context.args.end) : undefined,
        withLineNumbers: context.args.numbers !== false,
      }, toolContext(context.runtime, workspace));
      if (context.ui.emit(result)) return;
      context.ui.line(typeof result === 'string' ? result : result.content ?? JSON.stringify(result, null, 2));
    },
  },
};

// -------------------------------------------------------------------- session

const sessionCommands = {
  list: {
    usage: 'session list [--limit N]',
    summary: 'List chats',
    run(context) {
      const sessions = context.runtime.store.listSessions({ limit: Number(context.args.limit || 40) });
      if (context.ui.emit(sessions)) return;
      context.ui.table([
        { key: 'id', label: 'id' },
        { key: 'title', label: 'title', max: 42 },
        { key: 'model_id', label: 'model' },
        { key: 'status', label: 'status', tone: (row, theme) => STATUS_TONE(theme, row.status) },
        { key: 'updated_at', label: 'updated' },
      ], sessions);
    },
  },
  show: {
    usage: 'session show SESSION_ID',
    summary: 'Print a full transcript',
    run(context) {
      const sessionId = requirePositional(context, 0, 'SESSION_ID');
      const session = context.runtime.store.getSession(sessionId);
      if (!session) throw new Error(`Unknown session: ${sessionId}`);
      const messages = context.runtime.store.listMessages(sessionId, Number(context.args.limit || 500));
      if (context.ui.emit({ session, messages })) return;
      const { ui } = context;
      ui.heading(session.title || 'chat');
      for (const message of messages) {
        if (message.role === 'user') { ui.section('user'); ui.markdown(message.content); }
        else if (message.role === 'assistant' && message.content) { ui.section('maskshift'); ui.markdown(message.content); }
        else if (message.role === 'tool') {
          ui.line(ui.theme.paint(`  ${message.meta?.isError ? ui.marks.cross : ui.marks.check} ${message.meta?.toolName || 'tool'}`, {
            fg: message.meta?.isError ? ui.theme.roles.danger : ui.theme.roles.tool,
          }) + ui.theme.paint(`  ${oneLine(message.content, ui.width - 24)}`, { fg: ui.theme.roles.muted }));
        }
      }
    },
  },
  new: {
    usage: 'session new [TITLE] [--model REF]',
    summary: 'Create an empty chat',
    async run(context) {
      const workspace = await resolveWorkspace(context);
      const session = context.runtime.engine.createSession({
        workspaceId: workspace.id,
        title: context.positional.join(' ') || 'New chat',
        modelRef: context.args.model || null,
      });
      if (context.ui.emit(session)) return;
      context.ui.ok(`Chat ${session.id} opened`);
    },
  },
  rename: {
    usage: 'session rename SESSION_ID TITLE...',
    summary: 'Rename a chat',
    run(context) {
      const sessionId = requirePositional(context, 0, 'SESSION_ID');
      const title = context.positional.slice(1).join(' ');
      if (!title) throw new Error('Missing required argument: TITLE');
      const session = context.runtime.store.updateSession(sessionId, { title });
      if (context.ui.emit(session)) return;
      context.ui.ok(`Renamed to ${title}`);
    },
  },
  delete: {
    usage: 'session delete SESSION_ID',
    summary: 'Delete a chat and its messages',
    run(context) {
      const sessionId = requirePositional(context, 0, 'SESSION_ID');
      context.runtime.store.deleteSession(sessionId);
      if (context.ui.emit({ deleted: sessionId })) return;
      context.ui.warn(`Deleted ${sessionId}`);
    },
  },
  export: {
    usage: 'session export SESSION_ID [--out FILE]',
    summary: 'Export a chat as JSON',
    async run(context) {
      const sessionId = requirePositional(context, 0, 'SESSION_ID');
      const session = context.runtime.store.getSession(sessionId);
      if (!session) throw new Error(`Unknown session: ${sessionId}`);
      const payload = {
        session,
        messages: context.runtime.store.listMessages(sessionId, 5000),
        runs: context.runtime.store.listRuns({ sessionId, limit: 500 }),
      };
      if (context.args.out) {
        await fsp.writeFile(path.resolve(String(context.args.out)), `${JSON.stringify(payload, null, 2)}\n`);
        context.ui.ok(`Exported to ${context.args.out}`);
        return;
      }
      context.ui.write(JSON.stringify(payload, null, 2));
    },
  },
  runs: {
    usage: 'session runs SESSION_ID',
    summary: 'List the runs inside a chat',
    run(context) {
      const sessionId = requirePositional(context, 0, 'SESSION_ID');
      const runs = context.runtime.store.listRuns({ sessionId, limit: Number(context.args.limit || 50) });
      if (context.ui.emit(runs)) return;
      context.ui.table([
        { key: 'id', label: 'run' },
        { key: 'status', label: 'status', tone: (row, theme) => STATUS_TONE(theme, row.status) },
        { key: 'model_id', label: 'model' },
        { key: 'started_at', label: 'started' },
        { key: 'ended_at', label: 'ended' },
      ], runs);
    },
  },
};

// ---------------------------------------------------------------------- tools

const toolCommands = {
  list: {
    usage: 'tools list [--category NAME] [--search QUERY]',
    summary: 'List native tools',
    run(context) {
      const { runtime, ui, args } = context;
      const tools = args.search
        ? runtime.toolRegistry.search(String(args.search), { limit: Number(args.limit || 60), category: args.category || null })
        : runtime.toolRegistry.list({ category: args.category || null, includeSchema: false });
      if (ui.emit(tools)) return;
      ui.table([
        { key: 'name', label: 'tool', tone: (row, theme) => theme.roles.tool },
        { key: 'category', label: 'category' },
        { key: 'access', label: 'access', value: (row) => (row.readOnly ? 'read' : 'write'), tone: (row, theme) => (row.readOnly ? theme.roles.success : theme.roles.danger) },
        { key: 'risk', label: 'risk' },
        { key: 'description', label: 'description', max: 64 },
      ], tools);
      ui.line();
      ui.info(`${tools.length} tools`);
    },
  },
  show: {
    usage: 'tools show NAME',
    summary: 'Show a tool descriptor and its parameter schema',
    run(context) {
      const name = requirePositional(context, 0, 'NAME');
      const descriptor = context.runtime.toolRegistry.descriptor(name);
      if (!descriptor) throw new Error(`Unknown tool: ${name}`);
      if (context.ui.emit(descriptor)) return;
      const { ui } = context;
      ui.heading(descriptor.name);
      ui.paragraph(descriptor.description);
      ui.fields([
        ['category', descriptor.category],
        ['access', descriptor.readOnly ? 'read only' : 'writes / executes'],
        ['risk', descriptor.risk || 'normal'],
        ['always on', descriptor.alwaysAvailable ? 'yes' : 'loaded on demand'],
      ]);
      const properties = descriptor.inputSchema?.properties || {};
      const required = new Set(descriptor.inputSchema?.required || []);
      ui.section('parameters');
      ui.table([
        { key: 'name', label: 'name', tone: (row, theme) => theme.roles.info },
        { key: 'type', label: 'type' },
        { key: 'required', label: 'required' },
        { key: 'description', label: 'description', max: 60 },
      ], Object.entries(properties).map(([key, property]) => ({
        name: key, type: property.type || 'any',
        required: required.has(key) ? 'yes' : '', description: property.description || '',
      })));
    },
  },
  run: {
    usage: 'tools run NAME [JSON] [--args JSON] [--file PATH]',
    summary: 'Execute a tool directly',
    async run(context) {
      const workspace = await resolveWorkspace(context);
      const name = requirePositional(context, 0, 'NAME');
      const raw = context.args.file
        ? await fsp.readFile(path.resolve(String(context.args.file)), 'utf8')
        : (context.args.args || context.positional.slice(1).join(' ') || '{}');
      const parsed = safeJsonParse(String(raw), null);
      if (parsed === null) throw new Error('Tool arguments must be valid JSON');
      const result = await context.runtime.toolRegistry.execute(name, parsed, toolContext(context.runtime, workspace));
      if (context.ui.emit(result)) return;
      context.ui.line(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    },
  },
};

// --------------------------------------------------------------------- skills

const skillCommands = {
  list: {
    usage: 'skills list [--search QUERY]',
    summary: 'List bundled, user and workspace skills',
    run(context) {
      const skills = context.args.search
        ? context.runtime.skillManager.search(String(context.args.search), Number(context.args.limit || 40))
        : context.runtime.skillManager.list();
      if (context.ui.emit(skills)) return;
      context.ui.table([
        { key: 'name', label: 'skill', tone: (row, theme) => theme.roles.skill },
        { key: 'source', label: 'source' },
        { key: 'description', label: 'description', max: 72 },
      ], skills);
      context.ui.line();
      context.ui.info(`${skills.length} skills`);
    },
  },
  show: {
    usage: 'skills show NAME',
    summary: 'Load and print a skill body',
    async run(context) {
      const name = requirePositional(context, 0, 'NAME');
      const skill = await context.runtime.skillManager.load(name);
      if (context.ui.emit(skill)) return;
      context.ui.heading(skill.name);
      context.ui.markdown(skill.body || skill.content || '');
    },
  },
};

// ---------------------------------------------------------------------------- model

const modelCommands = {
  profile: {
    usage: 'model profile [--model REF]',
    summary: 'Show how much help the harness gives a model, and why',
    async run(context) {
      const ref = context.args.model || context.runtime.config.get().defaultModel;
      const profile = await context.runtime.providerManager.modelProfile(ref);
      const described = context.runtime.engine.capabilities.describe(profile.ref, profile);
      if (context.ui.emit(described)) return;
      context.ui.heading(described.ref, `level ${described.level} of 3 (${described.source})`);
      context.ui.key('window', `${profile.contextWindow} tokens, tier ${profile.tier}`, 18);
      context.ui.key('score', String(Math.round(described.score * 100) / 100), 18);
      context.ui.key('help', Object.entries(described.knobs).filter(([name]) => name !== 'level').map(([name, value]) => `${name}=${value}`).join('  '), 18);
      if (described.calibration) {
        context.ui.key('calibrated', `${described.calibration.at}`, 18);
        for (const probe of described.calibration.probes || []) context.ui.key(`  ${probe.name}`, `${probe.score}  ${probe.detail}`, 18);
      } else context.ui.info('Not calibrated: run `maskshift model calibrate` to measure it instead of estimating from its size.');
      if (described.observed) context.ui.key('observed', `${described.observed.runs} runs, stumble rate ${Math.round(described.observed.ema * 100) / 100}`, 18);
    },
  },
  calibrate: {
    usage: 'model calibrate [--model REF]',
    summary: 'Measure a model with short probes (a few thousand tokens) and store the result',
    async run(context) {
      const ref = context.args.model || context.runtime.config.get().defaultModel;
      const workspace = await resolveWorkspace(context);
      const result = await context.runtime.toolRegistry.execute('model_calibrate', { model: ref }, toolContext(context.runtime, workspace));
      if (context.ui.emit(result)) return;
      context.ui.heading(result.ref, `composite ${result.composite} → level ${result.decision.level}`);
      for (const probe of result.probes) context.ui.key(probe.name, `${probe.score}  ${probe.detail}`, 14);
      context.ui.info(`${result.tokens.input + result.tokens.output} tokens used`);
    },
  },
};

// --------------------------------------------------------------------------- bench

const benchCommands = {
  list: {
    usage: 'bench list',
    summary: 'List the benchmark tasks',
    async run(context) {
      const { TASKS } = await import('../bench/tasks.mjs');
      const rows = TASKS.map((task) => ({ id: task.id, title: task.title, tags: task.tags.join(', ') }));
      if (context.ui.emit(rows)) return;
      context.ui.table([{ key: 'id', label: 'task' }, { key: 'title', label: 'what it asks', max: 54 }, { key: 'tags', label: 'tags' }], rows);
    },
  },
  verify: {
    usage: 'bench verify',
    summary: 'Check every task fails untouched and passes after its reference solution (no model needed)',
    async run(context) {
      const { verifyTasks } = await import('../bench/runner.mjs');
      const results = await verifyTasks({ runtime: context.runtime });
      if (context.ui.emit(results)) return;
      for (const entry of results) context.ui.key(entry.id, entry.ok ? 'ok' : `broken (${entry.error || entry.detail || 'check did not flip'})`, 24);
      if (results.some((entry) => !entry.ok)) throw new Error('One or more benchmark tasks are not sound');
    },
  },
  run: {
    usage: 'bench run [--model REF] [--tasks a,b] [--repeat N] [--without callRepair,fuzzyEdits,observation,editFeedback] [--out FILE]',
    summary: 'Run the tasks against a model and report pass rate, turns and tokens per solved task',
    async run(context) {
      const { runBenchmark } = await import('../bench/runner.mjs');
      const { TASKS } = await import('../bench/tasks.mjs');
      const ref = context.args.model || context.runtime.config.get().defaultModel;
      const wanted = context.args.tasks ? String(context.args.tasks).split(',').map((item) => item.trim()) : null;
      const tasks = wanted ? TASKS.filter((task) => wanted.includes(task.id)) : TASKS;
      if (!tasks.length) throw new Error('No matching tasks; see `maskshift bench list`');
      const without = context.args.without ? String(context.args.without).split(',').map((item) => item.trim()).filter(Boolean) : [];
      const report = await runBenchmark({
        runtime: context.runtime, modelRef: ref, tasks, without, repeat: Number(context.args.repeat || 1), maxSteps: Number(context.args.steps || 24),
        onTask: (entry) => { if (!context.ui.json) context.ui.line(`  ${entry.passed ? 'pass' : 'fail'}  ${entry.id}  ${entry.steps} turns, ${(entry.inputTokens || 0) + (entry.outputTokens || 0)} tokens${entry.status === 'completed' ? '' : `  [${entry.status}]`}`); },
      });
      const file = context.args.out ? path.resolve(String(context.args.out)) : path.join(context.runtime.config.get().home, 'bench', `${report.at.replace(/[:.]/g, '-')}-${report.model.replace(/[^a-z0-9._-]+/gi, '_')}.json`);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify(report, null, 2));
      if (context.ui.emit({ ...report, file })) return;
      const { summary } = report;
      context.ui.line();
      context.ui.heading(report.model, `level ${report.level}${without.length ? `, without ${without.join('+')}` : ''}`);
      context.ui.key('solved', `${summary.solved}/${summary.tasks} (${Math.round(summary.passRate * 100)}%)`, 18);
      context.ui.key('avg turns', String(summary.avgSteps), 18);
      context.ui.key('tokens / solved', String(summary.tokensPerSolved ?? 'n/a'), 18);
      context.ui.key('harness stepped in', Object.entries(summary.harnessInterventions).filter(([, count]) => count).map(([name, count]) => `${name} ${count}`).join(', ') || 'never', 18);
      context.ui.key('saved to', file, 18);
    },
  },
  compare: {
    usage: 'bench compare BEFORE.json AFTER.json',
    summary: 'Compare two benchmark reports: pass rate, tokens per solved task, regressions and fixes',
    async run(context) {
      const { compareReports } = await import('../bench/runner.mjs');
      const [a, b] = [requirePositional(context, 0, 'BEFORE.json'), requirePositional(context, 1, 'AFTER.json')];
      const read = async (file) => JSON.parse(await fsp.readFile(path.resolve(file), 'utf8'));
      const result = compareReports(await read(a), await read(b));
      if (context.ui.emit(result)) return;
      context.ui.key('pass rate', `${result.passRate.before} → ${result.passRate.after} (${result.passRate.delta >= 0 ? '+' : ''}${result.passRate.delta})`, 18);
      context.ui.key('tokens / solved', `${result.tokensPerSolved.before} → ${result.tokensPerSolved.after}`, 18);
      context.ui.key('avg turns', `${result.avgSteps.before} → ${result.avgSteps.after}`, 18);
      context.ui.key('regressions', result.regressions.join(', ') || 'none', 18);
      context.ui.key('fixed', result.fixes.join(', ') || 'none', 18);
    },
  },
};

// ------------------------------------------------------------------------ mcp

const mcpCommands = {
  list: {
    usage: 'mcp list',
    summary: 'List configured MCP servers',
    run(context) {
      const servers = context.runtime.mcpManager.listServers(context.workspace?.id || null);
      if (context.ui.emit(servers)) return;
      context.ui.table([
        { key: 'name', label: 'server', tone: (row, theme) => theme.roles.mcp },
        { key: 'status', label: 'status', tone: (row, theme) => STATUS_TONE(theme, row.status) },
        { key: 'transport', label: 'transport', value: (row) => row.transport || (row.url ? 'http' : 'stdio') },
        { key: 'toolCount', label: 'tools', align: 'right' },
        { key: 'scope', label: 'scope' },
        { key: 'description', label: 'description', max: 48 },
      ], servers);
    },
  },
  connect: {
    usage: 'mcp connect NAME [--force]',
    summary: 'Connect to an MCP server and cache its tools',
    async run(context) {
      const workspace = await resolveWorkspace(context);
      const name = requirePositional(context, 0, 'NAME');
      const server = await context.runtime.mcpManager.connect(name, { workspaceId: workspace.id, force: Boolean(context.args.force) });
      const tools = await context.runtime.mcpManager.tools(name, workspace.id);
      if (context.ui.emit({ server, tools })) return;
      context.ui.ok(`${name} linked with ${tools.length} tools`);
      context.ui.table([
        { key: 'name', label: 'tool' },
        { key: 'description', label: 'description', max: 70 },
      ], tools);
    },
  },
  disconnect: {
    usage: 'mcp disconnect NAME',
    summary: 'Disconnect an MCP server',
    async run(context) {
      const workspace = await resolveWorkspace(context);
      const name = requirePositional(context, 0, 'NAME');
      await context.runtime.mcpManager.disconnect(name, workspace.id);
      if (context.ui.emit({ disconnected: name })) return;
      context.ui.warn(`${name} disconnected`);
    },
  },
  tools: {
    usage: 'mcp tools NAME',
    summary: 'List the tools a connected server exposes',
    async run(context) {
      const workspace = await resolveWorkspace(context);
      const name = requirePositional(context, 0, 'NAME');
      const tools = await context.runtime.mcpManager.tools(name, workspace.id);
      if (context.ui.emit(tools)) return;
      context.ui.table([
        { key: 'qualifiedName', label: 'qualified name' },
        { key: 'description', label: 'description', max: 70 },
      ], tools);
    },
  },
  add: {
    usage: 'mcp add NAME --command "npx -y pkg" | --url URL [--env JSON] [--scope user|workspace]',
    summary: 'Register an MCP server',
    async run(context) {
      const name = requirePositional(context, 0, 'NAME');
      const { args } = context;
      if (!args.command && !args.url) throw new Error('Provide --command or --url');
      const environment = args.env ? safeJsonParse(String(args.env), null) : {};
      if (args.env && environment === null) throw new Error('--env must be valid JSON');
      const definition = args.url
        ? { transport: 'http', url: String(args.url), headers: environment }
        : {
          transport: 'stdio',
          command: String(args.command).split(' ')[0],
          args: String(args.command).split(' ').slice(1),
          env: environment,
        };
      const server = await context.runtime.mcpManager.add(name, definition, args.workspace || process.cwd());
      if (context.ui.emit(server)) return;
      context.ui.ok(`${name} added`);
    },
  },
  remove: {
    usage: 'mcp remove NAME',
    summary: 'Remove an MCP server definition',
    async run(context) {
      const name = requirePositional(context, 0, 'NAME');
      await context.runtime.mcpManager.remove(name, context.args.workspace || process.cwd());
      if (context.ui.emit({ removed: name })) return;
      context.ui.warn(`${name} removed`);
    },
  },
  registry: {
    usage: 'mcp registry [QUERY] [--limit N]',
    summary: 'Search the official MCP registry',
    async run(context) {
      const results = await context.runtime.mcpManager.registrySearch(context.positional.join(' '), Number(context.args.limit || 30));
      if (context.ui.emit(results)) return;
      context.ui.table([
        { key: 'name', label: 'name', tone: (row, theme) => theme.roles.mcp },
        { key: 'version', label: 'version' },
        { key: 'description', label: 'description', max: 70 },
      ], results);
    },
  },
  install: {
    usage: 'mcp install REGISTRY_NAME [--prefer remote|package]',
    summary: 'Install a server from the official registry',
    async run(context) {
      const name = requirePositional(context, 0, 'REGISTRY_NAME');
      const candidates = await context.runtime.mcpManager.registrySearch(name, 100);
      const item = candidates.find((candidate) => candidate.name === name) || candidates[0];
      if (!item) throw new Error(`Registry server not found: ${name}`);
      const installed = await context.runtime.mcpManager.installRegistry(item, {
        prefer: context.args.prefer || 'remote',
        workspacePath: context.args.workspace || process.cwd(),
      });
      if (context.ui.emit(installed)) return;
      context.ui.ok(`Installed ${installed.name}`);
    },
  },
  call: {
    usage: 'mcp call QUALIFIED_NAME [JSON]',
    summary: 'Call a connected MCP tool (mcp__server__tool)',
    async run(context) {
      const workspace = await resolveWorkspace(context);
      const name = requirePositional(context, 0, 'QUALIFIED_NAME');
      const parsed = safeJsonParse(context.positional.slice(1).join(' ') || '{}', null);
      if (parsed === null) throw new Error('Arguments must be valid JSON');
      const result = await context.runtime.mcpManager.callQualified(name, parsed, { workspaceId: workspace.id });
      if (context.ui.emit(result)) return;
      context.ui.line(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    },
  },
  serve: {
    usage: 'mcp serve [--read-only] [--tools a,b,c]',
    summary: 'Run MaskShift itself as a stdio MCP server for this workspace',
    async run(context) {
      const workspace = await resolveWorkspace(context);
      const tools = context.args.tools
        ? String(context.args.tools).split(',').map((name) => name.trim()).filter(Boolean)
        : null;
      const server = new McpServer({
        toolRegistry: context.runtime.toolRegistry,
        buildContext: () => toolContext(context.runtime, workspace),
        logger: context.runtime.logger,
        tools,
        readOnly: Boolean(context.args['read-only']),
      });
      context.runtime.logger.info('MCP server listening on stdio', {
        workspace: workspace.path, tools: server.exposedTools().length, readOnly: server.readOnly,
      });
      const interrupted = new Promise((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      await Promise.race([server.listen(), interrupted]);
      server.close();
    },
  },
};

// -------------------------------------------------------------------- plugins

const pluginCommands = {
  list: {
    usage: 'plugins list',
    summary: 'List installed capability packs',
    run(context) {
      const plugins = context.runtime.pluginManager.list();
      if (context.ui.emit(plugins)) return;
      context.ui.table([
        { key: 'name', label: 'plugin' },
        { key: 'version', label: 'version' },
        { key: 'status', label: 'status', tone: (row, theme) => STATUS_TONE(theme, row.status) },
        { key: 'tools', label: 'tools', value: (row) => (row.tools || []).length, align: 'right' },
        { key: 'root', label: 'root', max: 48 },
      ], plugins);
    },
  },
  install: {
    usage: 'plugins install SOURCE [--kind auto|local|git|npm] [--name NAME]',
    summary: 'Install and activate a plugin',
    async run(context) {
      const source = requirePositional(context, 0, 'SOURCE');
      const plugin = await context.runtime.pluginManager.install(source, {
        kind: context.args.kind || 'auto', name: context.args.name || null,
      });
      if (context.ui.emit(plugin)) return;
      context.ui.ok(`Installed ${plugin.name}`);
    },
  },
  activate: {
    usage: 'plugins activate NAME',
    summary: 'Activate an installed plugin',
    async run(context) {
      const plugin = await context.runtime.pluginManager.activate(requirePositional(context, 0, 'NAME'));
      if (context.ui.emit(plugin)) return;
      context.ui.ok(`Activated ${plugin.name || context.positional[0]}`);
    },
  },
  deactivate: {
    usage: 'plugins deactivate NAME',
    summary: 'Deactivate a plugin',
    async run(context) {
      const plugin = await context.runtime.pluginManager.deactivate(requirePositional(context, 0, 'NAME'));
      if (context.ui.emit(plugin)) return;
      context.ui.warn(`Deactivated ${context.positional[0]}`);
    },
  },
  reload: {
    usage: 'plugins reload [NAME]',
    summary: 'Reload one plugin or every plugin',
    async run(context) {
      const result = await context.runtime.pluginManager.reload(context.positional[0] || null);
      if (context.ui.emit(result)) return;
      context.ui.ok('Reloaded');
    },
  },
  scaffold: {
    usage: 'plugins scaffold NAME [--dir PATH] [--description TEXT]',
    summary: 'Generate a plugin skeleton',
    async run(context) {
      const plugin = await context.runtime.pluginManager.scaffold({
        name: requirePositional(context, 0, 'NAME'),
        directory: context.args.dir || null,
        description: context.args.description || '',
      });
      if (context.ui.emit(plugin)) return;
      context.ui.ok(`Scaffolded ${plugin.root || plugin.name}`);
    },
  },
};

// ---------------------------------------------------------------- automations

const automationCommands = {
  list: {
    usage: 'automation list [--enabled true|false]',
    summary: 'List scheduled automations',
    run(context) {
      const automations = context.runtime.automationScheduler.list({
        enabled: context.args.enabled === undefined ? undefined : context.args.enabled !== 'false',
        limit: Number(context.args.limit || 200),
      });
      if (context.ui.emit(automations)) return;
      context.ui.table([
        { key: 'id', label: 'id' },
        { key: 'name', label: 'name', max: 34 },
        { key: 'enabled', label: 'armed', value: (row) => (row.enabled ? 'yes' : 'no'), tone: (row, theme) => (row.enabled ? theme.roles.success : theme.roles.muted) },
        { key: 'schedule', label: 'schedule', value: (row) => (typeof row.schedule === 'string' ? row.schedule : JSON.stringify(row.schedule)) },
        { key: 'type', label: 'action', value: (row) => row.action?.type || 'agent' },
        { key: 'next_run_at', label: 'next run' },
        { key: 'last_status', label: 'last' },
      ], automations);
    },
  },
  create: {
    usage: 'automation create NAME --schedule SPEC (--prompt TEXT | --command CMD | --tool JSON) [--model REF] [--paused]',
    summary: 'Arm a recurring agent run, shell command or tool call',
    async run(context) {
      const workspace = await resolveWorkspace(context);
      const name = context.positional.join(' ');
      const { args } = context;
      if (!name) throw new Error('Missing required argument: NAME');
      if (!args.schedule) throw new Error('Provide --schedule (e.g. "every 6h", a cron expression or an ISO timestamp)');
      let action;
      if (args.prompt) action = { type: 'agent', prompt: String(args.prompt), modelRef: args.model || null };
      else if (args.command) action = { type: 'shell', command: String(args.command) };
      else if (args.tool) {
        const parsed = safeJsonParse(String(args.tool), null);
        if (!parsed?.name) throw new Error('--tool needs {"name":"…","arguments":{…}}');
        action = { type: 'tool', ...parsed };
      } else throw new Error('Provide --prompt, --command or --tool');
      const automation = context.runtime.automationScheduler.create({
        workspaceId: workspace.id, name, schedule: String(args.schedule), action, enabled: !args.paused,
      });
      if (context.ui.emit(automation)) return;
      context.ui.ok(`${name} armed as ${automation.id}`);
    },
  },
  run: {
    usage: 'automation run ID',
    summary: 'Execute an automation immediately',
    async run(context) {
      const result = await context.runtime.automationScheduler.execute(requirePositional(context, 0, 'ID'), { manual: true });
      if (context.ui.emit(result)) return;
      context.ui.ok('Automation executed');
    },
  },
  pause: {
    usage: 'automation pause ID',
    summary: 'Disable an automation',
    run(context) {
      const automation = context.runtime.automationScheduler.update(requirePositional(context, 0, 'ID'), { enabled: false });
      if (context.ui.emit(automation)) return;
      context.ui.warn(`${automation.name} paused`);
    },
  },
  resume: {
    usage: 'automation resume ID',
    summary: 'Re-arm an automation',
    run(context) {
      const automation = context.runtime.automationScheduler.update(requirePositional(context, 0, 'ID'), { enabled: true });
      if (context.ui.emit(automation)) return;
      context.ui.ok(`${automation.name} armed`);
    },
  },
  delete: {
    usage: 'automation delete ID',
    summary: 'Remove an automation',
    run(context) {
      const id = requirePositional(context, 0, 'ID');
      context.runtime.automationScheduler.remove(id);
      if (context.ui.emit({ deleted: id })) return;
      context.ui.warn(`${id} deleted`);
    },
  },
};

// -------------------------------------------------------------------- browser

const browserCommands = {
  list: {
    usage: 'browser list',
    summary: 'List running browser instances',
    run(context) {
      const instances = context.runtime.browserManager.list();
      if (context.ui.emit(instances)) return;
      context.ui.table([
        { key: 'id', label: 'id' },
        { key: 'profile', label: 'profile' },
        { key: 'headless', label: 'headless' },
        { key: 'endpoint', label: 'endpoint', max: 46 },
      ], instances);
    },
  },
  launch: {
    usage: 'browser launch [--profile NAME] [--url URL] [--headed]',
    summary: 'Launch a persistent Chrome profile under MaskShift control',
    async run(context) {
      const instance = await context.runtime.browserManager.launch({
        profile: context.args.profile || 'default',
        url: context.args.url || 'about:blank',
        headless: !context.args.headed,
      });
      if (context.ui.emit(instance)) return;
      context.ui.ok(`Browser ${instance.id} launched`);
    },
  },
  tabs: {
    usage: 'browser tabs [INSTANCE_ID]',
    summary: 'List browser tabs',
    async run(context) {
      const tabs = await context.runtime.browserManager.tabs(context.positional[0] || null);
      if (context.ui.emit(tabs)) return;
      context.ui.table([
        { key: 'id', label: 'tab' },
        { key: 'title', label: 'title', max: 40 },
        { key: 'url', label: 'url', max: 60 },
      ], tabs);
    },
  },
  close: {
    usage: 'browser close [INSTANCE_ID]',
    summary: 'Close a browser instance',
    async run(context) {
      const result = await context.runtime.browserManager.close(context.positional[0] || null);
      if (context.ui.emit(result)) return;
      context.ui.warn('Browser closed');
    },
  },
};

// ------------------------------------------------------------------ inventory

const inventoryCommands = {
  lsp: {
    usage: 'lsp [--force]',
    summary: 'Discover and list language servers',
    async run(context) {
      const discovered = await context.runtime.lspManager.discover(Boolean(context.args.force));
      const active = context.runtime.lspManager.list();
      if (context.ui.emit({ discovered, active })) return;
      context.ui.heading('language servers');
      context.ui.table([
        { key: 'id', label: 'id' },
        { key: 'command', label: 'command' },
        { key: 'available', label: 'available', tone: (row, theme) => (row.available ? theme.roles.success : theme.roles.muted) },
        { key: 'languages', label: 'languages', value: (row) => (row.languages || []).join(', '), max: 40 },
      ], discovered);
      if (active.length) {
        context.ui.section('active');
        context.ui.table([{ key: 'serverId', label: 'server' }, { key: 'workspaceId', label: 'workspace' }], active);
      }
    },
  },
  bridges: {
    usage: 'bridges [--force]',
    summary: 'Discover installed coding-agent CLIs MaskShift can delegate to',
    async run(context) {
      const bridges = await context.runtime.bridgeManager.discover({ force: Boolean(context.args.force) });
      if (context.ui.emit(bridges)) return;
      context.ui.table([
        { key: 'name', label: 'bridge' },
        { key: 'title', label: 'title', max: 26 },
        { key: 'command', label: 'command' },
        { key: 'available', label: 'available', tone: (row, theme) => (row.available ? theme.roles.success : theme.roles.muted) },
        { key: 'version', label: 'version', value: (row) => oneLine(row.version || '', 32) },
      ], bridges);
    },
  },
  ps: {
    usage: 'ps [--running]',
    summary: 'List background processes MaskShift started',
    run(context) {
      const processes = context.runtime.processManager.list({ runningOnly: Boolean(context.args.running) });
      if (context.ui.emit(processes)) return;
      context.ui.table([
        { key: 'id', label: 'id' },
        { key: 'pid', label: 'pid', align: 'right' },
        { key: 'status', label: 'status', tone: (row, theme) => STATUS_TONE(theme, row.status) },
        { key: 'command', label: 'command', max: 56 },
      ], processes);
    },
  },
  models: {
    usage: 'models [--discover]',
    summary: 'List providers and their models',
    async run(context) {
      const providers = context.args.discover
        ? await context.runtime.providerManager.discoverAll({ force: true })
        : context.runtime.providerManager.listProviders();
      if (context.ui.emit(providers)) return;
      const { ui } = context;
      for (const provider of providers) {
        ui.section(`${provider.name} — ${provider.status}`);
        if (provider.error) { ui.fail(provider.error); continue; }
        const models = provider.models || [];
        if (!models.length) { ui.line(ui.theme.paint('  no models reported', { fg: ui.theme.roles.border })); continue; }
        for (const model of models) {
          ui.line(ui.theme.paint(`  ${provider.id}:${model.id || model}`, { fg: ui.theme.roles.accent }));
        }
      }
    },
  },
  logs: {
    usage: 'logs [--limit N]',
    summary: 'Tail the MaskShift log',
    async run(context) {
      const entries = await context.runtime.logger.tail(Number(context.args.limit || 120));
      if (context.ui.emit(entries)) return;
      for (const entry of entries) {
        const text = typeof entry === 'string' ? entry : `${entry.timestamp || ''} ${String(entry.level || '').toUpperCase()} ${entry.message || ''}`;
        const tone = /error/i.test(text) ? context.ui.theme.roles.danger
          : /warn/i.test(text) ? context.ui.theme.roles.warning : context.ui.theme.roles.muted;
        context.ui.line(context.ui.theme.paint(truncate(text, 400), { fg: tone }));
      }
    },
  },
  events: {
    usage: 'events [--limit N] [--follow]',
    summary: 'Print recent runtime events, optionally following the live bus',
    async run(context) {
      const { runtime, ui } = context;
      const print = (event) => {
        if (ui.json) { ui.write(JSON.stringify(event)); return; }
        ui.line(ui.theme.paint(String(event.timestamp).slice(11, 19), { fg: ui.theme.roles.border })
          + ui.theme.paint(` ${fitType(event.type)}`, { fg: ui.theme.roles.primary, bold: true })
          + ui.theme.paint(` ${oneLine(JSON.stringify(event.payload ?? {}), ui.width - 34)}`, { fg: ui.theme.roles.muted }));
      };
      for (const event of runtime.eventBus.recent(Number(context.args.limit || 60))) print(event);
      if (!context.args.follow) return;
      await new Promise((resolve) => {
        const unsubscribe = runtime.eventBus.subscribe(print);
        const stop = () => { unsubscribe(); resolve(); };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    },
  },
};

function fitType(type) {
  return String(type).padEnd(22).slice(0, 22);
}

// ------------------------------------------------------------------- recovery

const recoveryCommands = {
  pending: {
    usage: 'recovery pending',
    summary: 'List runs left "running" by a process that is no longer alive',
    run(context) {
      const runs = context.runtime.engine.recoverableRuns();
      if (context.ui.emit(runs)) return;
      if (!runs.length) { context.ui.ok('No interrupted runs pending recovery.'); return; }
      context.ui.table([
        { key: 'id', label: 'run' },
        { key: 'session_id', label: 'session', max: 26 },
        { key: 'started_at', label: 'started' },
        { key: 'unresolved', label: 'unresolved', value: (row) => String(row.pendingIntents.length) },
      ], runs);
    },
  },
  reconcile: {
    usage: 'recovery reconcile RUN_ID --note "What was inspected and repaired"',
    summary: 'Record a manual review of an interrupted run without replaying it',
    run(context) {
      const runId = requirePositional(context, 0, 'RUN_ID');
      const note = context.args.note;
      if (!note) throw new Error('Missing required flag: --note "What was inspected and repaired"');
      const updated = context.runtime.engine.reconcile(runId, String(note));
      if (context.ui.emit(updated)) return;
      context.ui.ok(`Run ${runId} reconciled`);
    },
  },
};

// ------------------------------------------------------------------- settings

const configCommands = {
  show: {
    usage: 'config show',
    summary: 'Print the effective configuration',
    run(context) {
      const view = context.runtime.config.publicView();
      if (context.ui.emit(view)) return;
      context.ui.heading('configuration');
      context.ui.line(JSON.stringify(view, null, 2));
    },
  },
  get: {
    usage: 'config get KEY',
    summary: 'Read one configuration value',
    run(context) {
      const key = requirePositional(context, 0, 'KEY');
      const value = key.split('.').reduce((node, part) => (node == null ? node : node[part]), context.runtime.config.get());
      if (context.ui.emit({ [key]: value })) return;
      context.ui.line(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
    },
  },
  set: {
    usage: 'config set KEY VALUE',
    summary: 'Write one configuration value (JSON values are parsed)',
    async run(context) {
      const key = requirePositional(context, 0, 'KEY');
      const raw = context.positional.slice(1).join(' ');
      if (raw === '') throw new Error('Missing required argument: VALUE');
      const parsed = safeJsonParse(raw, raw);
      const patch = {};
      const parts = key.split('.');
      let node = patch;
      for (const part of parts.slice(0, -1)) { node[part] = {}; node = node[part]; }
      node[parts[parts.length - 1]] = parsed;
      const updated = await context.runtime.config.update(patch);
      if (context.ui.emit(updated)) return;
      context.ui.ok(`${key} = ${typeof parsed === 'object' ? JSON.stringify(parsed) : parsed}`);
    },
  },
  path: {
    usage: 'config path',
    summary: 'Print the configuration and data file locations',
    run(context) {
      const config = context.runtime.config.get();
      const payload = {
        home: config.home, config: context.runtime.config.configPath || null,
        database: config.dataFile, log: config.logFile, audit: config.auditFile,
      };
      if (context.ui.emit(payload)) return;
      context.ui.fields(Object.entries(payload));
    },
  },
};

// ---------------------------------------------------------------------- fleet

const FLEET_TONE = (row, theme) => STATUS_TONE(theme, row.status);

function csv(value) {
  return value && value !== true ? String(value).split(',').map((item) => item.trim()).filter(Boolean) : [];
}

const fleetCommands = {
  harnesses: {
    usage: 'fleet harnesses [--force]',
    summary: 'List the harnesses a fleet member can run on, and which are installed',
    async run(context) {
      const harnesses = await context.runtime.fleetManager.harnesses({ force: Boolean(context.args.force) });
      if (context.ui.emit(harnesses)) return;
      context.ui.table([
        { key: 'name', label: 'harness' },
        { key: 'title', label: 'title', max: 26 },
        { key: 'command', label: 'command' },
        { key: 'available', label: 'installed', tone: (row, theme) => (row.available ? theme.roles.success : theme.roles.muted) },
      ], harnesses);
    },
  },
  list: {
    usage: 'fleet list',
    summary: 'List fleet members and what each is doing',
    run(context) {
      const members = context.runtime.fleetManager.list();
      if (context.ui.emit(members)) return;
      if (!members.length) { context.ui.info('The fleet is empty. Add members with: maskshift fleet spawn claude codex hermes'); return; }
      context.ui.table([
        { key: 'name', label: 'member' },
        { key: 'harness', label: 'harness' },
        { key: 'status', label: 'status', tone: FLEET_TONE },
        { key: 'mode', label: 'mode' },
        { key: 'unread', label: 'mail', align: 'right' },
        { key: 'turns', label: 'turns', align: 'right' },
        { key: 'role', label: 'role', max: 36 },
      ], members);
    },
  },
  spawn: {
    usage: 'fleet spawn HARNESS[:NAME]... [--role TEXT] [--mode inspect|edit] [--model REF] [--isolated] [--fallback a,b]',
    summary: 'Add one or more members, e.g. `fleet spawn claude codex:reviewer hermes`',
    async run(context) {
      if (!context.positional.length) throw new Error('Missing required argument: HARNESS');
      const workspace = await resolveWorkspace(context);
      const members = await context.runtime.fleetManager.spawnMany(context.positional, {
        workspaceId: workspace.id, role: context.args.role && context.args.role !== true ? String(context.args.role) : '',
        mode: context.args.mode || 'edit', model: context.args.model || null,
        isolated: Boolean(context.args.isolated), fallbacks: csv(context.args.fallback), cwd: context.args.cwd || null,
      });
      if (context.ui.emit(members)) return;
      for (const member of members) context.ui.ok(`${member.name} · ${member.title}${member.fellBackFrom ? ` (fell back from ${member.fellBackFrom})` : ''}`);
    },
  },
  ask: {
    usage: 'fleet ask MEMBER MESSAGE...',
    summary: 'Give one member a task and wait for its reply',
    async run(context) {
      const to = requirePositional(context, 0, 'MEMBER');
      const message = context.positional.slice(1).join(' ');
      if (!message) throw new Error('Missing required argument: MESSAGE');
      const result = await context.runtime.fleetManager.ask(to, { message, from: 'user' });
      if (context.ui.emit(result)) return;
      if (!result.ok) { context.ui.fail(`${result.name}: ${result.error}`); process.exitCode = 1; return; }
      context.ui.markdown(result.reply || '(no reply)');
      for (const sent of result.sends || []) context.ui.info(`${sent.from} → ${sent.to}${sent.dropped ? ` (dropped: ${sent.dropped})` : ' (queued)'}`);
    },
  },
  send: {
    usage: 'fleet send TO MESSAGE... [--from NAME]',
    summary: 'Queue a message for a member (or * for everyone) without running it',
    run(context) {
      const to = requirePositional(context, 0, 'TO');
      const record = context.runtime.fleetManager.send({ from: context.args.from || 'user', to, body: context.positional.slice(1).join(' ') });
      if (context.ui.emit(record)) return;
      context.ui.ok(`Queued for ${to}`);
    },
  },
  relay: {
    usage: 'fleet relay TASK... [--lead NAME] [--with claude,codex:reviewer] [--rounds N] [--timeout MS]',
    summary: 'Let the fleet work a task out between its members until the team says it is done',
    async run(context) {
      const manager = context.runtime.fleetManager;
      const task = context.positional.join(' ');
      if (!task) throw new Error('Missing required argument: TASK');
      const workspace = await resolveWorkspace(context);
      const created = csv(context.args.with).length
        ? await manager.spawnMany(csv(context.args.with), { workspaceId: workspace.id, mode: context.args.mode || 'edit', isolated: Boolean(context.args.isolated) })
        : [];
      const lead = context.args.lead || created[0]?.name || null;
      const live = (event) => {
        if (context.ui.json || !event.type.startsWith('fleet.turn.completed')) return;
        const { member, turn } = event.payload;
        context.ui.status(turn.ok ? 'ok' : 'fail', `${member.name}${turn.sends.length ? ` → ${turn.sends.map((item) => item.to).join(', ')}` : ''}${turn.done ? ' · done' : ''}`);
      };
      const unsubscribe = context.runtime.eventBus.subscribe(live);
      const controller = new AbortController();
      const onSignal = () => controller.abort(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
      process.once('SIGINT', onSignal);
      let relay;
      try {
        relay = await manager.relay({
          task, lead, members: created.length ? created.map((member) => member.name) : null,
          maxRounds: context.args.rounds ? Number(context.args.rounds) : null, timeoutMs: context.args.timeout ? Number(context.args.timeout) : null,
          signal: controller.signal,
        });
      } finally {
        process.off('SIGINT', onSignal);
        unsubscribe?.();
      }
      if (context.ui.emit(relay)) return;
      context.ui.section(`${relay.status} · ${relay.reason} · ${relay.rounds} round${relay.rounds === 1 ? '' : 's'}`);
      context.ui.markdown(relay.final || '(no final answer)');
      if (relay.status !== 'completed') process.exitCode = 1;
    },
  },
  log: {
    usage: 'fleet log [MEMBER] [--limit N]',
    summary: 'Show the messages passed between members',
    run(context) {
      const items = context.runtime.fleetManager.conversation({ member: context.positional[0] || null, limit: Number(context.args.limit || 40) });
      if (context.ui.emit(items)) return;
      context.ui.table([
        { key: 'at', label: 'time', value: (row) => row.at.slice(11, 19) },
        { key: 'from', label: 'from' },
        { key: 'to', label: 'to' },
        { key: 'kind', label: 'kind' },
        { key: 'status', label: 'status' },
        { key: 'body', label: 'message', value: (row) => oneLine(row.dropped || row.body, 70) },
      ], items);
    },
  },
  show: {
    usage: 'fleet show MEMBER',
    summary: 'Show a member\'s role, state and recent turns',
    run(context) {
      const member = context.runtime.fleetManager.details(requirePositional(context, 0, 'MEMBER'));
      if (context.ui.emit(member)) return;
      context.ui.fields([
        ['member', member.name], ['harness', `${member.title} (${member.harness})`], ['status', member.status], ['mode', member.mode],
        ['role', member.role || '—'], ['cwd', member.cwd], ['unread', String(member.unread)], ['error', member.error || '—'],
      ]);
      for (const turn of member.history.slice(-5)) {
        context.ui.section(`${turn.at.slice(11, 19)} · ${turn.ok ? 'ok' : 'failed'} · ${turn.durationMs}ms`);
        context.ui.paragraph(oneLine(turn.reply || turn.error || '', 400));
      }
    },
  },
  stop: {
    usage: 'fleet stop [MEMBER]',
    summary: 'Cancel a member\'s running turn (or everyone\'s)',
    run(context) {
      const manager = context.runtime.fleetManager;
      const result = context.positional[0] ? manager.stop(context.positional[0]) : manager.stopAll();
      if (context.ui.emit(result)) return;
      context.ui.ok('Stop requested');
    },
  },
  reset: {
    usage: 'fleet reset MEMBER',
    summary: 'Clear a member\'s history and inbox',
    run(context) {
      const member = context.runtime.fleetManager.reset(requirePositional(context, 0, 'MEMBER'));
      if (context.ui.emit(member)) return;
      context.ui.ok(`Reset ${member.name}`);
    },
  },
  remove: {
    usage: 'fleet remove MEMBER...',
    summary: 'Remove members from the fleet',
    async run(context) {
      if (!context.positional.length) throw new Error('Missing required argument: MEMBER');
      const out = [];
      for (const name of context.positional) out.push(await context.runtime.fleetManager.remove(name));
      if (context.ui.emit(out)) return;
      for (const item of out) context.ui.ok(`Removed ${item.removed}`);
    },
  },
};

// -------------------------------------------------------------------- storage

const storageCommands = {
  status: {
    usage: 'storage status',
    summary: 'What MaskShift stores on disk, the budget derived from this machine, and what to do about it',
    async run(context) {
      const status = await context.runtime.storageManager.status();
      if (context.ui.emit(status)) return;
      const { usage, budget } = status;
      context.ui.heading('disk use');
      context.ui.table([
        { key: 'area', label: 'area' },
        { key: 'size', label: 'size', align: 'right' },
        { key: 'share', label: 'budget', align: 'right' },
      ], [
        { area: 'database (search index, chats, runs)', size: formatBytes(usage.database), share: formatBytes(budget.share.index + budget.share.other * 0.5) },
        { area: 'checkpoints (undo points)', size: formatBytes(usage.checkpoints), share: formatBytes(budget.share.checkpoints) },
        { area: 'browser profiles, logs, caches', size: formatBytes(usage.other), share: formatBytes(budget.share.other * 0.5) },
        { area: 'total', size: formatBytes(usage.total), share: formatBytes(budget.total) },
      ]);
      context.ui.section('this machine');
      context.ui.fields([
        ['disk', `${formatBytes(budget.host.diskFree)} free of ${formatBytes(budget.host.diskTotal)}`],
        ['pressure', status.pressure],
        ['memory', formatBytes(budget.host.memTotal)],
        ['index per workspace', `${formatBytes(budget.index.maxTextBytes)} of text, ${budget.index.maxFiles} files`],
        ['checkpoints kept', `${budget.checkpoints.keepPerWorkspace} per workspace, ${budget.checkpoints.maxAgeDays} days`],
        ['run events kept', `${budget.runEventDays} days`],
      ]);
      for (const line of status.advice) context.ui.warn(line);
      if (!status.advice.length) context.ui.ok('Within budget');
    },
  },
  prune: {
    usage: 'storage prune [--dry-run]',
    summary: 'Free space: old checkpoints, stale search indexes, old run events, oversized logs. Never touches chats, memory or your files',
    async run(context) {
      const result = await context.runtime.storageManager.prune({ dryRun: Boolean(context.args['dry-run'] || context.args.dryRun) });
      if (context.ui.emit(result)) return;
      if (!result.actions.length) { context.ui.ok('Nothing to prune'); return; }
      context.ui.table([
        { key: 'type', label: 'what' },
        { key: 'reason', label: 'why', max: 52 },
        { key: 'bytes', label: 'size', align: 'right', value: (row) => (row.bytes ? formatBytes(row.bytes) : '') },
      ], result.actions);
      if (result.dryRun) context.ui.info(`Would free about ${formatBytes(result.wouldFreeBytes)}. Run without --dry-run to do it.`);
      else context.ui.ok(`Freed about ${formatBytes(result.freedBytes)}`);
      for (const failure of result.failures) context.ui.warn(`${failure.action}: ${failure.error}`);
    },
  },
  vacuum: {
    usage: 'storage vacuum',
    summary: 'Rebuild the database file so deleted space is returned to the disk (needs free space about the size of the database)',
    async run(context) {
      const result = await context.runtime.storageManager.vacuum();
      if (context.ui.emit(result)) return;
      context.ui.ok(`Database ${formatBytes(result.beforeBytes)} → ${formatBytes(result.afterBytes)}${result.autoVacuumNow === 2 ? ' · now returns space automatically' : ''}`);
    },
  },
};

export const GROUPS = {
  workspace: { title: 'Workspace', commands: workspaceCommands, defaultCommand: 'info' },
  session: { title: 'Chats', commands: sessionCommands, defaultCommand: 'list' },
  tools: { title: 'Tools', commands: toolCommands, defaultCommand: 'list' },
  skills: { title: 'Skills', commands: skillCommands, defaultCommand: 'list' },
  model: { title: 'Model capability', commands: modelCommands, defaultCommand: 'profile' },
  bench: { title: 'Benchmark', commands: benchCommands, defaultCommand: 'list' },
  mcp: { title: 'MCP network', commands: mcpCommands, defaultCommand: 'list' },
  fleet: { title: 'Agent fleet', commands: fleetCommands, defaultCommand: 'list' },
  storage: { title: 'Disk use', commands: storageCommands, defaultCommand: 'status' },
  plugins: { title: 'Plugins', commands: pluginCommands, defaultCommand: 'list' },
  automation: { title: 'Automations', commands: automationCommands, defaultCommand: 'list' },
  browser: { title: 'Browser', commands: browserCommands, defaultCommand: 'list' },
  config: { title: 'Configuration', commands: configCommands, defaultCommand: 'show' },
  recovery: { title: 'Recovery', commands: recoveryCommands, defaultCommand: 'pending' },
};

export const SINGLE = inventoryCommands;

export { resolveWorkspace, toolContext, STATUS_TONE };
