import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { absolutePath, ensureDir, id, runCommand, sha256, truncate } from '../core/utils.mjs';

function resolveTarget(input, context) {
  return absolutePath(input || '.', context.workspacePath || process.cwd());
}

export function registerFilesystemTools(registry, { workspaceManager, config }) {
  registry.register({
    name: 'fs_list',
    title: 'List files and directories',
    description: 'List a directory tree with file sizes and types. Paths may be workspace-relative or absolute in overdrive mode.',
    category: 'filesystem', readOnly: true, alwaysAvailable: true,
    keywords: ['ls', 'tree', 'directory', 'files', 'explore'],
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', default: '.' },
        depth: { type: 'integer', minimum: 0, maximum: 100, default: 3 },
        includeHidden: { type: 'boolean', default: false },
        maxEntries: { type: 'integer', minimum: 1, maximum: 50000, default: 5000 },
      },
    },
    execute: async (args, context) => {
      if (context.workspaceId && !path.isAbsolute(args.path || '.')) {
        return workspaceManager.listFiles(context.workspaceId, {
          target: args.path || '.', depth: args.depth ?? 3,
          includeHidden: Boolean(args.includeHidden), maxEntries: args.maxEntries || 5000,
        });
      }
      const root = resolveTarget(args.path, context);
      const maxEntries = args.maxEntries || 5000;
      const entries = [];
      const walk = async (dir, depth) => {
        if (entries.length >= maxEntries) return;
        const children = await fsp.readdir(dir, { withFileTypes: true });
        for (const child of children) {
          if (entries.length >= maxEntries) break;
          if (!args.includeHidden && child.name.startsWith('.')) continue;
          const full = path.join(dir, child.name);
          const stat = await fsp.lstat(full);
          entries.push({ path: full, name: child.name, type: child.isDirectory() ? 'directory' : child.isSymbolicLink() ? 'symlink' : 'file', size: stat.size });
          if (child.isDirectory() && depth < (args.depth ?? 3)) await walk(full, depth + 1);
        }
      };
      await walk(root, 0);
      return { root, entries, truncated: entries.length >= maxEntries };
    },
  });

  registry.register({
    name: 'fs_read',
    title: 'Read text file',
    description: 'Read a UTF-8 text file with optional 1-based line range and hard output bounds.',
    category: 'filesystem', readOnly: true, alwaysAvailable: true,
    keywords: ['cat', 'open file', 'source', 'inspect'],
    inputSchema: {
      type: 'object', required: ['path'],
      properties: {
        path: { type: 'string' },
        startLine: { type: 'integer', minimum: 1, default: 1 },
        endLine: { type: 'integer', minimum: 1 },
        maxChars: { type: 'integer', minimum: 100, maximum: 1000000 },
        withLineNumbers: { type: 'boolean', default: true },
      },
    },
    execute: async (args, context) => {
      const target = resolveTarget(args.path, context);
      const stat = await fsp.stat(target);
      if (!stat.isFile()) throw new Error(`Not a file: ${target}`);
      const maxChars = Math.min(args.maxChars || config.get().maxFileReadChars, 1_000_000);
      const content = await fsp.readFile(target, 'utf8');
      const lines = content.split('\n');
      const start = Math.max(1, args.startLine || 1);
      const end = Math.min(lines.length, args.endLine || lines.length);
      const selected = lines.slice(start - 1, end);
      const rendered = args.withLineNumbers === false
        ? selected.join('\n')
        : selected.map((line, index) => `${String(start + index).padStart(6)} | ${line}`).join('\n');
      return {
        path: target,
        size: stat.size,
        totalLines: lines.length,
        startLine: start,
        endLine: end,
        truncated: rendered.length > maxChars,
        content: truncate(rendered, maxChars),
      };
    },
  });

  registry.register({
    name: 'fs_read_binary',
    title: 'Read binary file',
    description: 'Read a bounded binary file as base64 with MIME-relevant metadata.',
    category: 'filesystem', readOnly: true,
    keywords: ['binary', 'image', 'base64', 'asset'],
    inputSchema: {
      type: 'object', required: ['path'],
      properties: { path: { type: 'string' }, maxBytes: { type: 'integer', minimum: 1, maximum: 20000000, default: 5000000 } },
    },
    execute: async (args, context) => {
      const target = resolveTarget(args.path, context);
      const stat = await fsp.stat(target);
      const maxBytes = Math.min(args.maxBytes || 5_000_000, 20_000_000);
      if (stat.size > maxBytes) throw new Error(`File is ${stat.size} bytes; maximum is ${maxBytes}`);
      const content = await fsp.readFile(target);
      return { path: target, size: stat.size, extension: path.extname(target), base64: content.toString('base64'), sha256: sha256(content) };
    },
  });

  registry.register({
    name: 'fs_write',
    title: 'Write file',
    description: 'Create or overwrite a file atomically. Parent directories are created automatically.',
    category: 'filesystem', risk: 'write', alwaysAvailable: true,
    keywords: ['write', 'create file', 'save', 'edit'],
    inputSchema: {
      type: 'object', required: ['path', 'content'],
      properties: {
        path: { type: 'string' }, content: { type: 'string' },
        mode: { type: 'string', enum: ['overwrite', 'create', 'append'], default: 'overwrite' },
      },
    },
    execute: async (args, context) => {
      const target = resolveTarget(args.path, context);
      await ensureDir(path.dirname(target));
      if (args.mode === 'create') {
        try { await fsp.access(target); throw new Error(`File already exists: ${target}`); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      if (args.mode === 'append') await fsp.appendFile(target, args.content, 'utf8');
      else {
        const temp = `${target}.${process.pid}.${id('write')}.tmp`;
        await fsp.writeFile(temp, args.content, 'utf8');
        await fsp.rename(temp, target);
      }
      const stat = await fsp.stat(target);
      return { path: target, size: stat.size, sha256: sha256(await fsp.readFile(target)) };
    },
  });

  registry.register({
    name: 'fs_patch',
    title: 'Apply exact text edits',
    description: 'Apply one or more exact oldText/newText replacements to a file atomically. Fails on missing or ambiguous text unless replaceAll is requested.',
    category: 'filesystem', risk: 'write', alwaysAvailable: true,
    keywords: ['patch', 'replace', 'edit file', 'modify'],
    inputSchema: {
      type: 'object', required: ['path', 'edits'],
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array', minItems: 1,
          items: {
            type: 'object', required: ['oldText', 'newText'],
            properties: { oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean', default: false } },
          },
        },
      },
    },
    execute: async (args, context) => {
      const target = resolveTarget(args.path, context);
      let content = await fsp.readFile(target, 'utf8');
      const applied = [];
      for (const [index, edit] of args.edits.entries()) {
        if (!edit.oldText) throw new Error(`Edit ${index} has empty oldText`);
        const count = content.split(edit.oldText).length - 1;
        if (count === 0) throw new Error(`Edit ${index} oldText was not found in ${target}`);
        if (count > 1 && !edit.replaceAll) throw new Error(`Edit ${index} matched ${count} locations; provide more context or set replaceAll`);
        content = edit.replaceAll ? content.split(edit.oldText).join(edit.newText) : content.replace(edit.oldText, edit.newText);
        applied.push({ index, replacements: edit.replaceAll ? count : 1 });
      }
      const temp = `${target}.${process.pid}.${id('patch')}.tmp`;
      await fsp.writeFile(temp, content, 'utf8');
      await fsp.rename(temp, target);
      return { path: target, applied, size: Buffer.byteLength(content), sha256: sha256(content) };
    },
  });

  registry.register({
    name: 'fs_apply_patch',
    title: 'Apply unified diff',
    description: 'Apply a unified diff using git apply. The patch can update multiple files and is checked before application.',
    category: 'filesystem', risk: 'write',
    keywords: ['unified diff', 'git apply', 'multi file patch'],
    inputSchema: {
      type: 'object', required: ['patch'],
      properties: { patch: { type: 'string' }, cwd: { type: 'string', default: '.' }, reverse: { type: 'boolean', default: false } },
    },
    execute: async (args, context) => {
      const cwd = resolveTarget(args.cwd || '.', context);
      const temp = path.join(os.tmpdir(), `maskshift-${id('diff')}.patch`);
      await fsp.writeFile(temp, args.patch, 'utf8');
      try {
        const flags = args.reverse ? '--reverse ' : '';
        const check = await runCommand(`git apply ${flags}--check --recount --whitespace=nowarn ${JSON.stringify(temp)}`, { cwd, timeoutMs: 30_000 });
        if (check.code !== 0) throw new Error(check.stderr || check.stdout || 'Patch check failed');
        const apply = await runCommand(`git apply ${flags}--recount --whitespace=nowarn ${JSON.stringify(temp)}`, { cwd, timeoutMs: 60_000 });
        if (apply.code !== 0) throw new Error(apply.stderr || apply.stdout || 'Patch application failed');
        return { applied: true, cwd, reverse: Boolean(args.reverse) };
      } finally {
        await fsp.rm(temp, { force: true });
      }
    },
  });

  registry.register({
    name: 'fs_mkdir',
    title: 'Create directory',
    description: 'Create a directory and missing parent directories.',
    category: 'filesystem', risk: 'write',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    execute: async (args, context) => ({ path: await ensureDir(resolveTarget(args.path, context)), created: true }),
  });

  registry.register({
    name: 'fs_move',
    title: 'Move or rename path',
    description: 'Move or rename a file or directory, optionally replacing the destination.',
    category: 'filesystem', risk: 'write',
    inputSchema: {
      type: 'object', required: ['from', 'to'],
      properties: { from: { type: 'string' }, to: { type: 'string' }, overwrite: { type: 'boolean', default: false } },
    },
    execute: async (args, context) => {
      const from = resolveTarget(args.from, context);
      const to = resolveTarget(args.to, context);
      await fsp.lstat(from);
      if (from === to) return { from, to };
      await ensureDir(path.dirname(to));
      if (!args.overwrite) {
        try {
          await fsp.lstat(to);
          throw new Error(`Destination already exists: ${to}`);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      if (args.overwrite) await fsp.rm(to, { recursive: true, force: true });
      await fsp.rename(from, to);
      return { from, to };
    },
  });

  registry.register({
    name: 'fs_delete',
    title: 'Delete path',
    description: 'Delete a file or directory recursively. Overdrive mode executes immediately without an approval prompt.',
    category: 'filesystem', risk: 'destructive',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, recursive: { type: 'boolean', default: true } } },
    execute: async (args, context) => {
      const target = resolveTarget(args.path, context);
      await fsp.rm(target, { recursive: args.recursive !== false, force: true });
      return { path: target, deleted: true };
    },
  });

  registry.register({
    name: 'fs_stat',
    title: 'Inspect path metadata',
    description: 'Return file type, size, timestamps, mode, target and hash metadata.',
    category: 'filesystem', readOnly: true,
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, hash: { type: 'boolean', default: false } } },
    execute: async (args, context) => {
      const target = resolveTarget(args.path, context);
      const stat = await fsp.lstat(target);
      const result = {
        path: target, type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other',
        size: stat.size, mode: stat.mode.toString(8), mtime: stat.mtime.toISOString(), ctime: stat.ctime.toISOString(),
      };
      if (stat.isSymbolicLink()) result.target = await fsp.readlink(target);
      if (args.hash && stat.isFile()) result.sha256 = sha256(await fsp.readFile(target));
      return result;
    },
  });
}
