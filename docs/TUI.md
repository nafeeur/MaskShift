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
| **crimson** `#e5384f` | Identity and focus: the wordmark, the active view tab, the pane holding the keyboard | A data value, or a severity |
| **gold** `#f0b429` | The operator: their turn, their keys, their pending input | A status |
| **danger** `#ff5f56` | Failure and destruction, and nothing else | Confused with crimson |
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
 MASKSHIFT · TARGET repo · branch · PERSONA model   MODE OVERDRIVE · TOOLS 148 · SKILLS 44 · ● LINK
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

The right rail carries four sections, spelled out across a single header row so
its first line of content sits on the same screen row as the first line of the
pane it is reporting on: **plan** (live multi-stage plan with progress),
**loadout** (which tools, skills and MCP servers the current run has actually
summoned, plus token flow), **events** (the raw runtime bus) and **git**.

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
| `ctrl+r` | Cycle rail: plan → loadout → events → git |
| `ctrl+y` | Focus the rail |
| `1`…`6`, `alt+1`…`alt+6` | Jump to a view |
| `f1` or `?` | Key reference |
| `f2` | Settings, including the mouse mode |
| `f5` | Refresh everything |
| `ctrl+c` | Cancel a running heist; press again to quit |
| `ctrl+q` | Quit immediately |

### 01 HEIST

| Key | Action |
|---|---|
| `enter` | Execute the prompt |
| `ctrl+j` | Newline inside the composer |
| `tab` | Move between transcript and composer |
| `t` | Expand or collapse tool output |
| `esc` | Retreat from the running heist |
| `f1`–`f3` | Fill the composer from a starter prompt (empty transcript only) |

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

## Slash commands

Typed into the composer:

`/new` `/clear` `/model [REF]` `/sessions` `/workspace` `/tools [QUERY]`
`/skills [QUERY]` `/mcp [QUERY]` `/mods` `/files` `/terminal` `/doctor` `/logs`
`/settings` `/help` `/quit`

## Terminal requirements

A TTY, 80×24 or larger, and UTF-8 for the full glyph set. MaskShift detects
colour depth from `COLORTERM`, `TERM` and `TERM_PROGRAM`; override it with
`MASKSHIFT_COLOR=off|basic|full`. Bracketed paste is enabled, so pasting a long
prompt arrives as one event rather than a thousand keystrokes.

Mouse support uses SGR reporting (`?1006`), which every terminal released this
decade speaks and which — unlike the legacy encoding — can address a cell past
column 223. The legacy X10 encoding is still decoded as a fallback. Tracking is
switched off whenever the alternate screen is left, so quitting or crashing
cannot strand the terminal in reporting mode.

Without a TTY, `maskshift` refuses to start the interface and points at
`maskshift run` — see [CLI.md](CLI.md).
