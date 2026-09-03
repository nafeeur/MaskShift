# Changelog

## Unreleased

- `web_search` now calls Brave, Tavily, or Exa when their API key is configured, falling back to the DuckDuckGo HTML scrape, with an explicit `provider` override.
- Added `pdf_read` for text extraction from PDFs via `pdftotext` (poppler-utils), with page-range and layout controls.
- Added `notebook_read` and `notebook_edit` for inspecting and editing Jupyter (`.ipynb`) notebook cells, clearing stale outputs on edit.
- Repository indexing now computes optional embedding vectors (via a local Ollama embedding model) alongside the existing SQLite FTS index, and `repo_search` blends both with reciprocal rank fusion. Embeddings are reused by content hash across reindexes, and the feature degrades silently to lexical-only search when no embedding model is reachable.
- Added Anthropic prompt caching: the stable system-prompt block (operating contract, repository context, capability catalog), the active tool schema list, and the conversation-so-far boundary are marked with `cache_control` breakpoints so a run's repeated turns reuse cached tokens instead of rebilling them. Disable per-provider with `promptCaching: false`.
- Fixed a bug where the Anthropic provider never read a tool call's `input` field, so tool-call arguments were silently dropped for every Anthropic-backed run.
- Added cost-estimation tooling: a new `usage_report` tool aggregates token usage and estimated spend per model across recent runs, and every completed run now carries a `costEstimate` in its metadata. Pricing comes only from the user-editable `pricing.models` config table (see `maskshift.config.example.json`); a model without a configured price is reported as token counts only, never a guessed cost. Local providers (Ollama) are always priced at zero.
- Made persistent memory ranking decay- and access-aware: `memory_search`/`memory_list` blend text relevance, importance, and an exponential recency decay (`memory.decayHalfLifeDays`, default 30) instead of ranking on raw importance or bm25 alone. `memory_save` now deduplicates by same-scope/same-title, merging tags and taking the max importance instead of accumulating duplicates. Added `memory_optimize` to find and (with `dryRun: false`) merge duplicate-title memories and prune stale, low-importance, never-accessed ones.
- Redesigned the cockpit UI to a strict black/orange/white palette (roughly 60/30/10) in place of the prior six-hue accent system. Category and status colors (skills/MCP/automation tags, connected/available/error states, plan-step and run-status indicators) are now expressed through a hazard-stripe motif (blocked/failed/danger) and a checkered-flag motif (completed) rather than hue, plus more motion throughout: entrance transitions, a drifting speed-streak background, CTA glint sweeps, and a scrolling hazard accent at the brand/topbar boundary. The logo mark was recolored to match. Refreshed all `docs/screenshots/*.png` to the new look.
- Replaced the racing-instrumentation cockpit with a maximalist black/red/white Phantom UI, styled after stylized JRPG menu design: angular clip-path panels and buttons in place of rectangles, poster display type (Anton/Oswald) over calm body prose, diagonal-wipe view transitions, a Three.js shard-particle backdrop behind the idle hero (self-hosted, gated by the existing motion setting and `prefers-reduced-motion`), and a new diamond/mask logo mark. Renamed cockpit chrome to match — Track→Target, Engine→Persona, Pit Garage→Mod Shop, MCP Grid→Network, Loadout tab→Arsenal, Race Plan→Plan of Attack, Abort→Retreat, driver messages→Phantom — without touching the underlying `permissionMode` config values (`overdrive`/`balanced`/`review`), which are unchanged. Renamed the `frontend-redline-ui` skill to `frontend-phantom-ui` to document the new design language. Refreshed all `docs/screenshots/*.png` to the new look.

## 1.0.0 — 2026-09-02

- Initial production baseline of the MaskShift maximalist coding harness.
- Added a zero-runtime-dependency Node.js 22 daemon and responsive Redline racing web cockpit.
- Added 143 native tools and 36 bundled lazy-loaded skills.
- Added model routing for Ollama, OpenAI Responses, OpenAI-compatible endpoints, Anthropic, Gemini, OpenRouter, LM Studio, and vLLM.
- Added modern stateless and legacy MCP support over stdio and Streamable HTTP, imported configuration, resources, prompts, qualified tools, and official registry installation.
- Added repository indexing, context construction, project-instruction import, persistent memory, sessions, plans, run history, SSE telemetry, and SQLite/FTS persistence.
- Added host filesystem and shell execution, persistent processes, Git checkpoints/worktrees, LSP, CDP browser automation, containers, Kubernetes, SSH, rsync, databases, runtimes, archives, web retrieval, plugins, scheduled automations, and external-agent bridges.
- Added automated integration tests, a full tool-calling smoke test, deployment assets, and visual QA artifacts.
