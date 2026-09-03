import fsp from 'node:fs/promises';
import path from 'node:path';
import { id, nowIso, runCommand, sha256, truncate } from '../core/utils.mjs';

const LANGUAGE_BY_EXT = {
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

export class RepositoryIndexer {
  constructor({ store, workspaceManager, config, logger, eventBus }) {
    this.store = store;
    this.workspaceManager = workspaceManager;
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
    this.running = new Map();
  }

  language(file) {
    const base = path.basename(file).toLowerCase();
    if (base === 'dockerfile') return 'dockerfile';
    if (base === 'makefile') return 'makefile';
    return LANGUAGE_BY_EXT[path.extname(file).toLowerCase()] || 'text';
  }

  shouldIndex(relative, size) {
    if (size > 2 * 1024 * 1024) return false;
    const ext = path.extname(relative).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) return false;
    return !relative.split(path.sep).some((part) => [
      '.git', 'node_modules', '.next', '.nuxt', 'dist', 'build', 'target', '.venv', 'venv',
      'vendor', 'coverage', '.cache', '__pycache__',
    ].includes(part));
  }

  async fileList(root) {
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

  chunkFile(relative, content) {
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

  async index(workspaceId, { force = false } = {}) {
    if (this.running.has(workspaceId)) return this.running.get(workspaceId);
    const task = this.#runIndex(workspaceId, { force }).finally(() => this.running.delete(workspaceId));
    this.running.set(workspaceId, task);
    return task;
  }

  async #runIndex(workspaceId) {
    const workspace = this.workspaceManager.get(workspaceId);
    const started = Date.now();
    this.eventBus.emit('index.started', { path: workspace.path }, { workspaceId });
    const files = await this.fileList(workspace.path);
    const chunks = [];
    let scanned = 0;
    let indexedFiles = 0;

    for (const relative of files.slice(0, 100_000)) {
      scanned += 1;
      const full = path.join(workspace.path, relative);
      let stat;
      try { stat = await fsp.stat(full); } catch { continue; }
      if (!stat.isFile() || !this.shouldIndex(relative, stat.size)) continue;
      let buffer;
      try { buffer = await fsp.readFile(full); } catch { continue; }
      if (buffer.includes(0)) continue;
      const content = buffer.toString('utf8');
      if (!content.trim()) continue;
      indexedFiles += 1;
      const language = this.language(relative);
      for (const chunk of this.chunkFile(relative, content)) {
        chunks.push({
          id: id('chunk'),
          path: relative,
          language,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: truncate(chunk.content, 80_000),
          contentHash: sha256(chunk.content),
          indexedAt: nowIso(),
        });
      }
      if (indexedFiles % 100 === 0) {
        this.eventBus.emit('index.progress', { scanned, indexedFiles, chunks: chunks.length, totalFiles: files.length }, { workspaceId });
      }
    }

    this.store.replaceRepoChunks(workspaceId, chunks);
    const stats = { scanned, indexedFiles, chunks: chunks.length, durationMs: Date.now() - started };
    this.logger.info('Repository index completed', { workspaceId, ...stats });
    this.eventBus.emit('index.completed', stats, { workspaceId });
    return stats;
  }

  search(workspaceId, query, limit = 20) {
    return this.store.searchRepo(workspaceId, query, limit);
  }

  stats(workspaceId) {
    return this.store.repoIndexStats(workspaceId);
  }

  async contextFor(workspaceId, prompt, { limit = 12, maxChars = 90_000 } = {}) {
    const hits = this.search(workspaceId, prompt, limit);
    let used = 0;
    const selected = [];
    for (const hit of hits) {
      if (used >= maxChars) break;
      const text = truncate(hit.content, Math.min(20_000, maxChars - used));
      selected.push({ path: hit.path, startLine: hit.start_line, endLine: hit.end_line, language: hit.language, content: text });
      used += text.length;
    }
    return selected;
  }
}
