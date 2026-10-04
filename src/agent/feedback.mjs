// Telling the model, immediately, whether the edit it just made broke the file.
//
// Without this a model finds out only if it thinks to run the build, then reads the log to find
// the line. Here the harness does both: after a write it checks the changed files — syntax first,
// using only tools a machine already has, then language-server errors when one is installed —
// and appends the findings to that same tool result. A clean edit adds nothing, so a model that
// writes correct code pays no tokens for this.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { commandExists, runCommand, shellQuote } from '../core/utils.mjs';

export const EDIT_TOOLS = new Set(['fs_write', 'fs_patch', 'fs_replace_lines', 'symbol_replace', 'fs_apply_patch']);

const availability = new Map();
async function has(command) {
  if (!availability.has(command)) availability.set(command, Boolean(await commandExists(command)));
  return availability.get(command);
}

/** Files a successful edit-tool call changed. */
export function editedFiles(name, args, value, workspacePath) {
  const files = [];
  if (name === 'fs_apply_patch') {
    for (const match of String(args?.patch || '').matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)) {
      if (match[1] !== '/dev/null') files.push(path.resolve(value?.cwd || workspacePath || '.', match[1]));
    }
  } else if (value?.path) files.push(value.path);
  return [...new Set(files)].slice(0, 5);
}

// A traceback ends with the error; node's check starts with the location. Keep the useful end.
function lines(text, max = 6) {
  const all = String(text || '').split('\n').map((line) => line.trimEnd()).filter((line) => line && !/^Node\.js v\d/.test(line));
  return (/^Traceback/.test(all[0] || '') ? all.slice(-5) : all.slice(0, max)).join('\n');
}

function jsonProblem(text) {
  try { JSON.parse(text); return null; } catch (error) {
    const message = String(error.message).split('\n')[0].slice(0, 200);
    const at = Number(message.match(/position (\d+)/)?.[1]);
    if (Number.isFinite(at) && !/line \d+/.test(message)) {
      const before = text.slice(0, at).split('\n');
      return `${message} (line ${before.length}, column ${before.at(-1).length + 1})`;
    }
    return message;
  }
}

// `only` limits a report to genuine syntax errors, so "module not found" or a missing interpreter
// feature is never blamed on the edit.
const NODE_SYNTAX = /SyntaxError/;
const CHECKS = {
  '.js': (file) => ({ command: `node --check ${shellQuote(file)}`, needs: 'node', only: NODE_SYNTAX }),
  '.mjs': (file) => ({ command: `node --check ${shellQuote(file)}`, needs: 'node', only: NODE_SYNTAX }),
  '.cjs': (file) => ({ command: `node --check ${shellQuote(file)}`, needs: 'node', only: NODE_SYNTAX }),
  '.py': (file) => ({ command: `python3 -c "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1])" ${shellQuote(file)}`, needs: 'python3', only: /(Syntax|Indentation|Tab)Error/ }),
  '.sh': (file) => ({ command: `bash -n ${shellQuote(file)}`, needs: 'bash' }),
  '.bash': (file) => ({ command: `bash -n ${shellQuote(file)}`, needs: 'bash' }),
  '.go': (file) => ({ command: `gofmt -e ${shellQuote(file)} > /dev/null`, needs: 'gofmt' }),
  '.rb': (file) => ({ command: `ruby -c ${shellQuote(file)} > /dev/null`, needs: 'ruby' }),
};

/** A syntax problem in `file`, or null. Uses only interpreters already on the machine. */
export async function syntaxProblem(file, { timeoutMs = 6000, signal } = {}) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.json') {
    const text = await fsp.readFile(file, 'utf8').catch(() => null);
    return text === null ? null : jsonProblem(text);
  }
  const check = CHECKS[extension]?.(file);
  if (!check || !(await has(check.needs))) return null;
  if (!(await fsp.stat(file).catch(() => null))?.isFile()) return null;
  const result = await runCommand(check.command, { cwd: path.dirname(file), timeoutMs, signal, maxOutputChars: 4000 }).catch(() => null);
  if (!result || result.code === 0 || result.timedOut) return null;
  const output = result.stderr || result.stdout;
  if (check.only && !check.only.test(output)) return null;
  return lines(output);
}

function severityName(severity) {
  return { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }[severity] || 'error';
}

export class EditFeedback {
  constructor({ config, lspManager = null, logger = null }) {
    this.config = config;
    this.lspManager = lspManager;
    this.logger = logger;
  }

  settings() {
    const raw = this.config.get().guardrails?.feedback || {};
    return {
      enabled: raw.enabled !== false && this.config.get().guardrails?.features?.editFeedback !== false,
      syntax: raw.syntax !== false,
      lsp: raw.lsp !== false,
      timeoutMs: Number(raw.timeoutMs) > 0 ? Number(raw.timeoutMs) : 8000,
      maxIssues: Number(raw.maxIssues) > 0 ? Number(raw.maxIssues) : 5,
    };
  }

  async #lspErrors(workspaceId, file, timeoutMs) {
    if (!this.lspManager || !workspaceId) return [];
    try {
      await this.lspManager.definitionFor(file); // throws when no server is installed for this language
    } catch { return []; }
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    try {
      const found = await Promise.race([this.lspManager.diagnostics(workspaceId, file, 600).catch(() => null), timeout]);
      return (found || []).filter((item) => (item.severity ?? 1) === 1);
    } finally { clearTimeout(timer); }
  }

  /**
   * Returns `{ text, problems }` for the files an edit changed, or null when everything is clean
   * (or checks are off). Never throws: a failing check must not turn a good edit into an error.
   */
  async check({ name, args, value, workspaceId, workspacePath, signal }) {
    const settings = this.settings();
    if (!settings.enabled || !EDIT_TOOLS.has(name)) return null;
    try {
      const files = editedFiles(name, args, value, workspacePath);
      const reports = [];
      for (const file of files) {
        const display = workspacePath ? path.relative(workspacePath, file) || file : file;
        const syntax = settings.syntax ? await syntaxProblem(file, { timeoutMs: Math.min(6000, settings.timeoutMs), signal }) : null;
        if (syntax) { reports.push({ file: display, kind: 'syntax', detail: syntax }); continue; }
        if (!settings.lsp) continue;
        const errors = await this.#lspErrors(workspaceId, file, settings.timeoutMs);
        for (const item of errors.slice(0, settings.maxIssues)) {
          const line = (item.range?.start?.line ?? 0) + 1;
          reports.push({ file: display, kind: severityName(item.severity), detail: `line ${line}: ${String(item.message || '').split('\n')[0].slice(0, 240)}` });
        }
      }
      if (!reports.length) return null;
      const body = reports.slice(0, settings.maxIssues * 2).map((report) => (report.kind === 'syntax'
        ? `- ${report.file}: syntax error\n${report.detail.split('\n').map((line) => `    ${line}`).join('\n')}`
        : `- ${report.file}: ${report.kind} — ${report.detail}`)).join('\n');
      return {
        problems: reports.length,
        text: `[Harness check] This edit left a problem in the file${reports.length === 1 ? '' : 's'} — fix it before moving on:\n${body}`,
      };
    } catch (error) {
      this.logger?.warn?.('Post-edit check failed', { error: error.message });
      return null;
    }
  }
}
