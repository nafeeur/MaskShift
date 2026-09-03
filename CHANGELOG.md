# Changelog

## Unreleased

- `web_search` now calls Brave, Tavily, or Exa when their API key is configured, falling back to the DuckDuckGo HTML scrape, with an explicit `provider` override.
- Added `pdf_read` for text extraction from PDFs via `pdftotext` (poppler-utils), with page-range and layout controls.
- Added `notebook_read` and `notebook_edit` for inspecting and editing Jupyter (`.ipynb`) notebook cells, clearing stale outputs on edit.
- Repository indexing now computes optional embedding vectors (via a local Ollama embedding model) alongside the existing SQLite FTS index, and `repo_search` blends both with reciprocal rank fusion. Embeddings are reused by content hash across reindexes, and the feature degrades silently to lexical-only search when no embedding model is reachable.

## 1.0.0 — 2026-09-02

- Initial production baseline of the MaskShift maximalist coding harness.
- Added a zero-runtime-dependency Node.js 22 daemon and responsive Redline racing web cockpit.
- Added 143 native tools and 36 bundled lazy-loaded skills.
- Added model routing for Ollama, OpenAI Responses, OpenAI-compatible endpoints, Anthropic, Gemini, OpenRouter, LM Studio, and vLLM.
- Added modern stateless and legacy MCP support over stdio and Streamable HTTP, imported configuration, resources, prompts, qualified tools, and official registry installation.
- Added repository indexing, context construction, project-instruction import, persistent memory, sessions, plans, run history, SSE telemetry, and SQLite/FTS persistence.
- Added host filesystem and shell execution, persistent processes, Git checkpoints/worktrees, LSP, CDP browser automation, containers, Kubernetes, SSH, rsync, databases, runtimes, archives, web retrieval, plugins, scheduled automations, and external-agent bridges.
- Added automated integration tests, a full tool-calling smoke test, deployment assets, and visual QA artifacts.
