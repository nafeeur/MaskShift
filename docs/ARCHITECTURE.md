# MaskShift Architecture

## v1.2 codebase intelligence

The repository index now has two complementary views. SQLite FTS plus optional embeddings select
relevant text. A persistent structural graph records files, symbols, local imports, containment,
and conservative likely-call edges. `change_impact` walks those edges in reverse to predict the
blast radius of changing a file or symbol and to identify affected tests.

`ContextPlanner` allocates a bounded character budget across the workspace snapshot, source tree,
instructions, memory, retrieved source, and reserve. Candidates are ranked by query overlap,
retrieval rank, code role, recency, and provenance. The selection report is stored with the run so
users can answer why a file entered context without exposing model chain-of-thought.

Durable memories may cite source files. MaskShift stores each source's hash and checks it before
recall; changed, deleted, or escaped sources mark the memory stale and keep it out of automatic
context until it is refreshed.

## v1.3 intelligence orchestration

`IntelligenceRouter` classifies work by domain and complexity, then ranks configured model profiles.
When matching historical runs exist, observed completion/verification outcomes influence the score.
The agent router applies the same task profile to the external bridge inventory and falls back to an
internal subagent when no preferred CLI is installed.

Executable plans are validated DAGs. Nodes become runnable only when all dependencies complete;
independent ready nodes execute in bounded parallel waves, dependency summaries flow into downstream
tasks, failed dependencies block their descendants, and edit nodes use isolated Git worktrees by
default. The resulting branches are deliberately not auto-merged: review and integration remain an
explicit operation.

Skill self-improvement is evidence-gated. `skill_evaluate` records comparable baseline/candidate
outcomes, while `skill_promote_validated` requires a minimum trial count, positive uplift, and zero
recorded regressions before modifying a skill.

## Adaptive harness

The harness assumes nothing about a model's name or size beyond a prior, and treats every piece of assistance as something a model may or may not need.

- **Three kinds of mechanism.** *Free for everyone* (`call-repair.mjs`, `edit-match.mjs`, `observation.mjs`, `feedback.mjs`): invisible when the model is already right, so they stay on for all models. *Triggered by evidence* (`guardrails.mjs`, the level controller): stagnation nudges, verification retries and hand-offs fire only after something goes wrong. *Chosen by measurement* (`capability-profile.mjs`, `calibration.mjs`): the help level, set from what the model has been shown to do.
- **One decision point.** `CapabilityRegistry.decide` turns a calibration, a track record or a prior into a level; `knobsFor(level)` turns the level into concrete settings read by the prompt builder, the tool menu, the output budget, the repair budget and the stagnation thresholds. A hard limit (a window too small for the full prompt) is a floor, separate from capability.
- **Evidence goes in a loop.** The engine reports every stumble to a per-run `ScaffoldController`; the finished run updates the model's running average; the next run starts from it. Calibration and the benchmark exist so none of this is taken on faith.
- **Everything is attributable.** Run events (`tool-call-repaired`, `edit-check`, `stagnation`, `verification`, `context-reset`, `scaffold`, `scaffold-level`) record what the harness did, and the cost estimate splits tokens by what caused them, so a helper that costs more than it saves shows up.

## Design objective

MaskShift separates **capability availability** from **model-context cost**. The harness may know about hundreds or thousands of local tools, skills, MCP servers, and plugins, but a run starts with a small always-available kernel. The capability controller searches the entire catalog and activates only what the current task or step requires.

```text
Terminal interface (TUI) / CLI subcommands
        │
        ▼
In-process runtime ───── event bus ───── audit + telemetry
        │
        ├── Agent engine
        │     ├── prompt + instruction builder
        │     ├── repository context builder
        │     ├── provider normalization
        │     ├── capability controller
        │     └── plan / tool / subagent loop
        │
        ├── Native tool registry (173 tools)
        ├── Skill manager (metadata eager, body lazy)
        ├── MCP manager (definition eager, connection/schema lazy)
        ├── Workspace + index + checkpoint managers
        ├── LSP manager
        ├── Browser/CDP manager
        ├── Plugin manager
        ├── Automation scheduler
        ├── External-agent bridge manager
        └── SQLite/FTS store
```

## Runtime construction

`src/runtime.mjs` is the composition root. It loads configuration, opens the SQLite store, creates the event bus and logger, initializes workspace-aware managers, registers native tools, activates trusted plugins, constructs the context and prompt builders, starts the agent engine, and finally starts the automation scheduler.

Runtime managers are passed to plugins and tool modules through explicit dependency objects. There is no global application singleton.

## Agent loop

1. Resolve the workspace, session, model, and run options.
2. Create a recovery checkpoint when enabled.
3. Import project instructions such as `AGENTS.md`, `CLAUDE.md`, `MASKSHIFT.md`, Copilot instructions, and Cursor rules.
4. Build bounded repository context from manifests, tree structure, indexed chunks, Git state, memory, and recent messages.
5. Create a run-scoped capability state containing only always-available kernel tools.
6. Auto-prime high-scoring local tools and skill bodies from the user prompt.
7. Send normalized messages and activated schemas to the selected provider.
8. Execute tool calls, record results, update the plan, and continue until the model returns a final answer or the run reaches a terminal state.
9. Stream lifecycle events over SSE and persist messages, run state, usage, and tool results.

Subagents receive independent sessions and capability states. They may share the workspace or use isolated Git worktrees.

## Lazy capability fabric

### Native tools

Native tool descriptors remain in the local registry. Only tools in the run-scoped active set are converted into provider function schemas. The model can invoke `capability_search` and `capability_activate` to locate anything outside the current set.

### Skills

Skill name and description are scanned into a compact catalog. The full Markdown body and references are read only after activation. Workspace changes trigger a new scan so project-local guidance becomes immediately available.

### MCP

MCP definitions are imported without starting their processes or downloading their schemas. Search uses server metadata and cached tool metadata. When activated, the manager:

1. resolves `${workspace}` and environment placeholders;
2. starts stdio or connects over Streamable HTTP;
3. negotiates the modern stateless protocol, falling back to legacy initialization when required;
4. retrieves tools, resources, and prompts;
5. namespaces tools as `mcp__<server>__<tool>`;
6. adds only the selected schemas to the active run.

Connections are workspace-scoped so the same server definition can operate against different repository roots safely and predictably.

## Provider normalization

`src/agent/providers.mjs` normalizes the following protocols into one internal response shape:

- Ollama `/api/chat`;
- OpenAI Responses `/responses`;
- OpenAI-compatible `/chat/completions`;
- Anthropic Messages;
- Gemini `generateContent`.

The internal shape contains text, normalized tool calls, finish reason, usage, model reference, and duration. Provider-specific message and tool-result formats are generated at the boundary.

## Persistence

The built-in `node:sqlite` driver stores:

- workspaces and repository chunks, each optionally carrying an embedding vector for hybrid lexical/semantic retrieval;
- sessions, messages, runs, plans, and events;
- durable memories with FTS5 search;
- checkpoints;
- scheduled automations and execution state;
- application settings.

Large binary artifacts remain on disk and are referenced by path.

## Host execution

MaskShift’s default execution target is the account running the daemon. Native tools support foreground commands, persistent PTY-like process interaction through stdin/stdout buffers, parallel commands, arbitrary host paths, SSH, rsync, containers, Kubernetes, database CLIs, Python cells, and Node cells.

The tool registry still attaches risk and read/write metadata for routing, display, and audit purposes. In `autonomous` mode those labels do not create approval prompts.

## Terminal interface

MaskShift ships one interface and it runs in the terminal. There is no HTTP
server, no browser and no frontend build step; the TUI is a set of ES modules
under `src/tui/` that talk to the same in-process runtime objects the CLI uses.

The renderer is written from scratch against Node's built-ins:

- `theme.mjs` — the MaskShift palette, generated for truecolor, 256-colour
  and 16-colour terminals from one set of hex values.
- `text.mjs` — ANSI-aware measurement, slicing and wrapping, including wide-glyph
  handling, so styled strings keep panel alignment.
- `screen.mjs` — an alternate-screen frame buffer that diffs against the previous
  frame and rewrites only the rows that changed.
- `input.mjs` — a raw-mode decoder for control keys, CSI sequences, modifiers and
  bracketed paste.
- `tokens.mjs` — the design system: the palette, the spacing scale, the
  breakpoints and the documented rules about when each token may be used.
- `type.mjs` / `status.mjs` / `motion.mjs` — the type ramp and the gutter
  primitive that keeps every pane on one grid, the single status vocabulary
  every subsystem's state resolves through, and the wall clock every animation
  is driven from.
- `box.mjs` / `layout.mjs` — the panel language and the column/row composition
  helpers.
- `widgets.mjs`, `overlays.mjs`, `views/` — editors, lists, viewports, the command
  palette, forms, and the six views.

Primary views:

- Chat: conversation, composer, plan, live tool calls.
- Files: workspace tree and syntax-tinted preview.
- Capabilities: searchable native tools, skills, MCP servers (installed and
  the official registry), plugins and agent bridges, one catalogue behind five
  tabs.
- Runtime: direct unrestricted command execution, plus automations,
  background processes and browser instances behind a secondary tab strip.
- Browser: a live, clickable view of a running browser tab.
- Git: working tree changes, log, branches, stash, checkpoints, worktrees.

In Chat, the right sidebar carries the plan, the tools in use and the raw
event feed; every other view gets the same slot for its own context instead (a
file's place in the code graph, a capability's usage, shell job history, a
browser tab's console/network tail, or a changed file's commit history). Below
108 columns the sidebar hides itself and the header sheds telemetry chips, so the
interface stays usable at 80×24.

## Command line

`src/cli/` wraps the same runtime for non-interactive use. Every capability the
TUI exposes has a subcommand, and every subcommand supports `--json`, so MaskShift
composes with shell pipelines and CI. `maskshift daemon` keeps the automation
scheduler resident with no interface at all.

## Extension boundary

A plugin exports `activate(api)` and may:

- `registerTool(descriptor)`;
- `registerSkillDirectory(path)`;
- `registerMcpServer(name, definition)`;
- subscribe to runtime events;
- return a cleanup function.

Plugins run in the daemon process with the same authority as MaskShift. Activation and deactivation update the live tool registry without restarting the server.

Install through the Capabilities view (`3`), the `maskshift plugins` subcommands, or the tool directly:

```text
plugin_install source=/absolute/path/to/plugin kind=local
plugin_install source=https://github.com/example/maskshift-plugin.git kind=git
plugin_install source=@scope/maskshift-plugin kind=auto
```

A complete worked example is in [`examples/plugins/telemetry-pack`](../examples/plugins/telemetry-pack).

MaskShift also detects compatible local agent CLIs — Claude Code, Codex, OpenCode, GitHub
Copilot CLI, Nous Hermes, Aider, plus any custom `agentBridges` entry — and can delegate scoped
work to them while retaining the parent run, telemetry and repository context. These CLIs are
not vendored; a bridge activates when the executable is on `PATH`.

The MCP fabric runs in both directions. MaskShift is an MCP client to the servers configured in
`docs/CONFIGURATION.md#mcp-definitions`, and `maskshift mcp serve` makes it an MCP server too,
exposing the live tool registry over stdio to any client that speaks the standard handshake —
Claude Desktop, Claude Code, an IDE extension, or another MaskShift instance. → [MCP server
config](docs/CONFIGURATION.md#running-maskshift-as-an-mcp-server)

## Recovery model

Recovery is layered:

- Git repositories: checkpoint commit/stash references plus untracked-file copies.
- Non-Git repositories: filesystem checkpoint manifests.
- Parallel work: isolated worktrees.
- Operational visibility: append-only audit log, persisted run events, process list, and live event feed.

Checkpointing reduces accidental damage but does not make arbitrary commands reversible. A command may modify external services or paths outside a tracked workspace.
