import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { absolutePath, ensureDir, id, nowIso, runCommand, sha256, truncate } from '../core/utils.mjs';

const DEFAULT_IGNORES = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.next', '.nuxt', '.cache', '.venv', 'venv',
  '__pycache__', 'dist', 'build', 'target', 'vendor', 'coverage', '.idea', '.vscode',
]);

export class WorkspaceManager {
  constructor({ store, config, logger, eventBus }) {
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
  }

  async open(workspacePath) {
    const resolved = absolutePath(workspacePath);
    const stat = await fsp.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Workspace is not a directory: ${resolved}`);
    const gitRoot = await this.findGitRoot(resolved);
    const workspace = this.store.upsertWorkspace(resolved, path.basename(resolved) || resolved, {
      gitRoot,
      openedAt: nowIso(),
    });
    this.store.setSetting('lastWorkspaceId', workspace.id);
    this.eventBus.emit('workspace.opened', workspace, { workspaceId: workspace.id });
    return workspace;
  }

  async findGitRoot(start) {
    let current = absolutePath(start);
    while (true) {
      try {
        const stat = await fsp.stat(path.join(current, '.git'));
        if (stat.isDirectory() || stat.isFile()) return current;
      } catch { /* continue */ }
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  get(workspaceId) {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    return workspace;
  }

  resolve(workspaceId, inputPath = '.') {
    const workspace = this.get(workspaceId);
    return absolutePath(inputPath, workspace.path);
  }

  async inspect(workspaceId) {
    const workspace = this.get(workspaceId);
    const gitRoot = workspace.meta?.gitRoot || await this.findGitRoot(workspace.path);
    const [files, gitStatus, packageFiles, context] = await Promise.all([
      this.listFiles(workspaceId, { maxEntries: 20_000, includeHidden: false }),
      gitRoot ? runCommand('git status --short --branch', { cwd: gitRoot, timeoutMs: 15_000 }).catch(() => null) : null,
      this.detectProjectFiles(workspace.path),
      this.loadContextFiles(workspace.path),
    ]);
    const languageCounts = {};
    for (const file of files.entries.filter((item) => item.type === 'file')) {
      const ext = path.extname(file.name).toLowerCase() || '(none)';
      languageCounts[ext] = (languageCounts[ext] || 0) + 1;
    }
    return {
      workspace,
      git: gitRoot ? { root: gitRoot, status: gitStatus?.stdout || '', clean: !gitStatus?.stdout?.split('\n').slice(1).join('').trim() } : null,
      files: { count: files.entries.filter((item) => item.type === 'file').length, truncated: files.truncated },
      languages: Object.entries(languageCounts).sort((a, b) => b[1] - a[1]).slice(0, 20),
      projectFiles: packageFiles,
      contextFiles: context.map((item) => ({ path: item.path, chars: item.content.length })),
    };
  }

  async detectProjectFiles(root) {
    const names = [
      'package.json', 'pnpm-workspace.yaml', 'pyproject.toml', 'requirements.txt', 'Cargo.toml',
      'go.mod', 'CMakeLists.txt', 'Makefile', 'meson.build', 'pom.xml', 'build.gradle',
      'composer.json', 'Gemfile', 'mix.exs', 'deno.json', 'bun.lock', 'Dockerfile',
      'docker-compose.yml', 'compose.yml', '.devcontainer/devcontainer.json',
    ];
    const found = [];
    for (const name of names) {
      try {
        const stat = await fsp.stat(path.join(root, name));
        if (stat.isFile()) found.push(name);
      } catch { /* optional */ }
    }
    return found;
  }

  async loadContextFiles(cwd) {
    const config = this.config.get();
    const gitRoot = await this.findGitRoot(cwd);
    const root = gitRoot || cwd;
    const ancestry = [];
    let current = cwd;
    while (true) {
      ancestry.push(current);
      if (current === root) break;
      const parent = path.dirname(current);
      if (parent === current || !current.startsWith(root)) break;
      current = parent;
    }
    ancestry.reverse();
    const results = [];
    for (const directory of ancestry) {
      for (const name of config.contextFiles) {
        const candidate = path.join(directory, name);
        try {
          const content = await fsp.readFile(candidate, 'utf8');
          results.push({ path: candidate, content: truncate(content, 50_000) });
        } catch { /* absent */ }
      }
    }
    return results;
  }

  async listFiles(workspaceId, {
    target = '.', depth = 4, includeHidden = false, maxEntries = 5000,
  } = {}) {
    const root = this.resolve(workspaceId, target);
    const workspace = this.get(workspaceId);
    const entries = [];
    let truncated = false;

    const walk = async (directory, currentDepth) => {
      if (entries.length >= maxEntries) { truncated = true; return; }
      let children;
      try {
        children = await fsp.readdir(directory, { withFileTypes: true });
      } catch (error) {
        entries.push({ path: path.relative(workspace.path, directory), name: path.basename(directory), type: 'error', error: error.message });
        return;
      }
      children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const child of children) {
        if (entries.length >= maxEntries) { truncated = true; return; }
        if (!includeHidden && child.name.startsWith('.')) continue;
        if (DEFAULT_IGNORES.has(child.name)) continue;
        const full = path.join(directory, child.name);
        const relative = path.relative(workspace.path, full) || '.';
        if (child.isDirectory()) {
          entries.push({ path: relative, name: child.name, type: 'directory', depth: relative.split(path.sep).length - 1 });
          if (currentDepth < depth) await walk(full, currentDepth + 1);
        } else if (child.isSymbolicLink()) {
          entries.push({ path: relative, name: child.name, type: 'symlink' });
        } else {
          const stat = await fsp.stat(full).catch(() => null);
          entries.push({ path: relative, name: child.name, type: 'file', size: stat?.size || 0, mtime: stat?.mtime?.toISOString() });
        }
      }
    };

    const stat = await fsp.stat(root);
    if (stat.isDirectory()) await walk(root, 0);
    else entries.push({ path: path.relative(workspace.path, root), name: path.basename(root), type: 'file', size: stat.size });
    return { root, entries, truncated };
  }

  async createCheckpoint(workspaceId, { runId = null, label = 'automatic' } = {}) {
    const workspace = this.get(workspaceId);
    const gitRoot = workspace.meta?.gitRoot || await this.findGitRoot(workspace.path);
    if (gitRoot) {
      const checkpointId = id('cpref');
      const refName = `refs/maskshift/checkpoints/${checkpointId}`;
      const status = await runCommand('git status --porcelain=v1 -z --untracked-files=all', { cwd: gitRoot, timeoutMs: 30_000 });
      const [tracked, head] = await Promise.all([
        runCommand('git stash create "MaskShift automatic checkpoint"', { cwd: gitRoot, timeoutMs: 60_000 }),
        runCommand('git rev-parse --verify HEAD', { cwd: gitRoot, timeoutMs: 15_000 }),
      ]);
      const commit = tracked.stdout.trim() || (head.code === 0 ? head.stdout.trim() : '');
      if (commit) {
        const update = await runCommand(`git update-ref ${refName} ${commit}`, { cwd: gitRoot, timeoutMs: 15_000 });
        if (update.code !== 0) throw new Error(update.stderr || update.stdout || 'Failed to create Git checkpoint ref');
      }

      const untrackedDir = path.join(this.config.get().home, 'checkpoints', checkpointId, 'untracked');
      const untracked = status.stdout.split('\0').filter(Boolean)
        .filter((line) => line.startsWith('?? ')).map((line) => line.slice(3));
      const copied = [];
      for (const relative of untracked.slice(0, 5000)) {
        const source = path.join(gitRoot, relative);
        const destination = path.join(untrackedDir, relative);
        try {
          const stat = await fsp.stat(source);
          if (stat.isFile() && stat.size <= 20 * 1024 * 1024) {
            await ensureDir(path.dirname(destination));
            await fsp.copyFile(source, destination);
            copied.push(relative);
          }
        } catch { /* best effort */ }
      }
      return this.store.saveCheckpoint({
        workspaceId, runId, kind: 'git-ref', ref: commit ? refName : null,
        manifest: { label, storageId: checkpointId, gitRoot, commit: commit || null, untracked: copied },
      });
    }

    const checkpointId = id('snapshot');
    const snapshotDir = path.join(this.config.get().home, 'checkpoints', checkpointId);
    await ensureDir(snapshotDir);
    const listing = await this.listFiles(workspaceId, { depth: 100, includeHidden: true, maxEntries: 20_000 });
    const files = [];
    let totalBytes = 0;
    for (const item of listing.entries) {
      if (item.type !== 'file' || item.size > 10 * 1024 * 1024 || totalBytes > 300 * 1024 * 1024) continue;
      const source = path.join(workspace.path, item.path);
      const destination = path.join(snapshotDir, item.path);
      await ensureDir(path.dirname(destination));
      await fsp.copyFile(source, destination);
      files.push(item.path);
      totalBytes += item.size || 0;
    }
    return this.store.saveCheckpoint({
      workspaceId, runId, kind: 'snapshot', ref: snapshotDir,
      manifest: { label, files, totalBytes },
    });
  }

  async restoreCheckpoint(workspaceId, checkpoint) {
    const workspace = this.get(workspaceId);
    if (checkpoint.kind === 'git-ref') {
      const { gitRoot, commit, untracked = [] } = checkpoint.manifest;
      if (commit) {
        const result = await runCommand(`git restore --source=${commit} --staged --worktree .`, {
          cwd: gitRoot, timeoutMs: 120_000,
        });
        if (result.code !== 0) throw new Error(result.stderr || 'Failed to restore git checkpoint');
      }
      const base = path.join(this.config.get().home, 'checkpoints', checkpoint.manifest?.storageId || checkpoint.ref?.split('/').pop() || '', 'untracked');
      for (const relative of untracked) {
        const source = path.join(base, relative);
        const destination = path.join(gitRoot, relative);
        try {
          await ensureDir(path.dirname(destination));
          await fsp.copyFile(source, destination);
        } catch { /* missing snapshot */ }
      }
      return { restored: true, kind: checkpoint.kind, commit };
    }
    if (checkpoint.kind === 'snapshot') {
      for (const relative of checkpoint.manifest.files || []) {
        const source = path.join(checkpoint.ref, relative);
        const destination = path.join(workspace.path, relative);
        await ensureDir(path.dirname(destination));
        await fsp.copyFile(source, destination);
      }
      return { restored: true, kind: checkpoint.kind, files: checkpoint.manifest.files?.length || 0 };
    }
    throw new Error(`Unsupported checkpoint type: ${checkpoint.kind}`);
  }

  async createWorktree(workspaceId, { branch, name, base = 'HEAD' } = {}) {
    const workspace = this.get(workspaceId);
    const gitRoot = workspace.meta?.gitRoot || await this.findGitRoot(workspace.path);
    if (!gitRoot) throw new Error('Worktrees require a Git repository');
    const safeName = (name || branch || `agent-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '-');
    const target = path.join(this.config.get().home, 'worktrees', sha256(gitRoot).slice(0, 12), safeName);
    await ensureDir(path.dirname(target));
    const branchName = branch || `maskshift/${safeName}`;
    const result = await runCommand(`git worktree add -b ${JSON.stringify(branchName)} ${JSON.stringify(target)} ${JSON.stringify(base)}`, {
      cwd: gitRoot, timeoutMs: 120_000,
    });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    const child = await this.open(target);
    return { workspace: child, path: target, branch: branchName, output: result.stdout };
  }
}
