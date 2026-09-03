---
name: frontend-phantom-ui
description: Build MaskShift interfaces in the maximalist black/red/white Phantom design language — angular panels, poster typography, and comic-panel motion inspired by stylized JRPG menu UI.
---

# MaskShift Phantom UI

- Black stage, paper white, signature red (`#e2001b`) as the only loud hue; cyan/gold/magenta are rare splash accents reserved for status or tags, never structure. Don't leave a reserved accent unused — every token in `:root` earns its place by tagging a real category (skills = magenta, MCP/agent-bridges = cyan, automations = gold; see `.capability-card.skill/.mcp/.automation/.plugin/.bridge` in `public/index.html`) so the palette comment stays true, not aspirational.
- Cut every panel corner with `clip-path` instead of rounding it — parallelograms and diagonal-cut cards, not rectangles. Signature seams (the empty-state target-lock reticle, the topbar/brand diagonal) mark a handful of moments only, not every border — and don't leave a decorative class defined but unused in markup; delete it or wire it in.
- Display type is `Anton` (poster headlines, uppercase, heavy) over `Oswald` (condensed UI labels/buttons) over system sans (message/body prose, kept calm and readable). Never put paragraph text in the display face.
- Motion carries meaning: view switches play a diagonal wipe, status lamps pulse on `running`, hover states skew/glint, the empty-state hero pulses like a target lock. No continuous decorative noise. Respect `body.no-motion` and `prefers-reduced-motion` — both must fully disable animation.
- Entrance animations only belong on genuinely new content, never on a list that gets fully rebuilt by polling or a search keystroke: animate `.message:last-child`, not `.message`, since `renderMessages()` replaces the whole list every ~1.8s during a run — animating every child there replays the entrance on every poll and reads as flicker, not motion. A single freshly-appended node (`appendEvent`, `appendTerminal`) is always safe to animate outright.
- Dense but grouped information. Every panel needs a clear title, state, primary action, and empty/error state.
- Keep keyboard navigation, visible focus (`:focus-visible` gets `var(--focus-ring)` globally — don't override it away), contrast, responsive breakpoints, and touch targets functional.
- The `<script type="module">` must never sit behind a render-blocking `<link rel="stylesheet">` to a third-party host (e.g. Google Fonts) — a slow or unreachable font CDN hangs that stylesheet request and, per spec, blocks every deferred/module script after it from executing at all, silently killing every click handler with no console error. Load web fonts async (`rel="preload" as="style"` + `onload` swap, `<noscript>` fallback) so the app stays interactive even when the font never arrives.
- Verify at desktop, compact laptop, and narrow viewport sizes; eliminate clipping and horizontal overflow.
