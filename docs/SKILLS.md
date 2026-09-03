# Bundled Skills

MaskShift ships with **36 skills**. Descriptions are indexed at startup; full skill bodies are loaded only after activation.

| Skill | Description | Source |
|---|---|---|
| `architecture` | Design system architecture with explicit requirements, boundaries, data flows, tradeoffs, failure modes, and evolution paths. | `skills/architecture` |
| `backend-api` | Design and implement reliable local or network APIs with validation, streaming, cancellation, observability, and stable contracts. | `skills/backend-api` |
| `browser-automation` | Automate and verify browser workflows using accessibility-first locators, deterministic waits, screenshots, and failure artifacts. | `skills/browser-automation` |
| `build-repair` | Repair broken builds, type checks, packaging, and startup paths across environments with minimal, verifiable changes. | `skills/build-repair` |
| `ci-cd` | Create and repair CI/CD pipelines with caching, parallelism, reproducibility, artifacts, and actionable failures. | `skills/ci-cd` |
| `code-review` | Review changes for real correctness, maintainability, regressions, missing tests, and integration defects with low-noise findings. | `skills/code-review` |
| `codebase-indexing` | Build and maintain scalable repository indexes for lexical, structural, symbol, and semantic retrieval with bounded context. | `skills/codebase-indexing` |
| `cpp-qt` | Implement and debug modern C++ and Qt applications, including signals/slots, models, threading, CMake, rendering, and ownership. | `skills/cpp-qt` |
| `data-analysis` | Analyze datasets reproducibly, validate quality, calculate defensible metrics, and produce clear artifacts. | `skills/data-analysis` |
| `database-migrations` | Evolve persistent schemas safely with compatible migrations, backfills, rollback strategy, and integrity checks. | `skills/database-migrations` |
| `debugging` | Diagnose and repair software failures using evidence, reproduction, instrumentation, and regression tests rather than speculative edits. | `skills/debugging` |
| `dependency-upgrade` | Upgrade libraries and runtimes with compatibility research, focused changes, lockfile integrity, and regression verification. | `skills/dependency-upgrade` |
| `docker-kubernetes` | Containerize and operate development services with reproducible images, health checks, persistent state, and clear networking. | `skills/docker-kubernetes` |
| `documentation` | Write accurate user, operator, API, and architecture documentation grounded in the implemented product. | `skills/documentation` |
| `feature-implementation` | Implement production features end to end, including integration, error states, tests, documentation, and verification. | `skills/feature-implementation` |
| `frontend-phantom-ui` | Build MaskShift interfaces in the maximalist black/red/white Phantom design language — angular panels, poster typography, and comic-panel motion inspired by stylized JRPG menu UI. | `skills/frontend-phantom-ui` |
| `git-worktrees` | Use Git worktrees and checkpoints for parallel agents, isolated changes, review, integration, and recovery. | `skills/git-worktrees` |
| `go-engineering` | Implement idiomatic Go services and tools with context propagation, interfaces, concurrency discipline, and tests. | `skills/go-engineering` |
| `incident-response` | Diagnose and stabilize production incidents, preserve evidence, restore service, and produce actionable follow-up work. | `skills/incident-response` |
| `mcp-authoring` | Build and integrate MCP servers and clients across modern 2026 stateless and legacy initialization-based protocol revisions. | `skills/mcp-authoring` |
| `migration-modernization` | Modernize legacy code or frameworks incrementally while preserving behavior, interoperability, and delivery velocity. | `skills/migration-modernization` |
| `performance` | Profile and optimize latency, throughput, memory, context usage, and startup costs using measured bottlenecks. | `skills/performance` |
| `plugin-authoring` | Create modular MaskShift plugins that add tools, skills, providers, hooks, UI panels, or MCP catalog sources without coupling core policy. | `skills/plugin-authoring` |
| `prompt-evals` | Create evaluations for agent prompts, tool routing, context retrieval, and coding outcomes using reproducible tasks and scoring. | `skills/prompt-evals` |
| `python-engineering` | Build maintainable Python applications and automation with typed boundaries, packaging, environments, tests, and robust subprocess handling. | `skills/python-engineering` |
| `refactoring` | Restructure code safely while preserving behavior, reducing duplication, clarifying ownership, and maintaining compatibility. | `skills/refactoring` |
| `release` | Prepare reproducible production releases with versioning, changelogs, packaging, smoke tests, and rollback notes. | `skills/release` |
| `repo-cartography` | Map unfamiliar repositories and identify the correct files, dependency paths, conventions, and verification commands before implementation. | `skills/repo-cartography` |
| `rust-engineering` | Implement reliable Rust systems with ownership-aware design, errors, async cancellation, tests, and workspace conventions. | `skills/rust-engineering` |
| `scientific-computing` | Implement numerically sound scientific and engineering software with units, validation, reproducibility, and performance awareness. | `skills/scientific-computing` |
| `security-audit` | Audit code and dependencies for concrete exploitable weaknesses while preserving MaskShift’s intentionally permissive local execution philosophy. | `skills/security-audit` |
| `self-improving-skills` | Capture durable, non-obvious workflow knowledge as reusable skills and improve it from verified outcomes. | `skills/self-improving-skills` |
| `test-engineering` | Design and implement high-signal unit, integration, end-to-end, property, and regression tests for changed behavior. | `skills/test-engineering` |
| `typescript-engineering` | Build strict TypeScript applications with stable runtime validation, modular architecture, and browser/server correctness. | `skills/typescript-engineering` |
| `ui-visual-qa` | Inspect web user interfaces for clipping, overlap, responsiveness, focus, loading, empty, error, and interaction-state defects. | `skills/ui-visual-qa` |
| `web-research` | Research changing technical facts from primary sources and convert findings into implementation decisions with traceability. | `skills/web-research` |

Workspace and user skill directories can extend this catalog without modifying the core distribution.
