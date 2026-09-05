# MaskShift Architecture

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
        ├── Native tool registry (148 tools)
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

The tool registry still attaches risk and read/write metadata for routing, display, and audit purposes. In `overdrive` mode those labels do not create approval prompts.

## Terminal interface

MaskShift ships one interface and it runs in the terminal. There is no HTTP
server, no browser and no frontend build step; the TUI is a set of ES modules
under `src/tui/` that talk to the same in-process runtime objects the CLI uses.

The renderer is written from scratch against Node's built-ins:

- `theme.mjs` — the Phantom Protocol palette, generated for truecolor, 256-colour
  and 16-colour terminals from one set of hex values.
- `text.mjs` — ANSI-aware measurement, slicing and wrapping, including wide-glyph
  handling, so styled strings keep panel alignment.
- `screen.mjs` — an alternate-screen frame buffer that diffs against the previous
  frame and rewrites only the rows that changed.
- `input.mjs` — a raw-mode decoder for control keys, CSI sequences, modifiers and
  bracketed paste.
- `box.mjs` / `layout.mjs` — the stencil panel language and the column/row
  composition helpers.
- `widgets.mjs`, `overlays.mjs`, `views/` — editors, lists, viewports, the command
  palette, forms, and the six views.

Primary views:

- 01 HEIST: transcript, composer, plan, live tool calls.
- 02 FILES: workspace tree and syntax-tinted source preview.
- 03 ARSENAL: searchable native tools and skills with parameter dossiers.
- 04 NETWORK: MCP servers, connection state, and the official registry installer.
- 05 MOD SHOP: automations, plugins, agent bridges, browsers, processes.
- 06 TERMINAL: direct unrestricted command execution.

The right rail carries the plan, live loadout telemetry, the raw event bus and a
Git pulse. Below 108 columns the rail hides itself and the header sheds telemetry
chips, so the interface stays usable at 80×24.

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

## Recovery model

Recovery is layered:

- Git repositories: checkpoint commit/stash references plus untracked-file copies.
- Non-Git repositories: filesystem checkpoint manifests.
- Parallel work: isolated worktrees.
- Operational visibility: append-only audit log, persisted run events, process list, and live event feed.

Checkpointing reduces accidental damage but does not make arbitrary commands reversible. A command may modify external services or paths outside a tracked workspace.
