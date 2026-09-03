import path from 'node:path';
import { commandExists, runCommand, shellQuote, truncate } from '../core/utils.mjs';

const DEFAULT_BRIDGES = {
  claude: {
    title: 'Claude Code',
    command: 'claude',
    args: ['-p', '{prompt}'],
    description: 'Delegate a task to an installed Claude Code CLI in non-interactive print mode.',
  },
  codex: {
    title: 'OpenAI Codex CLI',
    command: 'codex',
    args: ['exec', '{prompt}'],
    description: 'Delegate a task to an installed Codex CLI execution session.',
  },
  opencode: {
    title: 'OpenCode',
    command: 'opencode',
    args: ['run', '{prompt}'],
    description: 'Delegate a task to an installed OpenCode CLI.',
  },
  copilot: {
    title: 'GitHub Copilot CLI',
    command: 'copilot',
    args: ['-p', '{prompt}'],
    description: 'Delegate a task to an installed GitHub Copilot CLI.',
  },
  hermes: {
    title: 'Nous Hermes Agent',
    command: 'hermes',
    args: ['chat', '-q', '{prompt}'],
    description: 'Delegate a task to an installed Hermes Agent CLI.',
  },
  aider: {
    title: 'Aider',
    command: 'aider',
    args: ['--message', '{prompt}'],
    description: 'Delegate repository editing to an installed Aider CLI.',
  },
};

function interpolate(value, variables) {
  return String(value).replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => variables[key] ?? '');
}

export class BridgeManager {
  constructor({ config, logger, eventBus, processManager, workspaceManager }) {
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
    this.processManager = processManager;
    this.workspaceManager = workspaceManager;
    this.cache = null;
  }

  definitions() {
    const configured = this.config.get().agentBridges || {};
    const names = new Set([...Object.keys(DEFAULT_BRIDGES), ...Object.keys(configured)]);
    return [...names].map((name) => ({
      name,
      ...(DEFAULT_BRIDGES[name] || {}),
      ...(configured[name] || {}),
    })).filter((item) => item.enabled !== false && item.command);
  }

  async discover({ force = false } = {}) {
    if (this.cache && !force) return this.cache;
    const output = [];
    for (const definition of this.definitions()) {
      const executable = await commandExists(definition.command);
      let version = null;
      if (executable) {
        const result = await runCommand(`${shellQuote(executable)} --version`, { timeoutMs: 8_000, maxOutputChars: 8_000 });
        version = truncate((result.stdout || result.stderr || '').trim(), 1000);
      }
      output.push({
        ...definition,
        executable,
        available: Boolean(executable),
        version,
        args: definition.args || [],
      });
    }
    this.cache = output;
    return output;
  }

  async help(name) {
    const bridge = (await this.discover()).find((item) => item.name === name);
    if (!bridge) throw new Error(`Unknown agent bridge: ${name}`);
    if (!bridge.available) throw new Error(`${bridge.title || name} is not installed (${bridge.command})`);
    const result = await runCommand(`${shellQuote(bridge.executable)} --help`, { timeoutMs: 12_000, maxOutputChars: 40_000 });
    return { name, command: bridge.executable, code: result.code, stdout: result.stdout, stderr: result.stderr };
  }

  resolveWorkspace(workspaceId, cwd) {
    if (cwd) return path.resolve(cwd);
    if (workspaceId) return this.workspaceManager.get(workspaceId).path;
    return process.cwd();
  }

  async run(name, {
    prompt,
    workspaceId = null,
    cwd = null,
    extraArgs = [],
    env = {},
    wait = true,
    timeoutMs = 1_800_000,
    model = null,
    sessionId = null,
    runId = null,
  } = {}) {
    if (!prompt) throw new Error('Bridge prompt is required');
    const bridge = (await this.discover()).find((item) => item.name === name);
    if (!bridge) throw new Error(`Unknown agent bridge: ${name}`);
    if (!bridge.available) throw new Error(`${bridge.title || name} is not installed (${bridge.command})`);
    const workingDirectory = this.resolveWorkspace(workspaceId, cwd);
    const variables = { prompt, cwd: workingDirectory, model: model || '', workspace: workingDirectory };
    const args = [...(bridge.args || []), ...(extraArgs || [])]
      .map((arg) => interpolate(arg, variables))
      .filter((arg) => arg !== '');
    if (model && bridge.modelArgs && !args.some((arg) => String(arg).includes(model))) {
      args.push(...bridge.modelArgs.map((arg) => interpolate(arg, variables)));
    }
    const command = [shellQuote(bridge.executable), ...args.map(shellQuote)].join(' ');
    const scope = { workspaceId, sessionId, runId };
    this.eventBus?.emit('bridge.started', { bridge: name, command, cwd: workingDirectory }, scope);
    if (!wait) {
      const processState = this.processManager.start(command, { cwd: workingDirectory, env, workspaceId, sessionId, runId });
      return { bridge: name, async: true, process: processState };
    }
    const result = await runCommand(command, {
      cwd: workingDirectory,
      env,
      timeoutMs,
      maxOutputChars: this.config.get().maxToolOutputChars * 2,
    });
    const response = { bridge: name, async: false, ...result };
    this.eventBus?.emit('bridge.completed', response, scope);
    return response;
  }

  async runCustom({ command, args = [], prompt = '', cwd = null, workspaceId = null, wait = true, timeoutMs = 1_800_000, env = {}, sessionId = null, runId = null }) {
    if (!command) throw new Error('command is required');
    const executable = await commandExists(command) || command;
    const workingDirectory = this.resolveWorkspace(workspaceId, cwd);
    const variables = { prompt, cwd: workingDirectory, workspace: workingDirectory };
    const rendered = [shellQuote(executable), ...args.map((arg) => shellQuote(interpolate(arg, variables)))].join(' ');
    if (!wait) {
      return { async: true, process: this.processManager.start(rendered, { cwd: workingDirectory, env, workspaceId, sessionId, runId }) };
    }
    return runCommand(rendered, { cwd: workingDirectory, env, timeoutMs, maxOutputChars: this.config.get().maxToolOutputChars * 2 });
  }
}
