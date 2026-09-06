---
name: terminal-phantom-ui
description: Build MaskShift terminal interfaces in the Phantom Protocol design language — tokens over hex values, one marker gutter per pane, one filled chip per screen, and the ANSI width discipline that keeps a TUI aligned.
---

# MaskShift Phantom Protocol (terminal)

Maximalism in a terminal is a discipline, not a licence. Two constraints hold
the language together, and everything below serves them:

1. **Loud is not illegible.** Colour carries meaning, never decoration, and the
   whole palette has a defined fallback at 256 colours, 16 colours and none.
2. **Every row is exactly the terminal width.** A single miscounted column
   shears the entire frame. Alignment is correctness, not polish.

## Tokens, not colours

- Import meaning from `tokens.mjs`; never a hex value, and never `theme.palette.*`
  in a view. A view says `theme.roles.danger`, not "the red one". When one token
  moves, the whole interface moves with it.
- **Crimson is identity and focus only** — the wordmark, the active view tab,
  the pane holding the keyboard. It is never a data value and never a severity.
  Failure has its own red (`roles.danger`) precisely so a red pane cannot read
  as a focused one.
- **Gold is the operator** — their turn, their keys, their pending input.
- Capability classes keep fixed accents so the same colour always means the same
  category, everywhere: cyanide for tools, violet for skills, azure for MCP. If
  you add a category, give it a token; if you add a token, wire it to a category.
- Everything else is the neutral ramp. Hierarchy is carried by weight and case,
  not by inventing a hue. If you reach for a new colour, you probably want
  `heading` / `text` / `label` / `dim` / `muted` instead.
- Define colours once as hex and let the theme degrade them. `Theme.fg`/`bg`
  emit truecolor, 256-colour or 16-colour sequences from the same value.
  **Never hardcode an SGR number**: the 16-colour path has to clamp each channel
  to a single bit, and hand-written codes bypass that.
- `NO_COLOR`, `FORCE_COLOR`, `MASKSHIFT_COLOR=off|basic|full` and a non-TTY
  stdout all have to produce clean, still-aligned monochrome. Colour is never
  load-bearing on its own — pair it with a glyph or a label. Two states that
  differ only in hue are two states nobody can tell apart.

## The grid

- **Every content row is `SPACE.gutter` columns of marker, then text.** Build
  rows with `gutter()` / `row()` from `type.mjs`, even when there is no marker
  to put there. This is the whole reason a speaker rail, a status tick, a
  bullet, a tree glyph and a plain paragraph share one left edge; hand-rolling
  an indent is how a pane ends up with four of them.
- Lay tabular rows out with `columns()`, not with bare `fit` calls and magic
  numbers. Two lists that each invent their own column widths will never line
  up with each other.
- Selection inside a list is a spine (`▌`) in the gutter plus a raised
  background, so it survives a monochrome terminal.

## One label, one chip

- **A name appears once per screen.** The tab strip names the view; a panel's
  top rail then carries what the tab cannot — the session title, the shell's
  directory, a section switcher. Printing the view's name on the panel under
  its own tab is the single most repetitive thing a layout can do.
- **Exactly one filled chip per screen**: the active view tab. Everything else
  is text on the surface it belongs to. A modal's primary action is the only
  exception, and only because there is no tab strip on screen to confuse it
  with. Section switchers inside a pane are marked by weight and an underline.
- Focus is the frame, and the frame alone: a light hairline when idle, a heavy
  frame in a *dark* red when focused. Mixing a border with full crimson traces a
  bright rectangle around whatever the operator is already looking at.
- **Chrome is upper case; content keeps the case its author wrote.** Never
  upper-case a model's headings or a user's prose.

## Status and motion

- Every subsystem state — runs, plan steps, servers, processes, tool results —
  resolves through `statusOf()` in `status.mjs`. Seven kinds, each fixing a tone
  and a glyph. Do not write another `STATUS_TONES` map in a view; add to the
  vocabulary instead.
- Animation is a function of the wall clock in `motion.mjs`, never of a frame
  counter, so the interface looks the same at 8fps over SSH and freezes whole
  for a headless capture. Two spinners driven by their own counters drift apart
  on screen.
- Nothing animates for decoration. Each animation answers a question: is this
  alive (a breathing lamp), is it working or stuck (a sweep along the focused
  rail), did I miss that (a toast fading), which step is in flight (an inline
  spinner).
- `MASKSHIFT_ASCII=1` and a non-UTF-8 locale swap every box-drawing glyph for
  ASCII. Any new glyph needs an entry in both `MARKS.unicode` and `MARKS.ascii`.

## Width discipline

This is where TUIs actually break.

- Measure with `visibleWidth`, never `String.length`. Escape sequences are
  zero-width, CJK and emoji are two columns, and combining marks are zero.
- Pad and clip with `fit`/`truncate`/`padEnd` — all ANSI-aware. Slicing a styled
  string by index cuts an escape sequence in half and bleeds colour into the
  rest of the frame.
- A panel's body rows must be exactly `width - 2 - 2*padding` columns and
  exactly `height - 2` rows. Off-by-one here is the difference between a frame
  and a smear. Assert it in tests rather than eyeballing it.
- Reserve the space a component needs *before* spending it on optional chrome.
  A header that adds telemetry chips left to right will starve the workspace
  name; compute the reserve first, then add chips while they fit.
- Below a threshold, drop whole components rather than shrinking everything: the
  rail hides under 108 columns, and the detail pane under 92. A view that is
  merely cramped at 80×24 is a bug.

## Rendering

- Build a frame as an array of styled lines and diff it against the previous
  frame; rewrite only the rows that changed. Full repaints flicker over SSH and
  fight the terminal's own scrollback.
- Take the alternate screen on start and always give it back — including on a
  crash. Restore the cursor and reset SGR in the same teardown.
- Throttle repaints (one per tick, coalesced through `setImmediate`) instead of
  painting on every event. A run emits hundreds of events a second.
- Keep spinners and elapsed timers on one shared interval so the whole frame
  advances together.

## Input

- Decode raw mode yourself: control keys, CSI sequences, modifier parameters
  (`ESC[1;5A` is ctrl+up), and bracketed paste — a pasted prompt must arrive as
  one event, not a thousand keystrokes.
- A lone `ESC` is ambiguous until the next byte arrives. Buffer it and resolve
  it on a short timer, or every arrow key registers as an escape.
- Overlays own the keyboard completely while open. Global shortcuts must not
  fire underneath a dialog, and every overlay dismisses on `esc`.
- Every action needs a discoverable route: a key, a slash command, and an entry
  in the command palette. Nothing may be reachable only by a key you memorised.

## Layout and correctness

- Dense but grouped. Every panel needs a title, a state, a primary action, and
  an empty state that says what to do next.
- The hint bar is contextual: it shows the keys for the focused component, not a
  fixed list. If a key is not in the hint bar or the palette, it does not exist.
- Long output scrolls inside its own viewport with a visible scrollbar column;
  the frame itself never scrolls.
- A shell-like transcript anchors to the bottom, so new output appears next to
  the prompt. A catalogue anchors to the top.
- Verify by rendering real frames at several sizes and asserting every row's
  width and the frame's height — the terminal equivalent of checking for
  horizontal overflow. Reading the layout code is not verification; every
  alignment bug is invisible in source and obvious in a rendered frame.
- Assert the design rules, not just the geometry. `tests/tui.test.mjs` checks
  that every transcript row clears the gutter before its text starts, and that
  a view's name appears on exactly one row of its own screen — both are bugs
  that survive any width assertion and that no one notices while writing the
  code that causes them.
- Look at the output. `npm run capture` renders real frames to SVG through the
  same renderer; a palette that reads fine as a list of hex values can still put
  the loudest thing on screen around the thing the operator is already looking
  at.
