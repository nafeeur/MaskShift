# Configuration

MaskShift writes its effective configuration to `~/.maskshift/config.json` by default. Set `MASKSHIFT_HOME` to relocate the entire state directory or `MASKSHIFT_CONFIG` to select a different JSON file.

The full example is [`maskshift.config.example.json`](../maskshift.config.example.json).

## Core settings

| Field | Default | Meaning |
|---|---:|---|
| `permissionMode` | `overdrive` | Routing/display mode; overdrive does not prompt per command. |
| `filesystemScope` | `host` | Native file tools may resolve host paths. |
| `networkAccess` | `unrestricted` | Declares network intent for prompts and telemetry. |
| `maxAgentSteps` | `96` | Maximum model/tool turns in a run. |
| `maxSubagentDepth` | `3` | Maximum delegation nesting depth. |
| `maxParallelSubagents` | `6` | Concurrent delegated runs. |
| `maxToolOutputChars` | `60000` | Bounded tool output inserted into model history. |
| `maxContextChars` | `420000` | Maximum constructed repository context. |
| `maxFileReadChars` | `240000` | Maximum text returned by a single file read. |
| `commandTimeoutMs` | `300000` | Default foreground command timeout. |
| `mcpTimeoutMs` | `60000` | Default MCP request timeout. |
| `autoIndex` | `true` | Build/update the repository chunk index on open. |
| `autoCheckpoint` | `true` | Capture recoverable state before autonomous runs. |
| `autoLoadCapabilities` | `true` | Prime tools and skills from prompt relevance. |
| `autoConnectMcp` | `true` | Permit relevance-driven MCP connection. |
| `visionModel` | `null` | `provider:model` reference used by `image_read` to describe images (e.g. `ollama:llava`). `null` auto-detects a vision-capable model already pulled on the Ollama provider; override with `MASKSHIFT_VISION_MODEL`. |

## Terminal interface

| Field | Default | Meaning |
|---|---:|---|
| `ui.density` | `maximal` | Reserved for future layout density presets. |
| `ui.rail` | `plan` | Rail section shown first: `plan`, `telemetry`, `events` or `git`. |
| `ui.railVisible` | `true` | Whether the right rail starts visible. It hides itself below 108 columns regardless. |
| `ui.unicode` | `null` | Force Unicode box drawing on or off. `null` auto-detects from the locale. |
| `ui.colorDepth` | `null` | Force `0`, `4`, `8` or `24`-bit colour. `null` auto-detects. |
| `ui.expandToolOutput` | `false` | Start the transcript with tool output expanded. |
| `ui.mouse` | `click` | `click` for press, release and drag; `hover` adds pointer-over highlighting at the cost of a report per cell crossed; `off` returns text selection to the terminal. |

Environment overrides: `MASKSHIFT_COLOR=off|basic|full`, `MASKSHIFT_ASCII=1`,
`MASKSHIFT_MOUSE=click|hover|off`, plus the standard `NO_COLOR` and
`FORCE_COLOR`. While the mouse is on, most terminals still select text on
shift+drag.

## Repository indexing

`indexing` controls the local SQLite FTS code index and its optional embedding layer.

| Field | Default | Meaning |
|---|---:|---|
| `indexing.embeddings` | `true` | Attempt embedding-based semantic search in addition to lexical FTS. |
| `indexing.embedModel` | `nomic-embed-text` | Ollama model requested for embeddings; override with `MASKSHIFT_EMBED_MODEL`. |
| `indexing.embedBatchSize` | `32` | Chunks embedded per request to the Ollama `/api/embed` endpoint. |
| `indexing.embedMaxChunks` | `4000` | Upper bound on chunks embedded per index run. |

Embeddings are best-effort: if the configured Ollama endpoint or model is unreachable, `repo_search` and repository context construction silently fall back to lexical FTS only. Embeddings are keyed by content hash and carried over across reindexes, so unchanged files are never re-embedded.

## Code graph and context planning

`codeGraph.enabled` defaults to `true`. The graph is stored in SQLite and records source files,
top-level symbols, containment, resolved local imports, and conservative likely-call edges. Use
`code_graph_build` to refresh it explicitly and `change_impact` before broad edits. The graph is
static analysis, so dynamic imports and runtime dispatch may not be visible; edge confidence is
returned rather than presenting heuristic calls as certainty.

`contextPlanner.weights` divides the constructed context budget among the workspace snapshot,
tree, repository instructions, memories, retrieved source, and reserve. The defaults are:

```json
{"snapshot":0.12,"tree":0.10,"instructions":0.16,"memories":0.12,"source":0.42,"reserve":0.08}
```

`context_plan_explain` reports which sources were selected and why. `memory_save.sources` accepts
workspace-relative files; their hashes are captured on save and checked before automatic recall.

## Intelligence routing

Routing is active when `routing.autoSelect` is `true`, but it changes the configured default only
when `routing.models` contains candidates. Each candidate has a model reference, task tags, and an
optional priority. Historical success for matching task tags adjusts the ranking once runs exist.

```json
{
  "routing": {
    "autoSelect": true,
    "models": [
      {"model":"openai:MODEL_ID","tags":["frontend","verification"],"priority":1},
      {"model":"ollama:qwen3-coder:latest","tags":["systems","general-coding"],"priority":1}
    ],
    "agents": {
      "frontend": ["claude", "codex"],
      "research": ["hermes", "claude"]
    }
  }
}
```

Supported task tags are `frontend`, `systems`, `verification`, `large-change`, `research`, and
`general-coding`. An explicit `--model` still wins. `router:auto` requests routing for one run.

## Images and scanned PDFs

`image_read` and the OCR fallback in `pdf_read` give any model — including ones with no native
vision support — access to what's in an image or a scanned PDF, by running the extraction out of
band and returning plain text:

| Step | Tool | Requires |
|---|---|---|
| Text extraction (OCR) | `image_read`, `pdf_read` fallback | `tesseract` on `PATH` |
| Page rendering (scanned PDFs) | `pdf_read` fallback | `pdftoppm` (poppler-utils) on `PATH` |
| Natural-language description | `image_read` | An Ollama vision model (`ollama pull llava`, `moondream`, `qwen2.5vl`, ...) |

Each step degrades independently: without `tesseract`/`pdftoppm`, OCR is skipped with a note in
the result; without a discoverable vision model, the description step is skipped the same way.
`pdf_read` only attempts the OCR fallback when the PDF's extractable text layer looks too sparse
for its page count, so normal text PDFs are unaffected.

## Environment variables

```text
MASKSHIFT_HOME
MASKSHIFT_CONFIG
MASKSHIFT_HOST
MASKSHIFT_PORT
MASKSHIFT_MODEL
MASKSHIFT_DEBUG
MASKSHIFT_EMBED_MODEL
MASKSHIFT_VISION_MODEL
OLLAMA_BASE_URL
OPENAI_API_KEY
OPENAI_BASE_URL
ANTHROPIC_API_KEY
ANTHROPIC_BASE_URL
OPENROUTER_API_KEY
GEMINI_API_KEY
LMSTUDIO_BASE_URL
VLLM_BASE_URL
VLLM_API_KEY
BRAVE_API_KEY
TAVILY_API_KEY
EXA_API_KEY
GITHUB_TOKEN
```

## Providers

Provider entries are merged by `id` with built-in defaults.

### Models without native tool calling

Every MaskShift capability is reached through a tool call, so a model that cannot emit one
would otherwise be limited to conversation. Models that lack a native tool API are driven with
a text protocol instead: the active tools and their schemas are rendered into the system
prompt, and the model calls them by writing a block in its reply.

```text
<tool_call>
{"name": "fs_read", "arguments": {"path": "src/index.js"}}
</tool_call>
```

Replies are parsed back into ordinary tool calls, so the whole harness — lazy capability
activation, skills, MCP servers, subagents, plan tracking, checkpoints — behaves identically
either way. The reader accepts the variants small models tend to emit (single quotes, unquoted
keys, trailing commas, Python literals, fenced blocks, arguments as a JSON string), and a call
it cannot parse is sent back for correction rather than ending the run.

Each provider takes an optional `toolProtocol`:

| Value | Behaviour |
| --- | --- |
| `auto` (default) | Use the native tool API, and fall back to the text protocol the first time the endpoint rejects a tool schema or the model answers with a text call instead. |
| `native` | Always use the provider's tool API. |
| `text` | Always use the text protocol, and never send a `tools` field. |

`auto` needs no configuration: the downgrade is remembered per model, so it costs at most one
request. Set `text` explicitly to skip even that probe.

```json
{
  "providers": [
    { "id": "ollama", "type": "ollama", "toolProtocol": "text" }
  ]
}
```

Native tool calling remains preferable where a model supports it properly — it is more
token-efficient and less error-prone — so leave `auto` alone unless a model is known to need
otherwise.

### Provider entries

```json
{
  "providers": [
    {
      "id": "lab-ollama",
      "name": "Lab Ollama",
      "type": "ollama",
      "baseUrl": "http://model-host:11434",
      "enabled": true,
      "autoDiscover": true,
      "toolProtocol": "auto",
      "models": [],
      "timeoutMs": 600000,
      "options": {
        "num_ctx": 65536
      }
    },
    {
      "id": "internal-openai",
      "name": "Internal OpenAI-compatible",
      "type": "openai-compatible",
      "baseUrl": "https://models.example/v1",
      "apiKeyEnv": "INTERNAL_MODEL_KEY",
      "enabled": true,
      "autoDiscover": true,
      "headers": {},
      "requestDefaults": {}
    }
  ]
}
```

Supported `type` values are `ollama`, `openai-responses`, `openai-compatible`, `anthropic`, and `gemini`.

An `anthropic` provider entry also accepts `promptCaching` (default `true`). When enabled, MaskShift marks the stable system-prompt block, the active tool schema list, and the conversation-so-far boundary with `cache_control: {"type": "ephemeral"}` breakpoints so a run's repeated turns reuse cached input tokens instead of rebilling them in full. Set `"promptCaching": false` on the provider entry if a proxy in front of the Anthropic-compatible endpoint rejects the `cache_control` field.

## Memory ranking

`memory` controls how `memory_search`/`memory_list` rank and age persistent memories.

| Field | Default | Meaning |
|---|---:|---|
| `memory.decayHalfLifeDays` | `30` | A memory's recency contribution to ranking halves roughly every this many days since it was last saved or updated. Memories are never auto-deleted by decay alone — use `memory_optimize` to actually prune. |

Ranking blends normalized text relevance, raw `importance`, and this recency decay; `memory_save` also deduplicates by same-scope/same-title (merging tags, keeping the higher importance) unless called with `dedupe: false`.

## Cost estimation

`pricing` is a user-editable table the `usage_report` tool and per-run `costEstimate` use to turn token counts into an estimated spend. MaskShift ships this **empty by default** — it never guesses a price. Local providers (Ollama) are always priced at `0` since there is no per-token provider charge.

```json
{
  "pricing": {
    "currency": "USD",
    "models": {
      "anthropic:claude-sonnet-5": { "inputPerMTok": 3, "outputPerMTok": 15, "cacheWritePerMTok": 3.75, "cacheReadPerMTok": 0.3 }
    }
  }
}
```

Keys may be `"<providerId>:<model>"` or a bare model id. Verify current rates against your provider's own pricing page before relying on this for a real budget decision — prices change and this file will not update itself.

## MCP definitions

MaskShift maintains one combined catalog from the bundled curated starters, this file,
workspace `.mcp.json` and `.vscode/mcp.json`, the Claude/Codex/Copilot/Cursor/OpenCode/Windsurf
MCP configuration files, the live official MCP Registry, and any servers registered by plugins.

Servers are **lazy** by default. MaskShift searches the catalog, connects the relevant server
when a task requires it, reads its tool schema, qualifies every tool as `mcp__server__tool`,
and injects only those activated tools into the current run — so the whole catalog stays
available without consuming the context window before work begins. Credential-gated servers
still need their real API key or OAuth setup; MaskShift can discover, install, import and
connect them, but it cannot fabricate credentials.

```json
{
  "mcpServers": {
    "server-name": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "package-name", "${workspace}"],
      "cwd": "${workspace}",
      "env": {
        "TOKEN": "${TOKEN}"
      },
      "enabled": true,
      "lazy": true
    },
    "remote-server": {
      "transport": "http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${REMOTE_MCP_TOKEN}"
      },
      "enabled": true,
      "lazy": true
    }
  }
}
```

Environment placeholders are expanded at connection time. `${workspace}` in stdio arguments or `cwd` resolves to the active workspace root.

## Running MaskShift as an MCP server

`maskshift mcp serve` runs MaskShift itself as a stdio MCP server bound to one workspace,
exposing the same native tool registry the CLI and interface use. Any MCP client that speaks
the standard `initialize` → `tools/list` → `tools/call` handshake can drive it — Claude Desktop,
Claude Code, an MCP-aware IDE extension, or another MaskShift instance.

`--read-only` restricts the exposed catalog to tools marked `readOnly` (no `fs_write`,
`shell_exec`, and the like); `--tools a,b,c` restricts it to an explicit allowlist instead. Both
apply to `tools/list` and `tools/call` alike, so a tool that isn't listed cannot be invoked
either. Standard output carries only JSON-RPC frames — diagnostics go to the log file and to
stderr, never stdout, so nothing corrupts the transport.

A Claude Desktop-style client config:

```json
{
  "mcpServers": {
    "maskshift": {
      "command": "maskshift",
      "args": ["mcp", "serve", "--workspace", "/path/to/repository"]
    }
  }
}
```

Add `"--read-only"` to `args` for a client that should only ever inspect the workspace.

## External agent bridges

```json
{
  "agentBridges": {
    "my-agent": {
      "title": "Internal coding agent",
      "command": "my-agent",
      "args": ["--prompt", "${prompt}"],
      "enabled": true,
      "promptMode": "argument"
    }
  }
}
```

Use `agent_bridge_discover` and `agent_bridge_help` to inspect the effective command template before delegation.

## Automations

Schedules accept an ISO timestamp, an interval such as `every 15m`, or a five-field cron
expression. One-shot ISO automations disarm after they complete. An automation runs one of
three kinds of work: an autonomous MaskShift agent run, a direct native-tool call, or an
unrestricted host shell command. Runs and failures are persisted in SQLite and streamed into
the interface event feed.

```json
{
  "automations": {
    "enabled": true,
    "pollIntervalMs": 30000,
    "maxPerTick": 4
  }
}
```

Create and manage them from the Mod Shop (`5`), the `maskshift automation` subcommands, or the
`automation_*` tools.

## Browser profiles

MaskShift discovers Chromium, Chrome or Edge and launches persistent CDP profiles. Use visible
mode for an initial interactive login, then reuse the same named profile in headless runs.

```json
{
  "browser": {
    "profileRoot": "~/.maskshift/browser/profiles",
    "headless": true
  }
}
```

## Data locations

Default home is `~/.maskshift`, overridable with `MASKSHIFT_HOME`.

```text
config.json                 persistent configuration
maskshift.sqlite            sessions, runs, messages, memory, indexes, automations
logs/maskshift.log          daemon log
logs/audit.jsonl            tool and execution audit trail
artifacts/                  generated browser and run artifacts
browser/profiles/           persistent Chromium profiles
checkpoints/                non-Git checkpoint data
plugins/                    installed capability packs
skills/                     user-created skills
worktrees/                  isolated agent worktrees
```

## Hooks

Hooks are lifecycle actions keyed by event name. A hook may execute shell, HTTP, MCP, prompt, or agent actions depending on its definition. Hook failures are logged and emitted on the event bus.

```json
{
  "hooks": {
    "run.completed": [
      {
        "type": "shell",
        "command": "printf '%s\\n' 'MaskShift run completed'"
      }
    ]
  }
}
```

## UI

```json
{
  "ui": {
    "density": "maximal",
    "motion": true,
    "telemetry": true,
    "terminalHeight": 260
  }
}
```

Motion can also be disabled from the Settings dialog and respects `prefers-reduced-motion`.
