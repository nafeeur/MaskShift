// 08 GIT — the dedicated source-control view: working tree changes, commit
// history, branches, stash, checkpoints and worktrees, all in one place.
//
// Replaces the old small "GIT" tab that used to live in the right-hand rail
// (a raw `git status --short` dump with no way to act on anything). This
// view can actually do something with what it shows: stage/unstage/discard/
// commit, switch/create/rename/delete branches, apply/pop/drop stash, restore
// a MaskShift checkpoint, and manage worktrees — plus push/pull/fetch as
// global actions available from every tab.
//
// Every mutating action shells out to the system `git` binary directly (see
// app.mjs's gitStageToggle/gitPush/etc.) rather than going through the tool
// registry — the same pattern the header's branch readout already used in
// refreshGit(). This keeps the deliberately curated agent-facing tool surface
// untouched while still giving the human operator full control from the TUI.

import { glyphs } from '../box.mjs';
import { fit, oneLine, truncate } from '../text.mjs';
import { statusGlyph, statusOf } from '../status.mjs';
import { SPACE } from '../tokens.mjs';
import { detailBlock, handleCatalog, listRow, renderCatalog } from './catalog.mjs';
import { fuzzy } from '../widgets.mjs';

const TABS = [
  { id: 'changes', label: 'CHANGES' },
  { id: 'log', label: 'LOG' },
  { id: 'branches', label: 'BRANCHES' },
  { id: 'stash', label: 'STASH' },
  { id: 'checkpoints', label: 'CHECKPOINTS' },
  { id: 'worktrees', label: 'WORKTREES' },
];

const STATUS_LABEL = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', T: 'modified' };

// -------------------------------------------------------------- parsing

/** `git status --porcelain=v2 --branch` → branch/upstream/ahead-behind plus
 *  the raw per-path index(X)/worktree(Y) status pairs. */
export function parseGitStatus(text) {
  let branch = '';
  let upstream = '';
  let ahead = 0;
  let behind = 0;
  const changes = [];
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim();
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length).trim();
    else if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+) -(\d+)/);
      if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
    } else if (line.startsWith('1 ')) {
      const match = line.match(/^1 (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/);
      if (match) changes.push({ xy: match[1], path: match[2] });
    } else if (line.startsWith('2 ')) {
      const match = line.match(/^2 (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/);
      if (match) {
        const [path, origPath] = match[2].split('\t');
        changes.push({ xy: match[1], path, origPath });
      }
    } else if (line.startsWith('u ')) {
      const match = line.match(/^u (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/);
      if (match) changes.push({ xy: match[1], path: match[2], conflict: true });
    } else if (line.startsWith('? ')) {
      changes.push({ xy: '??', path: line.slice(2), untracked: true });
    }
  }
  return { branch, upstream, ahead, behind, changes };
}

/** Split each porcelain-v2 entry into up to two actionable rows — one for the
 *  index (staged) side, one for the worktree (unstaged) side — the same way
 *  a file with mixed staged/unstaged edits shows up twice in a normal
 *  `git status`. */
export function expandGitChanges(parsed) {
  const out = [];
  for (const change of parsed.changes) {
    if (change.untracked) { out.push({ path: change.path, staged: false, statusKey: 'untracked' }); continue; }
    if (change.conflict) { out.push({ path: change.path, staged: false, statusKey: 'conflict', conflict: true }); continue; }
    const [x, y] = change.xy;
    if (x && x !== '.') out.push({ path: change.path, staged: true, statusKey: STATUS_LABEL[x] || 'modified', origPath: change.origPath });
    if (y && y !== '.') out.push({ path: change.path, staged: false, statusKey: STATUS_LABEL[y] || 'modified', origPath: change.origPath });
  }
  return out;
}

export function parseGitLog(text) {
  return String(text || '').split('\n').filter(Boolean).map((line) => {
    const [hash, short, date, author, refs, ...rest] = line.split('\t');
    return { hash, short, date, author, refs: refs || '', subject: rest.join('\t') };
  });
}

export function parseGitBranches(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    const current = raw.startsWith('*');
    const rest = raw.slice(2);
    const match = rest.match(/^(\S+)\s+(\S+)\s+(?:\[([^\]]+)\]\s+)?(.*)$/);
    if (!match) continue;
    const [, rawName, hash, upstreamInfo, subject] = match;
    const remote = rawName.startsWith('remotes/');
    out.push({
      name: remote ? rawName.slice('remotes/'.length) : rawName,
      current, remote, hash, upstreamInfo: upstreamInfo || '', subject,
    });
  }
  return out;
}

export function parseGitStash(text) {
  return String(text || '').split('\n').filter(Boolean).map((line) => {
    const [ref, message] = line.split('\t');
    return { ref, message: message || '' };
  });
}

export function parseGitWorktrees(text) {
  return String(text || '').split('\n\n').map((block) => block.trim()).filter(Boolean).map((block) => {
    const entry = { path: '', head: '', branch: '', bare: false, locked: false, detached: false };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) entry.path = line.slice(9);
      else if (line.startsWith('HEAD ')) entry.head = line.slice(5);
      else if (line.startsWith('branch ')) entry.branch = line.slice(7).replace('refs/heads/', '');
      else if (line === 'bare') entry.bare = true;
      else if (line === 'detached') entry.detached = true;
      else if (line.startsWith('locked')) entry.locked = true;
    }
    return entry;
  });
}

// A small, local unified-diff colourer for the detail pane. `diff.mjs`'s
// `diffLines` bakes its own gutter into every line for the chat transcript;
// `detailBlock`'s `{ raw }` sections add their own gutter too, so reusing it
// here would double it up. This returns bare painted lines instead.
function paintDiff(theme, text, width, { maxLines = 300 } = {}) {
  const raw = String(text || '').replace(/\n$/, '').split('\n');
  if (!raw.length || (raw.length === 1 && !raw[0])) {
    return [theme.paint('No changes.', { fg: theme.roles.muted, italic: true })];
  }
  const shown = raw.slice(0, maxLines);
  const lines = shown.map((line) => {
    let tone = theme.roles.dim;
    let bold = false;
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) { tone = theme.roles.label; bold = true; }
    else if (line.startsWith('@@')) { tone = theme.roles.info; bold = true; }
    else if (line.startsWith('+')) tone = theme.roles.success;
    else if (line.startsWith('-')) tone = theme.roles.danger;
    return theme.paint(fit(truncate(line, width), width), { fg: tone, bold });
  });
  if (raw.length > maxLines) lines.push(theme.paint(`… ${raw.length - maxLines} more lines`, { fg: theme.roles.faint, italic: true }));
  return lines;
}

function loadingLines(theme) {
  return [theme.paint('Loading…', { fg: theme.roles.muted, italic: true })];
}

// ------------------------------------------------------------------ items

export function items(app) {
  const query = app.gitFilter.value.trim();
  let source = [];
  if (app.gitTab === 'changes') {
    source = app.gitChanges.map((change) => ({
      id: `change:${change.staged ? 's' : 'u'}:${change.path}`,
      kind: 'change',
      name: change.path,
      status: change.statusKey === 'untracked' || change.statusKey === 'conflict' ? change.statusKey : (change.staged ? 'staged' : change.statusKey),
      description: change.staged ? 'staged' : (change.statusKey === 'untracked' ? 'untracked' : change.statusKey === 'conflict' ? 'unmerged' : 'unstaged'),
      raw: change,
    }));
  } else if (app.gitTab === 'log') {
    source = app.gitLogEntries.map((entry) => ({
      id: `log:${entry.hash}`,
      kind: 'commit',
      name: entry.subject,
      status: entry.short,
      description: `${entry.author} · ${entry.date}${entry.refs ? ` · ${entry.refs}` : ''}`,
      raw: entry,
    }));
  } else if (app.gitTab === 'branches') {
    source = app.gitBranches.map((branch) => ({
      id: `branch:${branch.remote ? 'r' : 'l'}:${branch.name}`,
      kind: 'branch',
      name: branch.name,
      status: branch.current ? 'current' : (branch.remote ? 'remote' : 'local'),
      description: branch.subject || '',
      raw: branch,
    }));
  } else if (app.gitTab === 'stash') {
    source = app.gitStashes.map((stash) => ({
      id: `stash:${stash.ref}`,
      kind: 'stash',
      name: stash.message || stash.ref,
      status: stash.ref,
      description: '',
      raw: stash,
    }));
  } else if (app.gitTab === 'checkpoints') {
    source = (app.runtime.store.listCheckpoints(app.workspaceId, 200) || []).map((checkpoint) => ({
      id: `cp:${checkpoint.id}`,
      kind: 'checkpoint',
      name: `${checkpoint.kind} ${checkpoint.ref || ''}`.trim(),
      status: checkpoint.kind,
      description: `${app.stamp(checkpoint.created_at)} · ${checkpoint.manifest?.label || ''}`,
      raw: checkpoint,
    }));
  } else {
    source = app.gitWorktrees.map((worktree) => ({
      id: `wt:${worktree.path}`,
      kind: 'worktree',
      name: worktree.path,
      status: worktree.branch || (worktree.detached ? 'detached' : (worktree.bare ? 'bare' : '')),
      description: worktree.head ? worktree.head.slice(0, 10) : '',
      raw: worktree,
    }));
  }
  if (!query) return source;
  return source
    .map((item) => {
      const match = fuzzy(query, `${item.name} ${item.description}`);
      return match ? { ...item, score: match.score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

function row(app, item, selected, width) {
  const { theme } = app;
  const mark = glyphs(theme);
  let marker;
  let markerTone;
  let label;
  let tone;
  if (item.kind === 'commit') {
    marker = mark.dot; markerTone = theme.roles.accent; label = item.status; tone = theme.roles.accent;
  } else {
    const state = statusOf(item.status);
    marker = statusGlyph(theme, item.status, { animate: false });
    markerTone = theme.role(state.tone);
    label = state.label;
    tone = theme.role(state.tone);
  }
  const nameWidth = item.kind === 'commit' ? 44 : 28;
  const statusWidth = item.kind === 'commit' ? 9 : 11;
  return listRow(app, {
    selected, width, marker, markerTone,
    cells: [
      { text: truncate(item.name, nameWidth), width: nameWidth, tone: theme.roles.text, bold: item.kind !== 'commit' },
      { text: label, width: statusWidth, tone },
      { text: item.description || '', tone: theme.roles.muted },
    ],
  });
}

// ---------------------------------------------------------------- detail

function changeDetail(app, item, width) {
  const { theme } = app;
  const raw = item.raw;
  const key = `change:${raw.staged ? 's' : 'u'}:${raw.path}`;
  const cached = app.gitDetailCache.get(key);
  const sections = [
    { field: 'path', value: raw.path },
    raw.origPath ? { field: 'renamed from', value: raw.origPath } : null,
    { field: 'state', value: raw.staged ? 'staged' : raw.statusKey },
    { heading: 'diff' },
  ];
  if (!cached || cached.loading) sections.push({ raw: loadingLines(theme) });
  else if (cached.error) sections.push({ field: 'error', value: cached.error, tone: theme.roles.danger });
  else sections.push({ raw: paintDiff(theme, cached.text, Math.max(20, width - SPACE.gutter)) });
  return detailBlock(app, width, sections);
}

function commitDetail(app, item, width) {
  const { theme } = app;
  const raw = item.raw;
  const key = `commit:${raw.hash}`;
  const cached = app.gitDetailCache.get(key);
  const sections = [
    { field: 'hash', value: raw.hash },
    { field: 'author', value: raw.author },
    { field: 'date', value: raw.date },
    raw.refs ? { field: 'refs', value: raw.refs, tone: theme.roles.accent } : null,
    { heading: 'subject' },
    raw.subject,
    { heading: 'diff' },
  ];
  if (!cached || cached.loading) sections.push({ raw: loadingLines(theme) });
  else if (cached.error) sections.push({ field: 'error', value: cached.error, tone: theme.roles.danger });
  else sections.push({ raw: paintDiff(theme, cached.text, Math.max(20, width - SPACE.gutter)) });
  return detailBlock(app, width, sections);
}

function branchDetail(app, item, width) {
  const raw = item.raw;
  const sections = [
    { field: 'name', value: raw.name },
    { field: 'state', value: raw.current ? 'current' : (raw.remote ? 'remote' : 'local') },
    { field: 'hash', value: raw.hash },
    raw.upstreamInfo ? { field: 'upstream', value: raw.upstreamInfo } : null,
    { heading: 'last commit' },
    raw.subject,
  ];
  return detailBlock(app, width, sections);
}

function stashDetail(app, item, width) {
  const { theme } = app;
  const raw = item.raw;
  const key = `stash:${raw.ref}`;
  const cached = app.gitDetailCache.get(key);
  const sections = [
    { field: 'ref', value: raw.ref },
    { field: 'message', value: raw.message },
    { heading: 'diff' },
  ];
  if (!cached || cached.loading) sections.push({ raw: loadingLines(theme) });
  else if (cached.error) sections.push({ field: 'error', value: cached.error, tone: theme.roles.danger });
  else sections.push({ raw: paintDiff(theme, cached.text, Math.max(20, width - SPACE.gutter)) });
  return detailBlock(app, width, sections);
}

function checkpointDetail(app, item, width) {
  const { theme } = app;
  const raw = item.raw;
  const sections = [
    { field: 'id', value: raw.id },
    { field: 'kind', value: raw.kind },
    { field: 'ref', value: raw.ref || '' },
    { field: 'created', value: app.stamp(raw.created_at) },
    { field: 'label', value: raw.manifest?.label || '' },
  ];
  return detailBlock(app, width, sections);
}

function worktreeDetail(app, item, width) {
  const raw = item.raw;
  const sections = [
    { field: 'path', value: raw.path },
    { field: 'branch', value: raw.branch || (raw.detached ? '(detached)' : '') },
    { field: 'head', value: raw.head },
    raw.bare ? { field: 'bare', value: 'yes' } : null,
    raw.locked ? { field: 'locked', value: 'yes' } : null,
  ];
  return detailBlock(app, width, sections);
}

export function detail(app, width) {
  const item = app.gitList.current;
  if (!item) return null;
  if (item.kind === 'change') return changeDetail(app, item, width);
  if (item.kind === 'commit') return commitDetail(app, item, width);
  if (item.kind === 'branch') return branchDetail(app, item, width);
  if (item.kind === 'stash') return stashDetail(app, item, width);
  if (item.kind === 'checkpoint') return checkpointDetail(app, item, width);
  if (item.kind === 'worktree') return worktreeDetail(app, item, width);
  return null;
}

// ---------------------------------------------------------------- render

const EMPTY_HINTS = {
  changes: { title: 'Working tree clean', hint: '' },
  log: { title: 'No commits yet', hint: '' },
  branches: { title: 'No branches found', hint: 'n creates one' },
  stash: { title: 'Nothing stashed', hint: 'n stashes current changes' },
  checkpoints: { title: 'No checkpoints recorded', hint: 'n saves one' },
  worktrees: { title: 'No additional worktrees', hint: 'n creates one' },
};

export function render(app, region) {
  const list = items(app);
  app.gitList.setItems(list);
  const counts = {
    changes: app.gitChanges.length,
    log: app.gitLogEntries.length,
    branches: app.gitBranches.length,
    stash: app.gitStashes.length,
    checkpoints: (app.runtime.store.listCheckpoints(app.workspaceId, 200) || []).length,
    worktrees: app.gitWorktrees.length,
  };
  const query = app.gitFilter.value.trim();
  const empty = query ? { title: `No matches for "${query}"`, hint: '' } : EMPTY_HINTS[app.gitTab];

  const branchLabel = app.gitBranch || '(no branch)';
  const ahead = app.gitAhead ? ` ↑${app.gitAhead}` : '';
  const behind = app.gitBehind ? ` ↓${app.gitBehind}` : '';
  const dirty = app.gitChanges.length ? ` · ${app.gitChanges.length} dirty` : ' · clean';
  const stamp = oneLine(`${branchLabel}${ahead}${behind}${dirty}`, 60);

  return renderCatalog(app, region, {
    tabs: TABS.map((tab) => ({ ...tab, count: counts[tab.id] })),
    activeTab: app.gitTab,
    filter: app.gitFilter, filterFocus: 'git-filter', listFocus: 'git',
    placeholder: 'Filter changes, commits, branches…',
    list: app.gitList,
    row: (item, selected, width) => row(app, item, selected, width),
    stamp,
    note: app.gitBusy ? 'SYNCING' : '',
    empty,
    detail: detail(app, Math.max(30, Math.floor(region.width * 0.4) - 4)),
    detailTitle: app.gitList.current?.name ? truncate(app.gitList.current.name, 30) : 'DOSSIER',
    onTab: (target, id) => { target.gitTab = id; target.gitList.first(); },
    onSelect: (target, item) => { void target.loadGitDetail(item); },
    onActivate: (target, item) => activate(target, item),
  });
}

// Enter, and a click on the already-selected row, do the same thing.
function activate(app, item) {
  if (!item) return;
  if (item.kind === 'change') void app.gitStageToggle(item);
  else if (item.kind === 'branch') void app.gitSwitchBranch(item);
  else if (item.kind === 'stash') void app.gitStashApply(item);
  else if (item.kind === 'checkpoint') app.gitConfirmRestoreCheckpoint(item);
  else if (item.kind === 'worktree') app.toast(item.raw.path, 'info');
}

function create(app) {
  if (app.gitTab === 'branches') app.openGitBranchDialog();
  else if (app.gitTab === 'stash') app.openGitStashDialog();
  else if (app.gitTab === 'checkpoints') void app.createCheckpoint();
  else if (app.gitTab === 'worktrees') app.openGitWorktreeDialog();
}

export function handle(app, event) {
  const item = app.gitList.current;
  if (app.focus === 'git') {
    switch (true) {
      case event.name === 'P': void app.gitPush(); return true;
      case event.name === 'F': void app.gitFetch(); return true;
      case event.name === 'L': void app.gitPull(); return true;
      case event.name === 'r' && !event.ctrl: void app.refreshGitView({ force: true }); return true;
      case event.name === 'n': create(app); return true;
      case event.name === 'space' && item?.kind === 'change': void app.gitStageToggle(item); return true;
      case event.name === 'a' && app.gitTab === 'changes': void app.gitStageAll(); return true;
      case event.name === 'u' && app.gitTab === 'changes': void app.gitUnstageAll(); return true;
      case event.name === 'c' && app.gitTab === 'changes': app.openGitCommitDialog(); return true;
      case event.name === 'd' && app.gitTab === 'changes' && Boolean(item): app.confirmDiscardChange(item); return true;
      case event.name === 'enter': activate(app, item); return true;
      case event.name === 'p' && app.gitTab === 'stash' && Boolean(item): void app.gitStashApply(item, { pop: true }); return true;
      case event.name === 'delete' && app.gitTab === 'stash' && Boolean(item): app.confirmDropStash(item); return true;
      case event.name === 'e' && app.gitTab === 'branches' && item && !item.raw.remote: app.openGitRenameBranch(item); return true;
      case event.name === 'delete' && app.gitTab === 'branches' && Boolean(item): app.confirmDeleteBranch(item); return true;
      case event.name === 'delete' && app.gitTab === 'worktrees' && Boolean(item): app.confirmRemoveWorktree(item); return true;
      default: break;
    }
  }
  return handleCatalog(app, event, {
    filter: app.gitFilter, filterFocus: 'git-filter', listFocus: 'git',
    list: app.gitList, tabs: TABS,
    cycleTab: (direction) => {
      const index = TABS.findIndex((tab) => tab.id === app.gitTab);
      app.gitTab = TABS[(index + direction + TABS.length) % TABS.length].id;
      app.gitList.first();
    },
    onFilter: () => app.gitList.first(),
  });
}

export const hints = (app) => {
  const base = [['tab', 'section'], ['r', 'refresh'], ['/', 'filter'], ['P', 'push'], ['L', 'pull'], ['F', 'fetch']];
  if (app.gitTab === 'changes') return [...base, ['space', 'stage/unstage'], ['a', 'stage all'], ['u', 'unstage all'], ['c', 'commit'], ['d', 'discard']];
  if (app.gitTab === 'log') return base;
  if (app.gitTab === 'branches') return [...base, ['↵', 'switch'], ['n', 'new'], ['e', 'rename'], ['del', 'delete']];
  if (app.gitTab === 'stash') return [...base, ['↵', 'apply'], ['p', 'pop'], ['n', 'stash changes'], ['del', 'drop']];
  if (app.gitTab === 'checkpoints') return [...base, ['↵', 'restore'], ['n', 'checkpoint now']];
  return [...base, ['n', 'new worktree'], ['del', 'remove']];
};

export const meta = { id: 'git', index: '08', title: 'GIT', shortcut: '8' };
