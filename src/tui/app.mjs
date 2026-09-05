// The MaskShift TUI application shell.
//
// Owns global state, wires the runtime event bus into the views, routes the
// keyboard, and paints one frame at a time through the double-buffered screen.

import path from 'node:path';
import { glyphs } from './box.mjs';
import { headerBand, hintRail, statusRail, tabStrip } from './chrome.mjs';
import { Keyboard } from './input.mjs';
import { hstack, overlay as paintOverlay, split, vstack } from './layout.mjs';
import { ConfirmOverlay, FormOverlay, PaletteOverlay, PickerOverlay, TextOverlay } from './overlays.mjs';
import * as rail from './rail.mjs';
import { RAIL_TABS } from './rail.mjs';
import { Screen } from './screen.mjs';
import { Theme } from './theme.mjs';
import { fit, oneLine, truncate, wrap } from './text.mjs';
import { Composer, ListView, Spinner, TextField, Toasts, Viewport } from './widgets.mjs';
import { VERSION, runCommand, safeJsonParse } from '../core/utils.mjs';
import * as chatView from './views/chat.mjs';
import * as filesView from './views/files.mjs';
import * as arsenalView from './views/arsenal.mjs';
import * as networkView from './views/network.mjs';
import * as modshopView from './views/modshop.mjs';
import * as terminalView from './views/terminal.mjs';

const VIEWS = [chatView, filesView, arsenalView, networkView, modshopView, terminalView];
const EVENT_LIMIT = 400;
const TERMINAL_LIMIT = 2000;

export class MaskShiftTui {
  constructor(runtime, {
    workspacePath = process.cwd(), model = null, prompt = null,
    output = process.stdout, input = process.stdin, theme = null, headless = false,
  } = {}) {
    this.runtime = runtime;
    this.version = VERSION;
    this.headless = headless;
    const preferences = runtime.config.get().ui || {};
    this.theme = theme || new Theme({
      ...(headless ? { depth: 24, unicode: true } : {}),
      ...(preferences.colorDepth === null || preferences.colorDepth === undefined ? {} : { depth: Number(preferences.colorDepth) }),
      ...(preferences.unicode === null || preferences.unicode === undefined ? {} : { unicode: Boolean(preferences.unicode) }),
    });
    this.screen = new Screen({ theme: this.theme, output });
    this.keyboard = new Keyboard({ input });
    this.spinner = new Spinner();
    this.toasts = new Toasts();

    this.views = VIEWS.map((module) => module.meta);
    this.modules = new Map(VIEWS.map((module) => [module.meta.id, module]));
    this.view = 'chat';
    this.focus = 'composer';
    this.overlay = null;
    this.running = false;
    this.exitCode = 0;
    this.initialPrompt = prompt;
    this.startWorkspacePath = workspacePath;

    // Session and run state.
    this.workspace = null;
    this.workspaceId = null;
    this.sessionId = null;
    this.sessionTitle = '';
    this.messages = [];
    this.activeRun = null;
    this.runId = null;
    this.plan = null;
    this.capabilitySnapshot = null;
    this.activeCapabilities = new Set();
    this.subagents = 0;
    this.pendingCalls = new Map();
    this.tokenHistory = [];
    this.totals = { input: 0, output: 0, cost: 0 };
    this.startedAt = null;
    this.step = 0;
    this.events = [];
    this.gitBranch = '';
    this.gitStatus = '';

    // Model and provider state.
    this.providers = [];
    this.modelRef = model || runtime.config.get().defaultModel;
    this.counts = { tools: 0, skills: 0, mcp: 0 };

    // Composer and transcript.
    this.composer = new Composer();
    this.transcript = new Viewport();
    this.detail = new Viewport();
    this.railView = new Viewport();
    this.expandTools = Boolean(preferences.expandToolOutput);
    this.autoLoad = runtime.config.get().autoLoadCapabilities !== false;

    // Catalogue state.
    this.tools = [];
    this.skills = [];
    this.skillBodies = new Map();
    this.arsenalTab = 'tools';
    this.arsenalFilter = new TextField({ placeholder: 'SEARCH EVERY CAPABILITY' });
    this.arsenalList = new ListView();

    this.mcpServers = [];
    this.mcpTools = new Map();
    this.mcpTab = 'installed';
    this.mcpFilter = new TextField({ placeholder: 'FILTER SERVERS' });
    this.mcpList = new ListView();
    this.registryResults = [];

    this.automations = [];
    this.plugins = [];
    this.bridges = [];
    this.browsers = [];
    this.processes = [];
    this.modTab = 'automations';
    this.modFilter = new TextField({ placeholder: 'FILTER' });
    this.modList = new ListView();

    // Files.
    this.fileEntries = [];
    this.fileList = new ListView();
    this.fileFilter = new TextField({ placeholder: 'FILTER PATHS' });
    this.collapsedDirs = new Set();
    this.showHidden = false;
    this.previewPath = '';
    this.previewLines = [];
    this.previewError = '';
    this.preview = new Viewport();

    // Terminal.
    this.terminalLines = [];
    this.terminalField = new TextField({ placeholder: 'run any command with your full account permissions' });
    this.terminalCwd = '~';
    this.terminalBusy = false;
    this.terminalView = new Viewport();

    // Rail.
    this.railVisible = preferences.railVisible !== false;
    this.railTab = RAIL_TABS.includes(preferences.rail) ? preferences.rail : 'plan';

    this.bodyRegion = { row: 2, column: 0, width: 80, height: 20 };
    this.renderScheduled = false;
    this.actions = this.buildActions();
    this.quitArmed = false;
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    this.running = true;
    if (this.headless) throw new Error('Headless MaskShift TUI instances cannot take over the terminal');
    this.unsubscribe = this.runtime.eventBus.subscribe((event) => this.onEvent(event));
    this.screen.onResize = () => this.requestRender();
    this.screen.enter();
    this.screen.setTitle('MaskShift');
    this.keyboard.on('key', (event) => this.onKey(event));
    this.keyboard.start();
    this.ticker = setInterval(() => this.tick(), 120);

    await this.bootstrap();
    if (this.initialPrompt) {
      this.composer.set(this.initialPrompt);
      await this.submitPrompt();
    }
    this.requestRender();
    await new Promise((resolve) => { this.resolveExit = resolve; });
    return this.exitCode;
  }

  async bootstrap() {
    const runtime = this.runtime;
    try {
      const workspace = await runtime.workspaceManager.open(this.startWorkspacePath);
      this.setWorkspace(workspace);
    } catch (error) {
      this.toast(`Workspace unavailable: ${error.message}`, 'error');
    }
    this.refreshCatalogs();
    this.providers = runtime.providerManager.listProviders();
    void this.discoverProviders();
    void this.loadFileTree();
    void this.refreshGit();
    void this.refreshModShop({ force: false });
    this.openLatestSession();
  }

  stop(code = 0) {
    if (!this.running) return;
    this.running = false;
    this.exitCode = code;
    clearInterval(this.ticker);
    this.unsubscribe?.();
    this.keyboard.stop();
    this.screen.leave();
    this.resolveExit?.(code);
  }

  tick() {
    if (!this.running) return;
    this.spinner.advance();
    const dirty = this.toasts.prune();
    if (this.busy || dirty || this.terminalBusy) this.requestRender();
  }

  requestRender() {
    if (this.renderScheduled || !this.running) return;
    this.renderScheduled = true;
    setImmediate(() => {
      this.renderScheduled = false;
      try { this.paint(); } catch (error) {
        this.screen.leave();
        process.stderr.write(`MaskShift render failure: ${error.stack || error.message}\n`);
        this.stop(1);
      }
    });
  }

  // ------------------------------------------------------------------ getters

  get busy() {
    return Boolean(this.activeRun && ['running', 'queued'].includes(this.activeRun.status));
  }

  get metrics() {
    const elapsed = this.startedAt ? Date.now() - this.startedAt : 0;
    const seconds = Math.floor(elapsed / 1000);
    return {
      step: this.step,
      elapsed: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
      tokens: this.totals.input + this.totals.output > 0
        ? `${compact(this.totals.input)}/${compact(this.totals.output)}`
        : '—',
      cost: this.totals.cost > 0 ? `$${this.totals.cost.toFixed(4)}` : '—',
    };
  }

  get liveTrail() {
    if (!this.busy && this.pendingCalls.size === 0) return [];
    const entries = [];
    for (const call of this.pendingCalls.values()) {
      entries.push({
        render: (theme, width) => {
          const mark = glyphs(theme);
          const head = theme.paint(`  ${this.spinner.frame(theme)} `, { fg: theme.palette.gold })
            + theme.paint(call.name, { fg: theme.palette.cyanide, bold: true })
            + theme.paint(`  ${oneLine(JSON.stringify(call.args ?? {}), Math.max(6, width - call.name.length - 8))}`, { fg: theme.roles.border });
          return [fit(head, width)];
        },
      });
    }
    if (this.busy && this.pendingCalls.size === 0) {
      entries.push({
        render: (theme, width) => [fit(
          theme.paint(`  ${this.spinner.frame(theme)} `, { fg: theme.palette.crimson })
          + theme.paint(this.thinkingLabel || 'THINKING', { fg: theme.roles.muted, italic: true }),
          width,
        )],
      });
    }
    return entries;
  }

  composerPlaceholder() {
    return this.busy
      ? 'RUN IN FLIGHT — ESC RETREATS, OR QUEUE THE NEXT ORDER'
      : 'TELL MASKSHIFT WHAT SUCCESS LOOKS LIKE…';
  }

  currentHints() {
    if (this.overlay) return [['↵', 'accept'], ['esc', 'dismiss'], ['↑↓', 'move']];
    if (this.focus === 'rail') return [['tab', 'rail section'], ['↑↓', 'scroll'], ['^B', 'hide rail']];
    const module = this.modules.get(this.view);
    return module?.hints ? module.hints(this) : [];
  }

  stamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  }

  summarizeEvent(event) {
    const payload = event.payload || {};
    if (payload.tool) return `${payload.tool} ${oneLine(payload.content || '', 160)}`;
    if (payload.message) return oneLine(payload.message, 160);
    if (payload.error) return oneLine(payload.error, 160);
    if (payload.final) return oneLine(payload.final, 160);
    if (payload.content) return oneLine(payload.content, 160);
    if (payload.tools) return `${payload.tools.length} tools active`;
    if (payload.model) return String(payload.model);
    return '';
  }

  // -------------------------------------------------------------------- paint

  paint() {
    const { columns, rows } = this.screen.size;
    const theme = this.theme;
    const bodyHeight = Math.max(4, rows - 4);
    this.bodyRegion = { row: 2, column: 0, width: columns, height: bodyHeight };

    const showRail = this.railVisible && columns >= 108;
    const [mainWidth, railWidth] = showRail
      ? split(columns, [{ weight: 3, min: 60 }, { weight: 1, min: 30, max: 46 }])
      : [columns, 0];

    const module = this.modules.get(this.view);
    const region = { row: 2, column: 0, width: mainWidth, height: bodyHeight };
    this.bodyRegion = region;
    const rendered = module.render(this, region);
    let body = rendered.lines;
    this.lastRegion = region;

    if (showRail) {
      const railLines = rail.render(this, { row: 2, column: mainWidth, width: railWidth, height: bodyHeight });
      body = hstack([{ lines: body, width: mainWidth }, { lines: railLines, width: railWidth }], bodyHeight);
    }

    let frame = vstack([
      [headerBand(this, columns)],
      [tabStrip(this, columns)],
      body,
      [statusRail(this, columns)],
      [hintRail(this, columns)],
    ], rows, columns);

    let cursor = rendered.cursor;

    const toastLines = this.toasts.render(theme, Math.min(56, columns - 4));
    if (toastLines.length) {
      frame = paintOverlay(frame, toastLines, { row: rows - 3 - toastLines.length, column: columns - Math.min(58, columns - 2) }, columns);
    }

    if (this.overlay) {
      const drawn = this.overlay.render(this, { columns, rows });
      frame = paintOverlay(frame, drawn.lines, drawn.offset, columns);
      cursor = drawn.cursor;
    }

    this.screen.render(frame, cursor);
    this.lastFrame = frame;
    return frame;
  }

  /** Paint synchronously and hand back the frame. Used by tests and previews. */
  snapshot() {
    return this.paint();
  }

  // ---------------------------------------------------------------- keyboard

  onKey(event) {
    try {
      if (this.overlay) {
        this.overlay.handle(this, event);
        this.requestRender();
        return;
      }
      if (this.globalKey(event)) { this.requestRender(); return; }
      const module = this.modules.get(this.view);
      module.handle(this, event);
      this.requestRender();
    } catch (error) {
      this.toast(error.message, 'error');
      this.requestRender();
    }
  }

  globalKey(event) {
    const typing = ['composer', 'terminal', 'file-filter', 'arsenal-filter', 'mcp-filter', 'mod-filter'].includes(this.focus);

    if (event.ctrl && event.name === 'c') {
      if (this.busy) { this.cancelRun(); return true; }
      if (this.quitArmed) { this.stop(0); return true; }
      this.quitArmed = true;
      this.toast('Press ctrl+c again to leave MaskShift', 'warn');
      setTimeout(() => { this.quitArmed = false; }, 2500).unref?.();
      return true;
    }
    if (event.ctrl && event.name === 'q') { this.stop(0); return true; }
    if (event.ctrl && event.name === 'k') { this.openPalette(); return true; }
    if (event.ctrl && event.name === 'p') { this.openSessionPicker(); return true; }
    if (event.ctrl && event.name === 'g') { this.openModelPicker(); return true; }
    if (event.ctrl && event.name === 'o') { this.openWorkspaceDialog(); return true; }
    if (event.ctrl && event.name === 'n') { this.newSession(); return true; }
    if (event.ctrl && event.name === 'b') { this.railVisible = !this.railVisible; this.screen.invalidate(); return true; }
    if (event.ctrl && event.name === 'r') { this.cycleRail(1); return true; }
    if (event.ctrl && event.name === 'y') { this.focus = this.focus === 'rail' ? 'composer' : 'rail'; return true; }
    if (event.name === 'f1') { this.openHelp(); return true; }
    if (event.name === 'f2') { this.openSettings(); return true; }
    if (event.name === 'f5') { this.refreshAll(); return true; }

    if (event.alt && /^[1-6]$/.test(event.name)) { this.switchView(Number(event.name) - 1); return true; }
    if (!typing && /^[1-6]$/.test(event.name)) { this.switchView(Number(event.name) - 1); return true; }
    if (!typing && event.name === '?') { this.openHelp(); return true; }

    if (event.name === 'escape') {
      if (this.busy && this.view === 'chat') { this.cancelRun(); return true; }
      if (this.focus === 'rail') { this.focus = this.defaultFocus(); return true; }
      if (typing && this.focus !== 'composer' && this.focus !== 'terminal') { this.focus = this.defaultFocus(); return true; }
      if (this.view !== 'chat') { this.switchView(0); return true; }
      this.openPalette();
      return true;
    }
    if (event.name === 'right' && this.focus === 'rail') return false;
    return false;
  }

  defaultFocus() {
    return {
      chat: 'composer', files: 'files', arsenal: 'arsenal',
      network: 'network', modshop: 'modshop', terminal: 'terminal',
    }[this.view];
  }

  switchView(index) {
    const target = this.views[index];
    if (!target) return;
    this.view = target.id;
    this.focus = this.defaultFocus();
    this.screen.invalidate();
    if (target.id === 'files' && !this.fileEntries.length) void this.loadFileTree();
    if (target.id === 'modshop') void this.refreshModShop();
  }

  cycleRail(direction) {
    const index = RAIL_TABS.indexOf(this.railTab);
    this.railTab = RAIL_TABS[(index + direction + RAIL_TABS.length) % RAIL_TABS.length];
    this.railView.toTop();
    if (this.railTab === 'git') void this.refreshGit();
  }

  // ------------------------------------------------------------- runtime data

  setWorkspace(workspace) {
    this.workspace = workspace;
    this.workspaceId = workspace.id;
    this.terminalCwd = workspace.path;
    this.runtime.store.setSetting('lastWorkspaceId', workspace.id);
    this.collapsedDirs.clear();
  }

  refreshCatalogs() {
    this.tools = this.runtime.toolRegistry.list({ includeSchema: true });
    this.skills = this.runtime.skillManager.list();
    this.mcpServers = this.runtime.mcpManager.listServers(this.workspaceId);
    this.counts = { tools: this.tools.length, skills: this.skills.length, mcp: this.mcpServers.length };
  }

  async discoverProviders() {
    try {
      this.providers = await this.runtime.providerManager.discoverAll({ force: false });
    } catch { /* provider probing is best effort */ }
    this.requestRender();
  }

  openLatestSession() {
    const sessions = this.runtime.store.listSessions({ workspaceId: this.workspaceId, limit: 1 });
    if (sessions.length) this.loadSession(sessions[0].id);
    else this.newSession({ silent: true });
  }

  loadSession(sessionId) {
    const session = this.runtime.store.getSession(sessionId);
    if (!session) return;
    this.sessionId = session.id;
    this.messages = this.runtime.store.listMessages(session.id, 1000);
    this.sessionTitle = this.messages.length ? (session.title || '') : 'STANDBY FOR ORDERS';
    this.modelRef = session.model_id || this.modelRef;
    this.transcript.toBottom();
    const runs = this.runtime.store.listRuns({ sessionId: session.id, limit: 1 });
    this.activeRun = runs[0] && ['running', 'queued'].includes(runs[0].status) ? runs[0] : null;
    this.runId = this.activeRun?.id || null;
    this.plan = runs[0]?.meta?.plan || null;
    this.capabilitySnapshot = runs[0]?.meta?.capabilities || null;
    this.requestRender();
  }

  newSession({ silent = false } = {}) {
    const session = this.runtime.engine.createSession({
      workspaceId: this.workspaceId, title: 'New run', modelRef: this.modelRef,
    });
    this.sessionId = session.id;
    this.sessionTitle = 'STANDBY FOR ORDERS';
    this.messages = [];
    this.activeRun = null;
    this.runId = null;
    this.plan = null;
    this.capabilitySnapshot = null;
    this.activeCapabilities.clear();
    this.totals = { input: 0, output: 0, cost: 0 };
    this.tokenHistory = [];
    this.step = 0;
    this.startedAt = null;
    this.view = 'chat';
    this.focus = 'composer';
    if (!silent) this.toast('New heist opened', 'success');
    this.requestRender();
  }

  async submitPrompt() {
    const prompt = this.composer.value.trim();
    if (!prompt) return;
    if (prompt.startsWith('/')) { this.composer.clear(); await this.runSlash(prompt); return; }
    this.composer.remember(this.composer.value);
    this.composer.clear();
    this.view = 'chat';
    this.focus = 'composer';
    this.transcript.toBottom();
    try {
      const run = await this.runtime.engine.startRun({
        sessionId: this.sessionId, workspaceId: this.workspaceId, prompt,
        modelRef: this.modelRef, options: { source: 'tui' },
      });
      this.runId = run.id;
      this.sessionId = run.session_id;
      this.activeRun = run;
      this.startedAt = Date.now();
      this.step = 0;
      this.pendingCalls.clear();
      this.messages = this.runtime.store.listMessages(this.sessionId, 1000);
      const session = this.runtime.store.getSession(this.sessionId);
      this.sessionTitle = session?.title || this.sessionTitle;
    } catch (error) {
      this.toast(error.message, 'error');
    }
    this.requestRender();
  }

  cancelRun() {
    if (!this.runId) return;
    this.runtime.engine.cancel(this.runId);
    this.toast('Retreat signalled', 'warn');
  }

  // ------------------------------------------------------------- event bridge

  onEvent(event) {
    if (event.type.startsWith('run.')) this.onRunEvent(event);
    this.events.push(event);
    if (this.events.length > EVENT_LIMIT) this.events.splice(0, this.events.length - EVENT_LIMIT);
    if (['mcp.connected', 'mcp.disconnected', 'mcp.added', 'mcp.removed'].includes(event.type)) {
      this.mcpServers = this.runtime.mcpManager.listServers(this.workspaceId);
      this.counts.mcp = this.mcpServers.length;
    }
    if (event.type.startsWith('plugin.')) this.plugins = this.runtime.pluginManager.list();
    if (event.type.startsWith('automation.')) this.automations = this.runtime.automationScheduler.list({ limit: 200 });
    if (event.type.startsWith('tool.registered') || event.type.startsWith('plugin.activated')) this.refreshCatalogs();
    this.requestRender();
  }

  onRunEvent(event) {
    if (event.sessionId && event.sessionId !== this.sessionId) {
      if (event.type === 'run.subagent.started') this.subagents += 1;
      return;
    }
    const payload = event.payload || {};
    switch (event.type) {
      case 'run.started':
        this.startedAt = Date.now();
        this.step = 0;
        this.pendingCalls.clear();
        this.thinkingLabel = 'STUDYING THE TARGET';
        break;
      case 'run.model-turn':
        this.step = payload.step || this.step + 1;
        this.thinkingLabel = `TURN ${String(this.step).padStart(2, '0')} — ${payload.tools?.length ?? 0} TOOLS ACTIVE`;
        this.activeCapabilities = new Set(payload.tools || []);
        break;
      case 'run.assistant': {
        if (payload.usage) {
          this.totals.input += payload.usage.inputTokens || payload.usage.input_tokens || 0;
          this.totals.output += payload.usage.outputTokens || payload.usage.output_tokens || 0;
          this.tokenHistory.push((payload.usage.outputTokens || payload.usage.output_tokens || 0));
          if (this.tokenHistory.length > 120) this.tokenHistory.shift();
        }
        for (const call of payload.toolCalls || []) this.pendingCalls.set(call.id, { name: call.name, args: call.args });
        this.messages = this.runtime.store.listMessages(this.sessionId, 1000);
        this.thinkingLabel = payload.toolCalls?.length ? 'EXECUTING TOOLS' : 'WRITING';
        break;
      }
      case 'run.tool-result':
      case 'run.tool-error':
        this.pendingCalls.delete(payload.toolCallId);
        this.messages = this.runtime.store.listMessages(this.sessionId, 1000);
        break;
      case 'run.checkpoint':
        this.toast(`Checkpoint ${payload.kind || 'saved'}`, 'info');
        break;
      case 'run.completed':
      case 'run.failed':
      case 'run.cancelled':
      case 'run.max-steps': {
        this.pendingCalls.clear();
        this.messages = this.runtime.store.listMessages(this.sessionId, 1000);
        const run = this.runId ? this.runtime.store.getRun(this.runId) : null;
        this.activeRun = null;
        this.plan = run?.meta?.plan || this.plan;
        this.capabilitySnapshot = run?.meta?.capabilities || this.capabilitySnapshot;
        if (run?.meta?.costEstimate?.total) this.totals.cost = run.meta.costEstimate.total;
        const session = this.runtime.store.getSession(this.sessionId);
        this.sessionTitle = session?.title || this.sessionTitle;
        const tone = event.type === 'run.completed' ? 'success' : event.type === 'run.cancelled' ? 'warn' : 'error';
        this.toast(`Run ${event.type.replace('run.', '')}${payload.error ? `: ${oneLine(payload.error, 90)}` : ''}`, tone);
        void this.refreshGit();
        break;
      }
      default: break;
    }
    if (this.activeRun && this.runId) {
      const state = this.runtime.engine.getRunState(this.runId);
      if (state) {
        this.activeRun = state;
        this.plan = state.plan || this.plan;
        this.capabilitySnapshot = state.capabilities || this.capabilitySnapshot;
      }
    }
    if (this.transcript.stick) this.transcript.toBottom();
  }

  // ------------------------------------------------------------------- files

  async loadFileTree({ force = false, keepFilter = false } = {}) {
    if (!this.workspaceId) return;
    try {
      const filter = this.fileFilter.value.trim().toLowerCase();
      const result = await this.runtime.workspaceManager.listFiles(this.workspaceId, {
        depth: filter ? 12 : 4, includeHidden: this.showHidden, maxEntries: filter ? 20_000 : 4000,
      });
      this.fileEntries = filter
        ? result.entries.filter((entry) => entry.path.toLowerCase().includes(filter))
        : result.entries;
      if (!keepFilter) this.fileList.first();
    } catch (error) {
      this.toast(`File tree failed: ${error.message}`, 'error');
    }
    this.requestRender();
  }

  schedulePreview(relative) {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.openFile(relative, { quiet: true }), 90);
    this.previewTimer.unref?.();
  }

  async openFile(relative, { quiet = false } = {}) {
    if (!this.workspaceId) return;
    this.previewPath = relative;
    this.previewError = '';
    try {
      const result = await this.runtime.toolRegistry.execute('fs_read', {
        path: relative, withLineNumbers: false,
      }, this.toolContext());
      const content = typeof result === 'string' ? result : (result.content ?? result.text ?? '');
      this.previewLines = String(content).split('\n').slice(0, 5000);
      this.preview.toTop();
      if (!quiet) this.focus = 'preview';
    } catch (error) {
      this.previewLines = [];
      this.previewError = error.message;
    }
    this.requestRender();
  }

  attachContext(relative) {
    const reference = `@${relative}`;
    if (this.composer.value.includes(reference)) return;
    this.composer.insert(`${this.composer.value && !this.composer.value.endsWith(' ') ? ' ' : ''}${reference} `);
    this.toast(`Attached ${relative}`, 'success');
  }

  toolContext() {
    return {
      workspaceId: this.workspaceId,
      workspacePath: this.workspace?.path || process.cwd(),
      sessionId: this.sessionId,
      runId: null,
      scope: { workspaceId: this.workspaceId, sessionId: this.sessionId },
      eventBus: this.runtime.eventBus,
      store: this.runtime.store,
      capabilityState: this.runtime.capabilityController.createState({ runId: null, workspaceId: this.workspaceId }),
      planState: { summary: '', steps: [] },
    };
  }

  async refreshGit() {
    if (!this.workspace?.path) return;
    try {
      const [branch, status] = await Promise.all([
        runCommand('git rev-parse --abbrev-ref HEAD', { cwd: this.workspace.path, timeoutMs: 8000 }).catch(() => null),
        runCommand('git status --short --branch', { cwd: this.workspace.path, timeoutMs: 12_000 }).catch(() => null),
      ]);
      this.gitBranch = branch?.code === 0 ? branch.stdout.trim() : '';
      this.gitStatus = status?.code === 0 ? status.stdout.trim() : '';
    } catch { /* git is optional */ }
    this.requestRender();
  }

  // -------------------------------------------------------------------- MCP

  async refreshMcp() {
    this.mcpServers = this.runtime.mcpManager.listServers(this.workspaceId);
    this.counts.mcp = this.mcpServers.length;
    this.requestRender();
  }

  async connectMcp(name, force = false) {
    this.toast(`Linking ${name}…`, 'info');
    try {
      await this.runtime.mcpManager.connect(name, { workspaceId: this.workspaceId, force });
      const tools = await this.runtime.mcpManager.tools(name, this.workspaceId);
      this.mcpTools.set(name, tools);
      this.toast(`${name} linked (${tools.length} tools)`, 'success');
    } catch (error) {
      this.toast(`${name}: ${error.message}`, 'error');
    }
    await this.refreshMcp();
  }

  async disconnectMcp(name) {
    try {
      await this.runtime.mcpManager.disconnect(name, this.workspaceId);
      this.mcpTools.delete(name);
      this.toast(`${name} disconnected`, 'warn');
    } catch (error) {
      this.toast(error.message, 'error');
    }
    await this.refreshMcp();
  }

  async searchRegistry(query) {
    this.toast('Searching the official registry…', 'info');
    try {
      this.registryResults = await this.runtime.mcpManager.registrySearch(query || '', 40);
      this.toast(`${this.registryResults.length} registry entries`, 'success');
    } catch (error) {
      this.toast(`Registry search failed: ${error.message}`, 'error');
    }
    this.requestRender();
  }

  async installRegistryServer(item) {
    try {
      const installed = await this.runtime.mcpManager.installRegistry(item, {
        prefer: 'remote', workspacePath: this.workspace?.path || process.cwd(),
      });
      this.toast(`Installed ${installed.name}`, 'success');
      this.mcpTab = 'installed';
      await this.refreshMcp();
    } catch (error) {
      this.toast(`Install failed: ${error.message}`, 'error');
    }
  }

  openMcpDialog() {
    this.overlay = new FormOverlay({
      title: 'ADD MCP SERVER',
      submitLabel: 'ADD LINK',
      note: 'Environment values may reference shell variables with ${NAME}.',
      fields: [
        { name: 'name', label: 'name', value: '', hint: 'my-server' },
        {
          name: 'transport', label: 'transport', type: 'select', value: 'stdio',
          options: [{ label: 'STDIO', value: 'stdio' }, { label: 'STREAMABLE HTTP', value: 'http' }],
        },
        { name: 'command', label: 'command', value: '', hint: 'npx -y @modelcontextprotocol/server-filesystem .' },
        { name: 'url', label: 'url', value: '', hint: 'https://server.example/mcp' },
        { name: 'environment', label: 'env / headers json', type: 'textarea', value: '' },
      ],
      onSubmit: async (values) => {
        if (!values.name) throw new Error('A server name is required');
        const environment = values.environment ? safeJsonParse(values.environment, null) : {};
        if (values.environment && environment === null) throw new Error('Environment must be valid JSON');
        const definition = values.transport === 'http'
          ? { transport: 'http', url: values.url, headers: environment }
          : { transport: 'stdio', command: values.command.split(' ')[0], args: values.command.split(' ').slice(1), env: environment };
        await this.runtime.mcpManager.add(values.name, definition, this.workspace?.path || process.cwd());
        this.toast(`${values.name} added`, 'success');
        await this.refreshMcp();
      },
    });
  }

  confirmRemoveMcp(name) {
    this.overlay = new ConfirmOverlay({
      title: 'REMOVE SERVER', danger: true,
      message: `Remove the MCP server "${name}" from this workspace configuration?`,
      onConfirm: async () => {
        await this.runtime.mcpManager.remove(name, this.workspace?.path || process.cwd());
        this.toast(`${name} removed`, 'warn');
        await this.refreshMcp();
      },
    });
  }

  // --------------------------------------------------------------- mod shop

  async refreshModShop({ force = false } = {}) {
    this.automations = this.runtime.automationScheduler.list({ limit: 200 });
    this.plugins = this.runtime.pluginManager.list();
    this.processes = this.runtime.processManager.list({});
    this.browsers = this.runtime.browserManager.list();
    if (force || !this.bridges.length) {
      try { this.bridges = await this.runtime.bridgeManager.discover({ force }); } catch { /* optional */ }
    }
    this.requestRender();
  }

  openModCreate() {
    if (this.modTab === 'automations') return this.openAutomationDialog();
    if (this.modTab === 'plugins') return this.openPluginDialog();
    if (this.modTab === 'browser') return this.openBrowserDialog();
    if (this.modTab === 'bridges') return this.toast('Agent bridges are discovered from your PATH', 'info');
    return this.toast('Start processes from the terminal view', 'info');
  }

  openAutomationDialog() {
    this.overlay = new FormOverlay({
      title: 'NEW AUTOMATION', submitLabel: 'ARM AUTOMATION',
      note: 'Schedules accept "every 6h", cron expressions, or an ISO timestamp.',
      fields: [
        { name: 'name', label: 'name', value: '', hint: 'Nightly repository verification' },
        { name: 'schedule', label: 'schedule', value: 'every 6h' },
        {
          name: 'type', label: 'action', type: 'select', value: 'agent',
          options: [{ label: 'AGENT RUN', value: 'agent' }, { label: 'SHELL COMMAND', value: 'shell' }, { label: 'TOOL CALL', value: 'tool' }],
        },
        { name: 'payload', label: 'prompt / command / tool json', type: 'textarea', value: '' },
        { name: 'model', label: 'model override', value: '' },
        { name: 'enabled', label: 'enabled immediately', type: 'toggle', value: true },
      ],
      onSubmit: (values) => {
        if (!values.name) throw new Error('A name is required');
        let action;
        if (values.type === 'agent') action = { type: 'agent', prompt: values.payload, modelRef: values.model || null };
        else if (values.type === 'shell') action = { type: 'shell', command: values.payload };
        else {
          const parsed = safeJsonParse(values.payload, null);
          if (!parsed?.name) throw new Error('Tool actions need {"name":"…","arguments":{…}}');
          action = { type: 'tool', ...parsed };
        }
        this.runtime.automationScheduler.create({
          workspaceId: this.workspaceId, name: values.name,
          schedule: values.schedule, action, enabled: values.enabled,
        });
        this.toast(`${values.name} armed`, 'success');
        void this.refreshModShop();
      },
    });
  }

  openPluginDialog() {
    this.overlay = new FormOverlay({
      title: 'INSTALL PLUGIN', submitLabel: 'INSTALL + ACTIVATE',
      note: 'Plugins run inside MaskShift with full host authority and can register tools, skills, MCP servers and listeners.',
      fields: [
        { name: 'source', label: 'source', value: '', hint: '/path, git URL, or npm package' },
        {
          name: 'kind', label: 'install type', type: 'select', value: 'auto',
          options: [
            { label: 'AUTO DETECT', value: 'auto' }, { label: 'LOCAL DIRECTORY', value: 'local' },
            { label: 'GIT REPOSITORY', value: 'git' }, { label: 'NPM PACKAGE', value: 'npm' },
          ],
        },
        { name: 'name', label: 'local name', value: '' },
      ],
      onSubmit: async (values) => {
        if (!values.source) throw new Error('A source is required');
        const plugin = await this.runtime.pluginManager.install(values.source, { kind: values.kind, name: values.name || null });
        this.toast(`Installed ${plugin.name}`, 'success');
        this.refreshCatalogs();
        await this.refreshModShop();
      },
    });
  }

  openBrowserDialog() {
    this.overlay = new FormOverlay({
      title: 'LAUNCH BROWSER', submitLabel: 'LAUNCH',
      note: 'Visible mode is useful for one-time logins; profiles persist and are reused by the autonomous browser tools.',
      fields: [
        { name: 'profile', label: 'profile', value: 'default' },
        { name: 'url', label: 'start url', value: 'about:blank' },
        { name: 'headless', label: 'headless', type: 'toggle', value: true },
        { name: 'reuse', label: 'reuse matching profile', type: 'toggle', value: true },
      ],
      onSubmit: async (values) => {
        await this.runtime.browserManager.launch(values);
        this.toast('Browser launched', 'success');
        await this.refreshModShop();
      },
    });
  }

  openBridgeRunner(bridge) {
    this.overlay = new FormOverlay({
      title: `DELEGATE TO ${String(bridge.title || bridge.name).toUpperCase()}`, submitLabel: 'DELEGATE',
      note: bridge.available ? `Runs ${bridge.executable}` : 'This bridge is not installed on your PATH.',
      fields: [{ name: 'prompt', label: 'prompt', type: 'textarea', value: '' }],
      onSubmit: async (values) => {
        if (!values.prompt) throw new Error('A prompt is required');
        this.toast(`Delegating to ${bridge.name}…`, 'info');
        const result = await this.runtime.bridgeManager.run(bridge.name, {
          prompt: values.prompt, workspaceId: this.workspaceId, wait: true,
        });
        this.overlay = new TextOverlay({
          title: `${String(bridge.name).toUpperCase()} RESULT`,
          lines: wrap(result.stdout || result.stderr || 'No output', 90),
        });
      },
    });
  }

  async runAutomation(automationId) {
    try {
      await this.runtime.automationScheduler.execute(automationId, { manual: true });
      this.toast('Automation executed', 'success');
    } catch (error) {
      this.toast(error.message, 'error');
    }
    await this.refreshModShop();
  }

  async toggleAutomation(automation) {
    this.runtime.automationScheduler.update(automation.id, { enabled: !automation.enabled });
    this.toast(`${automation.name} ${automation.enabled ? 'paused' : 'armed'}`, 'info');
    await this.refreshModShop();
  }

  confirmDeleteAutomation(automation) {
    this.overlay = new ConfirmOverlay({
      title: 'DELETE AUTOMATION', danger: true,
      message: `Delete "${automation.name}" permanently?`,
      onConfirm: async () => {
        this.runtime.automationScheduler.remove(automation.id);
        this.toast('Automation deleted', 'warn');
        await this.refreshModShop();
      },
    });
  }

  async activatePlugin(name) {
    try { await this.runtime.pluginManager.activate(name); this.toast(`${name} activated`, 'success'); }
    catch (error) { this.toast(error.message, 'error'); }
    this.refreshCatalogs();
    await this.refreshModShop();
  }

  async deactivatePlugin(name) {
    try { await this.runtime.pluginManager.deactivate(name); this.toast(`${name} deactivated`, 'warn'); }
    catch (error) { this.toast(error.message, 'error'); }
    this.refreshCatalogs();
    await this.refreshModShop();
  }

  async reloadPlugin(name) {
    try { await this.runtime.pluginManager.reload(name); this.toast(`${name} reloaded`, 'success'); }
    catch (error) { this.toast(error.message, 'error'); }
    this.refreshCatalogs();
    await this.refreshModShop();
  }

  async closeBrowser(instanceId) {
    try { await this.runtime.browserManager.close(instanceId); this.toast('Browser closed', 'warn'); }
    catch (error) { this.toast(error.message, 'error'); }
    await this.refreshModShop();
  }

  async stopProcess(processId) {
    try { this.runtime.processManager.stop(processId, 'SIGTERM'); this.toast('Signal sent', 'warn'); }
    catch (error) { this.toast(error.message, 'error'); }
    await this.refreshModShop();
  }

  // ---------------------------------------------------------------- terminal

  async runTerminalCommand(command) {
    const value = command.trim();
    if (!value) return;
    this.terminalField.remember(value);
    this.terminalField.clear();
    this.pushTerminal(this.theme.paint(`❯ ${value}`, { fg: this.theme.palette.crimson, bold: true }));
    this.terminalBusy = true;
    this.requestRender();
    try {
      const result = await this.runtime.toolRegistry.execute('shell_exec', {
        command: value, cwd: '.', timeoutMs: this.runtime.config.get().commandTimeoutMs,
      }, this.toolContext());
      for (const line of String(result.stdout || '').split('\n')) if (line) this.pushTerminal(this.theme.paint(line, { fg: this.theme.roles.text }));
      for (const line of String(result.stderr || '').split('\n')) if (line) this.pushTerminal(this.theme.paint(line, { fg: this.theme.roles.danger }));
      this.pushTerminal(this.theme.paint(`exit ${result.code}`, { fg: result.code === 0 ? this.theme.roles.success : this.theme.roles.danger }));
    } catch (error) {
      this.pushTerminal(this.theme.paint(error.message, { fg: this.theme.roles.danger }));
    }
    this.terminalBusy = false;
    this.terminalView.toBottom();
    this.requestRender();
  }

  pushTerminal(line) {
    this.terminalLines.push(line);
    if (this.terminalLines.length > TERMINAL_LIMIT) this.terminalLines.splice(0, this.terminalLines.length - TERMINAL_LIMIT);
  }

  // ---------------------------------------------------------------- arsenal

  async loadSkillBody(name) {
    if (this.skillBodies.has(name)) { this.skillBodies.delete(name); return; }
    try {
      const skill = await this.runtime.skillManager.load(name);
      this.skillBodies.set(name, skill.body || skill.content || '');
      this.detail.toTop();
    } catch (error) {
      this.toast(error.message, 'error');
    }
    this.requestRender();
  }

  openToolRunner(tool) {
    const schema = tool.schema?.properties || {};
    const example = Object.fromEntries(Object.keys(schema).slice(0, 6).map((key) => [key, '']));
    this.overlay = new FormOverlay({
      title: `RUN ${tool.name.toUpperCase()}`, submitLabel: 'EXECUTE',
      note: tool.description,
      fields: [{ name: 'arguments', label: 'arguments json', type: 'textarea', value: JSON.stringify(example, null, 2) }],
      onSubmit: async (values) => {
        const args = safeJsonParse(values.arguments, null);
        if (args === null) throw new Error('Arguments must be valid JSON');
        const result = await this.runtime.toolRegistry.execute(tool.name, args, this.toolContext());
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        this.overlay = new TextOverlay({
          title: `${tool.name.toUpperCase()} RESULT`,
          lines: String(text).split('\n').flatMap((line) => wrap(line, 90)).slice(0, 3000),
        });
      },
    });
  }

  // --------------------------------------------------------------- overlays

  closeOverlay() { this.overlay = null; this.screen.invalidate(); }

  toast(message, tone = 'info') {
    this.toasts.push(message, tone);
    this.requestRender();
  }

  openPalette() {
    this.overlay = new PaletteOverlay(this.actions);
  }

  openHelp() {
    const theme = this.theme;
    const rows = [
      ['GLOBAL', ''],
      ['ctrl+k', 'command palette — every action MaskShift can perform'],
      ['ctrl+p', 'switch heist (session)'],
      ['ctrl+n', 'new heist'],
      ['ctrl+g', 'change persona (model)'],
      ['ctrl+o', 'open a different workspace'],
      ['ctrl+b', 'show or hide the right rail'],
      ['ctrl+r', 'cycle rail: plan → loadout → events → git'],
      ['ctrl+y', 'focus the rail'],
      ['1 … 6 / alt+1 … 6', 'jump to a view'],
      ['f1 or ?', 'this reference'],
      ['f2', 'settings'],
      ['f5', 'refresh everything'],
      ['ctrl+c', 'cancel a run, then quit'],
      ['ctrl+q', 'quit immediately'],
      ['', ''],
      ['01 HEIST', ''],
      ['enter', 'execute the prompt'],
      ['ctrl+j', 'newline inside the composer'],
      ['tab', 'move between transcript and composer'],
      ['t', 'expand or collapse tool output'],
      ['esc', 'retreat from the running heist'],
      ['/command', 'slash commands: /model /new /clear /tools /skills /mcp /help'],
      ['', ''],
      ['02 FILES', ''],
      ['enter', 'open a file or fold a directory'],
      ['a', 'attach the selected file to the composer'],
      ['h', 'toggle hidden files'],
      ['', ''],
      ['03 ARSENAL', ''],
      ['x', 'run a tool directly with JSON arguments'],
      ['enter', 'load a skill body'],
      ['', ''],
      ['04 NETWORK', ''],
      ['enter', 'connect, disconnect or install a server'],
      ['a', 'add a server by hand'],
      ['', ''],
      ['05 MOD SHOP', ''],
      ['n', 'new automation, plugin or browser'],
      ['space', 'arm or pause an automation'],
    ];
    const lines = rows.map(([key, description]) => {
      if (!key && !description) return '';
      if (!description) return theme.paint(key, { fg: theme.palette.crimson, bold: true });
      return theme.paint(fit(key, 20), { fg: theme.palette.gold, bold: true })
        + theme.paint(description, { fg: theme.roles.muted });
    });
    this.overlay = new TextOverlay({ title: 'KEY REFERENCE', lines, stamp: 'esc closes' });
  }

  openSessionPicker() {
    const sessions = this.runtime.store.listSessions({ limit: 200 });
    this.overlay = new PickerOverlay({
      title: 'HEIST ARCHIVE',
      placeholder: 'FILTER HEISTS…',
      items: sessions.map((session) => ({
        id: session.id, label: session.title || 'Untitled',
        detail: `${session.model_id || ''} · ${this.stamp(session.updated_at)}`,
        tone: session.id === this.sessionId ? this.theme.palette.crimson : undefined,
      })),
      onSelect: (item) => this.loadSession(item.id),
    });
  }

  openModelPicker() {
    const items = [];
    for (const provider of this.providers) {
      for (const model of provider.models || []) {
        const reference = `${provider.id}:${model.id || model}`;
        items.push({ id: reference, label: reference, detail: provider.status === 'online' ? provider.name : `${provider.name} (offline)` });
      }
      items.push({ id: `${provider.id}:auto`, label: `${provider.id}:auto`, detail: `${provider.name} — best available` });
    }
    this.overlay = new PickerOverlay({
      title: 'PERSONA SELECT',
      placeholder: 'FILTER MODELS…',
      footer: 'Providers are probed at startup; press f5 to re-discover.',
      items,
      onSelect: (item) => {
        this.modelRef = item.id;
        if (this.sessionId) this.runtime.store.updateSession(this.sessionId, { model_id: item.id });
        this.toast(`Persona set to ${item.id}`, 'success');
      },
    });
  }

  openWorkspaceDialog() {
    this.overlay = new FormOverlay({
      title: 'OPEN WORKSPACE', submitLabel: 'OPEN + INDEX',
      note: 'MaskShift detects Git, imports project instructions and MCP configuration, and builds a local context index.',
      fields: [
        { name: 'path', label: 'path', value: this.workspace?.path || process.cwd() },
        { name: 'index', label: 'index after opening', type: 'toggle', value: true },
      ],
      onSubmit: async (values) => {
        const workspace = await this.runtime.workspaceManager.open(values.path);
        this.setWorkspace(workspace);
        await this.runtime.mcpManager.refreshDefinitions(workspace.path);
        await this.runtime.skillManager.setWorkspace(workspace.path);
        this.runtime.pluginManager.workspacePath = workspace.path;
        await this.runtime.pluginManager.scan({ activate: true });
        this.refreshCatalogs();
        this.newSession({ silent: true });
        await this.loadFileTree({ force: true });
        await this.refreshGit();
        if (values.index) void this.runtime.indexer.index(workspace.id, { force: true }).catch(() => {});
        this.toast(`Target locked: ${workspace.name}`, 'success');
      },
    });
  }

  openSettings() {
    const config = this.runtime.config.get();
    this.overlay = new FormOverlay({
      title: 'SETTINGS', submitLabel: 'CONFIRM',
      note: 'Stored in your MaskShift home configuration and applied immediately.',
      fields: [
        { name: 'defaultModel', label: 'default model', value: config.defaultModel },
        {
          name: 'permissionMode', label: 'permission mode', type: 'select', value: config.permissionMode,
          options: [
            { label: 'OVERDRIVE', value: 'overdrive' }, { label: 'BALANCED', value: 'balanced' }, { label: 'REVIEW', value: 'review' },
          ],
        },
        { name: 'maxAgentSteps', label: 'max agent turns', value: String(config.maxAgentSteps) },
        { name: 'maxParallelSubagents', label: 'max parallel subagents', value: String(config.maxParallelSubagents) },
        { name: 'autoIndex', label: 'auto index repositories', type: 'toggle', value: config.autoIndex },
        { name: 'autoCheckpoint', label: 'auto checkpoint before run', type: 'toggle', value: config.autoCheckpoint },
        { name: 'autoLoadCapabilities', label: 'auto prime capabilities', type: 'toggle', value: config.autoLoadCapabilities },
      ],
      onSubmit: async (values) => {
        await this.runtime.config.update({
          defaultModel: values.defaultModel,
          permissionMode: values.permissionMode,
          maxAgentSteps: Number(values.maxAgentSteps) || config.maxAgentSteps,
          maxParallelSubagents: Number(values.maxParallelSubagents) || config.maxParallelSubagents,
          autoIndex: values.autoIndex,
          autoCheckpoint: values.autoCheckpoint,
          autoLoadCapabilities: values.autoLoadCapabilities,
        });
        this.autoLoad = values.autoLoadCapabilities;
        this.toast('Settings saved', 'success');
      },
    });
  }

  // ----------------------------------------------------------------- actions

  buildActions() {
    const action = (id, group, label, key = '') => ({ id, group, label, key });
    return [
      action('run.new', 'heist', 'New heist', 'ctrl+n'),
      action('run.switch', 'heist', 'Switch heist', 'ctrl+p'),
      action('run.cancel', 'heist', 'Retreat from the running heist', 'esc'),
      action('run.rename', 'heist', 'Rename this heist'),
      action('run.delete', 'heist', 'Delete this heist'),
      action('model.pick', 'persona', 'Change model', 'ctrl+g'),
      action('model.discover', 'persona', 'Re-discover providers and models'),
      action('workspace.open', 'target', 'Open workspace', 'ctrl+o'),
      action('workspace.index', 'target', 'Rebuild the context index'),
      action('workspace.inspect', 'target', 'Inspect the workspace'),
      action('workspace.checkpoint', 'target', 'Create a checkpoint'),
      action('workspace.restore', 'target', 'Restore a checkpoint'),
      action('view.chat', 'view', 'Go to 01 HEIST', '1'),
      action('view.files', 'view', 'Go to 02 FILES', '2'),
      action('view.arsenal', 'view', 'Go to 03 ARSENAL', '3'),
      action('view.network', 'view', 'Go to 04 NETWORK', '4'),
      action('view.modshop', 'view', 'Go to 05 MOD SHOP', '5'),
      action('view.terminal', 'view', 'Go to 06 TERMINAL', '6'),
      action('rail.toggle', 'rail', 'Show or hide the rail', 'ctrl+b'),
      action('rail.plan', 'rail', 'Rail: plan of attack'),
      action('rail.telemetry', 'rail', 'Rail: loadout telemetry'),
      action('rail.events', 'rail', 'Rail: event feed'),
      action('rail.git', 'rail', 'Rail: git pulse'),
      action('mcp.add', 'network', 'Add an MCP server'),
      action('mcp.registry', 'network', 'Search the official MCP registry'),
      action('mcp.connectAll', 'network', 'Connect every configured MCP server'),
      action('mcp.refresh', 'network', 'Refresh MCP servers'),
      action('mod.automation', 'mod shop', 'New automation'),
      action('mod.plugin', 'mod shop', 'Install a plugin'),
      action('mod.browser', 'mod shop', 'Launch a browser'),
      action('mod.refresh', 'mod shop', 'Refresh extensions'),
      action('tools.search', 'arsenal', 'Search tools'),
      action('skills.search', 'arsenal', 'Search skills'),
      action('capabilities.toggleTools', 'arsenal', 'Expand or collapse tool output', 't'),
      action('doctor', 'system', 'Run diagnostics'),
      action('settings', 'system', 'Settings', 'f2'),
      action('logs', 'system', 'Tail the MaskShift log'),
      action('help', 'system', 'Key reference', 'f1'),
      action('refresh', 'system', 'Refresh everything', 'f5'),
      action('quit', 'system', 'Quit MaskShift', 'ctrl+q'),
    ];
  }

  async runAction(id) {
    switch (id) {
      case 'run.new': this.newSession(); break;
      case 'run.switch': this.openSessionPicker(); break;
      case 'run.cancel': this.cancelRun(); break;
      case 'run.rename': this.openRenameDialog(); break;
      case 'run.delete': this.confirmDeleteSession(); break;
      case 'model.pick': this.openModelPicker(); break;
      case 'model.discover': await this.discoverProviders(); this.toast('Providers re-discovered', 'success'); break;
      case 'workspace.open': this.openWorkspaceDialog(); break;
      case 'workspace.index': void this.reindex(); break;
      case 'workspace.inspect': void this.showInspection(); break;
      case 'workspace.checkpoint': void this.createCheckpoint(); break;
      case 'workspace.restore': this.openCheckpointPicker(); break;
      case 'view.chat': this.switchView(0); break;
      case 'view.files': this.switchView(1); break;
      case 'view.arsenal': this.switchView(2); break;
      case 'view.network': this.switchView(3); break;
      case 'view.modshop': this.switchView(4); break;
      case 'view.terminal': this.switchView(5); break;
      case 'rail.toggle': this.railVisible = !this.railVisible; this.screen.invalidate(); break;
      case 'rail.plan': this.railTab = 'plan'; this.railVisible = true; break;
      case 'rail.telemetry': this.railTab = 'telemetry'; this.railVisible = true; break;
      case 'rail.events': this.railTab = 'events'; this.railVisible = true; break;
      case 'rail.git': this.railTab = 'git'; this.railVisible = true; void this.refreshGit(); break;
      case 'mcp.add': this.switchView(3); this.openMcpDialog(); break;
      case 'mcp.registry': this.switchView(3); this.mcpTab = 'registry'; this.focus = 'mcp-filter'; break;
      case 'mcp.connectAll': await this.connectAllMcp(); break;
      case 'mcp.refresh': await this.refreshMcp(); this.toast('MCP refreshed', 'success'); break;
      case 'mod.automation': this.switchView(4); this.modTab = 'automations'; this.openAutomationDialog(); break;
      case 'mod.plugin': this.switchView(4); this.modTab = 'plugins'; this.openPluginDialog(); break;
      case 'mod.browser': this.switchView(4); this.modTab = 'browser'; this.openBrowserDialog(); break;
      case 'mod.refresh': await this.refreshModShop({ force: true }); this.toast('Mod shop refreshed', 'success'); break;
      case 'tools.search': this.switchView(2); this.arsenalTab = 'tools'; this.focus = 'arsenal-filter'; break;
      case 'skills.search': this.switchView(2); this.arsenalTab = 'skills'; this.focus = 'arsenal-filter'; break;
      case 'capabilities.toggleTools': this.expandTools = !this.expandTools; break;
      case 'doctor': await this.showDoctor(); break;
      case 'settings': this.openSettings(); break;
      case 'logs': await this.showLogs(); break;
      case 'help': this.openHelp(); break;
      case 'refresh': this.refreshAll(); break;
      case 'quit': this.stop(0); break;
      default: this.toast(`Unknown action: ${id}`, 'warn');
    }
    this.requestRender();
  }

  refreshAll() {
    this.refreshCatalogs();
    void this.discoverProviders();
    void this.loadFileTree({ force: true });
    void this.refreshGit();
    void this.refreshModShop({ force: true });
    this.screen.invalidate();
    this.toast('Everything refreshed', 'success');
  }

  openRenameDialog() {
    this.overlay = new FormOverlay({
      title: 'RENAME HEIST', submitLabel: 'RENAME',
      fields: [{ name: 'title', label: 'title', value: this.sessionTitle }],
      onSubmit: (values) => {
        if (!this.sessionId) throw new Error('No active heist');
        this.runtime.store.updateSession(this.sessionId, { title: values.title });
        this.sessionTitle = values.title;
        this.toast('Renamed', 'success');
      },
    });
  }

  confirmDeleteSession() {
    if (!this.sessionId) return;
    this.overlay = new ConfirmOverlay({
      title: 'DELETE HEIST', danger: true,
      message: `Delete "${this.sessionTitle}" and every message in it?`,
      onConfirm: () => {
        this.runtime.store.deleteSession(this.sessionId);
        this.toast('Heist deleted', 'warn');
        this.openLatestSession();
      },
    });
  }

  async reindex() {
    if (!this.workspaceId) return;
    this.toast('Indexing the target…', 'info');
    try {
      const stats = await this.runtime.indexer.index(this.workspaceId, { force: true });
      this.toast(`Indexed ${stats.files ?? stats.chunks ?? 0} entries`, 'success');
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  async showInspection() {
    if (!this.workspaceId) return;
    try {
      const report = await this.runtime.workspaceManager.inspect(this.workspaceId);
      const theme = this.theme;
      const lines = [
        theme.paint(report.workspace.path, { fg: theme.palette.gold, bold: true }),
        '',
        theme.paint(`Files: ${report.files.count}${report.files.truncated ? '+' : ''}`, { fg: theme.roles.text }),
        theme.paint(`Git: ${report.git ? report.git.root : 'not a repository'}`, { fg: theme.roles.text }),
        theme.paint(`Project files: ${report.projectFiles.join(', ') || 'none'}`, { fg: theme.roles.text }),
        theme.paint(`Context files: ${report.contextFiles.map((file) => file.path).join(', ') || 'none'}`, { fg: theme.roles.text }),
        '',
        theme.paint('LANGUAGES', { fg: theme.palette.crimson, bold: true }),
        ...report.languages.map(([extension, count]) => theme.paint(`  ${fit(extension, 12)}${count}`, { fg: theme.roles.muted })),
        '',
        theme.paint('GIT STATUS', { fg: theme.palette.crimson, bold: true }),
        ...String(report.git?.status || '').split('\n').map((line) => theme.paint(`  ${line}`, { fg: theme.roles.muted })),
      ];
      this.overlay = new TextOverlay({ title: 'TARGET INTEL', lines });
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  async createCheckpoint() {
    if (!this.workspaceId) return;
    try {
      const checkpoint = await this.runtime.workspaceManager.createCheckpoint(this.workspaceId, { label: 'manual' });
      this.toast(`Checkpoint ${checkpoint.kind} saved`, 'success');
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  openCheckpointPicker() {
    if (!this.workspaceId) return;
    const checkpoints = this.runtime.store.listCheckpoints(this.workspaceId, 100);
    if (!checkpoints.length) { this.toast('No checkpoints recorded', 'warn'); return; }
    this.overlay = new PickerOverlay({
      title: 'RESTORE CHECKPOINT',
      placeholder: 'FILTER CHECKPOINTS…',
      items: checkpoints.map((checkpoint) => ({
        id: checkpoint.id, label: `${checkpoint.kind} ${checkpoint.ref || ''}`.trim(),
        detail: `${this.stamp(checkpoint.created_at)} · ${checkpoint.manifest?.label || ''}`,
      })),
      onSelect: (item) => {
        const checkpoint = checkpoints.find((entry) => entry.id === item.id);
        this.overlay = new ConfirmOverlay({
          title: 'RESTORE', danger: true,
          message: `Restore the workspace to checkpoint ${checkpoint.ref || checkpoint.id}? Uncommitted changes will be replaced.`,
          onConfirm: async () => {
            await this.runtime.workspaceManager.restoreCheckpoint(this.workspaceId, checkpoint);
            this.toast('Checkpoint restored', 'success');
            await this.loadFileTree({ force: true });
            await this.refreshGit();
          },
        });
      },
    });
  }

  async connectAllMcp() {
    const targets = this.mcpServers.filter((server) => server.status === 'available');
    if (!targets.length) { this.toast('Nothing left to connect', 'info'); return; }
    this.toast(`Linking ${targets.length} servers…`, 'info');
    await Promise.allSettled(targets.map((server) => this.connectMcp(server.name)));
  }

  async showDoctor() {
    const theme = this.theme;
    this.toast('Running diagnostics…', 'info');
    const providers = await this.runtime.providerManager.discoverAll({ force: true });
    this.providers = providers;
    const config = this.runtime.config.get();
    const lines = [
      theme.paint(`MaskShift ${this.version}  ·  node ${process.version}  ·  ${process.platform}/${process.arch}`, { fg: theme.palette.gold, bold: true }),
      '',
      theme.paint(`Home       ${config.home}`, { fg: theme.roles.text }),
      theme.paint(`Database   ${config.dataFile}`, { fg: theme.roles.text }),
      theme.paint(`Mode       ${config.permissionMode}`, { fg: theme.roles.text }),
      theme.paint(`Tools ${this.counts.tools}  Skills ${this.counts.skills}  MCP ${this.counts.mcp}`, { fg: theme.roles.text }),
      '',
      theme.paint('PROVIDERS', { fg: theme.palette.crimson, bold: true }),
      ...providers.map((provider) => theme.paint(
        `  ${provider.status === 'online' ? '✓' : '·'} ${fit(provider.id, 14)}${provider.status}${provider.error ? ` — ${provider.error}` : ''}`,
        { fg: provider.status === 'online' ? theme.roles.success : theme.roles.muted },
      )),
    ];
    this.overlay = new TextOverlay({ title: 'DOCTOR', lines });
  }

  async showLogs() {
    try {
      const entries = await this.runtime.logger.tail(300);
      const theme = this.theme;
      const lines = entries.map((entry) => {
        const text = typeof entry === 'string' ? entry : `${entry.timestamp || ''} ${entry.level || ''} ${entry.message || ''}`;
        const tone = /error/i.test(text) ? theme.roles.danger : /warn/i.test(text) ? theme.roles.warning : theme.roles.muted;
        return theme.paint(truncate(text, 110), { fg: tone });
      });
      this.overlay = new TextOverlay({ title: 'LOG TAIL', lines: lines.length ? lines : ['No entries yet.'] });
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  // ----------------------------------------------------------- slash commands

  async runSlash(input) {
    const [command, ...rest] = input.slice(1).split(/\s+/);
    const argument = rest.join(' ');
    switch (command) {
      case 'new': this.newSession(); break;
      case 'clear': this.messages = []; this.transcript.toBottom(); break;
      case 'model':
        if (argument) { this.modelRef = argument; this.toast(`Persona set to ${argument}`, 'success'); }
        else this.openModelPicker();
        break;
      case 'sessions': this.openSessionPicker(); break;
      case 'workspace': this.openWorkspaceDialog(); break;
      case 'tools': this.switchView(2); this.arsenalTab = 'tools'; if (argument) this.arsenalFilter.set(argument); break;
      case 'skills': this.switchView(2); this.arsenalTab = 'skills'; if (argument) this.arsenalFilter.set(argument); break;
      case 'mcp': this.switchView(3); if (argument) this.mcpFilter.set(argument); break;
      case 'mods': this.switchView(4); break;
      case 'files': this.switchView(1); break;
      case 'terminal': this.switchView(5); break;
      case 'doctor': await this.showDoctor(); break;
      case 'logs': await this.showLogs(); break;
      case 'settings': this.openSettings(); break;
      case 'help': this.openHelp(); break;
      case 'quit': case 'exit': this.stop(0); break;
      default: this.toast(`Unknown command: /${command}`, 'warn');
    }
  }
}

function compact(value) {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export async function startTui(runtime, options = {}) {
  const app = new MaskShiftTui(runtime, options);
  return app.start();
}
