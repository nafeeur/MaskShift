// Pure file-scanning and embedding helpers shared between RepositoryIndexer
// (which also does on-demand search, so it stays on the main thread) and
// index-worker.mjs (which does the one-time, CPU/IO-heavy walk of a large
// repository off the main thread — see repository-indexer.mjs's #runIndex).

import fsp from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '../core/utils.mjs';

export const LANGUAGE_BY_EXT = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.py': 'python', '.rs': 'rust', '.go': 'go',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.swift': 'swift', '.rb': 'ruby',
  '.php': 'php', '.cs': 'csharp', '.scala': 'scala', '.lua': 'lua', '.r': 'r', '.m': 'matlab',
  '.jl': 'julia', '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell',
  '.sql': 'sql', '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss',
  '.vue': 'vue', '.svelte': 'svelte', '.json': 'json', '.jsonc': 'json', '.yaml': 'yaml',
  '.yml': 'yaml', '.toml': 'toml', '.xml': 'xml', '.md': 'markdown', '.mdx': 'markdown',
  '.proto': 'protobuf', '.graphql': 'graphql', '.gql': 'graphql', '.cmake': 'cmake',
  '.dockerfile': 'dockerfile', '.tf': 'terraform', '.hcl': 'hcl', '.nix': 'nix',
};

const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.tar', '.gz', '.7z',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.woff', '.woff2', '.ttf', '.otf', '.class',
  '.jar', '.so', '.dylib', '.dll', '.exe', '.bin', '.db', '.sqlite', '.lock',
]);

const BOUNDARY = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|trait|impl|def|async\s+def|fn|pub\s+fn|func|package|namespace|module)\b|^\s*(?:describe|it|test)\s*\(/;

export function language(file) {
  const base = path.basename(file).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  return LANGUAGE_BY_EXT[path.extname(file).toLowerCase()] || 'text';
}

/**
 * Order files so the ones most likely to matter come first: recognised source before everything else, then shallow
 * before deep, then by name for a stable result. A limit that cuts the list short then cuts the least valuable end.
 */
export function prioritise(files) {
  const rank = (file) => (LANGUAGE_BY_EXT[path.extname(file).toLowerCase()] || /^(dockerfile|makefile)$/i.test(path.basename(file)) ? 0 : 1);
  return [...files].sort((a, b) => rank(a) - rank(b) || a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
}

export function shouldIndex(relative, size) {
  if (size > 2 * 1024 * 1024) return false;
  const ext = path.extname(relative).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return false;
  return !relative.split(path.sep).some((part) => [
    '.git', 'node_modules', '.next', '.nuxt', 'dist', 'build', 'target', '.venv', 'venv',
    'vendor', 'coverage', '.cache', '__pycache__',
  ].includes(part));
}

export async function fileList(root) {
  const result = await runCommand('rg --files --hidden -g "!.git/**" -g "!node_modules/**" -g "!dist/**" -g "!build/**" -g "!target/**" -g "!.venv/**" -g "!vendor/**"', {
    cwd: root, timeoutMs: 60_000, maxOutputChars: 8_000_000,
  }).catch(() => null);
  if (result?.code === 0 || result?.stdout) return result.stdout.split('\n').filter(Boolean);

  const files = [];
  const walk = async (directory) => {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (['.git', 'node_modules', 'dist', 'build', 'target', '.venv', 'vendor'].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(path.relative(root, full));
    }
  };
  await walk(root);
  return files;
}

export function chunkFile(relative, content) {
  const lines = content.split('\n');
  if (lines.length <= 180) return [{ startLine: 1, endLine: lines.length, content }];
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    let end = Math.min(lines.length, start + 180);
    if (end < lines.length) {
      for (let candidate = end; candidate > start + 80; candidate -= 1) {
        if (BOUNDARY.test(lines[candidate] || '')) { end = candidate; break; }
      }
    }
    const before = Math.max(0, start - (start ? 18 : 0));
    chunks.push({
      startLine: before + 1,
      endLine: end,
      content: lines.slice(before, end).join('\n'),
    });
    if (end <= start) break;
    start = end;
  }
  return chunks;
}

export async function ollamaEmbed(baseUrl, model, inputs, { timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Embedding request timed out')), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: inputs }), signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Ollama embeddings HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.embeddings)) throw new Error('Ollama embeddings response is missing an embeddings array');
    return data.embeddings;
  } finally { clearTimeout(timer); }
}
