# MaskShift Interface

`maskshift` opens a full-screen terminal interface built on a bespoke,
zero-dependency renderer: a diffing frame buffer, an ANSI-aware layout engine,
a raw-mode key decoder, and an SGR mouse decoder with per-frame hit testing.
Nothing is fetched, nothing is served, and there is no browser anywhere in the
stack.

## The Phantom Protocol design system

`src/tui/tokens.mjs` holds every colour, every measurement and every rule about
when to use them. Views import meaning — "this is destructive", "this is a
secondary label" — never a hex value, so the whole interface moves together when
one token does. `theme.mjs` is only the renderer that puts those tokens on the
wire.

### Rules of use

| Token | Means | Never |
|---|---|---|
| **crimson** `#E32C40` | Identity and focus: the wordmark, the active view tab, the pane holding the keyboard | A data value, or a severity |
| **gold** `#E9A227` | The operator: their turn, their keys, their pending input | A status |
| **danger** `#FF6B4A` | Failure and destruction, and nothing else | Confused with crimson |
| **tool / skill / mcp** | Capability classes, constant across every view | Reused for state |
| **neutrals** | Everything else | — |

Two consequences are worth stating outright, because breaking either is what
made earlier revisions read as noise:

- **Exactly one filled chip per screen** — the active view tab. Panels label
  their top rail with plain text and show focus through the frame alone. When
  panels drew chips too, the top-left corner stacked the wordmark, the active
  tab and the panel title in three consecutive rows and none of them read as
  "you are here". A modal's primary action is the single exception.
- **Chrome is upper case; content keeps the case its author wrote.** Model
  headings are no longer shouted back at the operator from inside a quiet panel.

### The grid

Every content row in every pane is `SPACE.gutter` columns of marker followed by
text. A speaker rail, a status tick, a bullet, a tree glyph and a plain
paragraph therefore all put their first character on the same column — which is
the invariant `tests/tui.test.mjs` now asserts directly. The transcript used to
have four different left edges inside one pane.

### Motion

`src/tui/motion.mjs` drives every moving part off one wall clock, so the
interface looks the same at 8fps over SSH as it does locally, and a headless
render freezes all of it at once for reproducible captures. Nothing animates for
decoration; each animation answers a question:

| Motion | Answers |
|---|---|
| A breathing lamp | Is this still alive? |
| A highlight sweeping the focused pane's top rail | Is it working, or stuck? |
| Toasts fading in and out | Did I miss that? |
| An inline spinner beside a named call | Which step is in flight? |

### Status

`src/tui/status.mjs` collapses every subsystem's state string — runs, plan
steps, MCP servers, automations, bridges, processes, tool results — onto seven
kinds, each fixing a tone and a glyph. A failed run, a failed plan step and a
failed tool are now the same red and the same mark.

### Graceful degradation

Truecolor, 256-colour and 16-colour palettes are generated from the same hex
values. `NO_COLOR`, `MASKSHIFT_COLOR=off` and dumb terminals get clean
monochrome; `MASKSHIFT_ASCII=1` swaps every box-drawing glyph for ASCII.

## Layout

```
 MASKSHIFT · TARGET repo · branch · PERSONA model   MODE OVERDRIVE · TOOLS 149 · SKILLS 44 · ● LINK
  01 HEIST │ 02 FILES │ 03 ARSENAL │ 04 NETWORK │ 05 MOD SHOP │ 06 TERMINAL             RAIL PLAN
┏━ SESSION TITLE ───────────────────────────────────── 42 MESSAGES ━┓ PLAN · LOADOUT · EVENTS · GIT
┃ ▌ OPERATOR                                                  14:22 ┃   Diff frames instead of
┃ ▌ Refactor the frame renderer so repaints only rewrite changed …  ┃   repainting the screen.
┃                                                                   ┃
┃ ▌ MASKSHIFT · ollama:qwen3-coder                            14:22 ┃   ━━━━━━━━━━──────────  2/4
┃ │ The screen currently repaints every row…                        ┃
┃                                                                   ┃ ✓ Read the screen module
┃ ✓ fs_read           src/tui/screen.mjs — 94 lines                 ┃ ⠙ Add a regression test
┣━ COMPOSER ───────────────────────── ↵ execute · ^J newline ━━━━━━━┫ ○ Run the suite
┃ ❯ Describe what success looks like…                               ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 ○ IDLE  │  session title                TURN 07 · TIME 01:32 · TOKENS 12.4k/3.1k · COST $0.02
 ↵ execute · ^J newline · tab transcript · ^K palette · esc menu                          v1.0.0
```

The view's name appears once, in the tab strip. A panel's top rail carries what
the tab cannot — the session's title, the shell's directory, a catalogue's
section switcher — and the frame beneath it carries focus. Panes that sit next
to each other share a single rule rather than each drawing their own: the heist
view is one frame split by an internal seam, and the rail and detail panes have
no frame at all.

The rail hides itself below 108 columns and the header sheds telemetry from the
left of its right-hand group as the terminal narrows, so the interface stays
usable at 80×24.

## Views

| View | What it holds |
|---|---|
| **01 HEIST** | The transcript and composer. Markdown, syntax-tinted code fences, coloured diffs, collapsed tool calls, and a live indicator for in-flight tools. |
| **02 FILES** | Workspace tree with fold state and a syntax-highlighted preview. `a` attaches the selected file to the composer. |
| **03 ARSENAL** | Every native tool and skill, fuzzy-searchable, with a dossier pane showing the parameter schema or the skill body. `x` runs a tool directly. |
| **04 NETWORK** | MCP servers: connect, disconnect, add by hand, search the official registry and install from it. |
| **05 MOD SHOP** | Automations, plugins, agent bridges, browsers and processes — each with create, arm/pause, reload and delete. |
| **06 TERMINAL** | The host shell, running with your full account permissions. |
| **07 BROWSER** | A live, clickable, typeable view of a running browser tab — the same CDP connection the browser tools drive. |
| **08 GIT** | Working tree changes, commit log, branches, stash, MaskShift checkpoints and worktrees, each with their own actions — plus push/pull/fetch from any tab. |

![01 HEIST](screenshots/heist.svg)

![02 FILES](screenshots/files.svg)

![03 ARSENAL](screenshots/arsenal.svg)

![04 NETWORK](screenshots/network.svg)

![05 MOD SHOP](screenshots/modshop.svg)

![08 GIT](screenshots/git.svg)

`ctrl+k` opens a fuzzy command palette over every action MaskShift can perform, so nothing is
buried behind a key you have to memorise:

![Command palette](screenshots/palette.svg)

In `balanced` and `review` modes, a gated tool call shows what it will do before
it runs (see [Approving tool calls](#approving-tool-calls)):

![Approving a tool call](screenshots/approval.svg)

`ctrl+d` reviews everything the last run changed, diffed against the checkpoint
taken before it, and `u` undoes it:

![Run changes](screenshots/changes.svg)

`ctrl+p` switches heists, previewing each one's goal, open issues and last
request from its saved summary:

![Heist archive](screenshots/sessions.svg)

`f2` tunes the core engine — default model, permission mode, agent turn and subagent limits,
indexing and checkpoint behaviour — without editing `config.json` by hand:

![Settings](screenshots/settings.svg)

The right rail carries three sections, spelled out across a single header row so
its first line of content sits on the same screen row as the first line of the
pane it is reporting on: **plan** (live multi-stage plan with progress),
**loadout** (which tools, skills and MCP servers the current run has actually
summoned, plus token flow) and **events** (the raw runtime bus). Source control
has its own dedicated view — see **08 GIT** below — rather than a rail summary.

![Live loadout telemetry](screenshots/loadout.svg)

Every screenshot on this page is rendered by `npm run capture` through the same code path the
terminal uses, so none of them can drift from the product.

## The mouse

Everything the interface draws as a control is a control. There is no widget
tree behind the frame buffer, so each surface declares the cells it occupies as
it paints and the click is resolved against the frame you were looking at.

| Gesture | What it does |
|---|---|
| Click a view tab | Switch views |
| Click a rail section | Switch rail sections, and focus the rail |
| Click `TARGET` or `PERSONA` | Open the workspace or model picker |
| Click `MODE` | Cycle overdrive → balanced → review |
| Click the session title | Switch heist |
| Click a key in the bottom hint rail | Run it |
| Click the transcript or composer | Focus that pane |
| Click a starter prompt | Load it into the composer |
| Click a list row | Select it; click the selected row (or double click) to open it |
| Click a directory | Fold or unfold it |
| Click a catalogue tab or filter | Switch section, focus the filter |
| Wheel | Scroll whatever is under the pointer, focused or not |
| Click or drag the scrollbar | Jump to that position |
| Click an overlay row, button or field | Choose, submit, toggle, cancel |
| Click outside an overlay | Dismiss it |

Mouse reporting takes text selection away from the terminal. Most terminals
still select on **shift+drag** while it is on; if yours does not, turn the
mouse off:

```bash
MASKSHIFT_MOUSE=off maskshift        # off | click | hover
```

`f2` (settings) and the `mouse.cycle` palette action change it without a
restart, and the choice is stored under `ui.mouse`. `hover` adds highlight on
pointer-over by asking the terminal to report every motion, which is a report
per cell crossed — worth it locally, wasteful over a slow link, and so not the
default.

## Keys

### Global

| Key | Action |
|---|---|
| `ctrl+k` | Command palette — fuzzy search over every action |
| `ctrl+p` | Switch heist |
| `ctrl+n` | New heist |
| `ctrl+g` | Change persona (model) |
| `ctrl+o` | Open a different workspace |
| `ctrl+b` | Show or hide the rail |
| `ctrl+r` | Cycle rail: plan → loadout → events |
| `ctrl+y` | Focus the rail |
| `1`…`8`, `alt+1`…`alt+8` | Jump to a view |
| `f1` or `?` | Key reference |
| `f2` | Settings, including the mouse mode |
| `f5` | Refresh everything |
| `ctrl+d` | Review what the last run changed (file list and diffs) |
| `ctrl+z` | Undo the last run's file changes (asks first, listing every file) |
| `ctrl+c` | Cancel a running heist; press again to quit |
| `ctrl+q` | Quit immediately |

### 01 HEIST

| Key | Action |
|---|---|
| `enter` | Execute the prompt (queue it, while a heist is running) |
| `ctrl+t` | While a heist is running: send the composer's text to it now, delivered at its next step |
| `ctrl+j` / `alt+enter` | Newline inside the composer |
| `tab` | Move between transcript and composer |
| `t` | Expand or collapse tool output |
| `s` | Read the session summary (transcript focus, once older turns have been summarized) |
| `esc` | Retreat from the running heist |
| `f1`–`f3` | Fill the composer from a starter prompt (empty transcript only) |

Prompts submitted while a heist is running enter a visible FIFO queue and run
one at a time in the same session. `ctrl+t` steers instead: the message joins the
run in progress at its next step (after any tool call already in flight), and is
marked *steered mid-run* in the transcript.

When older turns are summarized to fit the model's window, a rule in the
transcript marks exactly where the summary ends. After a run changes files, a
line under the transcript names them, with `^D` to review the diffs and `^Z` to
undo the run. Undo restores modified and deleted files from the checkpoint taken
before the run and removes files the run created; files that were already
there, untracked, before the run are left alone.

### Context meter

The status rail's `CTX` meter shows how much of the model's context window the
last request used, turning amber at 60% and red at 85% — the range in which
older turns start being summarized. The rail's LOADOUT section repeats it with
the model's tier, where the window size came from (config, the provider, the
model family, a learned overflow, or an assumed default) and the reply cap. See
[Model adaptation](CONFIGURATION.md#model-adaptation).

### Approving tool calls

In `balanced` and `review` permission modes a gated call opens an approval
dialog showing what it will actually do: the command and its directory, a file's
new contents, or an edit as a coloured diff. Answer `y`, `n`, or `a` to approve
the tool for the rest of the heist. Enter defaults to NO for anything that can
reach outside the workspace (host or remote execution, installs, secrets,
destructive calls) and to YES for plain edits. Switching heists or workspaces while a run,
queue or draft exists requires an explicit confirmation so work cannot silently
cross session or workspace boundaries.

### Catalogue views

| Key | Action |
|---|---|
| `/` | Filter |
| `tab` / `shift+tab` | Cycle the section (tools/skills, installed/registry, mod-shop sections) |
| `→` | Focus the dossier pane |
| `enter` | The primary action: open, connect, load, run now, toggle |
| `n` | New automation, plugin or browser (mod shop) |
| `space` | Arm or pause an automation |
| `delete` | Remove the selected entry |
| `r` | Refresh |

### 08 GIT

Built on the same catalogue chrome as ARSENAL/NETWORK/MOD SHOP above — `/`,
`tab`/`shift+tab`, `→` and `r` all work the same way — plus its own actions,
some of which only apply on the tab named:

| Key | Action |
|---|---|
| `P` / `L` / `F` | Push / pull / fetch — from any tab |
| `space` / `enter` | Stage or unstage a change (CHANGES) · switch branch (BRANCHES) · apply a stash (STASH) · restore a checkpoint (CHECKPOINTS) |
| `a` / `u` | Stage all / unstage all (CHANGES) |
| `c` | Commit, with amend and `--no-verify` toggles (CHANGES) |
| `d` | Discard a change (CHANGES) |
| `n` | New branch / stash / checkpoint / worktree, depending on the active tab |
| `e` | Rename a branch (BRANCHES) |
| `p` | Pop a stash (STASH) |
| `delete` | Delete a branch · drop a stash · remove a worktree |

Diffs and `git show` output load asynchronously into the dossier pane the
moment a row is selected. Every mutating action shells out to the system
`git` binary directly, the same way the header's branch readout always has —
it does not go through the agent-facing tool registry.

## Slash commands

Typed into the composer:

`/new` `/clear` `/model [REF]` `/sessions` `/search TEXT` `/workspace`
`/tools [QUERY]` `/skills [QUERY]` `/mcp [QUERY]` `/mods` `/themes` `/files`
`/terminal` `/browser` `/git` `/doctor` `/logs` `/settings` `/help` `/quit`

| Command | What it does |
|---|---|
| `/context [PROMPT]` | What went into the last request and why — model window and tier, which files were retrieved and their relevance, memories used or left out as stale. With a prompt, shows what that prompt would send. |
| `/compact` | Summarize older turns now, keeping the last two verbatim; later requests send the summary in their place |
| `/summary` | Read the session summary |
| `/cost` | Spend per run in this heist, with a total and a note on any unpriced model |
| `/changes` | Review what the last run changed (same as `ctrl+d`) |
| `/undo` | Undo the last run's file changes (same as `ctrl+z`) |
| `/steer TEXT` | Send text to the running heist now (same as `ctrl+t`) |

### Custom commands

Any Markdown file in `.maskshift/commands/` or `.claude/commands/` (in the
workspace), `~/.maskshift/commands/` or `~/.claude/commands/` becomes a slash
command named after the file. Its body is the prompt; `$ARGUMENTS` is replaced
with whatever follows the command, or the arguments are appended when the body
has no placeholder. An optional `description:` in YAML front matter is shown as
the hint. Project commands shadow personal ones; built-in commands cannot be
replaced. Custom commands are tagged `custom` in the suggestion list.

```markdown
---
description: Review a pull request
---
Review pull request $ARGUMENTS: correctness first, then tests, then style.
```

## Terminal requirements

A TTY, 80×24 or larger, and UTF-8 for the full glyph set. MaskShift detects
colour depth from `COLORTERM`, `TERM` and `TERM_PROGRAM`; override it with
`MASKSHIFT_COLOR=off|basic|full`. [`NO_COLOR`](https://no-color.org) turns colour
off and wins over a colour depth saved in the settings; without colour, the
active tab and the selected button are drawn in brackets (`[01 HEIST]`,
`[YES]`) so they stay visible. `MASKSHIFT_ASCII=1` swaps every glyph for ASCII. Bracketed paste is enabled, so pasting a long
prompt arrives as one event rather than a thousand keystrokes.

Mouse support uses SGR reporting (`?1006`), which every terminal released this
decade speaks and which — unlike the legacy encoding — can address a cell past
column 223. The legacy X10 encoding is still decoded as a fallback. Tracking is
switched off whenever the alternate screen is left, so quitting or crashing
cannot strand the terminal in reporting mode.

### Plain mode

`maskshift --plain` (or `MASKSHIFT_PLAIN=1`) runs the same agent without the
full-screen interface: each event is printed once, as an ordinary line, and the
next request is read from a normal prompt. Nothing is redrawn and no escape
codes are sent when colour is off, which suits screen readers, logging through
`script`/`tee`, and slow links. Plain mode uses ASCII marks and words (`call`,
`ok`, `error`) instead of symbols. Typing while a run is working steers it;
`/new` starts a fresh session and `/quit` leaves. In `balanced`/`review` modes,
approvals are asked inline with the same preview the interface shows, answered
with `y`, `n` or `a`.

Without a TTY, `maskshift` refuses to start the interface and points at
`maskshift --plain` and `maskshift run` — see [CLI.md](CLI.md).
