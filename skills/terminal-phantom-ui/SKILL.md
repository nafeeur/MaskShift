---
name: terminal-phantom-ui
description: Build MaskShift terminal interfaces in the Phantom Protocol design language — stencil frames with notched title tabs, a crimson-and-bone palette that degrades to 16 colours, and the ANSI width discipline that keeps a TUI aligned.
---

# MaskShift Phantom Protocol (terminal)

Maximalism in a terminal is a discipline, not a licence. Two constraints hold
the language together, and everything below serves them:

1. **Loud is not illegible.** Colour carries meaning, never decoration, and the
   whole palette has a defined fallback at 256 colours, 16 colours and none.
2. **Every row is exactly the terminal width.** A single miscounted column
   shears the entire frame. Alignment is correctness, not polish.

## Palette

- Crimson `#ff2d55` is identity and focus. Gold `#ffb648` is keys, the operator
  and anything the user typed. Bone `#ece7dd` is body text; ash and smoke are
  the two muted greys — don't invent a third.
- Capability classes keep fixed accents so the same colour always means the
  same category, everywhere: cyanide for tools, violet for skills, azure for
  MCP, gold for automations. If you add a category, give it a token; if you add
  a token, wire it to a category.
- Define colours once as hex and let the theme degrade them. `Theme.fg`/`bg`
  emit truecolor, 256-colour or 16-colour sequences from the same value.
  **Never hardcode an SGR number**: the 16-colour path has to clamp each channel
  to a single bit, and hand-written codes bypass that.
- `NO_COLOR`, `FORCE_COLOR`, `MASKSHIFT_COLOR=off|basic|full` and a
  non-TTY stdout all have to produce clean, still-aligned monochrome. Colour is
  never load-bearing on its own — pair it with a glyph or a label.

## Geometry: the stencil frame

- Every surface is a panel with a notched title tab inset into the top rail
  (`┏━┫ 03 ARSENAL ┣━━━┓`) and an optional stamp on the bottom rail — a count, a
  path, a status. One tab, one stamp; don't add a third decoration.
- Focus is shown by weight, not by colour alone: the focused panel is promoted
  from a light hairline frame to a heavy crimson one. Exactly one panel is
  focused at a time, and the hint bar always names what that panel's keys do.
- Selection inside a list is a crimson spine (`▌`) plus a raised background, so
  it survives a monochrome terminal.
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
