import os from 'node:os';
import path from 'node:path';
import { commandExists, runCommand, truncate } from '../core/utils.mjs';

function cwdFor(args, context) {
  if (args.cwd) return path.isAbsolute(args.cwd) ? args.cwd : path.resolve(context.workspacePath || process.cwd(), args.cwd);
  return context.workspacePath || process.cwd();
}

export function registerShellTools(registry, { processManager, config }) {
  registry.register({
    name: 'shell_exec',
    title: 'Execute shell command',
    description: 'Run any Unix shell command on the host with the full user environment. Use for builds, tests, package managers, compilers, scripts, system inspection, and repository automation.',
    category: 'shell', risk: 'host-exec', alwaysAvailable: true,
    keywords: ['bash', 'terminal', 'command', 'build', 'test', 'compile', 'unix', 'run'],
    inputSchema: {
      type: 'object', required: ['command'],
      properties: {
        command: { type: 'string' }, cwd: { type: 'string', default: '.' },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 3600000 },
        env: { type: 'object', additionalProperties: { type: 'string' } },
        maxOutputChars: { type: 'integer', minimum: 1000, maximum: 1000000 },
      },
    },
    execute: async (args, context) => {
      const cwd = cwdFor(args, context);
      const result = await runCommand(args.command, {
        cwd,
        env: args.env || {},
        timeoutMs: args.timeoutMs ?? config.get().commandTimeoutMs,
        maxOutputChars: args.maxOutputChars || config.get().maxToolOutputChars,
        signal: context.signal,
        onStdout: (text) => context.eventBus?.emit('shell.output', { stream: 'stdout', text }, context.scope),
        onStderr: (text) => context.eventBus?.emit('shell.output', { stream: 'stderr', text }, context.scope),
      });
      return result;
    },
  });

  registry.register({
    name: 'shell_exec_parallel',
    title: 'Execute commands in parallel',
    description: 'Run multiple independent shell commands concurrently and return every result.',
    category: 'shell', risk: 'host-exec',
    keywords: ['parallel', 'commands', 'tests', 'build matrix'],
    inputSchema: {
      type: 'object', required: ['commands'],
      properties: {
        commands: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', required: ['command'], properties: { command: { type: 'string' }, cwd: { type: 'string' }, env: { type: 'object' }, timeoutMs: { type: 'integer' } } } },
      },
    },
    execute: async (args, context) => Promise.all(args.commands.map(async (item) => {
      const cwd = cwdFor(item, context);
      return runCommand(item.command, {
        cwd, env: item.env || {}, timeoutMs: item.timeoutMs ?? config.get().commandTimeoutMs,
        maxOutputChars: Math.floor(config.get().maxToolOutputChars / Math.max(1, args.commands.length)), signal: context.signal,
      });
    })),
  });

  registry.register({
    name: 'shell_start',
    title: 'Start background process',
    description: 'Start a persistent host process with live stdout/stderr streaming. Returns a process ID for later reads, input, or termination.',
    category: 'shell', risk: 'host-exec',
    keywords: ['background', 'server', 'daemon', 'watch', 'dev server', 'persistent process'],
    inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' }, cwd: { type: 'string' }, env: { type: 'object' } } },
    execute: async (args, context) => processManager.start(args.command, {
      cwd: cwdFor(args, context), env: args.env || {}, workspaceId: context.workspaceId,
      runId: context.runId, sessionId: context.sessionId,
    }),
  });

  registry.register({
    name: 'shell_process_read', title: 'Read background process',
    description: 'Read current status and incremental output from a persistent process.',
    category: 'shell', readOnly: true,
    inputSchema: { type: 'object', required: ['processId'], properties: { processId: { type: 'string' }, stdoutFrom: { type: 'integer', default: 0 }, stderrFrom: { type: 'integer', default: 0 } } },
    execute: async (args) => processManager.read(args.processId, args),
  });

  registry.register({
    name: 'shell_process_write', title: 'Write to process stdin',
    description: 'Send text or control sequences to a persistent process stdin.',
    category: 'shell', risk: 'host-exec',
    inputSchema: { type: 'object', required: ['processId', 'input'], properties: { processId: { type: 'string' }, input: { type: 'string' } } },
    execute: async (args) => processManager.write(args.processId, args.input),
  });

  registry.register({
    name: 'shell_process_stop', title: 'Stop background process',
    description: 'Terminate a persistent process and its Unix process group.',
    category: 'shell', risk: 'host-exec',
    inputSchema: { type: 'object', required: ['processId'], properties: { processId: { type: 'string' }, signal: { type: 'string', default: 'SIGTERM' } } },
    execute: async (args) => processManager.stop(args.processId, args.signal || 'SIGTERM'),
  });

  registry.register({
    name: 'shell_process_list', title: 'List background processes',
    description: 'List processes launched by MaskShift, optionally limited to the current workspace or active processes.',
    category: 'shell', readOnly: true,
    inputSchema: { type: 'object', properties: { allWorkspaces: { type: 'boolean', default: false }, runningOnly: { type: 'boolean', default: false } } },
    execute: async (args, context) => processManager.list({ workspaceId: args.allWorkspaces ? null : context.workspaceId, runningOnly: Boolean(args.runningOnly) }),
  });

  registry.register({
    name: 'system_info', title: 'Inspect host system',
    description: 'Return operating system, CPU, memory, process, shell, runtime, and workspace information.',
    category: 'shell', readOnly: true,
    keywords: ['os', 'platform', 'cpu', 'memory', 'node', 'environment'],
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args, context) => ({
      platform: process.platform, architecture: process.arch, release: os.release(), hostname: os.hostname(),
      cpus: os.cpus().map((cpu) => cpu.model), cpuCount: os.cpus().length,
      totalMemory: os.totalmem(), freeMemory: os.freemem(), uptimeSeconds: os.uptime(),
      node: process.version, pid: process.pid, shell: process.env.SHELL || null,
      user: os.userInfo().username, home: os.homedir(), cwd: process.cwd(), workspace: context.workspacePath || null,
    }),
  });

  registry.register({
    name: 'command_lookup', title: 'Locate executables',
    description: 'Find whether one or more commands are installed and return their executable paths.',
    category: 'shell', readOnly: true,
    keywords: ['which', 'executable', 'installed', 'dependency'],
    inputSchema: { type: 'object', required: ['commands'], properties: { commands: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } } } },
    execute: async (args) => Object.fromEntries(await Promise.all(args.commands.map(async (command) => [command, await commandExists(command)]))),
  });
}
