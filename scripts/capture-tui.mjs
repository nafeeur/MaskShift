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
import { parseArgs } from '../src/core/utils.mjs';

const ESC = String.fromCharCode(27);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const outputDir = path.resolve(args.out || path.join(root, 'docs', 'screenshots'));
const workspacePath = path.resolve(args.workspace || root);

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
  await app.loadFileTree();
  await app.refreshModShop({ force: true });

  // A representative transcript so the hero capture shows real work.
  const now = new Date().toISOString();
  app.sessionTitle = 'RENDERER REFACTOR';
  app.messages = [
    { role: 'user', created_at: now, meta: {}, content: 'Refactor the frame renderer so repaints only rewrite changed rows, then prove it with a test.' },
    {
      role: 'assistant', created_at: now, meta: { modelRef: 'ollama:qwen3-coder' },
      content: '## Plan\n\nThe screen currently repaints every row. I will diff against the previous frame instead.\n\n- read `src/tui/screen.mjs`\n- keep the previous frame and rewrite only changed rows\n- add a regression test\n\n```js\nfor (let row = 0; row < rows; row += 1) {\n  if (this.previous[row] === frame[row]) continue;\n  out += `${moveTo(row, 0)}${clearLine}${frame[row]}`;\n}\n```\n',
    },
    { role: 'tool', meta: { toolName: 'fs_read', isError: false }, content: 'src/tui/screen.mjs — 94 lines' },
    { role: 'tool', meta: { toolName: 'fs_apply_patch', isError: false }, content: '1 file changed, 12 insertions(+), 4 deletions(-)' },
    { role: 'tool', meta: { toolName: 'shell_exec', isError: false }, content: 'node --test tests/tui.test.mjs → 12 pass, 0 fail' },
    { role: 'assistant', created_at: now, meta: {}, content: 'Done. Repaints now touch only the rows that changed, and `tests/tui.test.mjs` asserts an unchanged frame writes nothing at all.' },
  ];
  app.plan = {
    summary: 'Diff frames instead of repainting the screen.',
    steps: [
      { title: 'Read the screen module', status: 'done' },
      { title: 'Keep the previous frame and diff rows', status: 'done' },
      { title: 'Add a regression test for an unchanged frame', status: 'active' },
      { title: 'Run the suite', status: 'pending' },
    ],
  };
  app.capabilitySnapshot = {
    tools: ['fs_read', 'fs_apply_patch', 'shell_exec', 'repo_search'],
    skills: ['test-engineering', 'code-review'],
    mcpServers: [],
  };
  app.tokenHistory = [12, 48, 26, 84, 51, 96, 38, 72, 44, 88];
  app.totals = { input: 18_420, output: 4_180, cost: 0.0241 };
  app.startedAt = Date.now() - 112_000;
  app.step = 9;

  const captures = [
    ['heist', 'MaskShift — 01 HEIST', () => { app.view = 'chat'; app.focus = 'composer'; app.railTab = 'plan'; }],
    ['loadout', 'MaskShift — live loadout telemetry', () => { app.view = 'chat'; app.railTab = 'telemetry'; }],
    ['files', 'MaskShift — 02 FILES', () => { app.view = 'files'; app.focus = 'files'; app.fileList.selected = 6; }],
    ['arsenal', 'MaskShift — 03 ARSENAL', () => { app.view = 'arsenal'; app.focus = 'arsenal'; app.arsenalFilter.set('git'); }],
    ['network', 'MaskShift — 04 NETWORK', () => { app.view = 'network'; app.focus = 'network'; }],
    ['modshop', 'MaskShift — 05 MOD SHOP', () => { app.view = 'modshop'; app.modTab = 'bridges'; app.focus = 'modshop'; }],
    ['palette', 'MaskShift — command palette', () => { app.view = 'chat'; app.openPalette(); app.overlay.field.set('mcp'); }],
    ['settings', 'MaskShift — settings', () => { app.view = 'chat'; app.openSettings(); }],
  ];

  await fsp.mkdir(outputDir, { recursive: true });
  const written = [];
  for (const [name, title, prepare] of captures) {
    app.closeOverlay();
    prepare();
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
