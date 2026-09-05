import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const VERSION = '1.0.0';

export function id(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function absolutePath(value, cwd = process.cwd()) {
  const expanded = expandHome(value || cwd);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded);
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temp, file);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function truncate(value, maxChars = 60_000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.68);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n...[${text.length - maxChars} characters omitted]...\n\n${text.slice(-tail)}`;
}

export function safeJsonParse(value, fallback = null) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) {
      try { return JSON.parse(fenced); } catch { /* continue */ }
    }
    const first = Math.min(...['{', '['].map((c) => {
      const i = value.indexOf(c);
      return i < 0 ? Number.POSITIVE_INFINITY : i;
    }));
    if (Number.isFinite(first)) {
      const last = Math.max(value.lastIndexOf('}'), value.lastIndexOf(']'));
      if (last > first) {
        try { return JSON.parse(value.slice(first, last + 1)); } catch { /* continue */ }
      }
    }
    return fallback;
  }
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function normalizeWhitespace(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

export function tokenize(value = '') {
  return normalizeWhitespace(value)
    .toLowerCase()
    .split(/[^a-z0-9_+#.:-]+/)
    .filter((token) => token.length > 1);
}

export function textScore(query, haystack, keywords = []) {
  const q = tokenize(query);
  if (!q.length) return 0;
  const target = `${haystack} ${keywords.join(' ')}`.toLowerCase();
  let score = 0;
  for (const token of q) {
    if (target.includes(token)) score += 4;
    if (target.startsWith(token)) score += 2;
    const exact = new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}([^a-z0-9]|$)`, 'i');
    if (exact.test(target)) score += 3;
  }
  if (target.includes(query.toLowerCase())) score += 8;
  return score;
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('-')) {
      args._.push(item);
      continue;
    }
    const raw = item.replace(/^--?/, '');
    const [key, inline] = raw.split(/=(.*)/s, 2);
    if (inline !== undefined) {
      args[key] = inline;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
      args[key] = argv[++i];
    } else {
      args[key] = true;
    }
  }
  return args;
}

export async function commandExists(command) {
  if (typeof command !== 'string' || !command) return null;
  const candidates = path.isAbsolute(command) || command.includes(path.sep)
    ? [path.resolve(command)]
    : (process.env.PATH || '').split(path.delimiter).map((base) => path.join(base, command));
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      if ((await fsp.stat(candidate)).isFile()) return candidate;
    } catch { /* keep searching */ }
  }
  return null;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export async function runCommand(command, {
  cwd = process.cwd(),
  env = {},
  timeoutMs = 120_000,
  maxOutputChars = 100_000,
  signal,
  onStdout,
  onStderr,
  shell = true,
} = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, {
      cwd,
      env: { ...process.env, ...env },
      shell,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const append = (target, chunk) => {
      const next = target + chunk;
      return next.length > maxOutputChars ? next.slice(-maxOutputChars) : next;
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout = append(stdout, text);
      onStdout?.(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr = append(stderr, text);
      onStderr?.(text);
    });

    const kill = () => {
      if (child.killed) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch { child.kill('SIGTERM'); }
      setTimeout(() => {
        if (child.exitCode === null) {
          try {
            if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch { child.kill('SIGKILL'); }
        }
      }, 1500).unref();
    };

    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs) : null;
    timer?.unref();

    const abort = () => kill();
    signal?.addEventListener('abort', abort, { once: true });

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({
        command,
        cwd,
        pid: child.pid,
        code: code ?? (timedOut ? 124 : 1),
        signal: closeSignal,
        timedOut,
        aborted: Boolean(signal?.aborted),
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}

export function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
  })[ext] || 'application/octet-stream';
}

export function debounce(fn, delayMs) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

export function pick(object, keys) {
  return Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]]));
}

export function redactSecrets(value) {
  const secretKey = /(api[_-]?key|token|secret|password|authorization|cookie)/i;
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    secretKey.test(key) && typeof item === 'string' && item ? '***configured***' : redactSecrets(item),
  ]));
}

export async function readRequestBody(request, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error(`Request body exceeds ${limit} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  const type = request.headers['content-type'] || '';
  if (type.includes('application/json')) {
    try { return JSON.parse(text); } catch {
      const error = new Error('Invalid JSON body');
      error.statusCode = 400;
      throw error;
    }
  }
  return text;
}

export function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

export function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
