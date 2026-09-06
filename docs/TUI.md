# MaskShift Interface

`maskshift` opens a full-screen terminal interface built on a bespoke,
zero-dependency renderer: a diffing frame buffer, an ANSI-aware layout engine,
a raw-mode key decoder, and an SGR mouse decoder with per-frame hit testing.
Nothing is fetched, nothing is served, and there is no browser anywhere in the
stack.

## The Phantom Protocol theme

The interface has one visual language, used identically by the CLI:

- **Stencil frames.** Every surface is a panel with an inset title on the top
  rail and a stamp (a count, a path, a status) on the rule that bounds it. The
  focused panel is promoted from a hairline to a heavy crimson rule, so the eye
  always knows which panel owns the keyboard.
- **One rule per boundary.** Panes that sit next to each other share a single
  rule rather than each drawing their own. The heist view is one frame split by
  an internal seam; the rail and the detail panes have no frame at all, because
  the surface beside them already draws the divider. A rule is either a
  boundary or a label — never two boundaries stacked.
- **Crimson and bone.** Crimson `#ff2d55` for identity and focus, gold `#ffb648`
  for keys and the operator, bone `#ece7dd` for text, and a fixed accent per
  capability class: cyanide for tools, violet for skills, azure for MCP.
- **Graceful degradation.** Truecolor, 256-colour and 16-colour palettes are
  generated from the same hex values. `NO_COLOR`, `MASKSHIFT_COLOR=off` and dumb
  terminals get clean monochrome; `MASKSHIFT_ASCII=1` swaps every box-drawing
  glyph for ASCII.

## Layout

```
 MASKSHIFT   TARGET repo · branch   PERSONA model      OVERDRIVE  T 148  S 044  MCP 08  ● LINK
  01 HEIST │ 02 FILES │ 03 ARSENAL │ 04 NETWORK │ 05 MOD SHOP │ 06 TERMINAL           PLAN
┏━ 01 HEIST ─────────────────────────────────────────── 42 msg ━┓  PLAN  LOADOUT  EVENTS  GIT
┃ transcript                                                  ▌ ┃ ─────────────────────────
┣━ COMPOSER ───────────────────────── ↵ execute · ^J newline ━━┫ plan / loadout / events /
┃ ❯                                                             ┃ git
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 ● IDLE │ session title                     TURN 07 · TIME 01:32 · TOK 12.4k/3.1k · COST $0.02
 ↵ execute  ·  ^J newline  ·  tab transcript  ·  ^K palette  ·  esc menu          v1.0.0
```

The rail hides itself below 108 columns and the header sheds telemetry chips as
the terminal narrows, so the interface stays usable at 80×24.

## Views

| View | What it holds |
|---|---|
| **01 HEIST** | The transcript and composer. Markdown, syntax-tinted code fences, coloured diffs, collapsed tool calls, and a live indicator for in-flight tools. |
| **02 FILES** | Workspace tree with fold state and a syntax-highlighted preview. `a` attaches the selected file to the composer. |
| **03 ARSENAL** | Every native tool and skill, fuzzy-searchable, with a dossier pane showing the parameter schema or the skill body. `x` runs a tool directly. |
| **04 NETWORK** | MCP servers: connect, disconnect, add by hand, search the official registry and install from it. |
| **05 MOD SHOP** | Automations, plugins, agent bridges, browsers and processes — each with create, arm/pause, reload and delete. |
| **06 TERMINAL** | The host shell, running with your full account permissions. |

The right rail carries four sections, spelled out as tabs across its top:
**plan** (live multi-stage plan with progress), **loadout** (which tools, skills
and MCP servers the current run has actually summoned, plus token flow),
**events** (the raw runtime bus) and **git**.

## The mouse

Everything the interface draws as a control is a control. There is no widget
tree behind the frame buffer, so each surface declares the cells it occupies as
it paints and the click is resolved against the frame you were looking at.

| Gesture | What it does |
|---|---|
| Click a view tab | Switch views |
| Click a rail tab | Switch rail sections, and focus the rail |
| Click `TARGET` or `PERSONA` | Open the workspace or model picker |
| Click the mode chip | Cycle overdrive → balanced → review |
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
