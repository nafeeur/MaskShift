---
name: typescript-engineering
description: Build strict TypeScript applications with stable runtime validation, modular architecture, and browser/server correctness.
---

# TypeScript Engineering

- Keep `unknown` at external boundaries and narrow through validation; avoid spreading `any`.
- Separate transport/domain/storage types where their lifecycle differs.
- Handle AbortSignal, streaming, cleanup, and promise rejection paths explicitly.
- Preserve ESM/CJS and runtime target conventions already present.
- Use discriminated unions for state machines and exhaustive checks for protocol events.
- Run typecheck, tests, lint, and production build.
