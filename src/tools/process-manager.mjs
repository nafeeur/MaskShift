import { spawn } from 'node:child_process';
import { id, nowIso, truncate } from '../core/utils.mjs';

export class ProcessManager {
  constructor({ eventBus, logger, config }) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.config = config;
    this.processes = new Map();
  }

  start(command, { cwd, env = {}, shell = true, workspaceId, runId, sessionId } = {}) {
    const processId = id('proc');
    const child = spawn(command, {
      cwd,
      env: { ...process.env, ...env },
      shell,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const state = {
      id: processId,
      command,
      cwd,
      pid: child.pid,
      status: 'running',
      code: null,
      signal: null,
      startedAt: nowIso(),
      endedAt: null,
      stdout: '',
      stderr: '',
      child,
      workspaceId,
      runId,
      sessionId,
    };
    this.processes.set(processId, state);
    const append = (field, text) => {
      state[field] = (state[field] + text).slice(-this.config.get().maxToolOutputChars * 2);
      this.eventBus.emit('process.output', { processId, stream: field, text }, { workspaceId, runId, sessionId });
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk.toString()));
    child.stderr.on('data', (chunk) => append('stderr', chunk.toString()));
    child.once('error', (error) => {
      state.status = 'failed';
      state.stderr += `\n${error.message}`;
      state.endedAt = nowIso();
      this.eventBus.emit('process.failed', { processId, error: error.message }, { workspaceId, runId, sessionId });
    });
    child.once('close', (code, signal) => {
      state.status = code === 0 ? 'completed' : 'failed';
      state.code = code;
      state.signal = signal;
      state.endedAt = nowIso();
      this.eventBus.emit('process.exited', { processId, code, signal, status: state.status }, { workspaceId, runId, sessionId });
    });
    this.eventBus.emit('process.started', this.publicState(state), { workspaceId, runId, sessionId });
    return this.publicState(state);
  }

  publicState(state) {
    return {
      id: state.id,
      command: state.command,
      cwd: state.cwd,
      pid: state.pid,
      status: state.status,
      code: state.code,
      signal: state.signal,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      stdout: truncate(state.stdout, 60_000),
      stderr: truncate(state.stderr, 60_000),
      workspaceId: state.workspaceId,
      runId: state.runId,
    };
  }

  get(processId) {
    const state = this.processes.get(processId);
    if (!state) throw new Error(`Unknown process: ${processId}`);
    return state;
  }

  read(processId, { stdoutFrom = 0, stderrFrom = 0 } = {}) {
    const state = this.get(processId);
    return {
      ...this.publicState(state),
      stdout: state.stdout.slice(stdoutFrom),
      stderr: state.stderr.slice(stderrFrom),
      stdoutLength: state.stdout.length,
      stderrLength: state.stderr.length,
    };
  }

  write(processId, input) {
    const state = this.get(processId);
    if (!state.child.stdin.writable) throw new Error(`Process stdin is closed: ${processId}`);
    state.child.stdin.write(input);
    return { written: Buffer.byteLength(input), processId };
  }

  stop(processId, signal = 'SIGTERM') {
    const state = this.get(processId);
    if (state.status !== 'running') return this.publicState(state);
    try {
      if (process.platform !== 'win32') process.kill(-state.pid, signal);
      else state.child.kill(signal);
    } catch {
      state.child.kill(signal);
    }
    return { processId, signal, stopping: true };
  }

  list({ workspaceId, runningOnly = false } = {}) {
    return [...this.processes.values()]
      .filter((state) => !workspaceId || state.workspaceId === workspaceId)
      .filter((state) => !runningOnly || state.status === 'running')
      .map((state) => this.publicState(state));
  }

  async close() {
    for (const state of this.processes.values()) {
      if (state.status === 'running') this.stop(state.id, 'SIGTERM');
    }
  }
}
