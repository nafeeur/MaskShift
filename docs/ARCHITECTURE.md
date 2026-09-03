# MaskShift Architecture

## Design objective

MaskShift separates **capability availability** from **model-context cost**. The harness may know about hundreds or thousands of local tools, skills, MCP servers, and plugins, but a run starts with a small always-available kernel. The capability controller searches the entire catalog and activates only what the current task or step requires.

```text
Browser cockpit / CLI
        │
        ▼
Local HTTP daemon ───── SSE event stream ───── audit + telemetry
        │
        ├── Agent engine
        │     ├── prompt + instruction builder
        │     ├── repository context builder
        │     ├── provider normalization
        │     ├── capability controller
        │     └── plan / tool / subagent loop
        │
        ├── Native tool registry (143 tools)
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

- workspaces and repository chunks;
- sessions, messages, runs, plans, and events;
- durable memories with FTS5 search;
- checkpoints;
- scheduled automations and execution state;
- application settings.

Large binary artifacts remain on disk and are referenced by path.

## Host execution

MaskShift’s default execution target is the account running the daemon. Native tools support foreground commands, persistent PTY-like process interaction through stdin/stdout buffers, parallel commands, arbitrary host paths, SSH, rsync, containers, Kubernetes, database CLIs, Python cells, and Node cells.

The tool registry still attaches risk and read/write metadata for routing, display, and audit purposes. In `overdrive` mode those labels do not create approval prompts.

## Web cockpit

The UI is static HTML, CSS, and browser JavaScript served by the same local daemon. It has no frontend build step and no framework dependency. It communicates through JSON APIs and a Server-Sent Events stream.

Primary views:

- Cockpit: chat, run state, plan, telemetry, event feed, Git pulse.
- Files: workspace tree and bounded source preview.
- Loadout: searchable native tools and skills.
- MCP Grid: imported servers, connection state, and official registry installer.
- Pit Garage: automations, plugins, external-agent bridges, and browser profiles.
- Host Terminal: direct unrestricted command execution.

At compact widths, a six-position racing strip preserves access to all views and new-run creation; the MaskShift brand opens the session drawer.

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
