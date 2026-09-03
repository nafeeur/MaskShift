---
name: frontend-phantom-ui
description: Build MaskShift interfaces in the maximalist black/red/white Phantom design language — angular panels, poster typography, and comic-panel motion inspired by stylized JRPG menu UI.
---

# MaskShift Phantom UI

- Black stage, paper white, signature red (`#e2001b`) as the only loud hue; cyan/gold/magenta are rare splash accents reserved for status or tags, never structure.
- Cut every panel corner with `clip-path` instead of rounding it — parallelograms and diagonal-cut cards, not rectangles. Torn/zigzag seams (`.jagged-line`) mark a handful of signature edges only, not every border.
- Display type is `Anton` (poster headlines, uppercase, heavy) over `Oswald` (condensed UI labels/buttons) over system sans (message/body prose, kept calm and readable). Never put paragraph text in the display face.
- Motion carries meaning: view switches play a diagonal wipe, status lamps pulse on `running`, hover states skew/glint. No continuous decorative noise. Respect `body.no-motion` and `prefers-reduced-motion` — both must fully disable animation.
- Dense but grouped information. Every panel needs a clear title, state, primary action, and empty/error state.
- Keep keyboard navigation, visible focus, contrast, responsive breakpoints, and touch targets functional.
- Verify at desktop, compact laptop, and narrow viewport sizes; eliminate clipping and horizontal overflow.
