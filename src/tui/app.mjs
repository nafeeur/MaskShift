// The MaskShift TUI application shell.
//
// Owns global state, wires the runtime event bus into the views, routes the
// keyboard, and paints one frame at a time through the double-buffered screen.

import path from 'node:path';
import { headerBand, hintRail, statusRail, tabStrip } from './chrome.mjs';
import { frameColour, glyphs, panel } from './box.mjs';
import { isImagePath } from './image/render.mjs';
import { detectImageProtocol } from './image/protocol.mjs';
import { Keyboard } from './input.mjs';
import { hstack, overlay as paintOverlay, split, vstack } from './layout.mjs';
import { createInteractionHandler } from './interaction.mjs';
import { InlinePrompt } from './prompt.mjs';
import { ApprovalOverlay, ChangesOverlay, SAFE_RISKS, ConfirmOverlay, FormOverlay, PaletteOverlay, PickerOverlay, TextOverlay } from './overlays.mjs';
import { approvalPreview } from './approval.mjs';
import { commandDirectories, expandCommand, loadCustomCommands } from './commands.mjs';
import * as rail from './rail.mjs';
import { RAIL_TABS } from './rail.mjs';
import { LAYER, Regions } from './regions.mjs';
import { renderMarkdown } from './markdown.mjs';
import { Screen } from './screen.mjs';
import { Theme } from './theme.mjs';
import { fit, oneLine, truncate, visibleWidth, wrap } from './text.mjs';
import { Composer, ListView, Spinner, TextField, Toasts, Viewport } from './widgets.mjs';
import { columns, gutter, key as typeKey, label as sectionLabel } from './type.mjs';
import { VERSION, runCommand, safeJsonParse, shellQuote } from '../core/utils.mjs';
import { tokenCounts } from '../core/pricing.mjs';
import { formatBytes } from '../storage/budget.mjs';
import { notify } from '../notify/index.mjs';
import { VoiceInput } from '../voice/index.mjs';
import * as chatView from './views/chat.mjs';
import * as filesView from './views/files.mjs';
import * as capabilitiesView from './views/capabilities.mjs';
import * as runtimeView from './views/runtime.mjs';
import * as browserView from './views/browser.mjs';
import * as gitView from './views/git.mjs';
import * as fleetView from './views/fleet.mjs';
import {
  expandGitChanges, parseGitBranches, parseGitLog, parseGitStash, parseGitStatus, parseGitWorktrees,
} from './views/git.mjs';

const VIEWS = [chatView, filesView, capabilitiesView, runtimeView, browserView, gitView, fleetView];
// One-line rail titles for every non-chat view's own `rail()` export (see
// paint() below) — the chat view's rail carries its own titles per tab.
const PANE_RAIL_TITLES = {
  files: 'Code graph', capabilities: 'Usage', runtime: 'Job history', browser: 'Console and network', git: 'History', fleet: 'Team chatter',
};
const EVENT_LIMIT = 400;
const TERMINAL_LIMIT = 2000;
// How often the 05 BROWSER view re-captures the page it's watching. CDP
// screenshot capture plus a terminal repaint isn't free, so this trades
// off against real interactivity rather than chasing smooth video — a
// snapshot every few hundred ms is enough to tell "did my click land".
const BROWSER_POLL_MS = 400;
const MIN_COLUMNS = 40;

// How a finished run is announced — in plain words rather than as a bare
// status word, since this is the one moment the user is guaranteed to
// look up from whatever else they switched to while it ran.
const RUN_OUTCOME = {
  'run.completed': { tone: 'success', label: 'Completed' },
  'run.cancelled': { tone: 'warn', label: 'Cancelled' },
  'run.failed': { tone: 'error', label: 'Failed' },
  'run.max-steps': { tone: 'warn', label: 'Step limit reached' },
};
const MIN_ROWS = 12;

// Mirrors the cases in runSlash() below — kept in sync by hand since the
// switch statement there is the actual source of truth for what runs.
const SLASH_COMMANDS = [
  { name: 'new', hint: 'start a fresh session' },
  { name: 'clear', hint: 'clear the transcript' },
  { name: 'model', hint: 'switch model' },
  { name: 'sessions', hint: 'browse sessions' },
  { name: 'search', hint: 'grep every session for a phrase' },
  { name: 'context', hint: 'what went into the last request, and why' },
  { name: 'compact', hint: 'summarize older turns now' },
  { name: 'summary', hint: 'read the session summary' },
  { name: 'cost', hint: 'spend per run in this session' },
  { name: 'changes', hint: 'review what the last run changed' },
  { name: 'undo', hint: 'undo the last run\'s file changes' },
  { name: 'steer', hint: 'send a message to the running task now' },
  { name: 'workspace', hint: 'switch workspace' },
  { name: 'tools', hint: 'browse tools' },
  { name: 'skills', hint: 'browse skills' },
  { name: 'mcp', hint: 'manage MCP servers' },
  { name: 'runtime', hint: 'open runtime: automations, processes, browser instances' },
  { name: 'files', hint: 'browse files' },
  { name: 'terminal', hint: 'open terminal' },
  { name: 'browser', hint: 'watch and control a browser tab' },
  { name: 'git', hint: 'open the git view' },
  { name: 'fleet', hint: 'run Claude Code, Codex, Hermes, OpenCode… as one team' },
  { name: 'doctor', hint: 'run diagnostics' },
  { name: 'logs', hint: 'view logs' },
  { name: 'storage', hint: 'disk use, budget and cleanup' },
  { name: 'learned', hint: 'what MaskShift has learned from your runs' },
  { name: 'settings', hint: 'open settings' },
  { name: 'help', hint: 'reference & shortcuts' },
  { name: 'quit', hint: 'exit MaskShift' },
];

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
      // NO_COLOR (https://no-color.org) is the user's standing request; a colour depth saved
      // in the preferences must not quietly override it.
      ...(preferences.colorDepth === null || preferences.colorDepth === undefined || noColorRequested() ? {} : { depth: Number(preferences.colorDepth) }),
      ...(preferences.unicode === null || preferences.unicode === undefined ? {} : { unicode: Boolean(preferences.unicode) }),
    });
    // A headless render is a still: every clock-driven part of the interface
    // freezes together so a captured frame is reproducible byte for byte.
    if (headless) this.theme.motion.frozen = true;
    this.screen = new Screen({ theme: this.theme, output, mouse: resolveMouseMode(preferences) });
    this.keyboard = new Keyboard({ input });
    this.spinner = new Spinner('dots');
    this.toasts = new Toasts();
    // Rebuilt every frame; see regions.mjs.
    this.regions = new Regions();
    this.dragging = null;
    // Assumed focused until a terminal that actually supports DEC 1004 says
    // otherwise — so on one that doesn't, this just never gates anything.
    this.terminalFocused = true;

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
    // The assistant's text-so-far for the turn in progress, cumulative — not yet a persisted
    // message, so it's rendered inline (see chat.mjs) but replaced wholesale, never appended to,
    // by the real message the moment the turn actually finishes and `this.messages` reloads.
    this.streamingText = null;
    this.tokenHistory = [];
    this.totals = { input: 0, output: 0, cost: 0 };
    // The running model's limits (see ProviderManager.modelProfile) and how much of its window
    // the last request filled, for the CTX meter in the status rail.
    this.modelProfile = null;
    this.contextUsed = 0;
    // The session's saved compaction summary (engine.mjs keeps it in session.meta.compaction):
    // where it ends is marked in the transcript, and `s` opens it.
    this.compaction = null;
    this.costBudgetWarned = false;
    this.startedAt = null;
    this.endedAt = null;
    this.step = 0;
    this.events = [];
    this.gitBranch = '';
    this.gitStatus = '';

    // 06 GIT.
    this.gitTab = 'changes';
    // 07 FLEET — members, their mail, relays and the harnesses available (see views/fleet.mjs).
    this.fleet = fleetView.createState();
    this.fleetTab = 'members';
    this.fleetFilter = new TextField({ placeholder: 'Filter' });
    this.fleetList = new ListView();
    this.gitFilter = new TextField({ placeholder: 'Filter' });
    this.gitList = new ListView();
    this.gitChanges = [];
    this.gitLogEntries = [];
    this.gitBranches = [];
    this.gitStashes = [];
    this.gitWorktrees = [];
    this.gitUpstream = '';
    this.gitAhead = 0;
    this.gitBehind = 0;
    // Async diff/show output for the selected row, keyed by a stable id (see
    // loadGitDetail) — the same toggle-load-into-a-Map shape loadSkillBody
    // already uses, since a diff can't be produced synchronously inside a
    // view's render().
    this.gitDetailCache = new Map();
    // Recent commit history per file path — the rail's history for whichever
    // changed file is selected (see git.mjs's rail()); same cache-on-select
    // shape as gitDetailCache above.
    this.gitFileHistoryCache = new Map();
    this.gitBusy = false;

    // Model and provider state.
    this.providers = [];
    this.modelRef = model || runtime.config.get().defaultModel;
    this.counts = { tools: 0, skills: 0, mcp: 0 };

    // Composer and transcript.
    this.composer = new Composer();
    this.voice = new VoiceInput(runtime.config.get().voice);
    this.voiceRecording = false;
    this.transcript = new Viewport();
    this.detail = new Viewport();
    this.railView = new Viewport();
    this.expandTools = Boolean(preferences.expandToolOutput);
    // Per-call, click-driven expansion for a long tool result (see chat.mjs's
    // toolLines) — how many of its wrapped detail lines are currently shown,
    // keyed by tool-call id. Absent/0 means still collapsed to one line.
    // Separate from expandTools above, which is the `t` keyboard shortcut
    // for expanding every call at once.
    this.toolExpansion = new Map();
    this.toolExpansionVersion = 0;
    this.autoLoad = runtime.config.get().autoLoadCapabilities !== false;

    // 03 CAPABILITIES — tools, skills, MCP and plugins: one catalogue,
    // four tabs, all sharing a single filter/list the way each used to have
    // its own (the tools, MCP and plugins views before they were merged into capabilities.mjs).
    this.tools = [];
    this.skills = [];
    this.skillBodies = new Map();
    this.capabilitiesTab = 'tools';
    this.capabilitiesFilter = new TextField({ placeholder: 'Search every capability' });
    this.capabilitiesList = new ListView();

    this.mcpServers = [];
    this.mcpTools = new Map();
    this.mcpMode = 'installed'; // installed | registry — only meaningful while capabilitiesTab === 'mcp'
    this.registryResults = [];

    this.plugins = [];

    // 04 RUNTIME — the host shell (default) plus automations, processes and
    // browser instances behind a secondary tab strip.
    this.automations = [];
    this.browsers = [];
    this.processes = [];
    this.runtimeTab = 'shell';
    this.runtimeFilter = new TextField({ placeholder: 'Filter' });
    this.runtimeList = new ListView();
    // Exit code / duration for each command run from the shell tab, newest
    // last — the runtime rail's job history (see runtime.mjs's rail()).
    this.terminalHistory = [];

    // 05 BROWSER — a live, clickable view of one running tab (see
    // views/browser.mjs). Nothing here is populated until openBrowserView()
    // picks a target; polling only ever runs while that view is active.
    this.browserTarget = null; // { instanceId, tabId } | null
    this.browserFrame = null; // { buffer, cssWidth, cssHeight, cols, rows, title, url, error }
    this.browserFrameId = 0;
    // The view's own cell budget as of its last paint (see browser.mjs's
    // render()) — the next poll uses it to cap how large a screenshot it
    // asks Chrome for. Falls back to a reasonable guess before the view has
    // painted even once.
    this.browserRenderBudget = { cols: 100, rows: 32 };
    this.browserTyping = false;
    this.browserPollTimer = null;
    this.browserPollBusy = false;
    this.browserPollTick = 0;
    // Recent CDP console/network events for the current target, refreshed on
    // the same poll as the frame itself (see pollBrowserFrame) — the rail's
    // console/network tail (see browser.mjs's rail()).
    this.browserConsoleLog = [];
    this.browserNetworkLog = [];

    // Files.
    this.fileEntries = [];
    this.fileList = new ListView();
    this.fileFilter = new TextField({ placeholder: 'Filter paths' });
    this.collapsedDirs = new Set();
    this.showHidden = false;
    this.previewPath = '';
    this.previewLines = [];
    this.previewError = '';
    this.previewIsImage = false;
    this.preview = new Viewport();

    // Terminal.
    this.terminalLines = [];
    this.terminalField = new TextField({ placeholder: 'Run any command with your full account permissions…' });
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
    // Set true for one frame by whichever empty-state renders the mask glyph,
    // so tick() knows to keep the breathing animation moving — reset before
    // every paint so a view that never touches it correctly reads false.
    this.promptQueue = [];
    // Messages sent to the running task with ctrl+t, not yet delivered (see engine.steer).
    this.steering = [];
    // Slash commands from .maskshift/commands/*.md and friends (see commands.mjs).
    this.customCommands = [];
    // What the last finished run changed on disk (see refreshLastRunChanges), for the
    // "N files changed" line under the transcript and the ^D review pane.
    this.lastRunChanges = null;
    this.operationLocks = new Set();
    this.fileTreeGeneration = 0;
    this.previewGeneration = 0;
    this.registryGeneration = 0;
    this.processHandlers = null;
    // Serializes confirmation dialogs: a run can fire several gated tool calls
    // back to back (or two concurrent subagents can each want one), but only
    // one ConfirmOverlay can be on screen at a time.
    this.confirmationQueue = Promise.resolve();
    // Tools the user chose "always" for; cleared when the chat changes (see loadSession).
    this.approvedTools = new Set();
    this.runtime.toolRegistry.confirmHandler = (details) => this.requestToolConfirmation(details);
    // Questions from tools (pick a restaurant, enter a password, solve a CAPTCHA) land here.
    // { message, finish } while the agent is waiting for the person to act in the Browser view.
    this.handoff = null;
    // The question currently shown above the composer (see prompt.mjs), if any.
    this.prompt = null;
    this.detachInteraction = this.runtime.interaction?.attach(createInteractionHandler(this)) || null;
  }

  // Returns a Promise<boolean> resolved once the user answers the approval
  // dialog this opens — true for YES or ALWAYS, false for NO/escape. ALWAYS also
  // approves every later call to the same tool until the chat changes. See
  // ToolRegistry#authorize (src/tools/registry.mjs), wired via confirmHandler above.
  requestToolConfirmation({ name, tool, args }) {
    if (this.approvedTools.has(name)) return Promise.resolve(true);
    const run = () => new Promise((resolve) => {
      // Approved while this request was waiting its turn behind another prompt.
      if (this.approvedTools.has(name)) { resolve(true); return; }
      const width = Math.min(this.screen.size.columns - 6, 88) - 4;
      const mode = this.runtime.config.get().permissionMode;
      this.showPrompt(new InlinePrompt({
        kind: 'approval',
        title: `Approve ${name}`,
        question: `${tool?.title || name} wants to run${tool?.risk ? ` (${tool.risk} risk)` : ''} under ${mode} mode.`,
        preview: approvalPreview(this.theme, name, args || {}, width),
        danger: !SAFE_RISKS.has(tool?.risk || 'normal'),
        options: [
          { id: 'yes', label: 'Yes, run it' },
          { id: 'always', label: 'Yes, and don\'t ask again for this tool in this chat' },
          { id: 'no', label: 'No' },
        ],
        onAnswer: (answer) => {
          const choice = answer?.choice || 'no';
          if (choice === 'always') {
            this.approvedTools.add(name);
            this.toast(`${name} approved for the rest of this chat`, 'info');
          }
          resolve(choice !== 'no');
        },
      }));
    });
    this.confirmationQueue = this.confirmationQueue.then(run, run);
    return this.confirmationQueue;
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    if (this.headless) throw new Error('Headless MaskShift TUI instances cannot take over the terminal');
    this.running = true;
    const exit = new Promise((resolve) => { this.resolveExit = resolve; });
    this.installProcessHandlers();
    try {
      this.unsubscribe = this.runtime.eventBus.subscribe((event) => this.onEvent(event));
      this.screen.onResize = () => this.requestRender();
      this.screen.enter();
      this.screen.setTitle('MaskShift');
      this.keyboard.on('key', (event) => this.onKey(event));
      this.keyboard.on('mouse', (event) => this.onMouse(event));
      this.keyboard.start();
      this.ticker = setInterval(() => this.tick(), 120);

      await this.bootstrap();
      if (!this.running) return this.exitCode;
      if (this.initialPrompt) {
        this.composer.set(this.initialPrompt);
        await this.submitPrompt();
      }
      this.requestRender();
      await exit;
      return this.exitCode;
    } finally {
      this.cleanupTerminal();
    }
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
    void this.refreshModelProfile();
    void this.loadFileTree();
    void this.refreshGit();
    void this.refreshCapabilitiesExtras({ force: false });
    void this.refreshRuntimeExtras({ force: false });
    this.openLatestSession();
  }

  stop(code = 0) {
    if (!this.running) { this.cleanupTerminal(); return; }
    this.running = false;
    this.exitCode = code;
    clearInterval(this.ticker);
    this.unsubscribe?.();
    this.cleanupTerminal();
    this.resolveExit?.(code);
  }

  cleanupTerminal() {
    clearInterval(this.ticker);
    this.stopBrowserPolling();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.screen.onResize = null;
    this.keyboard.stop();
    this.screen.leave();
    this.removeProcessHandlers();
  }

  installProcessHandlers() {
    if (this.processHandlers) return;
    const stopFor = (code) => () => this.stop(code);
    const fatal = (error) => {
      this.screen.leave();
      process.stderr.write(`MaskShift fatal TUI error: ${error?.stack || error}\n`);
      this.stop(1);
    };
    const resume = () => {
      if (!this.running) return;
      this.screen.enter();
      this.screen.setTitle('MaskShift');
      this.keyboard.start();
      this.screen.invalidate();
      this.requestRender();
    };
    const suspend = () => {
      if (process.platform === 'win32') return;
      this.keyboard.stop();
      this.screen.leave();
      process.off('SIGTSTP', suspend);
      process.once('SIGCONT', () => {
        process.on('SIGTSTP', suspend);
        resume();
        this.screen.resync();
      });
      process.kill(process.pid, 'SIGTSTP');
    };
    this.processHandlers = {
      SIGINT: stopFor(130), SIGTERM: stopFor(143), SIGHUP: stopFor(129),
      SIGTSTP: suspend, uncaughtException: fatal, unhandledRejection: fatal,
    };
    for (const [name, handler] of Object.entries(this.processHandlers)) {
      if (process.platform === 'win32' && ['SIGHUP', 'SIGTSTP'].includes(name)) continue;
      process.on(name, handler);
    }
  }

  removeProcessHandlers() {
    if (!this.processHandlers) return;
    for (const [name, handler] of Object.entries(this.processHandlers)) process.off(name, handler);
    this.processHandlers = null;
  }

  tick() {
    if (!this.running) return;
    const dirty = this.toasts.prune();
    // Anything clock-driven has to keep the loop awake for as long as it is
    // moving, or a toast would sit at half-opacity until the next keystroke.
    if (this.busy || dirty || this.terminalBusy || this.toasts.animating || this.overlay?.pending
      || this.overlay?.animating) this.requestRender();
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
    const elapsed = this.startedAt ? Math.max(0, (this.endedAt || Date.now()) - this.startedAt) : 0;
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

  /** How full the running model's context window was on its last request. */
  get contextState() {
    const profile = this.modelProfile;
    if (!profile?.contextWindow) return null;
    const ratio = Math.max(0, Math.min(1, this.contextUsed / profile.contextWindow));
    return {
      used: this.contextUsed, window: profile.contextWindow, ratio,
      label: `${this.contextUsed ? compact(this.contextUsed) : '—'}/${compact(profile.contextWindow)}`,
      tone: ratio >= 0.85 ? 'danger' : ratio >= 0.6 ? 'warning' : 'success',
      tier: profile.tier, source: profile.source, maxOutputTokens: profile.maxOutputTokens,
    };
  }

  async refreshModelProfile() {
    const ref = this.modelRef;
    const profile = await this.runtime.providerManager.modelProfile(ref).catch(() => null);
    // A slower lookup for a model the user has since switched away from must not win.
    if (ref !== this.modelRef) return;
    this.modelProfile = profile;
    this.requestRender();
  }

  get liveTrail() {
    if (!this.busy && this.pendingCalls.size === 0 && this.promptQueue.length === 0 && this.steering.length === 0 && !this.lastRunChanges) return [];
    const entries = [];
    for (const call of this.pendingCalls.values()) {
      // A call in flight is laid out on the same columns as the completed call
      // it will become, so a row does not jump sideways when it finishes.
      entries.push({
        render: (theme, width) => [fit(
          gutter(theme, this.spinner.frame(theme), { tone: theme.roles.accent })
          + columns(theme, [
            { text: call.name, width: 18, tone: theme.roles.tool, bold: true },
            { text: oneLine(JSON.stringify(call.args ?? {})), tone: theme.roles.muted },
          ], Math.max(8, width - 2)),
          width,
        )],
      });
    }
    // Once real text is streaming in, the growing message itself (rendered in the transcript,
    // see chat.mjs) is the "still working" signal — a spinner underneath it would be redundant.
    if (this.busy && this.pendingCalls.size === 0 && !this.streamingText) {
      entries.push({
        render: (theme, width) => [fit(
          gutter(theme, this.spinner.frame(theme), { tone: theme.roles.primary })
          + theme.paint(this.thinkingLabel || 'Thinking…', { fg: theme.roles.muted, italic: true }),
          width,
        )],
      });
    }
    if (!this.busy && this.lastRunChanges?.files.length) {
      const files = this.lastRunChanges.files;
      entries.push({
        render: (theme, width) => {
          const names = files.slice(0, 3).map((file) => file.path.split('/').pop()).join(', ') + (files.length > 3 ? ` +${files.length - 3}` : '');
          const keys = `  ${typeKey(theme, '^D')}${theme.paint(' review', { fg: theme.roles.muted })}  ${typeKey(theme, '^Z')}${theme.paint(' undo', { fg: theme.roles.muted })}`;
          const lead = theme.paint(`${files.length} file${files.length === 1 ? '' : 's'} changed by this run  `, { fg: theme.roles.label, bold: true });
          return [fit(gutter(theme, glyphs(theme).diamond, { tone: theme.roles.info })
            + lead + theme.paint(oneLine(names, Math.max(8, width - visibleWidth(lead) - 22)), { fg: theme.roles.dim }) + keys, width)];
        },
      });
    }
    for (const text of this.steering) {
      entries.push({
        render: (theme, width) => [fit(
          gutter(theme, glyphs(theme).arrowRight, { tone: theme.roles.user })
          + theme.paint(`Sent  ${oneLine(text, Math.max(8, width - 12))}`, { fg: theme.roles.muted }),
          width,
        )],
      });
    }
    for (const [index, queued] of this.promptQueue.entries()) {
      entries.push({
        render: (theme, width) => [fit(
          gutter(theme, String(index + 1), { tone: theme.roles.warning })
          + theme.paint(`Queued  ${oneLine(queued.prompt, Math.max(8, width - 10))}`, { fg: theme.roles.muted }),
          width,
        )],
      });
    }
    return entries;
  }

  composerPlaceholder() {
    return this.busy
      ? `Task running — ^T sends a message now, ↵ queues the next request${this.promptQueue.length ? ` (${this.promptQueue.length} queued)` : ''}…`
      : 'Ask anything, or describe a task…';
  }

  currentHints() {
    if (this.overlay) return [['↵', 'accept'], ['esc', 'dismiss'], ['↑↓', 'move']];
    if (this.focus === 'rail') return [['tab', 'sidebar section'], ['↑↓', 'scroll'], ['^B', 'hide sidebar']];
    const module = this.modules.get(this.view);
    return module?.hints ? module.hints(this) : [];
  }

  // Seconds are noise in a transcript: they change every row and none of them
  // is ever the thing being read.
  stamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
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
    if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
      this.regions.clear();
      // The current size is the one fact worth protecting here — on a
      // terminal too small even for this message, a plain truncation from
      // the right would cut exactly that off the end.
      const need = `${MIN_COLUMNS}×${MIN_ROWS}`;
      const now = `${columns}×${rows}`;
      const candidates = [
        ` Resize to at least ${need} (now ${now})`,
        ` Resize to ${need} (now ${now})`,
        ` ${now} → ${need}`,
        now,
      ];
      const message = candidates.find((candidate) => visibleWidth(candidate) <= columns) ?? truncate(now, columns, '');
      const frame = new Array(rows).fill('').map((line, index) => {
        if (index === Math.floor(rows / 2)) return fit(message, columns);
        return fit(line, columns);
      });
      this.screen.render(frame, null);
      this.lastFrame = frame;
      return frame;
    }
    // A one-column, one-row margin around the active view — the outer frame
    // used to touch the tab strip above it and the terminal's own left/right
    // edges directly, with the panel's content starting flush against its
    // own border on every side. Small on purpose: a whole blank row/column
    // reads as generous already at typical terminal cell sizes: any more
    // would just be giving up rows a small terminal window can't spare.
    const marginX = columns >= MIN_COLUMNS + 4 ? 1 : 0;
    const marginY = rows >= MIN_ROWS + 2 ? 1 : 0;
    const usableWidth = columns - marginX * 2;
    const bodyHeight = Math.max(4, rows - 4 - marginY * 2);
    this.bodyRegion = { row: 2 + marginY, column: marginX, width: usableWidth, height: bodyHeight };
    // Click targets describe the frame being drawn, so they are rebuilt with it.
    this.regions.clear();

    const showRail = this.railVisible && usableWidth >= 108;
    const [mainWidth, railWidth] = showRail
      ? split(usableWidth, [{ weight: 3, min: 60 }, { weight: 1, min: 30, max: 46 }])
      : [usableWidth, 0];

    const module = this.modules.get(this.view);
    const region = { row: 2 + marginY, column: marginX, width: mainWidth, height: bodyHeight };
    this.bodyRegion = region;
    const rendered = module.render(this, region);
    let body = rendered.lines;
    this.lastRegion = region;
    // A modal draws its own curtain over the body in text, which a terminal
    // graphics placement doesn't necessarily respect — safer to not (re)send
    // one while anything is drawn on top, and to force a fresh send once it
    // closes rather than trust a placement the curtain may have disturbed.
    // A classic placement floats above the text, so it is withdrawn while a modal is drawn over
    // it (the screen deletes it when the overlay disappears). A placeholder image is text and the
    // modal simply covers part of it, so those stay.
    const wanted = [rendered.imageOverlay].flat().filter(Boolean);
    const imageOverlay = this.overlay ? wanted.filter((item) => item.protocol === 'kitty-unicode') : wanted;

    if (showRail) {
      const railRegion = { row: 2 + marginY, column: marginX + mainWidth, width: railWidth, height: bodyHeight };
      const railLines = this.view === 'chat'
        ? rail.render(this, railRegion)
        : rail.renderPane(this, railRegion, {
          title: PANE_RAIL_TITLES[this.view] || 'Context',
          lines: module.rail ? module.rail(this, railWidth - 2) : [' Nothing to show here yet.'],
          viewport: this.railView,
        });
      body = hstack([{ lines: body, width: mainWidth }, { lines: railLines, width: railWidth }], bodyHeight);
    }
    // Every chrome row shares the same inset as the body below it — before
    // this, the header/tab strip/status/hint rows ran flush to the terminal's
    // own edges while the panel beneath them sat one column in, so the whole
    // interface visually failed to line up against itself.
    const inset = (line) => (marginX ? ' '.repeat(marginX) + line + ' '.repeat(marginX) : line);
    body = body.map(inset);

    const marginRow = ' '.repeat(columns);
    let frame = vstack([
      [inset(headerBand(this, usableWidth, marginX))],
      [inset(tabStrip(this, usableWidth, marginX))],
      marginY ? [marginRow] : [],
      body,
      marginY ? [marginRow] : [],
      [inset(statusRail(this, usableWidth, marginX))],
      [inset(hintRail(this, usableWidth, marginX))],
    ], rows, columns);

    let cursor = rendered.cursor;

    const toastLines = this.toasts.render(theme, Math.min(56, columns - 4));
    if (toastLines.length) {
      // On the chat view, anchor above the composer's own seam row (the "COMPOSER" divider)
      // rather than a fixed distance from the bottom of the screen: the composer can be more
      // than one row tall (a multi-line draft), and a fixed offset drew the toast straight over
      // its border and clipped its placeholder/input text.
      const toastBottom = this.view === 'chat' && this.lastRegion && this.chatPanes
        ? this.lastRegion.row + 1 + this.chatPanes.transcriptHeight
        : rows - 3;
      frame = paintOverlay(frame, toastLines, { row: Math.max(2 + marginY, toastBottom - toastLines.length), column: columns - Math.min(58, columns - 2) }, columns);
    }

    if (!this.overlay && this.view === 'chat' && this.focus === 'composer' && !this.busy && this.lastRegion && this.chatPanes) {
      const matches = this.matchingSlashCommands();
      if (matches?.length) {
        // Capped to the chat panel's own width (not the full screen) so the
        // panel never bleeds into the rail that sits to its right.
        const width = Math.min(56, this.lastRegion.width - 4);
        // Commands from .maskshift/commands carry a tag, so a project's own command is never
        // mistaken for a built-in (or the other way round).
        const body = matches.slice(0, 12).map((entry) => {
          const name = theme.paint(`/${entry.name}`, { fg: entry.custom ? theme.roles.skill : theme.roles.text, bold: true });
          const tag = entry.custom ? theme.paint(' custom', { fg: theme.roles.faint }) : '';
          return truncate(`${name}${tag}  ${theme.paint(entry.hint, { fg: theme.roles.muted })}`, width - 4);
        });
        const suggestBottom = this.lastRegion.row + 1 + this.chatPanes.transcriptHeight;
        const lines = panel({
          theme, width, height: body.length + 2, title: 'Commands', body,
          colour: frameColour(theme, true), focused: true,
        });
        frame = paintOverlay(frame, lines, { row: Math.max(2 + marginY, suggestBottom - lines.length), column: 2 + marginX }, columns);
      }
    }

    if (this.overlay) {
      // Confined to the body band (never the header, tab strip, status or
      // hint rows) so a tall overlay can't collide with global chrome, and
      // curtained first so nothing behind it bleeds through on either side.
      const drawn = this.overlay.render(this, { columns, rows: bodyHeight, top: 2 + marginY });
      const curtain = new Array(bodyHeight).fill(' '.repeat(columns));
      frame = paintOverlay(frame, curtain, { row: 2 + marginY, column: 0 }, columns);
      frame = paintOverlay(frame, drawn.lines, drawn.offset, columns);
      cursor = drawn.cursor;
    }

    this.screen.render(frame, cursor, imageOverlay);
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
      // Not a keystroke — DEC 1004 focus reporting (see screen.mjs/input.mjs)
      // arrives on the same stream. Tracked so a finished run can tell
      // "nobody's looking at this terminal right now" before it notifies.
      if (event.name === 'focus') {
        this.terminalFocused = event.focused;
        // Coming back to this pane or window: redraw everything, images included, rather than
        // trust whatever the terminal kept or dropped while we were not in front.
        if (event.focused) { this.screen.resync(); this.requestRender(); }
        return;
      }
      if (this.overlay) {
        this.overlay.handle(this, event);
        this.requestRender();
        return;
      }
      // A question above the composer owns the keyboard while the chat is showing, except for the
      // keys that stop the program or the run.
      if (this.prompt && !this.prompt.answered && this.view === 'chat' && !(event.ctrl && (event.name === 'c' || event.name === 'q'))) {
        this.prompt.handle(event);
        this.afterPromptChange();
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

  // ------------------------------------------------------------------- mouse

  /**
   * Route a mouse report to whatever was painted under it.
   *
   * Zones are resolved against the last frame, which is the frame the user was
   * looking at when they clicked. A press latches its zone so a drag keeps
   * talking to the scrollbar it started on even once the pointer leaves it.
   */
  onMouse(event) {
    if (this.screen.mouse === 'off') return;
    try {
      if (event.type === 'wheel') { this.onWheel(event); return; }

      if (event.type === 'drag') {
        if (this.dragging?.onDrag) this.dragging.onDrag(this, event, this.dragging);
        else return;
        this.requestRender();
        return;
      }

      if (event.type === 'move') {
        const zone = this.regions.hit(event.row, event.column, { need: 'onPress' });
        const id = zone?.id ?? null;
        if (id === this.regions.hoverId) return;
        this.regions.hoverId = id;
        this.requestRender();
        return;
      }

      if (event.type === 'release') {
        const zone = this.dragging;
        this.dragging = null;
        this.regions.pressedId = null;
        if (zone?.onRelease) { zone.onRelease(this, event, zone); this.requestRender(); }
        return;
      }

      if (event.type !== 'press') return;

      // An open overlay owns the screen: a click outside it dismisses rather
      // than reaching through to the view behind.
      if (this.overlay && !this.regions.covered(event.row, event.column, LAYER.overlay)) {
        if (this.overlay.dismissOnOutsideClick !== false) this.closeOverlay();
        this.requestRender();
        return;
      }

      const zone = this.regions.hit(event.row, event.column, { need: 'onPress' });
      if (!zone) return;
      this.dragging = zone.onDrag ? zone : null;
      this.regions.pressedId = zone.id;
      zone.onPress(this, event, zone);
      this.requestRender();
    } catch (error) {
      this.toast(error.message, 'error');
      this.requestRender();
    }
  }

  // The wheel scrolls whatever the pointer is over, focused or not, which is
  // what every other scrolling surface on the machine does.
  onWheel(event) {
    const zone = this.regions.hit(event.row, event.column, { need: 'onWheel' });
    if (!zone) return;
    zone.onWheel(this, event, zone);
    this.requestRender();
  }

  globalKey(event) {
    // Typing into a live page (see views/browser.mjs) owns the keyboard the
    // same way the composer does — a digit meant for a form field shouldn't
    // switch views instead.
    const typing = ['composer', 'terminal', 'file-filter', 'capabilities-filter', 'runtime-filter', 'git-filter', 'fleet-filter'].includes(this.focus) || this.browserTyping;

    if (event.ctrl && event.name === 'c') {
      if (this.busy) { this.cancelRun(); return true; }
      if (this.quitArmed) { this.stop(0); return true; }
      this.quitArmed = true;
      this.toast('Press ctrl+c again to leave MaskShift', 'warn');
      setTimeout(() => { this.quitArmed = false; }, 2500).unref?.();
      return true;
    }
    if (this.handoff && event.ctrl && event.name === 'e') { this.handoff.finish(true); return true; }
    if (this.handoff && event.ctrl && event.name === 'x') { this.handoff.finish(false); return true; }
    if (event.ctrl && event.name === 'q') { this.stop(0); return true; }
    if (event.ctrl && event.name === 'k') { this.openPalette(); return true; }
    if (event.ctrl && event.name === 'p') { this.openSessionPicker(); return true; }
    if (event.ctrl && event.name === 'g') { this.openModelPicker(); return true; }
    if (event.ctrl && event.name === 'o') { this.openWorkspaceDialog(); return true; }
    if (event.ctrl && event.name === 'n') { this.requestNewSession(); return true; }
    if (event.ctrl && event.name === 'b') { this.railVisible = !this.railVisible; this.screen.invalidate(); return true; }
    if (event.ctrl && event.name === 'r') { this.cycleRail(1); return true; }
    if (event.ctrl && event.name === 'y') { this.focus = this.focus === 'rail' ? 'composer' : 'rail'; return true; }
    if (event.ctrl && event.name === 'v') { void this.startVoiceCapture(); return true; }
    if (event.ctrl && event.name === 'z') { void this.openUndoLastRun(); return true; }
    if (event.ctrl && event.name === 'd') { void this.openRunChanges(); return true; }
    if (event.name === 'f1') { this.openHelp(); return true; }
    if (event.name === 'f2') { this.openSettings(); return true; }
    if (event.name === 'f5') { this.refreshAll(); return true; }

    if (event.alt && /^[1-7]$/.test(event.name)) { this.switchView(Number(event.name) - 1); return true; }
    if (!typing && /^[1-7]$/.test(event.name)) { this.switchView(Number(event.name) - 1); return true; }
    if (!typing && event.name === '?') { this.openHelp(); return true; }

    if (event.name === 'escape') {
      // Exits typing mode in place — the browser view's own handle() never
      // sees this key otherwise, since escape is handled here first.
      if (this.browserTyping) { this.browserTyping = false; return true; }
      if (this.busy && this.view === 'chat') { this.cancelRun(); return true; }
      if (this.focus === 'rail') { this.focus = this.defaultFocus(); return true; }
      if (typing && this.focus !== 'composer' && this.focus !== 'terminal') { this.focus = this.defaultFocus(); return true; }
      if (this.view !== 'chat') {
        this.switchView(0);
        // Land on the transcript, not the composer: a digit pressed right after landing (the
        // natural next move for someone who was just navigating by view number) should still
        // switch views instead of being silently typed as a literal character. Typing anything
        // else still drops straight into the composer via the transcript's own key handling.
        this.focus = 'transcript';
        return true;
      }
      this.openPalette();
      return true;
    }
    if (event.name === 'right' && this.focus === 'rail') return false;
    return false;
  }

  defaultFocus() {
    return {
      chat: 'composer', files: 'files', capabilities: 'capabilities',
      runtime: 'terminal', browser: 'browser', git: 'git', fleet: 'fleet',
    }[this.view];
  }

  switchView(index) {
    const target = this.views[index];
    if (!target) return;
    const leavingBrowser = this.view === 'browser' && target.id !== 'browser';
    this.view = target.id;
    this.focus = this.defaultFocus();
    this.screen.invalidate();
    if (target.id === 'files' && !this.fileEntries.length) void this.loadFileTree();
    if (target.id === 'capabilities') void this.refreshCapabilitiesExtras();
    if (target.id === 'runtime') void this.refreshRuntimeExtras();
    if (target.id === 'git') void this.refreshGitView();
    if (target.id === 'fleet') void fleetView.refresh(this);
    if (target.id === 'browser') this.startBrowserPolling();
    else if (leavingBrowser) this.stopBrowserPolling();
  }

  cycleRail(direction) {
    const index = RAIL_TABS.indexOf(this.railTab);
    this.railTab = RAIL_TABS[(index + direction + RAIL_TABS.length) % RAIL_TABS.length];
    this.railView.toTop();
  }

  // ------------------------------------------------------------- runtime data

  setWorkspace(workspace) {
    this.fileTreeGeneration += 1;
    this.previewGeneration += 1;
    this.registryGeneration += 1;
    this.workspace = workspace;
    this.workspaceId = workspace.id;
    this.terminalCwd = workspace.path;
    void this.refreshCustomCommands();
    this.runtime.store.setSetting('lastWorkspaceId', workspace.id);
    this.collapsedDirs.clear();
    this.previewPath = '';
    this.previewLines = [];
    this.previewError = '';
    this.previewIsImage = false;
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
    const sessions = this.workspaceId
      ? this.runtime.store.listSessions({ workspaceId: this.workspaceId, limit: 1 })
      : [];
    if (sessions.length) this.loadSession(sessions[0].id);
    else this.newSession({ silent: true });
  }

  loadSession(sessionId) {
    const session = this.runtime.store.getSession(sessionId);
    if (!session) return;
    if (session.workspace_id !== this.workspaceId) {
      this.toast('That chat belongs to a different workspace', 'error');
      return;
    }
    if (session.id !== this.sessionId) this.approvedTools.clear();
    this.sessionId = session.id;
    this.messages = this.runtime.store.listMessages(session.id, 1000);
    this.sessionTitle = this.messages.length ? (session.title || '') : 'New chat';
    const previousModel = this.modelRef;
    this.compaction = session.meta?.compaction || null;
    this.modelRef = session.model_id || this.modelRef;
    if (this.modelRef !== previousModel || !this.modelProfile) void this.refreshModelProfile();
    this.lastRunChanges = null;
    void this.refreshLastRunChanges();
    this.transcript.toBottom();
    const runs = this.runtime.store.listRuns({ sessionId: session.id, limit: 1 });
    const latest = runs[0] || null;
    this.activeRun = latest && ['running', 'queued'].includes(latest.status) ? latest : null;
    this.runId = this.activeRun?.id || null;
    this.plan = latest?.meta?.plan || null;
    this.capabilitySnapshot = latest?.meta?.capabilities || null;
    this.activeCapabilities = new Set(this.capabilitySnapshot?.tools || []);
    this.pendingCalls.clear();
    this.tokenHistory = [];
    this.totals = { input: 0, output: 0, cost: latest?.meta?.costEstimate?.cost || 0 };
    this.costBudgetWarned = false;
    this.contextUsed = 0;
    for (const message of this.messages) {
      const usage = message.meta?.usage;
      if (!usage) continue;
      this.contextUsed = promptTokens(usage) || this.contextUsed;
      const { inputTokens, outputTokens } = tokenCounts(usage);
      this.totals.input += inputTokens;
      this.totals.output += outputTokens;
      if (outputTokens) this.tokenHistory.push(outputTokens);
    }
    this.step = latest?.step_count || 0;
    this.startedAt = latest?.started_at ? new Date(latest.started_at).getTime() : null;
    this.endedAt = latest?.ended_at ? new Date(latest.ended_at).getTime() : null;
    this.subagents = 0;
    this.requestRender();
  }

  requestSessionLoad(sessionId) {
    if (sessionId === this.sessionId) return;
    if (!this.busy && !this.composer.value && this.promptQueue.length === 0) {
      this.loadSession(sessionId);
      return;
    }
    this.overlay = new ConfirmOverlay({
      title: 'Switch chat', danger: Boolean(this.busy || this.promptQueue.length),
      message: this.busy || this.promptQueue.length
        ? 'Cancel the active run, discard queued requests and the current draft, then switch chats?'
        : 'Discard the current draft and switch chats?',
      onConfirm: async () => {
        if (this.busy) this.cancelRun();
        this.promptQueue = [];
        this.composer.clear();
        this.loadSession(sessionId);
      },
    });
  }

  newSession({ silent = false } = {}) {
    const session = this.runtime.engine.createSession({
      workspaceId: this.workspaceId, title: 'New chat', modelRef: this.modelRef,
    });
    this.sessionId = session.id;
    this.approvedTools.clear();
    this.compaction = null;
    this.sessionTitle = 'New chat';
    this.messages = [];
    this.activeRun = null;
    this.runId = null;
    this.plan = null;
    this.capabilitySnapshot = null;
    this.activeCapabilities.clear();
    this.totals = { input: 0, output: 0, cost: 0 };
    this.costBudgetWarned = false;
    this.tokenHistory = [];
    this.step = 0;
    this.startedAt = null;
    this.endedAt = null;
    this.view = 'chat';
    this.focus = 'composer';
    if (!silent) this.toast('New chat opened', 'success');
    this.requestRender();
  }

  requestNewSession() {
    if (!this.busy && !this.composer.value && this.promptQueue.length === 0) {
      this.newSession();
      return;
    }
    this.overlay = new ConfirmOverlay({
      title: 'New chat', danger: Boolean(this.busy || this.promptQueue.length),
      message: this.busy || this.promptQueue.length
        ? 'Cancel the active run, discard queued requests and the current draft, then start a new chat?'
        : 'Discard the current draft and start a new chat?',
      onConfirm: async () => {
        if (this.busy) this.cancelRun();
        this.promptQueue = [];
        this.composer.clear();
        this.newSession();
      },
    });
  }

  async submitPrompt() {
    const original = this.composer.value;
    const prompt = original.trim();
    if (!prompt) return;
    if (prompt.startsWith('/')) { this.composer.clear(); await this.runSlash(prompt); return; }
    this.composer.remember(original);
    this.composer.clear();
    this.view = 'chat';
    this.focus = 'composer';
    this.transcript.toBottom();
    if (this.busy) {
      this.promptQueue.push({ id: `queued-${Date.now()}-${this.promptQueue.length}`, prompt, queuedAt: Date.now() });
      this.toast(`Request queued (${this.promptQueue.length})`, 'info');
      this.requestRender();
      return;
    }
    await this.startPrompt(prompt, { restoreOnFailure: original });
  }

  /**
   * ctrl+t while a run is working: the message joins the run at its next step rather than
   * waiting in the queue for the run to end.
   */
  steerPrompt() {
    const original = this.composer.value;
    const text = original.trim();
    if (!text) return;
    if (text.startsWith('/') || !this.busy || !this.runId) { void this.submitPrompt(); return; }
    const result = this.runtime.engine.steer(this.runId, text);
    if (!result.accepted) {
      this.toast('That run has already finished — press ↵ to send it as a new request', 'warn');
      return;
    }
    this.composer.remember(original);
    this.composer.clear();
    this.transcript.toBottom();
    this.toast('Message sent to the running task — it reads this at its next step', 'info');
    this.requestRender();
  }

  // Clicking a collapsed (or partially expanded) tool result reveals another
  // chunk of it — chat.mjs's transcript cache is keyed on toolExpansionVersion
  // too, so this alone is enough to make the next repaint show more.
  toggleToolExpansion(key) {
    this.toolExpansion.set(key, (this.toolExpansion.get(key) || 0) + chatView.TOOL_EXPAND_STEP);
    this.toolExpansionVersion += 1;
  }

  async startPrompt(prompt, { restoreOnFailure = '' } = {}) {
    try {
      const run = await this.runtime.engine.startRun({
        sessionId: this.sessionId, workspaceId: this.workspaceId, prompt,
        modelRef: this.modelRef, options: { source: 'tui' },
      });
      this.runId = run.id;
      this.sessionId = run.session_id;
      this.activeRun = run;
      this.startedAt = Date.now();
      this.endedAt = null;
      this.step = 0;
      this.pendingCalls.clear();
      this.messages = this.runtime.store.listMessages(this.sessionId, 1000);
      const session = this.runtime.store.getSession(this.sessionId);
      this.sessionTitle = session?.title || this.sessionTitle;
    } catch (error) {
      this.toast(error.message, 'error');
      if (restoreOnFailure && !this.composer.value) this.composer.set(restoreOnFailure);
    }
    this.requestRender();
  }

  async drainPromptQueue() {
    if (this.busy || !this.promptQueue.length) return;
    const next = this.promptQueue.shift();
    await this.startPrompt(next.prompt);
    if (!this.busy && this.promptQueue.length) void this.drainPromptQueue();
  }

  /** Called after a prompt handled a key or click: drop it once answered. */
  afterPromptChange() {
    if (this.prompt?.answered) this.prompt = null;
    this.requestRender();
  }

  /** Shows `prompt` above the composer, bringing the chat to the front so it cannot be missed. */
  showPrompt(prompt) {
    this.prompt = prompt;
    if (this.view !== 'chat') this.switchView(0);
    this.screen.invalidate();
    this.requestRender();
  }

  cancelRun() {
    this.prompt?.decline();
    if (this.prompt?.answered) this.prompt = null;
    if (!this.runId) return;
    this.runtime.engine.cancel(this.runId);
    this.toast('Retreat signalled', 'warn');
  }

  /** A desktop notification for a run that just finished while the user
   *  was looking elsewhere — gated on focus (best-effort; see screen.mjs),
   *  on the setting being turned on, and on the run having actually taken
   *  a while, so a two-second lookup doesn't also ping the desktop. */
  notifyRunFinished(label, run) {
    const config = this.runtime.config.get().notifications || {};
    if (!config.enabled || this.terminalFocused) return;
    const duration = this.startedAt ? Date.now() - this.startedAt : 0;
    if (duration < (config.minDurationMs ?? 15_000)) return;
    notify({
      title: `MaskShift — ${label}`,
      message: oneLine(this.sessionTitle || run?.prompt || 'Run finished', 120),
      command: config.command,
    }, { onError: (error) => this.runtime.logger?.warn?.(`Desktop notification failed: ${error.message}`) });
  }

  /** A soft spend guardrail: never blocks a run, just makes the header cost
   *  chip read as a warning and says so once per session when it's first
   *  crossed, rather than staying silent about it forever after. */
  checkCostBudget() {
    const budget = this.runtime.config.get().costBudget?.session;
    if (!budget || this.totals.cost < budget || this.costBudgetWarned) return;
    this.costBudgetWarned = true;
    this.toast(`Session cost $${this.totals.cost.toFixed(2)} has crossed the $${budget.toFixed(2)} budget`, 'warn');
  }

  // ------------------------------------------------------------- event bridge

  onEvent(event) {
    if (event.type.startsWith('run.')) this.onRunEvent(event);
    if (event.type === 'subagent.started' && (!event.sessionId || event.sessionId === this.sessionId)) this.subagents += 1;
    if (event.type === 'subagent.completed' && (!event.sessionId || event.sessionId === this.sessionId)) this.subagents = Math.max(0, this.subagents - 1);
    this.events.push(event);
    if (this.events.length > EVENT_LIMIT) this.events.splice(0, this.events.length - EVENT_LIMIT);
    if (['mcp.connected', 'mcp.disconnected', 'mcp.added', 'mcp.removed'].includes(event.type)) {
      this.mcpServers = this.runtime.mcpManager.listServers(this.workspaceId);
      this.counts.mcp = this.mcpServers.length;
    }
    if (event.type === 'model.context-window.learned') void this.refreshModelProfile();
    if (event.type.startsWith('plugin.')) this.plugins = this.runtime.pluginManager.list();
    if (event.type.startsWith('fleet.')) fleetView.onEvent(this, event);
    if (event.type === 'learning.updated' && (event.payload.newLessons || event.payload.preferences)) this.toast(`Learned something new from that run — /learned shows what`, 'info');
    if (event.type === 'run.escalated') this.toast(`Moved to ${event.payload.to}: ${truncate(event.payload.reason, 80)}`, 'warn');
    if (event.type === 'run.stuck' && event.payload.level === 'stop') this.toast('Stopped: no progress. See the report in the chat.', 'warn');
    if (event.type === 'storage.warning') this.toast(truncate(event.payload.message, 160), 'warn');
    if (event.type === 'storage.pruned' && event.payload.freedBytes > 50 * 1024 * 1024) this.toast(`Freed ${formatBytes(event.payload.freedBytes)} of old checkpoints and indexes`, 'info');
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
      case 'run.steer-queued':
        this.steering.push(payload.message);
        break;
      case 'run.steered':
        this.steering.shift();
        this.messages = this.runtime.store.listMessages(this.sessionId, 1000);
        break;
      case 'run.started':
        this.steering = [];
        this.lastRunChanges = null;
        this.startedAt = Date.now();
        this.endedAt = null;
        this.step = 0;
        this.pendingCalls.clear();
        this.thinkingLabel = 'Thinking';
        break;
      case 'run.model-turn':
        this.step = payload.step || this.step + 1;
        this.thinkingLabel = `Turn ${String(this.step)} — ${payload.tools?.length ?? 0} tools active`;
        this.activeCapabilities = new Set(payload.tools || []);
        this.streamingText = null;
        break;
      case 'run.assistant-delta':
        this.streamingText = payload.content || '';
        if (this.streamingText) this.thinkingLabel = 'Writing';
        break;
      case 'run.assistant': {
        if (payload.usage) {
          this.contextUsed = promptTokens(payload.usage) || this.contextUsed;
          const { inputTokens, outputTokens } = tokenCounts(payload.usage);
          this.totals.input += inputTokens;
          this.totals.output += outputTokens;
          this.tokenHistory.push(outputTokens);
          if (this.tokenHistory.length > 120) this.tokenHistory.shift();
        }
        for (const call of payload.toolCalls || []) this.pendingCalls.set(call.id, { name: call.name, args: call.args });
        this.streamingText = null;
        this.messages = this.runtime.store.listMessages(this.sessionId, 1000);
        this.thinkingLabel = payload.toolCalls?.length ? 'Running tools' : 'Writing';
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
      case 'run.context-compacted':
        this.compaction = this.runtime.store.getSession(this.sessionId)?.meta?.compaction || this.compaction;
        this.toast(payload.summarized
          ? `Summarized ${payload.omittedTurns} earlier turn${payload.omittedTurns === 1 ? '' : 's'} to fit the window · s in the transcript reads it`
          : 'Context trimmed (summarizing failed; retrying later)', payload.summarized ? 'info' : 'warn');
        break;
      case 'run.context-window-learned':
        void this.refreshModelProfile();
        this.toast(`Window is ${compact(payload.next)}, not ${compact(payload.previous)} — resized, retrying`, 'warn');
        break;
      case 'run.completed':
      case 'run.failed':
      case 'run.cancelled':
      case 'run.max-steps': {
        this.pendingCalls.clear();
        this.streamingText = null;
        this.messages = this.runtime.store.listMessages(this.sessionId, 1000);
        const run = this.runId ? this.runtime.store.getRun(this.runId) : null;
        this.activeRun = null;
        this.runId = null;
        this.endedAt = run?.ended_at ? new Date(run.ended_at).getTime() : Date.now();
        this.plan = run?.meta?.plan || this.plan;
        this.capabilitySnapshot = run?.meta?.capabilities || this.capabilitySnapshot;
        if (run?.meta?.costEstimate?.cost) this.totals.cost = run.meta.costEstimate.cost;
        const session = this.runtime.store.getSession(this.sessionId);
        this.sessionTitle = session?.title || this.sessionTitle;
        const outcome = RUN_OUTCOME[event.type] || { tone: 'error', label: event.type.replace('run.', '').toUpperCase() };
        this.toast(`${outcome.label}${payload.error ? ` — ${oneLine(payload.error, 90)}` : ''}`, outcome.tone);
        this.notifyRunFinished(outcome.label, run);
        void this.refreshLastRunChanges();
        this.checkCostBudget();
        void this.refreshGit();
        if (this.promptQueue.length) setImmediate(() => void this.drainPromptQueue());
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
    const generation = ++this.fileTreeGeneration;
    try {
      const filter = this.fileFilter.value.trim().toLowerCase();
      const result = await this.runtime.workspaceManager.listFiles(this.workspaceId, {
        depth: filter ? 12 : 4, includeHidden: this.showHidden, maxEntries: filter ? 20_000 : 4000,
      });
      if (generation !== this.fileTreeGeneration) return;
      this.fileEntries = filter
        ? result.entries.filter((entry) => entry.path.toLowerCase().includes(filter))
        : result.entries;
      if (!keepFilter) this.fileList.first();
    } catch (error) {
      if (generation !== this.fileTreeGeneration) return;
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
    const generation = ++this.previewGeneration;
    this.previewPath = relative;
    this.previewError = '';
    // An image is decoded and rendered straight from disk at paint time (see
    // files.mjs) rather than read as text here — there is no line content to
    // fetch, just a file to hand to the image renderer.
    this.previewIsImage = isImagePath(relative);
    if (this.previewIsImage) {
      this.previewLines = [];
      this.preview.toTop();
      if (!quiet) this.focus = 'preview';
      this.requestRender();
      return;
    }
    try {
      const result = await this.runtime.toolRegistry.execute('fs_read', {
        path: relative, withLineNumbers: false,
      }, this.toolContext());
      if (generation !== this.previewGeneration) return;
      const content = typeof result === 'string' ? result : (result.content ?? result.text ?? '');
      this.previewLines = String(content).split('\n').slice(0, 5000);
      this.preview.toTop();
      if (!quiet) this.focus = 'preview';
    } catch (error) {
      if (generation !== this.previewGeneration) return;
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

  async startVoiceCapture() {
    return this.withOperation('voice', 'Voice input', async () => {
      if (!this.voice.enabled) { this.toast('Voice input is disabled — enable it in settings (f2)', 'warn'); return; }
      if (!this.voice.config.transcribeCommand) {
        this.toast('No speech-to-text command configured — set one in settings (f2)', 'warn');
        return;
      }
      this.voiceRecording = true;
      this.toast(`Listening for ${this.voice.durationSeconds}s…`, 'info');
      this.requestRender();
      try {
        const transcript = await this.voice.captureAndTranscribe();
        if (!transcript) { this.toast('Heard nothing', 'warn'); return; }
        const needsSpace = this.composer.value && !/\s$/.test(this.composer.value);
        this.composer.insert(`${needsSpace ? ' ' : ''}${transcript}`);
        this.focus = 'composer';
        this.toast('Voice prompt transcribed', 'success');
      } catch (error) {
        this.toast(`Voice input failed: ${error.message}`, 'error');
      } finally {
        this.voiceRecording = false;
      }
    });
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

  // --------------------------------------------------------------- 06 git

  async refreshGitView({ force = false } = {}) {
    if (!this.workspace?.path) return;
    if (this.gitBusy && !force) return;
    const cwd = this.workspace.path;
    this.gitBusy = true;
    this.requestRender();
    try {
      const [status, log, branches, stashes, worktrees] = await Promise.all([
        runCommand('git status --porcelain=v2 --branch', { cwd, timeoutMs: 12_000 }).catch(() => null),
        runCommand('git log -n 300 --date=short --pretty=format:%H%x09%h%x09%ad%x09%an%x09%D%x09%s', { cwd, timeoutMs: 12_000 }).catch(() => null),
        runCommand('git branch -a -vv --no-color', { cwd, timeoutMs: 12_000 }).catch(() => null),
        runCommand('git stash list --pretty=format:%gd%x09%gs', { cwd, timeoutMs: 8000 }).catch(() => null),
        runCommand('git worktree list --porcelain', { cwd, timeoutMs: 8000 }).catch(() => null),
      ]);
      const parsedStatus = parseGitStatus(status?.stdout || '');
      this.gitUpstream = parsedStatus.upstream;
      this.gitAhead = parsedStatus.ahead;
      this.gitBehind = parsedStatus.behind;
      this.gitChanges = expandGitChanges(parsedStatus);
      this.gitLogEntries = parseGitLog(log?.stdout || '');
      this.gitBranches = parseGitBranches(branches?.stdout || '');
      this.gitStashes = parseGitStash(stashes?.stdout || '');
      this.gitWorktrees = parseGitWorktrees(worktrees?.stdout || '');
    } catch { /* git is optional */ }
    this.gitBusy = false;
    this.requestRender();
  }

  /** Fetch and cache a diff/show for the selected row in the 06 GIT view —
   *  the pane's own render() has to stay synchronous, so this feeds
   *  gitDetailCache the same way loadSkillBody feeds skillBodies. */
  async loadGitDetail(item) {
    const cwd = this.workspace?.path;
    if (!cwd || !item) return;
    let key = null;
    let command = null;
    if (item.kind === 'change') {
      const raw = item.raw;
      key = `change:${raw.staged ? 's' : 'u'}:${raw.path}`;
      command = raw.statusKey === 'untracked'
        ? `git diff --no-index -- /dev/null ${shellQuote(raw.path)}`
        : `git diff ${raw.staged ? '--staged' : ''} -- ${shellQuote(raw.path)}`;
    } else if (item.kind === 'commit') {
      key = `commit:${item.raw.hash}`;
      command = `git show --pretty=format: ${shellQuote(item.raw.hash)}`;
    } else if (item.kind === 'stash') {
      key = `stash:${item.raw.ref}`;
      command = `git stash show -p ${shellQuote(item.raw.ref)}`;
    } else {
      return;
    }
    if (this.gitDetailCache.has(key)) return;
    this.gitDetailCache.set(key, { loading: true });
    this.requestRender();
    try {
      const result = await runCommand(command, { cwd, timeoutMs: 15_000 });
      this.gitDetailCache.set(key, { loading: false, text: result.stdout || result.stderr || '' });
    } catch (error) {
      this.gitDetailCache.set(key, { loading: false, error: error.message });
    }
    this.requestRender();
  }

  /** Recent commits touching one file — the Git view's rail history for
   *  whichever changed file is selected (see git.mjs's rail()). Cached the
   *  same way loadGitDetail caches a diff, since render() has to stay
   *  synchronous. */
  async loadGitFileHistory(relative) {
    const cwd = this.workspace?.path;
    if (!cwd || !relative || this.gitFileHistoryCache.has(relative)) return;
    this.gitFileHistoryCache.set(relative, { loading: true });
    this.requestRender();
    try {
      const result = await runCommand(
        `git log -n 20 --date=short --pretty=format:%H%x09%h%x09%ad%x09%an%x09%D%x09%s -- ${shellQuote(relative)}`,
        { cwd, timeoutMs: 12_000 },
      );
      this.gitFileHistoryCache.set(relative, { loading: false, entries: parseGitLog(result.stdout || '') });
    } catch (error) {
      this.gitFileHistoryCache.set(relative, { loading: false, error: error.message });
    }
    this.requestRender();
  }

  async gitStageToggle(item) {
    const cwd = this.workspace?.path;
    if (!cwd || !item || item.kind !== 'change') return;
    const raw = item.raw;
    try {
      if (raw.staged) await runCommand(`git restore --staged -- ${shellQuote(raw.path)}`, { cwd, timeoutMs: 10_000 });
      else await runCommand(`git add -- ${shellQuote(raw.path)}`, { cwd, timeoutMs: 10_000 });
      await this.refreshGitView({ force: true });
    } catch (error) { this.toast(error.message, 'error'); }
  }

  async gitStageAll() {
    const cwd = this.workspace?.path;
    if (!cwd) return;
    try {
      await runCommand('git add -A', { cwd, timeoutMs: 15_000 });
      this.toast('Staged all changes', 'success');
      await this.refreshGitView({ force: true });
    } catch (error) { this.toast(error.message, 'error'); }
  }

  async gitUnstageAll() {
    const cwd = this.workspace?.path;
    if (!cwd) return;
    try {
      await runCommand('git restore --staged .', { cwd, timeoutMs: 15_000 });
      this.toast('Unstaged all changes', 'info');
      await this.refreshGitView({ force: true });
    } catch (error) { this.toast(error.message, 'error'); }
  }

  confirmDiscardChange(item) {
    const raw = item.raw;
    this.overlay = new ConfirmOverlay({
      title: 'Discard change', danger: true,
      message: `Discard changes to "${raw.path}"? This cannot be undone.`,
      onConfirm: async () => {
        const cwd = this.workspace?.path;
        if (!cwd) return;
        try {
          if (raw.statusKey === 'untracked') await runCommand(`git clean -f -- ${shellQuote(raw.path)}`, { cwd, timeoutMs: 10_000 });
          else {
            if (raw.staged) await runCommand(`git restore --staged -- ${shellQuote(raw.path)}`, { cwd, timeoutMs: 10_000 });
            await runCommand(`git checkout -- ${shellQuote(raw.path)}`, { cwd, timeoutMs: 10_000 });
          }
          this.toast('Change discarded', 'warn');
          await this.refreshGitView({ force: true });
        } catch (error) { this.toast(error.message, 'error'); }
      },
    });
  }

  openGitCommitDialog() {
    const stagedCount = this.gitChanges.filter((change) => change.staged).length;
    this.overlay = new FormOverlay({
      title: 'Commit', submitLabel: stagedCount ? `Commit ${stagedCount} file${stagedCount === 1 ? '' : 's'}` : 'Commit all tracked',
      note: stagedCount ? '' : 'Nothing staged — this commits every tracked change (git commit -a).',
      fields: [
        { name: 'message', label: 'message', type: 'textarea', value: '' },
        { name: 'amend', label: 'amend previous commit', type: 'toggle', value: false },
        { name: 'noVerify', label: 'skip hooks (--no-verify)', type: 'toggle', value: false },
      ],
      onSubmit: async (values) => {
        if (!values.amend && !values.message.trim()) throw new Error('A commit message is required');
        const cwd = this.workspace?.path;
        if (!cwd) throw new Error('No workspace open');
        const parts = ['git commit'];
        if (values.amend) parts.push('--amend');
        if (values.noVerify) parts.push('--no-verify');
        if (!stagedCount) parts.push('-a');
        if (values.message.trim()) parts.push(`-m ${shellQuote(values.message.trim())}`);
        else parts.push('--no-edit');
        const result = await runCommand(parts.join(' '), { cwd, timeoutMs: 30_000 });
        if (result.code !== 0) throw new Error(oneLine(result.stderr || result.stdout || 'commit failed', 300));
        this.toast('Committed', 'success');
        await this.refreshGitView({ force: true });
        await this.refreshGit();
      },
    });
  }

  async gitSwitchBranch(item) {
    const raw = item.raw;
    if (!raw || raw.current) return;
    const cwd = this.workspace?.path;
    if (!cwd) return;
    const run = async () => {
      try {
        const command = raw.remote ? `git checkout --track ${shellQuote(raw.name)}` : `git checkout ${shellQuote(raw.name)}`;
        const result = await runCommand(command, { cwd, timeoutMs: 30_000 });
        if (result.code !== 0) throw new Error(oneLine(result.stderr || result.stdout || 'checkout failed', 300));
        this.toast(`Switched to ${raw.name}`, 'success');
        await this.refreshGitView({ force: true });
        await this.refreshGit();
        await this.loadFileTree({ force: true });
      } catch (error) { this.toast(error.message, 'error'); }
    };
    if (this.gitChanges.length) {
      this.overlay = new ConfirmOverlay({
        title: 'Switch branch', danger: true,
        message: `Switch to ${raw.name} with uncommitted changes present? Git refuses if it would overwrite anything.`,
        onConfirm: run,
      });
    } else {
      await run();
    }
  }

  openGitBranchDialog() {
    this.overlay = new FormOverlay({
      title: 'New branch', submitLabel: 'Create and switch',
      fields: [
        { name: 'name', label: 'name', value: '' },
        { name: 'startPoint', label: 'start point', value: this.gitBranches.find((branch) => branch.current)?.name || 'HEAD' },
        { name: 'switch', label: 'switch to it', type: 'toggle', value: true },
      ],
      onSubmit: async (values) => {
        if (!values.name.trim()) throw new Error('A branch name is required');
        const cwd = this.workspace?.path;
        if (!cwd) throw new Error('No workspace open');
        const command = values.switch
          ? `git checkout -b ${shellQuote(values.name.trim())} ${shellQuote(values.startPoint || 'HEAD')}`
          : `git branch ${shellQuote(values.name.trim())} ${shellQuote(values.startPoint || 'HEAD')}`;
        const result = await runCommand(command, { cwd, timeoutMs: 20_000 });
        if (result.code !== 0) throw new Error(oneLine(result.stderr || result.stdout || 'branch create failed', 300));
        this.toast(`Branch ${values.name.trim()} created`, 'success');
        await this.refreshGitView({ force: true });
        await this.refreshGit();
      },
    });
  }

  openGitRenameBranch(item) {
    const raw = item.raw;
    if (!raw || raw.remote) return;
    this.overlay = new FormOverlay({
      title: 'Rename branch', submitLabel: 'Rename',
      fields: [{ name: 'name', label: 'new name', value: raw.name }],
      onSubmit: async (values) => {
        if (!values.name.trim()) throw new Error('A new name is required');
        const cwd = this.workspace?.path;
        if (!cwd) throw new Error('No workspace open');
        const command = raw.current
          ? `git branch -m ${shellQuote(values.name.trim())}`
          : `git branch -m ${shellQuote(raw.name)} ${shellQuote(values.name.trim())}`;
        const result = await runCommand(command, { cwd, timeoutMs: 15_000 });
        if (result.code !== 0) throw new Error(oneLine(result.stderr || result.stdout || 'rename failed', 300));
        this.toast('Branch renamed', 'success');
        await this.refreshGitView({ force: true });
        await this.refreshGit();
      },
    });
  }

  confirmDeleteBranch(item) {
    const raw = item.raw;
    if (!raw || raw.current) { this.toast('Cannot delete the current branch', 'warn'); return; }
    this.overlay = new ConfirmOverlay({
      title: 'Delete branch', danger: true,
      message: `Delete branch "${raw.name}"? This cannot be undone if it isn't merged elsewhere.`,
      onConfirm: async () => {
        const cwd = this.workspace?.path;
        if (!cwd) return;
        try {
          const command = raw.remote ? `git branch -d -r ${shellQuote(raw.name)}` : `git branch -D ${shellQuote(raw.name)}`;
          const result = await runCommand(command, { cwd, timeoutMs: 15_000 });
          if (result.code !== 0) throw new Error(oneLine(result.stderr || result.stdout || 'delete failed', 300));
          this.toast('Branch deleted', 'warn');
          await this.refreshGitView({ force: true });
        } catch (error) { this.toast(error.message, 'error'); }
      },
    });
  }

  async gitStashApply(item, { pop = false } = {}) {
    const raw = item.raw;
    const cwd = this.workspace?.path;
    if (!cwd) return;
    try {
      const result = await runCommand(`git stash ${pop ? 'pop' : 'apply'} ${shellQuote(raw.ref)}`, { cwd, timeoutMs: 20_000 });
      if (result.code !== 0) throw new Error(oneLine(result.stderr || result.stdout || 'stash failed', 300));
      this.toast(pop ? 'Stash popped' : 'Stash applied', 'success');
      await this.refreshGitView({ force: true });
    } catch (error) { this.toast(error.message, 'error'); }
  }

  confirmDropStash(item) {
    const raw = item.raw;
    this.overlay = new ConfirmOverlay({
      title: 'Drop stash', danger: true,
      message: `Drop ${raw.ref} permanently?`,
      onConfirm: async () => {
        const cwd = this.workspace?.path;
        if (!cwd) return;
        try {
          await runCommand(`git stash drop ${shellQuote(raw.ref)}`, { cwd, timeoutMs: 15_000 });
          this.toast('Stash dropped', 'warn');
          await this.refreshGitView({ force: true });
        } catch (error) { this.toast(error.message, 'error'); }
      },
    });
  }

  openGitStashDialog() {
    this.overlay = new FormOverlay({
      title: 'Stash changes', submitLabel: 'Stash',
      fields: [
        { name: 'message', label: 'message', value: '' },
        { name: 'includeUntracked', label: 'include untracked', type: 'toggle', value: true },
      ],
      onSubmit: async (values) => {
        const cwd = this.workspace?.path;
        if (!cwd) throw new Error('No workspace open');
        const parts = ['git stash push'];
        if (values.includeUntracked) parts.push('-u');
        if (values.message.trim()) parts.push(`-m ${shellQuote(values.message.trim())}`);
        const result = await runCommand(parts.join(' '), { cwd, timeoutMs: 20_000 });
        if (result.code !== 0) throw new Error(oneLine(result.stderr || result.stdout || 'stash failed', 300));
        this.toast('Changes stashed', 'success');
        await this.refreshGitView({ force: true });
      },
    });
  }

  gitConfirmRestoreCheckpoint(item) {
    const checkpoint = item.raw;
    if (this.busy) { this.toast('Cancel the active run before restoring a checkpoint', 'warn'); return; }
    this.overlay = new ConfirmOverlay({
      title: 'Restore', danger: true,
      message: `Restore the workspace to checkpoint ${checkpoint.ref || checkpoint.id}? Uncommitted changes will be replaced.`,
      onConfirm: async () => {
        await this.runtime.workspaceManager.restoreCheckpoint(this.workspaceId, checkpoint);
        this.toast('Checkpoint restored', 'success');
        await this.loadFileTree({ force: true });
        await this.refreshGit();
        await this.refreshGitView({ force: true });
      },
    });
  }

  openGitWorktreeDialog() {
    this.overlay = new FormOverlay({
      title: 'New worktree', submitLabel: 'Create',
      fields: [
        { name: 'path', label: 'path', value: '' },
        { name: 'branch', label: 'branch (existing, blank for a new one)', value: '' },
      ],
      onSubmit: async (values) => {
        if (!values.path.trim()) throw new Error('A path is required');
        const cwd = this.workspace?.path;
        if (!cwd) throw new Error('No workspace open');
        const branch = values.branch.trim();
        const command = branch
          ? `git worktree add ${shellQuote(values.path.trim())} ${shellQuote(branch)}`
          : `git worktree add -b ${shellQuote(`wt-${Date.now()}`)} ${shellQuote(values.path.trim())}`;
        const result = await runCommand(command, { cwd, timeoutMs: 30_000 });
        if (result.code !== 0) throw new Error(oneLine(result.stderr || result.stdout || 'worktree add failed', 300));
        this.toast('Worktree created', 'success');
        await this.refreshGitView({ force: true });
      },
    });
  }

  confirmRemoveWorktree(item) {
    const raw = item.raw;
    this.overlay = new ConfirmOverlay({
      title: 'Remove worktree', danger: true,
      message: `Remove worktree at ${raw.path}?`,
      onConfirm: async () => {
        const cwd = this.workspace?.path;
        if (!cwd) return;
        try {
          const result = await runCommand(`git worktree remove ${shellQuote(raw.path)}`, { cwd, timeoutMs: 20_000 });
          if (result.code !== 0) throw new Error(oneLine(result.stderr || result.stdout || 'remove failed', 300));
          this.toast('Worktree removed', 'warn');
          await this.refreshGitView({ force: true });
        } catch (error) { this.toast(error.message, 'error'); }
      },
    });
  }

  async gitPush() {
    return this.withOperation('git:push', 'Git push', async () => {
      const cwd = this.workspace?.path;
      if (!cwd) return;
      this.toast('Pushing…', 'info');
      try {
        const result = await runCommand('git push', { cwd, timeoutMs: 60_000 });
        if (result.code !== 0) throw new Error(oneLine(result.stderr || result.stdout || 'push failed', 300));
        this.toast('Pushed', 'success');
      } catch (error) { this.toast(error.message, 'error'); }
      await this.refreshGitView({ force: true });
      await this.refreshGit();
    });
  }

  async gitPull() {
    return this.withOperation('git:pull', 'Git pull', async () => {
      const cwd = this.workspace?.path;
      if (!cwd) return;
      this.toast('Pulling…', 'info');
      try {
        const result = await runCommand('git pull', { cwd, timeoutMs: 60_000 });
        if (result.code !== 0) throw new Error(oneLine(result.stderr || result.stdout || 'pull failed', 300));
        this.toast('Pulled', 'success');
      } catch (error) { this.toast(error.message, 'error'); }
      await this.refreshGitView({ force: true });
      await this.refreshGit();
      await this.loadFileTree({ force: true });
    });
  }

  async gitFetch() {
    return this.withOperation('git:fetch', 'Git fetch', async () => {
      const cwd = this.workspace?.path;
      if (!cwd) return;
      this.toast('Fetching…', 'info');
      try {
        const result = await runCommand('git fetch --all --prune', { cwd, timeoutMs: 60_000 });
        if (result.code !== 0) throw new Error(oneLine(result.stderr || result.stdout || 'fetch failed', 300));
        this.toast('Fetched', 'success');
      } catch (error) { this.toast(error.message, 'error'); }
      await this.refreshGitView({ force: true });
      await this.refreshGit();
    });
  }

  // -------------------------------------------------------------------- MCP

  async refreshMcp() {
    this.mcpServers = this.runtime.mcpManager.listServers(this.workspaceId);
    this.counts.mcp = this.mcpServers.length;
    this.requestRender();
  }

  async connectMcp(name, force = false) {
    return this.withOperation(`mcp:${name}`, `MCP server ${name}`, async () => {
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
    });
  }

  async disconnectMcp(name) {
    return this.withOperation(`mcp:${name}`, `MCP server ${name}`, async () => {
      try {
        await this.runtime.mcpManager.disconnect(name, this.workspaceId);
        this.mcpTools.delete(name);
        this.toast(`${name} disconnected`, 'warn');
      } catch (error) {
        this.toast(error.message, 'error');
      }
      await this.refreshMcp();
    });
  }

  async searchRegistry(query) {
    const generation = ++this.registryGeneration;
    this.toast('Searching the official registry…', 'info');
    try {
      const results = await this.runtime.mcpManager.registrySearch(query || '', 40);
      if (generation !== this.registryGeneration) return;
      this.registryResults = results;
      this.toast(`${this.registryResults.length} registry entries`, 'success');
    } catch (error) {
      if (generation !== this.registryGeneration) return;
      this.toast(`Registry search failed: ${error.message}`, 'error');
    }
    this.requestRender();
  }

  async installRegistryServer(item) {
    return this.withOperation(`mcp-install:${item.name}`, `MCP install ${item.name}`, async () => {
      try {
        const installed = await this.runtime.mcpManager.installRegistry(item, {
          prefer: 'remote', workspacePath: this.workspace?.path || process.cwd(),
        });
        this.toast(`Installed ${installed.name}`, 'success');
        this.mcpMode = 'installed';
        await this.refreshMcp();
      } catch (error) {
        this.toast(`Install failed: ${error.message}`, 'error');
      }
    });
  }

  openMcpDialog() {
    this.overlay = new FormOverlay({
      title: 'Add MCP server',
      submitLabel: 'Add link',
      note: 'Environment values may reference shell variables with ${NAME}.',
      fields: [
        { name: 'name', label: 'name', value: '', hint: 'my-server' },
        {
          name: 'transport', label: 'transport', type: 'select', value: 'stdio',
          options: [{ label: 'STDIO', value: 'stdio' }, { label: 'Streamable HTTP', value: 'http' }],
        },
        { name: 'command', label: 'command', value: '', hint: 'npx -y @modelcontextprotocol/server-filesystem .', visible: (values) => values.transport === 'stdio' },
        { name: 'url', label: 'url', value: '', hint: 'https://server.example/mcp', visible: (values) => values.transport === 'http' },
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
      title: 'Remove server', danger: true,
      message: `Remove the MCP server "${name}" from this workspace configuration?`,
      onConfirm: async () => {
        await this.runtime.mcpManager.remove(name, this.workspace?.path || process.cwd());
        this.toast(`${name} removed`, 'warn');
        await this.refreshMcp();
      },
    });
  }

  // ------------------------------------------------------- 03 capabilities

  /** Plugins — the one 03 CAPABILITIES tab without its own refresh (tools/skills: refreshCatalogs; mcp: refreshMcp). */
  async refreshCapabilitiesExtras() {
    this.plugins = this.runtime.pluginManager.list();
    this.requestRender();
  }

  // ------------------------------------------------------------ 04 runtime

  /** Automations, processes and browser instances — the three catalogued
   *  04 RUNTIME tabs behind the shell. */
  async refreshRuntimeExtras({ force = false } = {}) {
    this.automations = this.runtime.automationScheduler.list({ limit: 200 });
    this.processes = this.runtime.processManager.list({});
    this.browsers = this.runtime.browserManager.list();
    this.requestRender();
  }

  openAutomationDialog() {
    this.overlay = new FormOverlay({
      title: 'New automation', submitLabel: 'Arm automation',
      note: 'Schedules accept "every 6h", cron expressions, or an ISO timestamp.',
      fields: [
        { name: 'name', label: 'name', value: '', hint: 'Nightly repository verification' },
        { name: 'schedule', label: 'schedule', value: 'every 6h' },
        {
          name: 'type', label: 'action', type: 'select', value: 'agent',
          options: [{ label: 'Agent run', value: 'agent' }, { label: 'Shell command', value: 'shell' }, { label: 'Tool call', value: 'tool' }],
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
        void this.refreshRuntimeExtras();
      },
    });
  }

  openPluginDialog() {
    this.overlay = new FormOverlay({
      title: 'Install plugin', submitLabel: 'Install and activate',
      note: 'Plugins run inside MaskShift with full host authority and can register tools, skills, MCP servers and listeners.',
      fields: [
        { name: 'source', label: 'source', value: '', hint: '/path, git URL, or npm package' },
        {
          name: 'kind', label: 'install type', type: 'select', value: 'auto',
          options: [
            { label: 'Auto-detect', value: 'auto' }, { label: 'Local directory', value: 'local' },
            { label: 'Git repository', value: 'git' }, { label: 'npm package', value: 'npm' },
          ],
        },
        { name: 'name', label: 'local name', value: '' },
      ],
      onSubmit: async (values) => {
        if (!values.source) throw new Error('A source is required');
        const plugin = await this.runtime.pluginManager.install(values.source, { kind: values.kind, name: values.name || null });
        this.toast(`Installed ${plugin.name}`, 'success');
        this.refreshCatalogs();
        await this.refreshCapabilitiesExtras();
      },
    });
  }

  openBrowserDialog() {
    this.overlay = new FormOverlay({
      title: 'Launch browser', submitLabel: 'Launch',
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
        await this.refreshRuntimeExtras();
      },
    });
  }

  async runAutomation(automationId) {
    return this.withOperation(`automation:${automationId}`, 'Automation', async () => {
      try {
        await this.runtime.automationScheduler.execute(automationId, { manual: true });
        this.toast('Automation executed', 'success');
      } catch (error) {
        this.toast(error.message, 'error');
      }
      await this.refreshRuntimeExtras();
    });
  }

  async toggleAutomation(automation) {
    this.runtime.automationScheduler.update(automation.id, { enabled: !automation.enabled });
    this.toast(`${automation.name} ${automation.enabled ? 'paused' : 'armed'}`, 'info');
    await this.refreshRuntimeExtras();
  }

  confirmDeleteAutomation(automation) {
    this.overlay = new ConfirmOverlay({
      title: 'Delete automation', danger: true,
      message: `Delete "${automation.name}" permanently?`,
      onConfirm: async () => {
        this.runtime.automationScheduler.remove(automation.id);
        this.toast('Automation deleted', 'warn');
        await this.refreshRuntimeExtras();
      },
    });
  }

  async activatePlugin(name) {
    return this.withOperation(`plugin:${name}`, `Plugin ${name}`, async () => {
      try { await this.runtime.pluginManager.activate(name); this.toast(`${name} activated`, 'success'); }
      catch (error) { this.toast(error.message, 'error'); }
      this.refreshCatalogs();
      await this.refreshCapabilitiesExtras();
    });
  }

  async deactivatePlugin(name) {
    return this.withOperation(`plugin:${name}`, `Plugin ${name}`, async () => {
      try { await this.runtime.pluginManager.deactivate(name); this.toast(`${name} deactivated`, 'warn'); }
      catch (error) { this.toast(error.message, 'error'); }
      this.refreshCatalogs();
      await this.refreshCapabilitiesExtras();
    });
  }

  async reloadPlugin(name) {
    return this.withOperation(`plugin:${name}`, `Plugin ${name}`, async () => {
      try { await this.runtime.pluginManager.reload(name); this.toast(`${name} reloaded`, 'success'); }
      catch (error) { this.toast(error.message, 'error'); }
      this.refreshCatalogs();
      await this.refreshCapabilitiesExtras();
    });
  }

  async closeBrowser(instanceId) {
    return this.withOperation(`browser:${instanceId}`, 'Browser close', async () => {
      try { await this.runtime.browserManager.close(instanceId); this.toast('Browser closed', 'warn'); }
      catch (error) { this.toast(error.message, 'error'); }
      await this.refreshRuntimeExtras();
    });
  }

  // ------------------------------------------------------- 05 browser view

  openBrowserTargetPicker() {
    if (!this.browsers.length) { this.toast('No browser instances running — launch one from 04 RUNTIME', 'warn'); return; }
    this.overlay = new PickerOverlay({
      title: 'Choose a browser',
      placeholder: 'Filter instances…',
      items: this.browsers.map((instance) => ({
        id: instance.id, label: instance.profile || instance.id,
        detail: `${instance.headless ? 'headless' : 'headed'} · pid ${instance.pid}`,
        tone: instance.id === this.browserTarget?.instanceId ? this.theme.roles.primary : undefined,
      })),
      selectedId: this.browserTarget?.instanceId,
      onSelect: (item) => void this.openBrowserView(item.id),
    });
  }

  async openBrowserView(instanceId, tabId = null) {
    try {
      let resolvedTabId = tabId;
      if (!resolvedTabId) {
        const tabs = await this.runtime.browserManager.tabs(instanceId);
        if (!tabs.length) { this.toast('That browser has no open tabs', 'warn'); return; }
        resolvedTabId = tabs[0].id;
      }
      this.browserTarget = { instanceId, tabId: resolvedTabId };
      this.browserFrame = null;
      this.browserFrameId = 0;
      this.browserPollTick = 0;
      this.browserConsoleLog = [];
      this.browserNetworkLog = [];
      const index = this.views.findIndex((view) => view.id === 'browser');
      if (index >= 0) this.switchView(index);
      await this.pollBrowserFrame({ force: true });
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  startBrowserPolling() {
    if (this.browserPollTimer) return;
    this.browserPollTimer = setInterval(() => void this.pollBrowserFrame(), BROWSER_POLL_MS);
    this.browserPollTimer.unref?.();
  }

  stopBrowserPolling() {
    if (!this.browserPollTimer) return;
    clearInterval(this.browserPollTimer);
    this.browserPollTimer = null;
  }

  /** One screenshot round-trip. Skipped (not queued) if the previous one
   *  hasn't landed yet — CDP screenshot capture is not free, and a slow
   *  connection backing up a queue of polls is worse than just dropping a
   *  frame and trying again on the next tick. */
  async pollBrowserFrame({ force = false } = {}) {
    if (!this.browserTarget) return;
    if (!force && this.view !== 'browser') return;
    if (this.browserPollBusy) return;
    this.browserPollBusy = true;
    try {
      const { instanceId, tabId } = this.browserTarget;
      // Only the half-block fallback needs to decode this screenshot itself
      // (Kitty passes PNG bytes straight through, iTerm2 only reads the
      // header) — so only it needs a resolution cap to stay fast; for the
      // other two, more pixels cost nothing here and only help crispness.
      // Half-block samples at most two source pixel-rows per terminal row,
      // so anything past `cols` x `rows * 2` is wasted decode work.
      const capped = detectImageProtocol() === 'halfblock';
      const maxWidth = capped ? Math.max(1, this.browserRenderBudget.cols) : null;
      const maxHeight = capped ? Math.max(1, this.browserRenderBudget.rows * 2) : null;
      const frame = await this.runtime.browserManager.captureFrame({ instanceId, tabId, maxWidth, maxHeight });
      this.browserFrameId += 1;
      this.browserPollTick += 1;
      let { title, url } = this.browserFrame || {};
      // The page's title/URL change far less often than its pixels do, and
      // costs its own round-trip — worth fetching occasionally, not every tick.
      if (this.browserPollTick % 10 === 1) {
        try {
          const info = await this.runtime.browserManager.evaluate({ instanceId, tabId, expression: '({title: document.title, url: location.href})' });
          title = info.value?.title; url = info.value?.url;
        } catch { /* keep whatever the last successful fetch had */ }
      }
      // Console/network tails change slower than the frame does and cost their
      // own CDP round-trip each — fetched every few ticks rather than every
      // one, for the rail's console/network tail (see browser.mjs's rail()).
      if (this.browserPollTick % 5 === 1) {
        try {
          const [consoleResult, networkResult] = await Promise.all([
            this.runtime.browserManager.console({ instanceId, tabId, limit: 40 }),
            this.runtime.browserManager.network({ instanceId, tabId, limit: 40 }),
          ]);
          this.browserConsoleLog = consoleResult.events;
          this.browserNetworkLog = networkResult.events;
        } catch { /* best effort */ }
      }
      this.browserFrame = { buffer: frame.buffer, cssWidth: frame.cssWidth, cssHeight: frame.cssHeight, title, url, error: null };
    } catch (error) {
      this.browserFrame = { ...(this.browserFrame || {}), error: error.message };
    } finally {
      this.browserPollBusy = false;
      if (this.view === 'browser') this.requestRender();
    }
  }

  /** A clicked/scrolled cell, translated into the page's own CSS-pixel
   *  coordinate space via the box the image actually occupies (`zone`) and
   *  the CSS viewport size captureFrame reported alongside it. Terminal
   *  mouse reporting only ever gives cell granularity, never sub-cell pixel
   *  position — the same resolution limit any other terminal mouse
   *  interaction has, not something specific to this view. */
  browserPagePoint(event, zone) {
    const frame = this.browserFrame;
    if (!frame || !frame.cols || !frame.rows || !frame.cssWidth || !frame.cssHeight) return null;
    const cellX = event.column - zone.column;
    const cellY = event.row - zone.row;
    if (cellX < 0 || cellY < 0 || cellX >= zone.width || cellY >= zone.height) return null;
    return {
      x: Math.round(((cellX + 0.5) / frame.cols) * frame.cssWidth),
      y: Math.round(((cellY + 0.5) / frame.rows) * frame.cssHeight),
    };
  }

  browserClick(event, zone) {
    if (!this.browserTarget) return;
    const point = this.browserPagePoint(event, zone);
    if (!point) return;
    this.focus = 'browser';
    const { instanceId, tabId } = this.browserTarget;
    void this.runtime.browserManager.mouseEvent({ instanceId, tabId, kind: 'click', ...point })
      .then(() => this.pollBrowserFrame({ force: true }))
      .catch((error) => this.toast(error.message, 'error'));
  }

  browserScroll(event, zone) {
    if (!this.browserTarget) return;
    const point = this.browserPagePoint(event, zone);
    if (!point) return;
    const { instanceId, tabId } = this.browserTarget;
    const deltaY = event.button === 'wheeldown' ? 100 : event.button === 'wheelup' ? -100 : 0;
    void this.runtime.browserManager.mouseEvent({ instanceId, tabId, kind: 'wheel', ...point, deltaY })
      .then(() => this.pollBrowserFrame({ force: true }))
      .catch((error) => this.toast(error.message, 'error'));
  }

  /** Every keystroke while "typing" mode is on (see views/browser.mjs) — a
   *  chunk of literal text goes through Input.insertText (Unicode-correct,
   *  same call the type() tool already relies on); a key with no character
   *  of its own (Enter, Backspace, an arrow, …) goes through as a named key
   *  instead, since insertText has nothing to send for those. */
  async forwardBrowserKey(event) {
    if (!this.browserTarget) return;
    const { instanceId, tabId } = this.browserTarget;
    try {
      if (event.name === 'paste' && event.text) {
        await this.runtime.browserManager.keyEvent({ instanceId, tabId, text: event.text });
      } else if (event.printable && !event.ctrl && !event.alt) {
        await this.runtime.browserManager.keyEvent({ instanceId, tabId, text: event.name });
      } else {
        await this.runtime.browserManager.keyEvent({ instanceId, tabId, key: event.name });
      }
      void this.pollBrowserFrame({ force: true });
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  async stopProcess(processId) {
    return this.withOperation(`process:${processId}`, 'Process stop', async () => {
      try { this.runtime.processManager.stop(processId, 'SIGTERM'); this.toast('Signal sent', 'warn'); }
      catch (error) { this.toast(error.message, 'error'); }
      await this.refreshRuntimeExtras();
    });
  }

  // ------------------------------------------------------------- 04 runtime

  async runTerminalCommand(command) {
    const value = command.trim();
    if (!value) return;
    if (this.terminalBusy) { this.toast('A terminal command is already running', 'warn'); return; }
    this.terminalField.remember(value);
    this.terminalField.clear();
    const theme = this.theme;
    // The echoed command wears the prompt marker in the gutter and its output
    // sits in the blank one below it, so a command and everything it printed
    // share the left edge the live prompt is already on.
    this.pushTerminal(gutter(theme, '❯', { tone: theme.roles.primary })
      + theme.paint(value, { fg: theme.roles.text, bold: true }));
    this.terminalBusy = true;
    const startedAt = Date.now();
    this.requestRender();
    try {
      const result = await this.runtime.toolRegistry.execute('shell_exec', {
        command: value, cwd: '.', timeoutMs: this.runtime.config.get().commandTimeoutMs,
      }, this.toolContext());
      for (const line of String(result.stdout || '').split('\n')) if (line) this.pushTerminal(gutter(theme) + theme.paint(line, { fg: theme.roles.text }));
      for (const line of String(result.stderr || '').split('\n')) if (line) this.pushTerminal(gutter(theme) + theme.paint(line, { fg: theme.roles.danger }));
      this.pushTerminal(gutter(theme, result.code === 0 ? '✓' : '✕', {
        tone: result.code === 0 ? theme.roles.success : theme.roles.danger,
      }) + theme.paint(`exit ${result.code}`, { fg: theme.roles.muted }));
      this.pushTerminalHistory({ command: value, code: result.code, durationMs: Date.now() - startedAt });
    } catch (error) {
      this.pushTerminal(gutter(theme, '✕', { tone: theme.roles.danger })
        + theme.paint(error.message, { fg: theme.roles.danger }));
      this.pushTerminalHistory({ command: value, code: null, error: error.message, durationMs: Date.now() - startedAt });
    }
    this.terminalBusy = false;
    this.terminalView.toBottom();
    this.requestRender();
  }

  pushTerminalHistory(entry) {
    this.terminalHistory.push({ ...entry, at: Date.now() });
    if (this.terminalHistory.length > 200) this.terminalHistory.shift();
  }

  pushTerminal(line) {
    this.terminalLines.push(line);
    if (this.terminalLines.length > TERMINAL_LIMIT) this.terminalLines.splice(0, this.terminalLines.length - TERMINAL_LIMIT);
  }

  // ------------------------------------------------------- 03 capabilities

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
      title: `Run ${tool.name}`, submitLabel: 'Run',
      note: tool.description,
      fields: [{ name: 'arguments', label: 'arguments json', type: 'textarea', value: JSON.stringify(example, null, 2) }],
      onSubmit: async (values) => {
        const args = safeJsonParse(values.arguments, null);
        if (args === null) throw new Error('Arguments must be valid JSON');
        const result = await this.runtime.toolRegistry.execute(tool.name, args, this.toolContext());
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        this.overlay = new TextOverlay({
          title: `${tool.name} result`,
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

  async withOperation(key, label, operation) {
    if (this.operationLocks.has(key)) {
      this.toast(`${label} is already in progress`, 'warn');
      return null;
    }
    this.operationLocks.add(key);
    this.requestRender();
    try {
      return await operation();
    } finally {
      this.operationLocks.delete(key);
      this.requestRender();
    }
  }

  openPalette() {
    this.overlay = new PaletteOverlay(this.actions);
  }

  openHelp() {
    const theme = this.theme;
    const rows = [
      ['Global', ''],
      ['ctrl+k', 'command palette — every action MaskShift can perform'],
      ['ctrl+p', 'switch chat'],
      ['ctrl+n', 'new chat'],
      ['ctrl+g', 'change model'],
      ['ctrl+o', 'open a different workspace'],
      ['ctrl+b', 'show or hide the sidebar'],
      ['ctrl+r', 'cycle sidebar: plan → active → events'],
      ['ctrl+y', 'focus the sidebar'],
      ['ctrl+v', 'record a voice prompt and transcribe it into the composer'],
      ['1 … 6 / alt+1 … 6', 'jump to a view'],
      ['f1 or ?', 'this reference'],
      ['f2', 'settings'],
      ['f5', 'refresh everything'],
      ['ctrl+c', 'cancel a run, then quit'],
      ['ctrl+q', 'quit immediately'],
      ['', ''],
      ['Chat', ''],
      ['enter', 'execute the prompt'],
      ['ctrl+j', 'newline inside the composer'],
      ['tab', 'move between transcript and composer'],
      ['t', 'expand or collapse tool output'],
      ['esc', 'stop the running task'],
      ['/command', 'slash commands: /model /new /clear /tools /skills /mcp /help'],
      ['', ''],
      ['02 FILES', ''],
      ['enter', 'open a file or fold a directory'],
      ['a', 'attach the selected file to the composer'],
      ['h', 'toggle hidden files'],
      ['', ''],
      ['03 CAPABILITIES', ''],
      ['tab', 'section: tools, skills, mcp, plugins'],
      ['x', 'run a tool directly with JSON arguments'],
      ['enter', 'load a skill body · connect/install a server · toggle a plugin'],
      ['a', 'add an MCP server by hand'],
      ['g', 'toggle installed/registry (mcp tab)'],
      ['', ''],
      ['04 RUNTIME', ''],
      ['tab', 'section: shell, automations, processes, browser instances'],
      ['n', 'new automation or browser instance'],
      ['space', 'arm or pause an automation'],
      ['', ''],
      ['06 GIT', ''],
      ['tab', 'section: changes, log, branches, stash, checkpoints, worktrees'],
      ['space / enter', 'stage or unstage a change · switch branch · apply stash'],
      ['a / u', 'stage all / unstage all'],
      ['c', 'commit'],
      ['d', 'discard a change'],
      ['n', 'new branch, stash, checkpoint or worktree'],
      ['e', 'rename a branch'],
      ['p', 'pop a stash'],
      ['del', 'delete a branch, drop a stash, or remove a worktree'],
      ['P / L / F', 'push / pull / fetch'],
      ['', ''],
      ['07 FLEET', ''],
      ['tab', 'section: members, messages, relays, harnesses'],
      ['n / t', 'add one agent / start a team (Claude Code, Codex, Hermes, OpenCode…)'],
      ['↵ / a / m', 'ask a member · queue a message between members'],
      ['g', 'relay a task: members talk to each other until done'],
      ['s / x / del', 'stop · reset · remove a member'],
    ];
    const lines = rows.map(([key, description]) => {
      if (!key && !description) return '';
      if (!description) return sectionLabel(theme, key);
      return gutter(theme) + typeKey(theme, fit(key, 18)) + theme.paint(description, { fg: theme.roles.muted });
    });
    this.overlay = new TextOverlay({ title: 'Keyboard shortcuts', lines, stamp: 'esc closes' });
  }

  openSessionSummary() {
    const summary = this.compaction?.summary;
    if (!summary) { this.toast('Nothing summarized yet — this session still fits the model\'s window', 'info'); return; }
    const width = Math.min(this.screen.size.columns - 8, 90);
    const lines = renderMarkdown(this.theme, summary, width);
    const stamp = this.compaction.updatedAt ? `updated ${this.stamp(this.compaction.updatedAt)}` : 'esc closes';
    this.overlay = new TextOverlay({ title: 'Chat summary', lines, stamp });
  }

  openSessionPicker() {
    const sessions = this.runtime.store.listSessions({ workspaceId: this.workspaceId, limit: 200 });
    const mark = glyphs(this.theme);
    const lastAsked = new Map();
    this.overlay = new PickerOverlay({
      title: 'Chats',
      placeholder: 'Filter chats…',
      items: sessions.map((session) => ({
        id: session.id, label: session.title || 'Untitled', session,
        detail: `${session.meta?.compaction?.summary ? `${mark.diamond} ` : ''}${session.model_id || ''} · ${this.stamp(session.updated_at)}`,
        tone: session.id === this.sessionId ? this.theme.roles.primary : undefined,
      })),
      selectedId: this.sessionId,
      // What the chat was for and where it stands, so picking one is not a guess from its title.
      preview: (app, item, width) => {
        if (!lastAsked.has(item.id)) {
          const messages = this.runtime.store.listMessages(item.id, 200);
          lastAsked.set(item.id, [...messages].reverse().find((message) => message.role === 'user') || null);
        }
        return sessionPreviewLines(this.theme, item.session, lastAsked.get(item.id), width, (value) => this.stamp(value));
      },
      onSelect: (item) => this.requestSessionLoad(item.id),
    });
  }

  /** Grep every session in this workspace's history for a phrase — "when did
   *  I ask about X" — rather than only the currently open one. Selecting a
   *  result switches to the session it was found in. */
  openSearchResults(query) {
    const trimmed = String(query || '').trim();
    if (!trimmed) { this.toast('Usage: /search <text>', 'warn'); return; }
    const results = this.runtime.store.searchMessages(trimmed, { workspaceId: this.workspaceId, limit: 60 });
    if (!results.length) { this.toast(`No messages matching "${trimmed}"`, 'info'); return; }
    const needle = trimmed.toLowerCase();
    this.overlay = new PickerOverlay({
      title: `Search: ${trimmed}`,
      placeholder: 'Filter results…',
      footer: `${results.length} message${results.length === 1 ? '' : 's'} across this workspace's history`,
      items: results.map((result) => {
        const flat = result.content.replace(/\s+/g, ' ').trim();
        const at = flat.toLowerCase().indexOf(needle);
        const around = at < 0 ? flat.slice(0, 96) : flat.slice(Math.max(0, at - 32), at + needle.length + 64);
        return {
          id: result.messageId, sessionId: result.sessionId,
          label: `${at < 0 ? '' : '… '}${around}${flat.length > around.length ? ' …' : ''}`,
          detail: `${result.sessionTitle || 'Untitled'} · ${result.role} · ${this.stamp(result.createdAt)}`,
          tone: result.sessionId === this.sessionId ? this.theme.roles.primary : undefined,
        };
      }),
      onSelect: (item) => this.requestSessionLoad(item.sessionId),
    });
  }

  openModelPicker() {
    const items = [];
    for (const provider of this.providers) {
      for (const model of provider.models || []) {
        const reference = `${provider.id}:${model.id || model}`;
        items.push({ id: reference, label: reference, detail: provider.status === 'online' ? provider.name : `${provider.name} (offline)`, tone: reference === this.modelRef ? this.theme.roles.primary : undefined });
      }
      const autoId = `${provider.id}:auto`;
      items.push({ id: autoId, label: autoId, detail: `${provider.name} — best available`, tone: autoId === this.modelRef ? this.theme.roles.primary : undefined });
    }
    this.overlay = new PickerOverlay({
      title: 'Choose model',
      placeholder: 'Filter models…',
      footer: 'Providers are probed at startup; press f5 to re-discover.',
      items,
      selectedId: this.modelRef,
      onSelect: (item) => {
        this.modelRef = item.id;
        void this.refreshModelProfile();
        if (this.sessionId) this.runtime.store.updateSession(this.sessionId, { model_id: item.id });
        this.toast(`Model set to ${item.id}`, 'success');
      },
    });
  }

  openWorkspaceDialog({ force = false } = {}) {
    if (!force && (this.busy || this.composer.value || this.promptQueue.length)) {
      this.overlay = new ConfirmOverlay({
        title: 'Switch workspace', danger: Boolean(this.busy || this.promptQueue.length),
        message: this.busy || this.promptQueue.length
          ? 'Cancel the active run, discard queued requests and the current draft, then choose another workspace?'
          : 'Discard the current draft and choose another workspace?',
        onConfirm: async () => {
          if (this.busy) this.cancelRun();
          this.promptQueue = [];
          this.composer.clear();
          this.openWorkspaceDialog({ force: true });
        },
      });
      return;
    }
    this.overlay = new FormOverlay({
      title: 'Open workspace', submitLabel: 'Open and index',
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
        await this.runtime.personaManager.setWorkspace(workspace.path);
        this.runtime.pluginManager.workspacePath = workspace.path;
        await this.runtime.pluginManager.scan({ activate: true });
        this.refreshCatalogs();
        this.newSession({ silent: true });
        await this.loadFileTree({ force: true });
        await this.refreshGit();
        if (values.index) void this.runtime.indexer.index(workspace.id, { force: true }).catch(() => {});
        this.toast(`Workspace set: ${workspace.name}`, 'success');
      },
    });
  }

  /** Step the permission mode along. Bound to a click on the header chip. */
  async cyclePermissionMode() {
    const modes = ['autonomous', 'balanced', 'review'];
    const current = this.runtime.config.get().permissionMode || 'autonomous';
    const next = modes[(modes.indexOf(current) + 1) % modes.length];
    await this.runtime.config.update({ permissionMode: next });
    this.toast(`Permission mode: ${next}`, 'info');
  }

  /**
   * Mouse reporting suppresses the terminal's own selection, so it has to be
   * reachable without knowing the environment variable. Most terminals still
   * select on shift+drag while tracking is on.
   */
  async setMouseMode(mode) {
    if (!MOUSE_MODES.includes(mode)) return;
    this.screen.setMouse(mode);
    const ui = { ...(this.runtime.config.get().ui || {}), mouse: mode };
    await this.runtime.config.update({ ui });
    this.toast(mode === 'off'
      ? 'Mouse off — the terminal owns selection again'
      : `Mouse: ${mode} (shift+drag still selects text)`, 'info');
  }

  /** What the learning layer knows, in plain words: what it will tell the model, who it trusts, and what it has noticed. */
  async openLearned() {
    try {
      const status = this.runtime.learningManager.status({ workspaceId: this.workspaceId });
      const pct = (value) => `${Math.round(value * 100)}%`;
      const lines = [`Learned from ${status.runs} run${status.runs === 1 ? '' : 's'} on this machine. Everything stays here; \`maskshift learn forget ID\` removes anything.`, ''];
      if (status.preferences.length) {
        lines.push('What you have told it');
        for (const item of status.preferences.slice(0, 8)) lines.push(`  ${item.active ? '●' : '○'} ${item.text}${item.active ? '' : '  (said once; not applied yet)'}`);
        lines.push('');
      }
      if (status.lessons.length) {
        lines.push('Lessons from earlier runs');
        for (const item of status.lessons.slice(0, 8)) lines.push(`  • ${item.text}  [seen ${item.occurrences}×, trusted ${pct(item.confidence)}]`);
        lines.push('');
      }
      if (status.executors.length) {
        lines.push('Track record');
        for (const item of status.executors.slice(0, 8)) lines.push(`  ${fit(item.executor, 34)} ${fit(`${item.runs} runs`, 9)} ${pct(item.rate)} went well`);
        lines.push('');
      }
      const proposed = status.skills.filter((item) => item.status === 'proposed');
      if (proposed.length) lines.push(`${proposed.length} repeated workflow${proposed.length === 1 ? '' : 's'} could become a skill: open the palette → "Skills found in your repeated workflows".`, '');
      if (!status.runs) lines.push('Nothing yet. It builds up as you work.');
      this.overlay = new TextOverlay({ title: 'What MaskShift has learned', lines: lines.flatMap((line) => wrap(line, 92)), stamp: 'esc closes' });
    } catch (error) { this.toast(error.message, 'error'); }
    this.requestRender();
  }

  /** Workflows found in your own runs, offered as skills. Picking one installs it. */
  openMinedSkills() {
    const miner = this.runtime.learningManager.miner;
    // What the background pass already found; only look afresh when it has found nothing.
    const known = miner.candidates(this.workspaceId).filter((item) => item.status === 'proposed');
    const found = known.length ? known : miner.mine({ workspaceId: this.workspaceId }).filter((item) => item.status === 'proposed');
    if (!found.length) { this.toast('No repeated workflows found yet — they need to show up in at least three runs', 'info'); return; }
    this.overlay = new PickerOverlay({
      title: 'Install a skill from your own workflows', placeholder: 'Filter…',
      items: found.map((item) => ({ id: item.id, label: item.name, detail: `${item.support} runs · ${Math.round(item.successRate * 100)}% went well`, item })),
      preview: (_app, entry, width) => wrap(entry.item.steps.map((step) => step.replace(/^shell:/, '')).join(' → '), Math.max(20, width - 2)),
      onSelect: (entry) => void miner.accept(this.workspaceId, entry.id).then(() => this.toast(`Installed skill ${entry.label}`, 'success')).catch((error) => this.toast(error.message, 'error')),
    });
  }

  /** Disk use, as a read-only report: what is stored, the budget this machine implies, and what to do about it. */
  async openStorage() {
    try {
      const status = await this.runtime.storageManager.status();
      const { usage, budget } = status;
      const row = (label, value, extra = '') => `${fit(label, 30)}${fit(value, 12)}${extra}`;
      const lines = [
        row('Database (index, chats, runs)', formatBytes(usage.database), `of ${formatBytes(budget.share.index + budget.share.other * 0.5)}`),
        row('Checkpoints (undo points)', formatBytes(usage.checkpoints), `of ${formatBytes(budget.share.checkpoints)}`),
        row('Browser profiles, logs, caches', formatBytes(usage.other), `of ${formatBytes(budget.share.other * 0.5)}`),
        row('Total', formatBytes(usage.total), `of ${formatBytes(budget.total)} budget`),
        '',
        `This machine: ${formatBytes(budget.host.diskFree)} free of ${formatBytes(budget.host.diskTotal)} · ${formatBytes(budget.host.memTotal)} memory · disk pressure ${status.pressure}`,
        `Per workspace index: up to ${formatBytes(budget.index.maxTextBytes)} of text, ${budget.index.maxFiles} files · checkpoints kept: ${budget.checkpoints.keepPerWorkspace} / ${budget.checkpoints.maxAgeDays} days`,
        '',
        ...(status.advice.length ? status.advice.map((line) => `▲ ${line}`) : ['Within budget.']),
        '',
        'Limits are derived from this machine; override them under "storage" in your config. Use the palette to free space.',
      ];
      this.overlay = new TextOverlay({ title: 'Disk use', lines: lines.flatMap((line) => wrap(line, 92)), stamp: 'esc closes' });
    } catch (error) { this.toast(error.message, 'error'); }
    this.requestRender();
  }

  /** Show what a cleanup would remove, then ask. Chats, memory and workspace files are never in the list. */
  async confirmStoragePrune() {
    try {
      const plan = await this.runtime.storageManager.prune({ dryRun: true });
      if (!plan.actions.length) { this.toast('Nothing to clean up', 'success'); return; }
      const names = { checkpoint: 'old checkpoints', 'orphan-checkpoint': 'orphaned checkpoint folders', index: 'search indexes', 'run-events': 'old run event batches', 'rotate-log': 'oversized logs' };
      this.overlay = new ConfirmOverlay({
        title: 'Free up space', danger: true,
        message: `Remove about ${formatBytes(plan.wouldFreeBytes)}? Chats, memory and your files are not touched; search indexes rebuild when needed.`,
        details: Object.entries(plan.summary).map(([type, count]) => `  ${count} × ${names[type] || type}`),
        onConfirm: async () => {
          const result = await this.runtime.storageManager.prune({ dryRun: false });
          this.toast(`Freed ${formatBytes(result.freedBytes)}`, 'success');
        },
      });
    } catch (error) { this.toast(error.message, 'error'); }
    this.requestRender();
  }

  openSettings() {
    const config = this.runtime.config.get();
    this.overlay = new FormOverlay({
      title: 'Settings', submitLabel: 'Confirm',
      note: 'Stored in your MaskShift home configuration and applied immediately.',
      fields: [
        { name: 'defaultModel', label: 'default model', value: config.defaultModel },
        {
          name: 'permissionMode', label: 'permission mode', type: 'select', value: config.permissionMode,
          options: [
            { label: 'Autonomous', value: 'autonomous' }, { label: 'Balanced', value: 'balanced' }, { label: 'Review', value: 'review' },
          ],
        },
        { name: 'maxAgentSteps', label: 'max agent turns', value: String(config.maxAgentSteps) },
        { name: 'maxParallelSubagents', label: 'max parallel subagents', value: String(config.maxParallelSubagents) },
        { name: 'autoIndex', label: 'index workspaces automatically', type: 'toggle', value: config.autoIndex },
        { name: 'autoCheckpoint', label: 'auto checkpoint before run', type: 'toggle', value: config.autoCheckpoint },
        { name: 'autoLoadCapabilities', label: 'auto prime capabilities', type: 'toggle', value: config.autoLoadCapabilities },
        {
          name: 'mouse', label: 'mouse', type: 'select', value: this.screen.mouse,
          options: [
            { label: 'Click', value: 'click' },
            { label: 'Click and hover', value: 'hover' },
            { label: 'Off (terminal selects)', value: 'off' },
          ],
        },
        { name: 'voiceEnabled', label: 'voice input (ctrl+v)', type: 'toggle', value: config.voice?.enabled !== false },
        {
          name: 'voiceTranscribeCommand', label: 'voice transcribe command', value: config.voice?.transcribeCommand || '',
          hint: 'whisper-cli -f {audio} -otxt -of {output} (blank disables voice input)',
        },
        {
          name: 'voiceRecordCommand', label: 'voice record command (optional)', value: config.voice?.recordCommand || '',
          hint: 'blank uses ffmpeg\'s default microphone input for this OS',
        },
        { name: 'notifyEnabled', label: 'desktop notification on finish', type: 'toggle', value: config.notifications?.enabled === true },
        {
          name: 'notifyCommand', label: 'notification command (optional)', value: config.notifications?.command || '',
          hint: 'blank uses this OS\'s own notifier (osascript/notify-send/PowerShell)',
        },
        {
          name: 'notifyMinDuration', label: 'notify only past (seconds)', value: String(Math.round((config.notifications?.minDurationMs ?? 15_000) / 1000)),
          hint: 'skips the notification for a run shorter than this',
        },
        {
          name: 'costBudget', label: 'session cost budget (optional)', value: config.costBudget?.session != null ? String(config.costBudget.session) : '',
          hint: 'e.g. 5 — warns once this session\'s cost crosses $5, blank disables it',
        },
      ],
      onSubmit: async (values) => {
        const voice = {
          ...(config.voice || {}),
          enabled: values.voiceEnabled,
          transcribeCommand: values.voiceTranscribeCommand?.trim() || null,
          recordCommand: values.voiceRecordCommand?.trim() || null,
        };
        const notifications = {
          ...(config.notifications || {}),
          enabled: values.notifyEnabled,
          command: values.notifyCommand?.trim() || null,
          minDurationMs: Math.max(0, Number(values.notifyMinDuration) || 0) * 1000,
        };
        const budgetValue = values.costBudget?.trim();
        const costBudget = { ...(config.costBudget || {}), session: budgetValue ? Number(budgetValue) || null : null };
        await this.runtime.config.update({
          defaultModel: values.defaultModel,
          permissionMode: values.permissionMode,
          maxAgentSteps: Number(values.maxAgentSteps) || config.maxAgentSteps,
          maxParallelSubagents: Number(values.maxParallelSubagents) || config.maxParallelSubagents,
          autoIndex: values.autoIndex,
          autoCheckpoint: values.autoCheckpoint,
          autoLoadCapabilities: values.autoLoadCapabilities,
          ui: { ...(config.ui || {}), mouse: values.mouse },
          voice,
          notifications,
          costBudget,
        });
        this.autoLoad = values.autoLoadCapabilities;
        this.screen.setMouse(values.mouse);
        this.voice = new VoiceInput(voice);
        this.costBudgetWarned = false;
        this.toast('Settings saved', 'success');
      },
    });
  }

  // ----------------------------------------------------------------- actions

  buildActions() {
    const action = (id, group, label, key = '') => ({ id, group, label, key });
    return [
      action('run.new', 'chat', 'New chat', 'ctrl+n'),
      action('run.switch', 'chat', 'Switch chat', 'ctrl+p'),
      action('run.cancel', 'chat', 'Stop the running task', 'esc'),
      action('run.rename', 'chat', 'Rename this chat'),
      action('run.delete', 'chat', 'Delete this chat'),
      action('run.summary', 'chat', 'Read the session summary', 's'),
      action('run.changes', 'chat', 'Review what the last run changed', 'ctrl+d'),
      action('run.undo', 'chat', 'Undo the last run\'s file changes', 'ctrl+z'),
      action('voice.capture', 'chat', 'Record a voice prompt', 'ctrl+v'),
      action('model.pick', 'model', 'Change model', 'ctrl+g'),
      action('model.discover', 'model', 'Re-discover providers and models'),
      action('workspace.open', 'workspace', 'Open workspace', 'ctrl+o'),
      action('workspace.index', 'workspace', 'Rebuild the context index'),
      action('learn.status', 'learning', 'What MaskShift has learned: lessons, preferences, track record'),
      action('learn.skills', 'learning', 'Skills found in your repeated workflows'),
      action('storage.status', 'storage', 'Disk use: usage and the budget for this machine'),
      action('storage.prune', 'storage', 'Disk use: free up space (old checkpoints, stale indexes)'),
      action('workspace.inspect', 'workspace', 'Inspect the workspace'),
      action('workspace.checkpoint', 'workspace', 'Create a checkpoint'),
      action('workspace.restore', 'workspace', 'Restore a checkpoint'),
      action('view.chat', 'view', 'Go to 01 CHAT', '1'),
      action('view.files', 'view', 'Go to 02 FILES', '2'),
      action('view.capabilities', 'view', 'Go to 03 CAPABILITIES', '3'),
      action('view.runtime', 'view', 'Go to 04 RUNTIME', '4'),
      action('view.browser', 'view', 'Go to 05 BROWSER', '5'),
      action('view.git', 'view', 'Go to 06 GIT', '6'),
      action('view.fleet', 'view', 'Go to 07 FLEET', '7'),
      action('fleet.spawn', 'fleet', 'Add an agent to the fleet'),
      action('fleet.team', 'fleet', 'Start a multi-agent team'),
      action('fleet.relay', 'fleet', 'Run the fleet on a task'),
      action('browser.pick', 'view', 'Pick a browser tab to watch'),
      action('rail.toggle', 'sidebar', 'Show or hide the sidebar', 'ctrl+b'),
      action('rail.plan', 'sidebar', 'Sidebar: plan'),
      action('rail.telemetry', 'sidebar', 'Sidebar: active tools'),
      action('rail.events', 'sidebar', 'Sidebar: events'),
      action('mcp.add', 'capabilities', 'Add an MCP server'),
      action('mcp.registry', 'capabilities', 'Search the official MCP registry'),
      action('mcp.connectAll', 'capabilities', 'Connect every configured MCP server'),
      action('mcp.refresh', 'capabilities', 'Refresh MCP servers'),
      action('capabilities.plugin', 'capabilities', 'Install a plugin'),
      action('capabilities.refresh', 'capabilities', 'Refresh plugins'),
      action('tools.search', 'capabilities', 'Search tools'),
      action('skills.search', 'capabilities', 'Search skills'),
      action('capabilities.toggleTools', 'capabilities', 'Expand or collapse tool output', 't'),
      action('runtime.automation', 'runtime', 'New automation'),
      action('runtime.browser', 'runtime', 'Launch a browser'),
      action('runtime.refresh', 'runtime', 'Refresh automations, processes and browser instances'),
      action('git.push', 'git', 'Push'),
      action('git.pull', 'git', 'Pull'),
      action('git.fetch', 'git', 'Fetch'),
      action('git.commit', 'git', 'Commit staged changes'),
      action('git.refresh', 'git', 'Refresh git view'),
      action('mouse.cycle', 'system', 'Mouse: click / click + hover / off'),
      action('permission.cycle', 'system', 'Cycle the permission mode'),
      action('doctor', 'system', 'Run diagnostics'),
      action('settings', 'system', 'Settings', 'f2'),
      action('logs', 'system', 'Tail the MaskShift log'),
      action('help', 'system', 'Key reference', 'f1'),
      action('refresh', 'system', 'Refresh everything', 'f5'),
      action('quit', 'system', 'Quit MaskShift', 'ctrl+q'),
    ];
  }

  async runAction(id) {
    try {
      switch (id) {
      case 'run.new': this.requestNewSession(); break;
      case 'run.switch': this.openSessionPicker(); break;
      case 'run.cancel': this.cancelRun(); break;
      case 'run.rename': this.openRenameDialog(); break;
      case 'run.delete': this.confirmDeleteSession(); break;
      case 'run.summary': this.openSessionSummary(); break;
      case 'run.changes': void this.openRunChanges(); break;
      case 'run.undo': void this.openUndoLastRun(); break;
      case 'voice.capture': await this.startVoiceCapture(); break;
      case 'model.pick': this.openModelPicker(); break;
      case 'model.discover': await this.discoverProviders(); this.toast('Providers re-discovered', 'success'); break;
      case 'workspace.open': this.openWorkspaceDialog(); break;
      case 'workspace.index': void this.reindex(); break;
      case 'learn.status': void this.openLearned(); break;
      case 'learn.skills': this.openMinedSkills(); break;
      case 'storage.status': void this.openStorage(); break;
      case 'storage.prune': void this.confirmStoragePrune(); break;
      case 'workspace.inspect': void this.showInspection(); break;
      case 'workspace.checkpoint': void this.createCheckpoint(); break;
      case 'workspace.restore': this.openCheckpointPicker(); break;
      case 'mouse.cycle': {
        const next = MOUSE_MODES[(MOUSE_MODES.indexOf(this.screen.mouse) + 1) % MOUSE_MODES.length];
        await this.setMouseMode(next);
        break;
      }
      case 'permission.cycle': await this.cyclePermissionMode(); break;
      case 'view.chat': this.switchView(0); break;
      case 'view.files': this.switchView(1); break;
      case 'view.capabilities': this.switchView(2); break;
      case 'view.runtime': this.switchView(3); break;
      case 'view.browser': this.switchView(4); break;
      case 'view.git': this.switchView(5); break;
      case 'view.fleet': this.switchView(6); break;
      case 'fleet.spawn': this.switchView(6); fleetView.openSpawn(this); break;
      case 'fleet.team': this.switchView(6); fleetView.openTeam(this); break;
      case 'fleet.relay': this.switchView(6); fleetView.openRelay(this); break;
      case 'browser.pick': this.openBrowserTargetPicker(); break;
      case 'rail.toggle': this.railVisible = !this.railVisible; this.screen.invalidate(); break;
      case 'rail.plan': this.railTab = 'plan'; this.railVisible = true; break;
      case 'rail.telemetry': this.railTab = 'telemetry'; this.railVisible = true; break;
      case 'rail.events': this.railTab = 'events'; this.railVisible = true; break;
      case 'mcp.add': this.switchView(2); this.capabilitiesTab = 'mcp'; this.openMcpDialog(); break;
      case 'mcp.registry': this.switchView(2); this.capabilitiesTab = 'mcp'; this.mcpMode = 'registry'; this.focus = 'capabilities-filter'; break;
      case 'mcp.connectAll': await this.connectAllMcp(); break;
      case 'mcp.refresh': await this.refreshMcp(); this.toast('MCP refreshed', 'success'); break;
      case 'capabilities.plugin': this.switchView(2); this.capabilitiesTab = 'plugins'; this.openPluginDialog(); break;
      case 'capabilities.refresh': await this.refreshCapabilitiesExtras({ force: true }); this.toast('Plugins refreshed', 'success'); break;
      case 'tools.search': this.switchView(2); this.capabilitiesTab = 'tools'; this.focus = 'capabilities-filter'; break;
      case 'skills.search': this.switchView(2); this.capabilitiesTab = 'skills'; this.focus = 'capabilities-filter'; break;
      case 'capabilities.toggleTools': this.expandTools = !this.expandTools; break;
      case 'runtime.automation': this.switchView(3); this.runtimeTab = 'automations'; this.openAutomationDialog(); break;
      case 'runtime.browser': this.switchView(3); this.runtimeTab = 'browsers'; this.openBrowserDialog(); break;
      case 'runtime.refresh': await this.refreshRuntimeExtras({ force: true }); this.toast('Runtime refreshed', 'success'); break;
      case 'git.push': void this.gitPush(); break;
      case 'git.pull': void this.gitPull(); break;
      case 'git.fetch': void this.gitFetch(); break;
      case 'git.commit': this.switchView(5); this.gitTab = 'changes'; this.openGitCommitDialog(); break;
      case 'git.refresh': await this.refreshGitView({ force: true }); this.toast('Git view refreshed', 'success'); break;
      case 'doctor': await this.showDoctor(); break;
      case 'settings': this.openSettings(); break;
      case 'logs': await this.showLogs(); break;
      case 'storage': await this.openStorage(); break;
      case 'learned': case 'learning': await this.openLearned(); break;
      case 'help': this.openHelp(); break;
      case 'refresh': this.refreshAll(); break;
      case 'quit': this.stop(0); break;
        default: this.toast(`Unknown action: ${id}`, 'warn');
      }
    } catch (error) {
      this.toast(error.message, 'error');
    }
    this.requestRender();
  }

  refreshAll() {
    this.refreshCatalogs();
    void this.discoverProviders();
    void this.loadFileTree({ force: true });
    void this.refreshGit();
    void this.refreshCapabilitiesExtras({ force: true });
    void this.refreshRuntimeExtras({ force: true });
    void this.refreshGitView({ force: true });
    this.screen.invalidate();
    this.toast('Everything refreshed', 'success');
  }

  openRenameDialog() {
    this.overlay = new FormOverlay({
      title: 'Rename chat', submitLabel: 'Rename',
      fields: [{ name: 'title', label: 'title', value: this.sessionTitle }],
      onSubmit: (values) => {
        if (!this.sessionId) throw new Error('No active chat');
        this.runtime.store.updateSession(this.sessionId, { title: values.title });
        this.sessionTitle = values.title;
        this.toast('Renamed', 'success');
      },
    });
  }

  confirmDeleteSession() {
    if (!this.sessionId) return;
    if (this.busy) { this.toast('Cancel the active run before deleting this chat', 'warn'); return; }
    this.overlay = new ConfirmOverlay({
      title: 'Delete chat', danger: true,
      message: `Delete "${this.sessionTitle}" and every message in it?`,
      onConfirm: () => {
        this.runtime.store.deleteSession(this.sessionId);
        this.toast('Chat deleted', 'warn');
        this.openLatestSession();
      },
    });
  }

  async reindex() {
    if (!this.workspaceId) return;
    return this.withOperation(`index:${this.workspaceId}`, 'Workspace indexing', async () => {
      this.toast('Indexing the workspace…', 'info');
      try {
        const stats = await this.runtime.indexer.index(this.workspaceId, { force: true });
        this.toast(`Indexed ${stats.files ?? stats.chunks ?? 0} entries`, 'success');
      } catch (error) {
        this.toast(error.message, 'error');
      }
    });
  }

  async showInspection() {
    if (!this.workspaceId) return;
    try {
      const report = await this.runtime.workspaceManager.inspect(this.workspaceId);
      const theme = this.theme;
      const lines = [
        theme.paint(report.workspace.path, { fg: theme.roles.accent, bold: true }),
        '',
        theme.paint(`Files: ${report.files.count}${report.files.truncated ? '+' : ''}`, { fg: theme.roles.text }),
        theme.paint(`Git: ${report.git ? report.git.root : 'not a repository'}`, { fg: theme.roles.text }),
        theme.paint(`Project files: ${report.projectFiles.join(', ') || 'none'}`, { fg: theme.roles.text }),
        theme.paint(`Context files: ${report.contextFiles.map((file) => file.path).join(', ') || 'none'}`, { fg: theme.roles.text }),
        '',
        sectionLabel(theme, 'Languages'),
        ...report.languages.map(([extension, count]) => gutter(theme) + theme.paint(`${fit(extension, 12)}${count}`, { fg: theme.roles.muted })),
        '',
        sectionLabel(theme, 'Git status'),
        ...String(report.git?.status || '').split('\n').map((line) => gutter(theme) + theme.paint(line, { fg: theme.roles.muted })),
      ];
      this.overlay = new TextOverlay({ title: 'Workspace details', lines });
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  async createCheckpoint() {
    if (!this.workspaceId) return;
    return this.withOperation(`checkpoint:${this.workspaceId}`, 'Checkpoint creation', async () => {
      try {
        const checkpoint = await this.runtime.workspaceManager.createCheckpoint(this.workspaceId, { label: 'manual' });
        this.toast(`Checkpoint ${checkpoint.kind} saved`, 'success');
      } catch (error) {
        this.toast(error.message, 'error');
      }
    });
  }

  /** The newest run in this chat that has a pre-run checkpoint, and that checkpoint. */
  lastUndoableRun() {
    const runs = this.runtime.store.listRuns({ sessionId: this.sessionId, limit: 50 });
    const checkpoints = this.runtime.store.listCheckpoints(this.workspaceId, 500);
    for (const run of runs) {
      const checkpoint = checkpoints.find((item) => item.run_id === run.id || item.id === run.meta?.checkpointId);
      if (checkpoint) return { run, checkpoint };
    }
    return null;
  }

  /** Files the last undoable run changed, grouped for the changes pane. */
  async runChangeSet() {
    const found = this.lastUndoableRun();
    if (!found) return null;
    const changes = await this.runtime.workspaceManager.checkpointChanges(this.workspaceId, found.checkpoint).catch(() => null);
    if (!changes) return null;
    const files = [
      ...changes.modified.map((path) => ({ path, kind: 'modified' })),
      ...changes.created.map((path) => ({ path, kind: 'created' })),
      ...changes.deleted.map((path) => ({ path, kind: 'deleted' })),
    ];
    return { ...found, changes, files };
  }

  async refreshLastRunChanges() {
    const sessionId = this.sessionId;
    const set = this.workspaceId && sessionId ? await this.runChangeSet().catch(() => null) : null;
    if (sessionId !== this.sessionId) return;
    this.lastRunChanges = set?.files.length ? { runId: set.run.id, files: set.files } : null;
    this.requestRender();
  }

  async openRunChanges() {
    if (!this.workspaceId || !this.sessionId) return;
    const set = await this.runChangeSet();
    if (!set) { this.toast('No run in this chat has a checkpoint to compare against', 'warn'); return; }
    if (!set.files.length) { this.toast('The last run left the files exactly as it found them', 'info'); return; }
    this.overlay = new ChangesOverlay({
      subtitle: oneLine(set.run.prompt || '', 60),
      files: set.files,
      loadDiff: (file) => this.runtime.workspaceManager.checkpointFileDiff(this.workspaceId, set.checkpoint, file),
      onUndo: () => { this.closeOverlay(); void this.openUndoLastRun(); },
    });
  }

  async openUndoLastRun() {
    if (!this.workspaceId || !this.sessionId) return;
    if (this.busy) { this.toast('Cancel the running task before undoing it', 'warn'); return; }
    const found = this.lastUndoableRun();
    if (!found) {
      this.toast(this.runtime.config.get().autoCheckpoint ? 'No run in this chat has a checkpoint to go back to' : 'Checkpoints are off (F2 → auto checkpoint), so there is nothing to undo to', 'warn');
      return;
    }
    const { run, checkpoint } = found;
    const changes = await this.runtime.workspaceManager.checkpointChanges(this.workspaceId, checkpoint).catch(() => null);
    const total = changes ? changes.modified.length + changes.created.length + changes.deleted.length : null;
    if (total === 0) { this.toast('Nothing to undo — the files already match the checkpoint before that run', 'info'); return; }
    const { theme } = this;
    const rows = changes ? [
      ...changes.modified.map((file) => [theme.paint('M ', { fg: theme.roles.warning, bold: true }), file, 'restored']),
      ...changes.created.map((file) => [theme.paint('+ ', { fg: theme.roles.success, bold: true }), file, 'removed']),
      ...changes.deleted.map((file) => [theme.paint('- ', { fg: theme.roles.danger, bold: true }), file, 'brought back']),
    ] : [];
    const details = rows.slice(0, 12).map(([mark, file, what]) => mark + theme.paint(file, { fg: theme.roles.text }) + theme.paint(`  ${what}`, { fg: theme.roles.muted }));
    if (rows.length > 12) details.push(theme.paint(`… and ${rows.length - 12} more`, { fg: theme.roles.faint, italic: true }));
    const title = oneLine(run.prompt || 'the last run', 48);
    this.overlay = new ConfirmOverlay({
      title: 'Undo last run', danger: true,
      message: changes
        ? `Put ${total} file${total === 1 ? '' : 's'} back the way they were before “${title}”?`
        : `Restore the workspace to the checkpoint taken before “${title}”? Uncommitted changes since then will be replaced.`,
      details,
      onConfirm: async () => {
        const result = await this.runtime.workspaceManager.undoToCheckpoint(this.workspaceId, checkpoint);
        const count = result.changes ? result.changes.modified.length + result.changes.deleted.length + result.removed.length : null;
        this.toast(count === null ? 'Run undone' : `Run undone — ${count} file${count === 1 ? '' : 's'} restored`, 'success');
        this.lastRunChanges = null;
        await this.loadFileTree({ force: true });
        await this.refreshGit();
      },
    });
  }

  openCheckpointPicker() {
    if (!this.workspaceId) return;
    if (this.busy) { this.toast('Cancel the active run before restoring a checkpoint', 'warn'); return; }
    const checkpoints = this.runtime.store.listCheckpoints(this.workspaceId, 100);
    if (!checkpoints.length) { this.toast('No checkpoints recorded', 'warn'); return; }
    this.overlay = new PickerOverlay({
      title: 'Restore checkpoint',
      placeholder: 'Filter checkpoints…',
      items: checkpoints.map((checkpoint) => ({
        id: checkpoint.id, label: `${checkpoint.kind} ${checkpoint.ref || ''}`.trim(),
        detail: `${this.stamp(checkpoint.created_at)} · ${checkpoint.manifest?.label || ''}`,
      })),
      onSelect: (item) => {
        const checkpoint = checkpoints.find((entry) => entry.id === item.id);
        this.overlay = new ConfirmOverlay({
          title: 'Restore', danger: true,
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
      theme.paint(`MaskShift ${this.version}  ·  node ${process.version}  ·  ${process.platform}/${process.arch}`, { fg: theme.roles.accent, bold: true }),
      '',
      theme.paint(`Home       ${config.home}`, { fg: theme.roles.text }),
      theme.paint(`Database   ${config.dataFile}`, { fg: theme.roles.text }),
      theme.paint(`Mode       ${config.permissionMode}`, { fg: theme.roles.text }),
      theme.paint(`Tools ${this.counts.tools}  Skills ${this.counts.skills}  MCP ${this.counts.mcp}`, { fg: theme.roles.text }),
      '',
      sectionLabel(theme, 'Providers'),
      ...providers.map((provider) => gutter(theme, provider.status === 'online' ? '✓' : '·', {
        tone: provider.status === 'online' ? theme.roles.success : theme.roles.muted,
      }) + theme.paint(
        `${fit(provider.id, 14)}${provider.status}${provider.error ? ` — ${provider.error}` : ''}`,
        { fg: provider.status === 'online' ? theme.roles.text : theme.roles.muted },
      )),
    ];
    this.overlay = new TextOverlay({ title: 'Diagnostics', lines });
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
      this.overlay = new TextOverlay({ title: 'Log', lines: lines.length ? lines : ['No entries yet.'] });
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  // ----------------------------------------------------------- slash commands

  // The list of slash commands matching what's currently typed in the composer,
  // or null when the composer isn't in "typing a bare command" shape (a slash
  // followed by nothing but letters). Shared by the suggestion panel in paint()
  // and by tab-completion in the chat view's key handler, so the two stay in sync.
  matchingSlashCommands() {
    const typed = this.composer.value;
    if (!/^\/[a-z]*$/i.test(typed)) return null;
    const prefix = typed.slice(1).toLowerCase();
    return [...SLASH_COMMANDS, ...this.customCommands].filter((entry) => entry.name.startsWith(prefix));
  }

  async refreshCustomCommands() {
    if (!this.workspace) return [];
    const reserved = new Set(SLASH_COMMANDS.map((entry) => entry.name).concat(['exit']));
    this.customCommands = await loadCustomCommands(commandDirectories(this.workspace.path, this.runtime.config.get().home), reserved)
      .catch(() => []);
    return this.customCommands;
  }

  async runCustomCommand(command, argument) {
    const prompt = expandCommand(command, argument);
    this.view = 'chat';
    this.transcript.toBottom();
    if (this.busy) {
      this.promptQueue.push({ id: `queued-${Date.now()}-${this.promptQueue.length}`, prompt, queuedAt: Date.now() });
      this.toast(`/${command.name} queued (${this.promptQueue.length})`, 'info');
      return;
    }
    await this.startPrompt(prompt);
  }

  async compactNow() {
    if (!this.sessionId) return;
    if (this.busy) { this.toast('Wait for the running task to finish, then compact', 'warn'); return; }
    this.toast('Summarizing older turns…', 'info');
    try {
      const result = await this.runtime.engine.compactSession(this.sessionId, { modelRef: this.modelRef });
      if (!result.compacted) { this.toast(result.reason, 'info'); return; }
      this.compaction = this.runtime.store.getSession(this.sessionId)?.meta?.compaction || this.compaction;
      this.toast(`Summarized ${result.turns} turn${result.turns === 1 ? '' : 's'} — later requests send the summary instead`, 'success');
    } catch (error) {
      this.toast(error.message, 'error');
    }
  }

  async openContextReport(prompt = '') {
    const { theme } = this;
    const mark = glyphs(theme);
    let plan = null;
    let label = 'Last request';
    if (prompt.trim() && this.workspaceId) {
      const profile = this.modelProfile;
      const maxChars = profile ? Math.min(this.runtime.config.get().maxContextChars, Math.floor(profile.contextWindow * 4 * (profile.tier === 'small' ? 0.2 : 0.35))) : undefined;
      const built = await this.runtime.contextBuilder.build({ workspaceId: this.workspaceId, prompt, sessionId: this.sessionId, maxChars }).catch(() => null);
      plan = built?.contextPlan || null;
      label = 'This request';
    } else {
      const run = this.runtime.store.listRuns({ sessionId: this.sessionId, limit: 20 }).find((item) => item.meta?.contextPlan);
      plan = run?.meta?.contextPlan || null;
    }
    const lines = [];
    const heading = (text) => lines.push('', sectionLabel(theme, text));
    const row = (name, value, tone = theme.roles.text) => lines.push(gutter(theme) + theme.paint(fit(name, 10), { fg: theme.roles.muted }) + theme.paint(value, { fg: tone }));
    const context = this.contextState;
    heading('Model');
    row('model', this.modelRef || '—');
    if (context) {
      row('window', `${compact(context.window)} tokens (${context.source}) · ${String(context.tier)} tier · replies up to ${compact(context.maxOutputTokens)}`);
      row('last used', context.used ? `${compact(context.used)} tokens · ${Math.round(context.ratio * 100)}% of the window` : 'no request yet', context.used ? theme.role(context.tone) : theme.roles.muted);
    }
    heading(`Repository context · ${label}`);
    if (!plan) {
      lines.push(gutter(theme) + theme.paint('No run yet. Try /context <a prompt> to see what it would send.', { fg: theme.roles.muted, italic: true }));
    } else {
      row('profile', `${plan.profile || 'broad'} prompt`);
      const source = plan.source || {};
      row('source', `${source.selected ?? 0} chunk${source.selected === 1 ? '' : 's'} sent · ${source.excluded ?? 0} left out below relevance · ${compact(source.usedChars || 0)} chars`);
      for (const item of (source.items || []).slice(0, 10)) {
        const why = item.reason ? `overlap ${Number(item.reason.lexical || 0).toFixed(2)}${item.reason.semantic ? ` · similarity ${Number(item.reason.semantic).toFixed(2)}` : ''}` : '';
        lines.push(gutter(theme, mark.dot, { tone: theme.roles.faint }) + theme.paint(fit(item.path, 44), { fg: theme.roles.tool }) + theme.paint(why, { fg: theme.roles.muted }));
      }
      const memories = plan.memories || {};
      row('memory', `${memories.selected ?? 0} selected of ${memories.considered ?? 0}${memories.staleExcluded ? ` · ${memories.staleExcluded} stale, left out` : ''}`);
    }
    heading('History');
    row('summary', this.compaction?.summary ? 'earlier turns are summarized · s in the transcript reads it' : 'none yet — the session still fits', this.compaction?.summary ? theme.roles.info : theme.roles.muted);
    this.overlay = new TextOverlay({ title: 'Context', lines: lines.slice(1), stamp: 'esc closes' });
  }

  openCostReport() {
    const { theme } = this;
    const runs = this.runtime.store.listRuns({ sessionId: this.sessionId, limit: 200 }).filter((run) => run.meta?.costEstimate);
    if (!runs.length) { this.toast('No finished runs in this chat yet', 'info'); return; }
    const lines = [];
    let cost = 0; let input = 0; let output = 0; let unpriced = 0;
    lines.push(gutter(theme) + theme.paint(`${fit('When', 7)}${fit('Cost', 11)}${fit('In / out', 16)}Request`, { fg: theme.roles.muted }));
    for (const run of [...runs].reverse()) {
      const estimate = run.meta.costEstimate;
      cost += estimate.cost || 0; input += estimate.inputTokens || 0; output += estimate.outputTokens || 0;
      if (!estimate.complete) unpriced += 1;
      const price = estimate.pricedEntries ? `$${(estimate.cost || 0).toFixed(4)}` : 'unpriced';
      lines.push(gutter(theme)
        + theme.paint(fit(this.stamp(run.started_at), 7), { fg: theme.roles.dim })
        + theme.paint(fit(price, 11), { fg: estimate.pricedEntries ? theme.roles.text : theme.roles.muted, bold: Boolean(estimate.pricedEntries) })
        + theme.paint(fit(`${compact(estimate.inputTokens || 0)} / ${compact(estimate.outputTokens || 0)}`, 16), { fg: theme.roles.text })
        + theme.paint(oneLine(run.prompt || '', 60), { fg: theme.roles.muted }));
    }
    lines.push('', gutter(theme) + theme.paint(`${fit('Total', 7)}`, { fg: theme.roles.label, bold: true })
      + theme.paint(fit(`$${cost.toFixed(4)}`, 11), { fg: theme.roles.accent, bold: true })
      + theme.paint(`${compact(input)} / ${compact(output)} tokens over ${runs.length} run${runs.length === 1 ? '' : 's'}`, { fg: theme.roles.text }));
    if (unpriced) lines.push('', gutter(theme) + theme.paint(`${unpriced} run${unpriced === 1 ? ' has' : 's have'} usage with no price — add the model under pricing.models to include it.`, { fg: theme.roles.warning, italic: true }));
    this.overlay = new TextOverlay({ title: 'Chat cost', lines, stamp: 'esc closes' });
  }

  async runSlash(input) {
    const [command, ...rest] = input.slice(1).split(/\s+/);
    const argument = rest.join(' ');
    switch (command) {
      case 'new': this.requestNewSession(); break;
      case 'clear': this.messages = []; this.transcript.toBottom(); break;
      case 'model':
        if (argument) { this.modelRef = argument; void this.refreshModelProfile(); this.toast(`Model set to ${argument}`, 'success'); }
        else this.openModelPicker();
        break;
      case 'sessions': this.openSessionPicker(); break;
      case 'search': this.openSearchResults(argument); break;
      case 'workspace': this.openWorkspaceDialog(); break;
      case 'tools': this.switchView(2); this.capabilitiesTab = 'tools'; if (argument) this.capabilitiesFilter.set(argument); break;
      case 'skills': this.switchView(2); this.capabilitiesTab = 'skills'; if (argument) this.capabilitiesFilter.set(argument); break;
      case 'mcp': this.switchView(2); this.capabilitiesTab = 'mcp'; if (argument) this.capabilitiesFilter.set(argument); break;
      case 'runtime': case 'mods': this.switchView(3); break;
      case 'files': this.switchView(1); break;
      case 'terminal': this.switchView(3); break;
      case 'browser': this.switchView(4); this.openBrowserTargetPicker(); break;
      case 'git': this.switchView(5); break;
      case 'fleet': case 'team': case 'agents': this.switchView(6); break;
      case 'doctor': await this.showDoctor(); break;
      case 'logs': await this.showLogs(); break;
      case 'settings': this.openSettings(); break;
      case 'help': this.openHelp(); break;
      case 'context': await this.openContextReport(argument); break;
      case 'compact': await this.compactNow(); break;
      case 'summary': this.openSessionSummary(); break;
      case 'cost': this.openCostReport(); break;
      case 'changes': case 'diff': await this.openRunChanges(); break;
      case 'undo': await this.openUndoLastRun(); break;
      case 'steer':
        if (!argument) { this.toast('Usage: /steer <message> while a task is running', 'warn'); break; }
        this.composer.set(argument);
        this.steerPrompt();
        break;
      case 'quit': case 'exit': this.stop(0); break;
      default: {
        const name = String(command || '').toLowerCase();
        const custom = this.customCommands.find((entry) => entry.name === name)
          || (await this.refreshCustomCommands()).find((entry) => entry.name === name);
        if (custom) await this.runCustomCommand(custom, argument);
        else this.toast(`Unknown command: /${command}`, 'warn');
      }
    }
  }
}

function noColorRequested() {
  const value = process.env.NO_COLOR;
  return (value !== undefined && value !== '' && value !== '0' && value !== 'false') || process.env.MASKSHIFT_COLOR === 'off';
}

// The first bullets under a "## Heading" of the saved session summary (see compaction.mjs).
function summarySection(summary, heading) {
  const lines = String(summary || '').split('\n');
  const start = lines.findIndex((line) => new RegExp(`^#+\\s*${heading}\\b`, 'i').test(line.trim()));
  if (start < 0) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#+\s/.test(line.trim())) break;
    const text = line.replace(/^\s*[-*•]\s*/, '').trim();
    if (text) out.push(text);
  }
  return out;
}

function sessionPreviewLines(theme, session, lastUser, width, stamp) {
  const summary = session?.meta?.compaction?.summary;
  const label = (text) => theme.paint(text.padEnd(6), { fg: theme.roles.muted });
  const lines = [];
  const add = (name, text, tone = theme.roles.text) => {
    if (text) lines.push(`${label(name)}${theme.paint(oneLine(text, Math.max(8, width - 6)), { fg: tone })}`);
  };
  add('Goal', summarySection(summary, 'Goal')[0]);
  for (const [index, issue] of summarySection(summary, 'Open issues').slice(0, 2).entries()) add(index ? '' : 'Open', issue, theme.roles.warning);
  if (lastUser) add('Last', `“${oneLine(lastUser.content, 200)}” · ${stamp(lastUser.created_at)}`, theme.roles.dim);
  if (!lines.length) lines.push(theme.paint('Nothing asked in this chat yet.', { fg: theme.roles.muted, italic: true }));
  if (!summary && lastUser) lines.push(theme.paint('No summary yet — written once the chat outgrows the model\'s window.', { fg: theme.roles.faint, italic: true }));
  return lines;
}

// Tokens the last request actually sent. Anthropic reports cache reads and writes outside
// input_tokens, so they are added back; other providers already count them inside it.
function promptTokens(usage) {
  const counts = tokenCounts(usage);
  const splitsCache = usage?.cache_creation_input_tokens != null || usage?.cache_read_input_tokens != null;
  return counts.inputTokens + (splitsCache ? counts.cacheWriteTokens + counts.cacheReadTokens : 0);
}

function compact(value) {
  if (value < 1000) return String(value);
  // "200k", not "200.0k": the decimal is only worth a column when it says something.
  if (value < 1_000_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export const MOUSE_MODES = ['off', 'click', 'hover'];

/**
 * Mouse reporting takes the terminal's own text selection away from the user,
 * so it stays overridable: MASKSHIFT_MOUSE wins, then the stored preference,
 * and the default is click tracking without hover motion — hover floods the
 * wire with a report per cell, which is wasteful over SSH.
 */
export function resolveMouseMode(preferences = {}) {
  const override = String(process.env.MASKSHIFT_MOUSE || '').toLowerCase();
  if (override === 'off' || override === '0' || override === 'false') return 'off';
  if (MOUSE_MODES.includes(override)) return override;
  const stored = preferences.mouse;
  if (stored === false) return 'off';
  if (MOUSE_MODES.includes(stored)) return stored;
  return 'click';
}

export async function startTui(runtime, options = {}) {
  const app = new MaskShiftTui(runtime, options);
  return app.start();
}
