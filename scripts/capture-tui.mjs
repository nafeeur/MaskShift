// Render the terminal interface to SVG so the documentation stays in step with
// the real renderer. No browser, no screenshot tooling: the same frames the TUI
// paints are parsed back out of their ANSI and drawn as text.
//
//   node --no-warnings ./scripts/capture-tui.mjs [--out DIR] [--workspace PATH]

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { createRuntime } from '../src/runtime.mjs';
import { MaskShiftTui } from '../src/tui/app.mjs';
import { Theme, PALETTE } from '../src/tui/theme.mjs';
import { charWidth } from '../src/tui/text.mjs';
import { parseArgs, runCommand } from '../src/core/utils.mjs';

const ESC = String.fromCharCode(27);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const outputDir = path.resolve(args.out || path.join(root, 'docs', 'screenshots'));
// The demo workspace is a scratch folder of everyday documents, not this repository, so the
// captures show what the product does for any kind of work.
async function scratchWorkspace() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'maskshift-demo-'));
  const dir = path.join(base, 'Documents');
  const files = {
    'README.md': '# Documents\n\nInvoices, reports and planning notes.\n',
    'Invoices/northwind-0412.pdf': 'placeholder\n',
    'Invoices/contoso-0418.pdf': 'placeholder\n',
    'Invoices/fabrikam-0502.pdf': 'placeholder\n',
    'Reports/q2-by-vendor.xlsx': 'placeholder\n',
    'Notes/offsite-plan.md': '# Team offsite\n\n- Venue shortlist\n- Agenda draft\n- Budget under $6,000\n',
    'Notes/meeting-2025-09-12.md': '# Meeting notes\n\nAction items are listed below.\n',
  };
  for (const [name, content] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fsp.writeFile(path.join(dir, name), content);
  }
  await runCommand('git init -q -b main && git config user.email demo@maskshift.invalid && git config user.name demo && git add . && git commit -qm "Initial documents"', { cwd: dir });
  await fsp.writeFile(path.join(dir, 'Notes/offsite-plan.md'), '# Team offsite\n\n- Venue shortlist (3 options)\n- Agenda draft for two days\n- Budget under $6,000\n- Travel plan\n');
  await fsp.writeFile(path.join(dir, 'Reports/q3-by-vendor.xlsx'), 'placeholder\n');
  await fsp.rm(path.join(dir, 'Notes/meeting-2025-09-12.md'));
  return dir;
}

const workspacePath = path.resolve(args.workspace || await scratchWorkspace());

const COLUMNS = Number(args.columns || 132);
const ROWS = Number(args.rows || 38);
const CHAR_WIDTH = 8.4;
const LINE_HEIGHT = 18;
const FONT_SIZE = 14;
const PADDING = 16;

class FakeTerminal extends Writable {
  constructor(columns, rows) { super(); this.columns = columns; this.rows = rows; this.isTTY = false; }
  _write(chunk, encoding, callback) { callback(); }
}

// ---------------------------------------------------------------- ANSI parser

const BASIC = {
  30: '#0a090d', 31: '#c0102f', 32: '#4fe08b', 33: '#ffb648',
  34: '#5cc8ff', 35: '#b184ff', 36: '#2ee6c5', 37: '#9d97ad',
  90: '#3a3648', 91: '#ff2d55', 92: '#4fe08b', 93: '#ffb648',
  94: '#5cc8ff', 95: '#b184ff', 96: '#2ee6c5', 97: '#ffffff',
};

function parseLine(line) {
  const runs = [];
  let style = { fg: PALETTE.bone, bg: null, bold: false, italic: false, underline: false };
  let current = null;
  let column = 0;
  let index = 0;

  const push = (character, width) => {
    if (!current || !sameStyle(current.style, style) || current.end !== column) {
      current = { text: '', style: { ...style }, start: column, end: column };
      runs.push(current);
    }
    current.text += character;
    current.end = column + width;
    column += width;
  };

  while (index < line.length) {
    if (line[index] === ESC && line[index + 1] === '[') {
      const match = /^\[([0-9;]*)m/.exec(line.slice(index + 1));
      if (match) {
        style = applyCodes(style, match[1].split(';').filter(Boolean).map(Number));
        index += 1 + match[0].length;
        continue;
      }
    }
    const character = String.fromCodePoint(line.codePointAt(index));
    const width = charWidth(character);
    if (width > 0) push(character, width);
    index += character.length;
  }
  return runs;
}

function sameStyle(a, b) {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.italic === b.italic && a.underline === b.underline;
}

function applyCodes(style, codes) {
  const next = { ...style };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) { next.fg = PALETTE.bone; next.bg = null; next.bold = false; next.italic = false; next.underline = false; continue; }
    if (code === 1) { next.bold = true; continue; }
    if (code === 2) { next.fg = PALETTE.ash; continue; }
    if (code === 3) { next.italic = true; continue; }
    if (code === 4) { next.underline = true; continue; }
    if (code === 7) { const swap = next.fg; next.fg = next.bg || PALETTE.ink; next.bg = swap; continue; }
    if (BASIC[code]) { next.fg = BASIC[code]; continue; }
    if (BASIC[code - 10]) { next.bg = BASIC[code - 10]; continue; }
    if (code === 38 || code === 48) {
      const mode = codes[index + 1];
      if (mode === 2) {
        const colour = `#${codes.slice(index + 2, index + 5).map((value) => value.toString(16).padStart(2, '0')).join('')}`;
        if (code === 38) next.fg = colour; else next.bg = colour;
        index += 4;
      } else if (mode === 5) {
        index += 2;
      }
    }
  }
  return next;
}

const escapeXml = (text) => text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function segments(run) {
  const out = [];
  let column = run.start;
  let current = null;
  for (const character of run.text) {
    const width = charWidth(character);
    if (character === ' ') {
      current = null;
    } else {
      if (!current) { current = { text: '', start: column, columns: 0 }; out.push(current); }
      current.text += character;
      current.columns += width;
    }
    column += width;
  }
  return out;
}

function toSvg(frame, title) {
  const width = COLUMNS * CHAR_WIDTH + PADDING * 2;
  const height = ROWS * LINE_HEIGHT + PADDING * 2;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(0)}" height="${height.toFixed(0)}" viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}" role="img" aria-label="${escapeXml(title)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<rect width="100%" height="100%" rx="10" fill="${PALETTE.ink}"/>`,
    '<g font-family="SFMono-Regular, Menlo, Consolas, DejaVu Sans Mono, monospace" '
      + `font-size="${FONT_SIZE}" xml:space="preserve">`,
  ];

  for (const [row, line] of frame.entries()) {
    const y = PADDING + row * LINE_HEIGHT;
    const runs = parseLine(line);
    for (const run of runs) {
      if (!run.text.trim() && !run.style.bg) continue;
      const x = PADDING + run.start * CHAR_WIDTH;
      const runWidth = (run.end - run.start) * CHAR_WIDTH;
      if (run.style.bg) {
        parts.push(`<rect x="${x.toFixed(2)}" y="${(y).toFixed(2)}" width="${runWidth.toFixed(2)}" height="${LINE_HEIGHT}" fill="${run.style.bg}"/>`);
      }
      if (!run.text.trim()) continue;
      // Emit one <text> per whitespace-free segment. Whitespace inside a
      // textLength span makes renderers stretch the glyphs instead of the gaps.
      for (const segment of segments(run)) {
        const attributes = [
          `x="${(PADDING + segment.start * CHAR_WIDTH).toFixed(2)}"`,
          `y="${(y + FONT_SIZE).toFixed(2)}"`,
          `fill="${run.style.fg}"`,
          `textLength="${(segment.columns * CHAR_WIDTH).toFixed(2)}"`,
          'lengthAdjust="spacingAndGlyphs"',
          run.style.bold ? 'font-weight="700"' : '',
          run.style.italic ? 'font-style="italic"' : '',
          run.style.underline ? 'text-decoration="underline"' : '',
        ].filter(Boolean).join(' ');
        parts.push(`<text ${attributes}>${escapeXml(segment.text)}</text>`);
      }
    }
  }

  parts.push('</g></svg>');
  return `${parts.join('\n')}\n`;
}

// ------------------------------------------------------------------- captures

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'maskshift-capture-'));
const runtime = await createRuntime({
  configPath: path.join(home, 'config.json'),
  workspacePath,
  configOverrides: {
    home, autoIndex: false, autoCheckpoint: false,
    automations: { enabled: false, pollIntervalMs: 10_000, maxPerTick: 1 },
  },
});

try {
  const app = new MaskShiftTui(runtime, {
    workspacePath, headless: true,
    theme: new Theme({ depth: 24, unicode: true }),
    output: new FakeTerminal(COLUMNS, ROWS),
  });
  await app.bootstrap();
  // Settle bootstrap's own model lookup before the capture sets a profile by hand.
  await app.refreshModelProfile();
  await app.loadFileTree();
  await app.refreshCapabilitiesExtras({ force: true });
  await app.refreshRuntimeExtras({ force: true });
  await app.refreshGitView({ force: true });

  // A representative conversation so the main capture shows real, non-trivial work.
  const now = new Date().toISOString();
  app.sessionTitle = 'Q3 invoice summary';
  app.messages = [
    { role: 'user', created_at: now, meta: {}, content: 'Go through the PDFs in ~/Documents/Invoices, total the amounts by vendor for Q3, and write the result to a spreadsheet I can send to finance.' },
    {
      role: 'assistant', created_at: now, meta: { modelRef: 'anthropic:claude-sonnet-5' },
      content: '## Plan\n\nThere are 23 PDFs. I will extract the vendor and amount from each one, check that the totals add up, and write one row per vendor.\n\n- list the folder and read each invoice\n- group the amounts by vendor\n- write `q3-by-vendor.xlsx` and verify it by reading it back\n\n```python\ntotals = defaultdict(float)\nfor invoice in invoices:\n    totals[invoice.vendor] += invoice.amount\n```\n',
    },
    { role: 'tool', meta: { toolName: 'fs_list', isError: false }, content: '~/Documents/Invoices — 23 files' },
    { role: 'tool', meta: { toolName: 'pdf_read', isError: false }, content: '23 invoices read — 2 needed OCR' },
    { role: 'tool', meta: { toolName: 'python_cell', isError: false }, content: '9 vendors, total $48,215.60 — matches the sum of the invoices' },
    { role: 'assistant', created_at: now, meta: {}, content: 'Done. `q3-by-vendor.xlsx` has one row per vendor (9 in total) and a total of $48,215.60. I re-opened the file to confirm the totals match the invoices. Two scans were low quality, so I listed them on a second sheet for you to double-check.' },
  ];
  app.plan = {
    summary: 'Total Q3 invoices by vendor.',
    steps: [
      { title: 'Read every invoice in the folder', status: 'done' },
      { title: 'Group the amounts by vendor', status: 'done' },
      { title: 'Write the spreadsheet', status: 'active' },
      { title: 'Check the totals against the invoices', status: 'pending' },
    ],
  };
  app.capabilitySnapshot = {
    tools: ['fs_list', 'pdf_read', 'python_cell', 'fs_write'],
    skills: ['data-analysis', 'xlsx'],
    mcpServers: [],
  };
  app.tokenHistory = [12, 48, 26, 84, 51, 96, 38, 72, 44, 88];
  app.totals = { input: 18_420, output: 4_180, cost: 0.0241 };
  app.modelProfile = { contextWindow: 200_000, tier: 'large', source: 'provider', maxOutputTokens: 16_384 };
  app.contextUsed = 41_200;
  app.startedAt = Date.now() - 112_000;
  app.step = 9;

  // Two scheduled jobs so the Runtime view shows something real.
  const workspaceId = app.workspaceId;
  await runtime.toolRegistry.execute('automation_create', { name: 'weekly-notes-summary', schedule: 'every 7d', action: { type: 'agent', prompt: "Summarize this week's notes and list the open action items" } }, { workspaceId, workspacePath, scope: { workspaceId }, eventBus: runtime.eventBus });
  await runtime.toolRegistry.execute('automation_create', { name: 'invoice-check', schedule: '0 9 * * 1', action: { type: 'agent', prompt: 'Check the Invoices folder for new files and add them to the Q3 summary' } }, { workspaceId, workspacePath, scope: { workspaceId }, eventBus: runtime.eventBus });
  await app.refreshRuntimeExtras({ force: true });

  const captures = [
    ['chat', 'MaskShift — Chat', () => { app.view = 'chat'; app.focus = 'composer'; app.railTab = 'plan'; }],
    ['active-tools', 'MaskShift — tools in use', () => { app.view = 'chat'; app.railTab = 'telemetry'; }],
    ['files', 'MaskShift — Files', () => { app.view = 'files'; app.focus = 'files'; app.fileList.selected = Math.max(0, app.fileEntries.findIndex((entry) => entry.path === 'Notes/offsite-plan.md')); }],
    ['capabilities', 'MaskShift — Capabilities', () => { app.view = 'capabilities'; app.focus = 'capabilities'; app.capabilitiesTab = 'mcp'; app.capabilitiesFilter.clear(); }],
    ['runtime', 'MaskShift — Runtime', () => { app.view = 'runtime'; app.runtimeTab = 'automations'; app.focus = 'runtime'; }],
    ['git', 'MaskShift — Git', async () => {
      app.view = 'git'; app.gitTab = 'changes'; app.focus = 'git';
      // The list is only populated inside the view's own render(), so force
      // one before asking for its current row's diff.
      app.screen.invalidate();
      app.snapshot();
      await app.loadGitDetail(app.gitList.current);
    }],
    ['palette', 'MaskShift — command palette', () => { app.view = 'chat'; app.openPalette(); app.overlay.field.set('mcp'); }],
    ['approval', 'MaskShift — approving a tool call', async () => {
      app.view = 'chat';
      // Approvals only exist outside autonomous mode; the next capture puts the mode back.
      runtime.config.get().permissionMode = 'balanced';
      void app.requestToolConfirmation({
        name: 'shell_exec', tool: runtime.toolRegistry.descriptor('shell_exec'),
        args: { command: 'python3 summarize_invoices.py --quarter Q3 --out Reports/q3-by-vendor.xlsx', cwd: '~/Documents' },
      });
      await new Promise((resolve) => setImmediate(resolve));
    }],
    ['changes', 'MaskShift — what the last run changed', async () => {
      app.view = 'chat';
      runtime.config.get().permissionMode = 'autonomous';
      const scratch = await changedRepo();
      const workspaceId = app.workspaceId;
      app.workspaceId = scratch.workspaceId;
      app.lastUndoableRun = () => ({ run: { id: 'capture', prompt: 'Total the Q3 invoices by vendor and write the summary report' }, checkpoint: scratch.checkpoint });
      await app.openRunChanges();
      app.snapshot();
      await new Promise((resolve) => setTimeout(resolve, 300));
      app.workspaceId = workspaceId;
    }],
    ['chats', 'MaskShift — chats', () => {
      app.view = 'chat';
      const summary = '## Goal\n- Total the Q3 invoices by vendor and write them to a spreadsheet.\n## Open issues\n- Two scans are low quality and need a manual check.\n- Finance has not confirmed the currency for one vendor.';
      const make = (title, prompt, withSummary) => {
        const session = runtime.engine.createSession({ workspaceId: app.workspaceId, title, modelRef: 'anthropic:claude-sonnet-5' });
        runtime.store.addMessage({ sessionId: session.id, role: 'user', content: prompt });
        if (withSummary) runtime.store.updateSession(session.id, { meta: { compaction: { summary, throughMessageId: 'capture' } } });
        return session;
      };
      make('Plan the team offsite', 'Draft a two-day agenda for twelve people and a budget under $6,000', false);
      make('Compare laptop options', 'Compare three laptops for video editing and summarize the trade-offs', false);
      const current = make('Q3 invoice summary', 'Now add a second sheet listing the two low-quality scans', true);
      const sessionId = app.sessionId;
      app.sessionId = current.id;
      app.openSessionPicker();
      app.sessionId = sessionId;
    }],
    ['settings', 'MaskShift — settings', () => { app.view = 'chat'; app.openSettings(); }],
    ['welcome', 'MaskShift — new chat', () => {
      app.view = 'chat'; app.focus = 'composer'; app.railTab = 'plan';
      app.sessionTitle = ''; app.messages = []; app.plan = { summary: '', steps: [] };
    }],
  ];

  // The changes capture needs a real diff, made in a throwaway repository rather than by
  // checkpointing whatever repository the capture happens to run in.
  async function changedRepo() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'maskshift-capture-repo-'));
    await fsp.mkdir(path.join(root, 'report'), { recursive: true });
    const summary = '# Q3 invoice summary\n\nVendors: 8\nTotal: $41,980.00\n';
    await fsp.writeFile(path.join(root, 'report/summary.md'), summary);
    await fsp.writeFile(path.join(root, 'report/draft-notes.txt'), 'scratch notes\n');
    await runCommand('git init -q && git config user.email capture@maskshift.invalid && git config user.name capture && git add . && git commit -qm init', { cwd: root });
    const workspace = await runtime.workspaceManager.open(root);
    const checkpoint = await runtime.workspaceManager.createCheckpoint(workspace.id, { runId: 'capture' });
    await fsp.writeFile(path.join(root, 'report/summary.md'), '# Q3 invoice summary\n\nVendors: 9\nTotal: $48,215.60\n\nTwo scans were low quality and are listed on the second sheet.\n');
    await fsp.writeFile(path.join(root, 'report/totals.csv'), 'vendor,total\nNorthwind,12400.00\nContoso,9815.60\n');
    await fsp.rm(path.join(root, 'report/draft-notes.txt'));
    return { workspaceId: workspace.id, checkpoint };
  }

  await fsp.mkdir(outputDir, { recursive: true });
  const written = [];
  for (const [name, title, prepare] of captures) {
    app.closeOverlay();
    await prepare();
    app.screen.invalidate();
    const frame = app.snapshot();
    const file = path.join(outputDir, `${name}.svg`);
    await fsp.writeFile(file, toSvg(frame, title));
    written.push(path.relative(root, file));
  }
  console.log(`Captured ${written.length} frames at ${COLUMNS}x${ROWS}:`);
  for (const file of written) console.log(`  ${file}`);
} finally {
  await runtime.close().catch(() => {});
  await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
}
