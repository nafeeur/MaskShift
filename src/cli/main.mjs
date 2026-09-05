// MaskShift command-line entry point.
//
// `maskshift` with no arguments opens the TUI. Everything the TUI can do is
// also reachable as a subcommand so MaskShift scripts and pipes cleanly.

import { createRuntime } from '../runtime.mjs';
import { startTui } from '../tui/app.mjs';
import { commandExists, parseArgs, VERSION } from '../core/utils.mjs';
import { GROUPS, SINGLE, toolContext } from './commands.mjs';
import { Ui, oneLine } from './ui.mjs';

const GLOBAL_FLAGS = [
  ['--workspace PATH', 'Workspace to operate on (default: the current directory)'],
  ['--model REF', 'Model reference, for example ollama:qwen3 or anthropic:claude-sonnet-5'],
  ['--config PATH', 'Configuration file to load'],
  ['--json', 'Emit machine-readable JSON instead of styled output'],
  ['--no-color', 'Disable colour (NO_COLOR is honoured too)'],
  ['-h, --help', 'Show help for a command'],
  ['-v, --version', 'Print the MaskShift version'],
];

const TOP_LEVEL = {
  tui: { usage: 'tui [PROMPT]', summary: 'Open the full-screen interface (default command)' },
  run: { usage: 'run "PROMPT"', summary: 'Execute one agent run and stream it to the terminal' },
  exec: { usage: 'exec "COMMAND"', summary: 'Run a shell command through the MaskShift tool layer' },
  doctor: { usage: 'doctor [--json]', summary: 'Check the environment, providers and capability counts' },
  daemon: { usage: 'daemon', summary: 'Stay resident so scheduled automations keep firing' },
  help: { usage: 'help [COMMAND]', summary: 'Show this help, or help for one command group' },
};

function printHelp(ui, topic = null) {
  if (topic && GROUPS[topic]) {
    const group = GROUPS[topic];
    ui.banner(VERSION, { compact: true });
    ui.heading(group.title, topic);
    for (const command of Object.values(group.commands)) {
      ui.line(ui.theme.paint(`  maskshift ${command.usage}`, { fg: ui.theme.palette.gold, bold: true }));
      ui.line(ui.theme.paint(`      ${command.summary}`, { fg: ui.theme.roles.muted }));
    }
    ui.line();
    return;
  }
  if (topic && SINGLE[topic]) {
    ui.banner(VERSION, { compact: true });
    ui.line(ui.theme.paint(`  maskshift ${SINGLE[topic].usage}`, { fg: ui.theme.palette.gold, bold: true }));
    ui.line(ui.theme.paint(`      ${SINGLE[topic].summary}`, { fg: ui.theme.roles.muted }));
    return;
  }

  ui.banner(VERSION);
  ui.heading('usage');
  ui.key('maskshift', 'open the interface in the current directory', 38);
  ui.key('maskshift run "make the tests pass"', 'one headless run, streamed to stdout', 38);
  ui.key('maskshift mcp connect playwright', 'anything the interface can do, scripted', 38);

  ui.heading('core');
  for (const command of Object.values(TOP_LEVEL)) ui.key(command.usage, command.summary);

  ui.heading('capabilities');
  for (const [name, group] of Object.entries(GROUPS)) {
    ui.key(name, group.title, 14);
    ui.line(ui.theme.paint(`      ${Object.keys(group.commands).join('  ')}`, { fg: ui.theme.roles.border }));
  }
  ui.line();
  for (const [name, command] of Object.entries(SINGLE)) ui.key(command.usage, command.summary);

  ui.heading('flags');
  for (const [flag, description] of GLOBAL_FLAGS) ui.key(flag, description);

  ui.heading('environment');
  ui.paragraph('MASKSHIFT_HOME, MASKSHIFT_CONFIG, MASKSHIFT_MODEL, MASKSHIFT_COLOR (off|basic|full), MASKSHIFT_ASCII');
  ui.paragraph('OLLAMA_BASE_URL, OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, LMSTUDIO_BASE_URL, VLLM_BASE_URL');
  ui.line();
}

async function doctor(runtime, ui) {
  const commands = ['git', 'rg', 'node', 'npm', 'python3', 'docker', 'podman', 'npx', 'uvx', 'gh'];
  const commandMap = Object.fromEntries(await Promise.all(commands.map(async (command) => [command, await commandExists(command)])));
  const providers = await runtime.providerManager.discoverAll({ force: true });
  const config = runtime.config.get();
  const report = {
    ok: Boolean(commandMap.git && commandMap.node) && providers.some((provider) => provider.status === 'online'),
    version: VERSION,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    home: config.home,
    database: config.dataFile,
    permissionMode: config.permissionMode,
    commands: commandMap,
    providers,
    tools: runtime.toolRegistry.list({ includeSchema: false }).length,
    skills: runtime.skillManager.list().length,
    mcpServers: runtime.mcpManager.listServers().length,
  };
  if (ui.emit(report)) return report;

  ui.banner(VERSION, { compact: true });
  ui.heading(report.ok ? 'doctor — pass' : 'doctor — attention', '');
  ui.fields([
    ['node', report.node],
    ['platform', report.platform],
    ['home', report.home],
    ['database', report.database],
    ['permission mode', report.permissionMode],
    ['inventory', `${report.tools} tools  ${report.skills} skills  ${report.mcpServers} MCP servers`],
  ]);
  ui.section('commands');
  for (const [name, found] of Object.entries(commandMap)) {
    if (found) ui.ok(`${name.padEnd(10)}${found}`);
    else ui.line(ui.theme.paint(`${ui.marks.dot} ${name}`, { fg: ui.theme.roles.border }));
  }
  ui.section('providers');
  for (const provider of providers) {
    if (provider.status === 'online') ui.ok(`${provider.id.padEnd(12)}${(provider.models || []).length} models`);
    else ui.line(ui.theme.paint(`${ui.marks.dot} ${provider.id.padEnd(12)}${provider.status}${provider.error ? ` — ${provider.error}` : ''}`, { fg: ui.theme.roles.border }));
  }
  ui.line();
  return report;
}

async function headlessRun(runtime, ui, args, positional) {
  const prompt = positional.join(' ') || args.prompt;
  if (!prompt) throw new Error('A prompt is required: maskshift run "…"');
  const workspace = await runtime.workspaceManager.open(args.workspace || process.cwd());
  runtime.store.setSetting('lastWorkspaceId', workspace.id);
  const session = runtime.engine.createSession({
    workspaceId: workspace.id, title: prompt.slice(0, 78), modelRef: args.model || null,
  });

  const quiet = Boolean(args.quiet || ui.json);
  const unsubscribe = quiet ? () => {} : runtime.eventBus.subscribe((event) => {
    if (event.sessionId !== session.id) return;
    const payload = event.payload || {};
    switch (event.type) {
      case 'run.started':
        ui.line(ui.theme.paint(`${ui.marks.diamond} run ${event.runId} on ${payload.model}`, { fg: ui.theme.palette.crimson, bold: true }));
        break;
      case 'run.model-turn':
        ui.line(ui.theme.paint(`${ui.marks.dot} turn ${String(payload.step).padStart(2, '0')} — ${payload.tools?.length ?? 0} tools active`, { fg: ui.theme.roles.border }));
        break;
      case 'run.assistant':
        if (payload.content?.trim()) { ui.line(); ui.markdown(payload.content); }
        for (const call of payload.toolCalls || []) {
          ui.line(ui.theme.paint(`  ${ui.marks.caret} ${call.name}`, { fg: ui.theme.roles.tool })
            + ui.theme.paint(` ${oneLine(JSON.stringify(call.args ?? {}), ui.width - call.name.length - 8)}`, { fg: ui.theme.roles.border }));
        }
        break;
      case 'run.tool-result':
        ui.line(ui.theme.paint(`  ${ui.marks.check} ${payload.tool}`, { fg: ui.theme.roles.success })
          + ui.theme.paint(` ${oneLine(payload.content, ui.width - String(payload.tool).length - 8)}`, { fg: ui.theme.roles.muted }));
        break;
      case 'run.tool-error':
        ui.line(ui.theme.paint(`  ${ui.marks.cross} ${payload.tool}`, { fg: ui.theme.roles.danger })
          + ui.theme.paint(` ${oneLine(payload.content, ui.width - String(payload.tool).length - 8)}`, { fg: ui.theme.roles.muted }));
        break;
      case 'run.checkpoint':
        ui.line(ui.theme.paint(`  ${ui.marks.dot} checkpoint ${payload.ref || payload.kind || ''}`, { fg: ui.theme.roles.border }));
        break;
      default: break;
    }
  });

  const run = await runtime.engine.startRun({
    sessionId: session.id, workspaceId: workspace.id, prompt,
    modelRef: args.model || null, options: { source: 'cli' },
  });
  const completed = await runtime.engine.waitForRun(run.id);
  unsubscribe();

  const messages = runtime.store.listMessages(session.id, 2000);
  const final = [...messages].reverse().find((message) => message.role === 'assistant' && message.content);

  if (ui.json) {
    ui.write(JSON.stringify({
      runId: run.id, sessionId: session.id, status: completed.status,
      model: completed.model_id, error: completed.error || null,
      final: final?.content || '', usage: completed.meta?.usage || null,
      cost: completed.meta?.costEstimate || null,
    }, null, 2));
  } else {
    ui.rule();
    if (final?.content) ui.markdown(final.content);
    ui.line();
    const tone = completed.status === 'completed' ? 'ok' : completed.status === 'cancelled' ? 'warn' : 'fail';
    ui.status(tone, `run ${completed.status}${completed.error ? `: ${completed.error}` : ''}`);
  }
  return completed.status === 'completed' ? 0 : 1;
}

async function execCommand(runtime, ui, args, positional) {
  const command = positional.join(' ') || args.command;
  if (!command) throw new Error('A command is required: maskshift exec "…"');
  const workspace = await runtime.workspaceManager.open(args.workspace || process.cwd());
  const result = await runtime.toolRegistry.execute('shell_exec', {
    command, cwd: args.cwd || '.', timeoutMs: Number(args.timeout || runtime.config.get().commandTimeoutMs),
  }, toolContext(runtime, workspace));
  if (ui.emit(result)) return result.code === 0 ? 0 : result.code;
  if (result.stdout) ui.write(result.stdout.replace(/\n$/, ''));
  if (result.stderr) ui.writeError(result.stderr.replace(/\n$/, ''));
  return result.code === 0 ? 0 : result.code;
}

async function daemon(runtime, ui) {
  ui.banner(VERSION, { compact: true });
  const automations = runtime.automationScheduler.list({ enabled: true, limit: 500 });
  ui.ok(`Daemon resident — ${automations.length} armed automation${automations.length === 1 ? '' : 's'}`);
  for (const automation of automations) {
    ui.bullet(`${automation.name} ${ui.marks.dot} next ${automation.next_run_at || 'unscheduled'}`);
  }
  ui.line();
  ui.info('Press ctrl+c to stop.');
  await new Promise((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const positional = args._;
  if (args['no-color']) process.env.NO_COLOR = '1';
  const ui = new Ui({ json: Boolean(args.json) });

  if (args.version || args.v) { ui.write(VERSION); return 0; }

  const command = positional[0] || 'tui';
  if (command === 'help' || ((args.help || args.h) && positional.length <= 1)) {
    printHelp(ui, positional[1] || null);
    return 0;
  }

  const group = GROUPS[command];
  const single = SINGLE[command];
  const known = Boolean(group || single || TOP_LEVEL[command]);
  if (!known) {
    ui.fail(`Unknown command: ${command}`);
    ui.info('Run "maskshift help" for the full command list.');
    return 2;
  }
  if (group && (args.help || args.h)) { printHelp(ui, command); return 0; }

  const runtime = await createRuntime({
    configPath: args.config,
    workspacePath: args.workspace || process.cwd(),
    configOverrides: args.model ? { defaultModel: String(args.model) } : {},
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await runtime.close().catch(() => {});
  };

  try {
    if (command === 'tui') {
      if (!process.stdout.isTTY) {
        ui.fail('The MaskShift interface needs an interactive terminal.');
        ui.info('Use "maskshift run" for headless execution, or "maskshift help" for the command list.');
        return 2;
      }
      return await startTui(runtime, {
        workspacePath: args.workspace || process.cwd(),
        model: args.model || null,
        prompt: positional.slice(1).join(' ') || null,
      });
    }
    if (command === 'run') return await headlessRun(runtime, ui, args, positional.slice(1));
    if (command === 'exec') return await execCommand(runtime, ui, args, positional.slice(1));
    if (command === 'doctor') { const report = await doctor(runtime, ui); return report.ok ? 0 : 1; }
    if (command === 'daemon') return await daemon(runtime, ui);

    if (single) {
      await single.run({ runtime, ui, args, positional: positional.slice(1) });
      return 0;
    }

    const verb = positional[1] && group.commands[positional[1]] ? positional[1] : group.defaultCommand;
    const entry = group.commands[verb];
    if (!entry) {
      ui.fail(`Unknown ${command} command: ${positional[1]}`);
      printHelp(ui, command);
      return 2;
    }
    const offset = positional[1] === verb ? 2 : 1;
    await entry.run({ runtime, ui, args, positional: positional.slice(offset) });
    return 0;
  } finally {
    await close();
  }
}

export { doctor, printHelp };
