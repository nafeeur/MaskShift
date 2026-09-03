---
name: frontend-phantom-ui
description: Build MaskShift interfaces in the maximalist black/red/white Phantom design language — torn graphic plates, halftone screens, poster typography on a hard skew, and a per-destination transition vocabulary inspired by stylized JRPG menu UI.
---

# MaskShift Phantom UI

Maximalism here is a discipline, not a licence. Two constraints hold the whole
language together, and everything below serves them:

1. **Loud is not illegible.** Every foreground token clears 4.5:1 on the
   surface it sits on, and nothing renders below 10px.
2. **Motion is rationed.** Entrances, state changes and pointer feedback carry
   the energy. Only the idle hero and live-status indicators loop.

## Palette

- Black stage, paper white, signature red (`#e2001b`) as the only loud hue.
  `cyan`/`gold`/`magenta` are rare splash accents reserved for status and
  category tags, never structure — and never left unused: every token in
  `:root` earns its place by tagging a real category (skills = magenta,
  MCP/agent-bridges = cyan, automations = gold; see
  `.capability-card.skill/.mcp/.automation/.plugin/.bridge`).
- Red comes in three grades and they are not interchangeable. `--red` is
  **graphic only** — large surfaces and display type, never small text.
  `--red-deep` (#b40016) backs any red surface that has to carry small text,
  because white on `--red` is only 4.35:1. `--red-glow` (#ff4a5e) is red *as
  text* on a dark surface. Reaching for `--red` where one of the other two
  belongs is the most common way this palette fails an audit.
- `--muted` and `--dim` are the two body-text greys (8.2:1 and 5.6:1 on
  `--black-2`). Don't invent a third and don't darken these.

## Geometry

- Cut every panel corner with `clip-path`, never `border-radius`. The tokens
  are `--plate` (panels), `--plate-sm` (cards, messages, toasts), `--shard`
  (buttons, gauges, plan steps) and `--blade-l`/`--blade-r` (chips, tags) —
  use them instead of writing a fresh polygon, so the whole surface shares one
  cut angle.
- Panels carry one 68px red rule at their top-left edge. That is the bound-edge
  accent; don't add a second decoration to the same panel. A red triangle
  placed in a clipped-away corner is invisible — check what the clip removes
  before positioning an accent near it.
- Signature seams (the hero target-lock reticle, the topbar/brand diagonal, the
  scrolling hazard stripe under the topbar) mark a handful of moments only.
  Don't leave a decorative class defined but unused in markup — delete it or
  wire it in.

## Type

- `Anton` (poster headlines, uppercase) over `Oswald` (condensed UI labels and
  buttons) over system sans (message and body prose, kept calm and readable).
  Never put paragraph text in the display face.
- Sizes come from `--fs-micro` (10px) through `--fs-body` (13px) plus the two
  mono steps. 10px is a floor, not a suggestion: condensed uppercase Oswald
  below it is decoration, not text.
- Tracking loosens as size shrinks but never past `--track-wide` (.12em). Wide
  tracking on tiny caps costs more legibility than it buys, and it is what
  pushed the brand lockup, the composer chips and the mobile nav past their
  boxes the last time this was tuned.
- Panel headings (`.rail-heading h2` and friends) get a skew plus a hard red
  offset shadow. Keep them `display: block; width: fit-content` — making them
  `inline-block` so the skew "fits the text" pulls them onto the same line as
  their `<small>` eyebrow.

## Motion

- Entrances arrive on a skew and settle square: `plate-in`, `slide-in-l/r`,
  `rise-in`, `stamp-in`. Lists and menus cascade with per-`nth-child` delays.
- **Never animate the entrance of a list that gets rebuilt by polling.**
  `renderMessages()`, `renderPlan()` and `renderCapabilitiesSnapshot()` all
  replace their whole list every ~1.8s during a run, so `.message` animates on
  `:last-child` only, and `.plan-step`/`.telemetry-item` get no entrance at all
  — they animate state instead. A single freshly-appended node (`appendEvent`,
  `appendTerminal`) is always safe to animate outright.
- View switches use a **different cut per destination**, mapped in
  `VIEW_TRANSITIONS`: shatter (cockpit), slats (files), splat (arsenal), burst
  (network), tear (mod shop). The transition tells you where you landed;
  adding a view means adding its cut.
- `body.no-motion` and `prefers-reduced-motion` must both disable every
  animation **and** hide `.transition-wipe` outright — a full-screen cut is the
  loudest thing in the app and a blanket `animation: none` would leave it
  frozen on screen mid-wipe.

## Layout and correctness

- Dense but grouped. Every panel needs a clear title, state, primary action,
  and empty/error state.
- **A grid item must not be a scroll container.** `overflow: hidden` on a card
  inside `.card-grid` makes it one, and a scroll container's automatic minimum
  size is 0 — the row collapses to the header and silently clips away every
  description and action button. `clip-path` already confines a card's
  background wash, so cards clip by shape, not by `overflow`.
- Keep keyboard navigation, visible focus (`:focus-visible` gets
  `var(--focus-ring)` globally — don't override it away), contrast, responsive
  breakpoints and touch targets functional. A wipe-in `::before` overlay will
  paint over a button's bare text node, which `> *` cannot lift; send the
  overlay to `z-index: -1` inside the button's own stacking context instead.
- The `<script type="module">` must never sit behind a render-blocking
  `<link rel="stylesheet">` to a third-party host (e.g. Google Fonts) — a slow
  or unreachable font CDN hangs that stylesheet request and, per spec, blocks
  every deferred/module script after it from executing at all, silently killing
  every click handler with no console error. Load web fonts async
  (`rel="preload" as="style"` + `onload` swap, `<noscript>` fallback).
- Verify at desktop, compact laptop and narrow viewport sizes; eliminate
  clipping and horizontal overflow. Drive the real app in a browser rather than
  eyeballing the CSS — every layout bug listed above was invisible in source
  and obvious in a screenshot.
