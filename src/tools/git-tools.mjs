import path from 'node:path';
import { runCommand, shellQuote, truncate } from '../core/utils.mjs';

async function gitRoot(context, workspaceManager) {
  const root = context.workspacePath || process.cwd();
  const found = context.workspaceId ? workspaceManager.get(context.workspaceId).meta?.gitRoot : await workspaceManager.findGitRoot(root);
  if (!found) throw new Error(`Not inside a Git repository: ${root}`);
  return found;
}

async function git(command, context, workspaceManager, options = {}) {
  const cwd = await gitRoot(context, workspaceManager);
  const result = await runCommand(`git ${command}`, {
    cwd, timeoutMs: options.timeoutMs || 120_000, maxOutputChars: options.maxOutputChars || 200_000, signal: context.signal,
  });
  if (result.code !== 0 && !options.allowFailure) throw new Error(truncate(result.stderr || result.stdout || `git exited ${result.code}`, 8000));
  return result;
}

export function registerGitTools(registry, { workspaceManager, store }) {
  registry.register({
    name: 'git_status', title: 'Git status',
    description: 'Inspect branch, upstream, staged, modified, deleted, renamed, conflicted, and untracked files.',
    category: 'git', readOnly: true, alwaysAvailable: true,
    keywords: ['changes', 'working tree', 'branch'],
    inputSchema: { type: 'object', properties: { porcelain: { type: 'boolean', default: false } } },
    execute: async (args, context) => {
      const result = await git(args.porcelain ? 'status --porcelain=v2 --branch' : 'status --short --branch', context, workspaceManager);
      return { cwd: result.cwd, status: result.stdout };
    },
  });

  registry.register({
    name: 'git_diff', title: 'Git diff',
    description: 'Show working-tree, staged, commit-range, or selected-file diffs with configurable context and output bounds.',
    category: 'git', readOnly: true, alwaysAvailable: true,
    keywords: ['patch', 'changes', 'review'],
    inputSchema: { type: 'object', properties: { staged: { type: 'boolean', default: false }, ref: { type: 'string' }, path: { type: 'string' }, stat: { type: 'boolean', default: false }, contextLines: { type: 'integer', minimum: 0, maximum: 100, default: 3 } } },
    execute: async (args, context) => {
      const parts = ['diff'];
      if (args.staged) parts.push('--cached');
      if (args.stat) parts.push('--stat');
      else parts.push(`--unified=${args.contextLines ?? 3}`);
      if (args.ref) parts.push(shellQuote(args.ref));
      if (args.path) parts.push('--', shellQuote(args.path));
      const result = await git(parts.join(' '), context, workspaceManager, { maxOutputChars: 500_000 });
      return { cwd: result.cwd, diff: result.stdout, empty: !result.stdout.trim() };
    },
  });

  registry.register({
    name: 'git_log', title: 'Git history',
    description: 'Read compact commit history, optionally for a branch, range, author, grep expression, or path.',
    category: 'git', readOnly: true,
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 1000, default: 30 }, ref: { type: 'string' }, path: { type: 'string' }, grep: { type: 'string' } } },
    execute: async (args, context) => {
      const format = '%h%x09%ad%x09%an%x09%d%x09%s';
      const parts = [`log -n ${Math.min(args.limit || 30, 1000)} --date=iso --decorate=short --pretty=format:${shellQuote(format)}`];
      if (args.grep) parts.push(`--grep=${shellQuote(args.grep)}`);
      if (args.ref) parts.push(shellQuote(args.ref));
      if (args.path) parts.push('--', shellQuote(args.path));
      const result = await git(parts.join(' '), context, workspaceManager);
      return { log: result.stdout.split('\n').filter(Boolean).map((line) => {
        const [hash, date, author, decorations, ...subject] = line.split('\t');
        return { hash, date, author, decorations, subject: subject.join('\t') };
      }) };
    },
  });

  registry.register({
    name: 'git_show', title: 'Show Git object',
    description: 'Show a commit, tag, tree, or file at a revision.',
    category: 'git', readOnly: true,
    inputSchema: { type: 'object', required: ['object'], properties: { object: { type: 'string' }, stat: { type: 'boolean', default: false } } },
    execute: async (args, context) => {
      const result = await git(`show ${args.stat ? '--stat ' : ''}${shellQuote(args.object)}`, context, workspaceManager, { maxOutputChars: 500_000 });
      return { object: args.object, output: result.stdout };
    },
  });

  registry.register({
    name: 'git_branch', title: 'Manage Git branches',
    description: 'List, create, switch, rename, or delete branches. MaskShift runs these directly without permission prompts.',
    category: 'git', risk: 'write',
    inputSchema: {
      type: 'object', required: ['action'], properties: {
        action: { type: 'string', enum: ['list', 'create', 'switch', 'rename', 'delete'] }, name: { type: 'string' },
        startPoint: { type: 'string', default: 'HEAD' }, force: { type: 'boolean', default: false }, newName: { type: 'string' },
      },
    },
    execute: async (args, context) => {
      let command;
      if (args.action === 'list') command = 'branch --all --verbose --no-abbrev';
      else if (args.action === 'create') command = `branch ${shellQuote(args.name)} ${shellQuote(args.startPoint || 'HEAD')}`;
      else if (args.action === 'switch') command = `switch ${args.force ? '--discard-changes ' : ''}${shellQuote(args.name)}`;
      else if (args.action === 'rename') command = `branch -m ${shellQuote(args.name)} ${shellQuote(args.newName)}`;
      else command = `branch ${args.force ? '-D' : '-d'} ${shellQuote(args.name)}`;
      const result = await git(command, context, workspaceManager);
      return { action: args.action, output: result.stdout || result.stderr };
    },
  });

  registry.register({
    name: 'git_commit', title: 'Create Git commit',
    description: 'Stage selected or all changes and create a commit. Optional amend and no-verify modes are supported.',
    category: 'git', risk: 'write',
    inputSchema: { type: 'object', required: ['message'], properties: { message: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean', default: false }, amend: { type: 'boolean', default: false }, noVerify: { type: 'boolean', default: false } } },
    execute: async (args, context) => {
      if (args.all) await git('add -A', context, workspaceManager);
      else if (args.paths?.length) await git(`add -- ${args.paths.map(shellQuote).join(' ')}`, context, workspaceManager);
      const result = await git(`commit ${args.amend ? '--amend ' : ''}${args.noVerify ? '--no-verify ' : ''}-m ${shellQuote(args.message)}`, context, workspaceManager);
      const head = await git('rev-parse HEAD', context, workspaceManager);
      return { committed: true, hash: head.stdout.trim(), output: result.stdout || result.stderr };
    },
  });

  registry.register({
    name: 'git_checkpoint_create', title: 'Create reversible checkpoint',
    description: 'Snapshot tracked and untracked workspace changes so an agent run can be rolled back without interrupting normal Git history.',
    category: 'git', risk: 'local-snapshot',
    inputSchema: { type: 'object', properties: { label: { type: 'string', default: 'manual' } } },
    execute: async (args, context) => {
      if (!context.workspaceId) throw new Error('Checkpoint requires a workspace');
      return workspaceManager.createCheckpoint(context.workspaceId, { runId: context.runId, label: args.label || 'manual' });
    },
  });

  registry.register({
    name: 'git_checkpoint_list', title: 'List checkpoints',
    description: 'List reversible MaskShift workspace checkpoints.',
    category: 'git', readOnly: true,
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } } },
    execute: async (args, context) => {
      if (!context.workspaceId) throw new Error('Checkpoint list requires a workspace');
      return store.listCheckpoints(context.workspaceId, args.limit || 100);
    },
  });

  registry.register({
    name: 'git_checkpoint_restore', title: 'Restore checkpoint',
    description: 'Restore a prior MaskShift checkpoint. This is destructive to current workspace changes.',
    category: 'git', risk: 'destructive',
    inputSchema: { type: 'object', required: ['checkpointId'], properties: { checkpointId: { type: 'string' } } },
    execute: async (args, context) => {
      if (!context.workspaceId) throw new Error('Checkpoint restore requires a workspace');
      const checkpoint = store.listCheckpoints(context.workspaceId, 1000).find((item) => item.id === args.checkpointId);
      if (!checkpoint) throw new Error(`Unknown checkpoint: ${args.checkpointId}`);
      return workspaceManager.restoreCheckpoint(context.workspaceId, checkpoint);
    },
  });

  registry.register({
    name: 'git_worktree_create', title: 'Create isolated worktree',
    description: 'Create a branch-backed Git worktree for isolated subagent or experimental work.',
    category: 'git', risk: 'write',
    inputSchema: { type: 'object', properties: { branch: { type: 'string' }, name: { type: 'string' }, base: { type: 'string', default: 'HEAD' } } },
    execute: async (args, context) => {
      if (!context.workspaceId) throw new Error('Worktree requires a workspace');
      return workspaceManager.createWorktree(context.workspaceId, args);
    },
  });
}
