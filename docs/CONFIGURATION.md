# Configuration

MaskShift writes its effective configuration to `~/.maskshift/config.json` by default. Set `MASKSHIFT_HOME` to relocate the entire state directory or `MASKSHIFT_CONFIG` to select a different JSON file.

The full example is [`maskshift.config.example.json`](../maskshift.config.example.json).

## Core settings

| Field | Default | Meaning |
|---|---:|---|
| `permissionMode` | `autonomous` | `autonomous` never prompts (the older name `overdrive` is still accepted). `balanced` requires interactive confirmation (in the TUI) before a high-risk tool call — one whose `risk` tier is `destructive`, `host-exec`, `remote-exec`, `secrets`, `install`, `database-write`, `persistent-exec`, `dynamic-load`, or `external-action`. `review` requires confirmation before any non-`readOnly` tool call. See [`docs/PERMISSIONS.md`](PERMISSIONS.md#balanced-and-review-modes). |
| `filesystemScope` | `host` | Native file tools may resolve host paths. |
| `networkAccess` | `unrestricted` | Declares network intent for prompts and telemetry. |
| `maxAgentSteps` | `96` | Maximum model/tool turns in a run. |
| `maxSubagentDepth` | `3` | Maximum delegation nesting depth. |
| `maxParallelSubagents` | `6` | Concurrent delegated runs sharing the same parent. |
| `maxRunDurationMs` | `28800000` | Wall-clock deadline for a single run (8 hours); it is aborted past this. |
| `maxRunTokens` | `5000000` | Total accounted input+output tokens a single run may use before it is aborted. |
| `maxToolOutputChars` | `60000` | Bounded tool output inserted into model history. |
| `maxContextChars` | `420000` | Maximum constructed repository context. |
| `maxFileReadChars` | `240000` | Maximum text returned by a single file read. |
| `commandTimeoutMs` | `300000` | Default foreground command timeout. |
| `mcpTimeoutMs` | `60000` | Default MCP request timeout. |
| `autoIndex` | `true` | Build/update the repository chunk index on open. |
| `autoCheckpoint` | `true` | Capture recoverable state before autonomous runs. |
| `guardrails` | see [Run guardrails](#run-guardrails) | Stagnation detection, project-check verification and context hand-off for long runs. |
| `autoLoadCapabilities` | `true` | Prime tools and skills from prompt relevance. |
| `autoConnectMcp` | `true` | Permit relevance-driven MCP connection. |
| `visionModel` | `null` | `provider:model` reference used by `image_read` to describe images (e.g. `ollama:llava`). `null` auto-detects a vision-capable model already pulled on the Ollama provider; override with `MASKSHIFT_VISION_MODEL`. |

## Run guardrails

Three checks that do not rely on the model's own judgement of its progress. All live under `guardrails` in the config file.

```json
"guardrails": {
  "stagnation":   { "enabled": true, "window": 16, "repeatThreshold": 3, "stopThreshold": 6 },
  "verification": { "commands": [{ "command": "npm test", "label": "tests" }, "npm run lint"], "maxAttempts": 3, "timeoutMs": 300000 },
  "handoff":      { "enabled": true, "thresholdRatio": 0.75, "maxResets": 3 }
}
```

- **Stagnation.** A call's signature is the tool, its arguments and a hash of its result. The same signature `repeatThreshold` times in the last `window` calls (or a strict A,B,A,B alternation) injects a `[Harness notice]` telling the model to change approach. At `stopThreshold` the run ends with status `stagnated`. A changed result (a test going from red to a different red) counts as progress.
- **Verification.** Off until `commands` is set. When a run that changed something says it is done, the commands run in the workspace; any non-zero exit sends the failing output back as a new turn. After `maxAttempts` failures the run completes anyway with `meta.verification.ok: false` and a note appended to the reply. Runs that only read are never verified, and a run option `skipVerification` opts a single run out.
- **Hand-off.** When the conversation passes `thresholdRatio` of the model's history budget (and before compaction would start dropping turns), earlier turns are summarized into `.maskshift/progress.md` in the workspace — goal, plan, progress, last verification result, `git status` — and the run continues from a fresh context seeded with that file. At most `maxResets` times per run. `.maskshift/` is already git-ignored.

Run events: `stagnation`, `verification` and `context-reset`.

```json
"guardrails": {
  "feedback": { "enabled": true, "syntax": true, "lsp": true, "timeoutMs": 8000, "maxIssues": 5 },
  "features": { "callRepair": true, "fuzzyEdits": true, "observation": true, "editFeedback": true }
}
```

- **Edit feedback.** After `fs_write`, `fs_patch`, `fs_replace_lines`, `symbol_replace` or `fs_apply_patch`, each changed file is checked and any problem is appended to *that same tool result*. Syntax first, using only interpreters already on the machine (`node --check`, `python3`'s `ast`, `bash -n`, `gofmt -e`, `ruby -c`, JSON); then language-server errors if a server is installed (`lsp`). A clean edit adds nothing. Files the check cannot judge on its own are left alone: JSX or bundler-style ES modules in `.js`, and JSON-with-comments files such as `tsconfig.json`. One time budget (`timeoutMs`) covers the whole call. Event: `edit-check`.
- **Always-on helpers.** `features` switches the helpers that are free for every model: `callRepair` (tool names and arguments repaired deterministically — aliases like `read_file`, key spellings like `file_path`, `"5"` → `5`, a flattened edit wrapped into `edits`), `fuzzyEdits` (see below), `observation` (tool output shaping) and `editFeedback`. They exist mostly so `maskshift bench run --without …` can measure each one; leave them on.
- **Forgiving edits.** `fs_patch` tries exact text first, then ignores trailing whitespace, then indentation (re-indenting the replacement to the file), then runs of whitespace, then CRLF vs LF, then a copied `fs_read` line-number gutter, and finally a near match — accepted only when it is clearly the single best by a margin. An ambiguous match is never guessed at. A real miss returns the closest region of the file with line numbers. A batch is all-or-nothing. When a looser rule applied, the result says so. `symbol_read` / `symbol_replace` (by name, `Class.method` for methods) and `fs_replace_lines` let a model edit without reproducing old text at all.
- **Observation shaping.** Tool output is stripped of ANSI colour and progress-bar redraws, repeated lines are collapsed, and results are rendered compactly (file text raw rather than as an escaped JSON string; shell results as `$ command → exit N` with the error stream first on failure). Over a budget sized to the model's window (and scaled down at higher help levels), logs keep their head, their tail and the lines around errors; file reads are cut at a line boundary with the exact `startLine` to continue from; diffs keep their start and end; long arrays are trimmed with a count. Whenever something was left out the full text is saved under `.maskshift/outputs/` and referenced, so the model can range-read it. `.maskshift/` ignores itself, so it never dirties a repository.

The cost estimate on every run now carries `bySource`: tokens split into ordinary `turn`s versus calls the harness itself caused — `repair`, `verification`, `nudge`, `compaction` and `handoff`.

## Adaptive scaffolding

Help is a dial, not a mode. Every model gets a level from 0 (leave it alone) to 3 (carry it); each level only *adds* assistance, and the always-on helpers above run at all of them.

| Level | Prompt and tools | Output budget | Repairs allowed | Stagnation nudge after | Plan |
|---|---|---|---:|---:|---|
| 0 | full contract, full tool menu | 100% | 2 | 3 repeats | — |
| 1 | full | 80% | 3 | 3 | — |
| 2 | compact contract, core tool set, short schemas | 50% | 3 | 2 | — |
| 3 | compact | 35% | 4 | 2 | `plan_update` asked for before any edit |

The starting level comes from, in order of trust: a **calibration** (`maskshift model calibrate` scores the model 0–1 on tool calling, a precise edit, planning and long-context recall; a few thousand tokens, and opt-in because nothing is spent on a model until you ask), its **observed track record** (a running average of how often it needed the harness to step in, used after two or more runs), and a **prior** from its size and window. A context window under 16k tokens always forces level 2 or higher, however well the model scored — the full prompt does not fit in it. Within a run the level only rises: repeated stumbles (failed edits, parse failures, repaired calls, stagnation, failed verification) add pressure, clean calls relieve it, and past a threshold the level goes up one step (event `scaffold-level`). It never drops mid-run, which would churn the prompt cache; the track record handles easing off over later runs. Inspect any model with `maskshift model profile`.

## Benchmark

`maskshift bench run --model REF` runs 12 small self-checking tasks (an off-by-one, a cross-file rename, a function from a spec, a config edit, a null check, a stub from its tests, a syntax error, a moved import, a tab-indented block, a bug hidden in 3,000 lines of log, dead-code removal, a class-method bug) through the real engine and scores each by the exit code of its check, never by what the model says. The report gives pass rate, average turns, tokens per solved task, a `bySource` token split, and how often each helper stepped in. Reports are saved under `$MASKSHIFT_HOME/bench/`; `bench compare` diffs two of them, and `--without fuzzyEdits` (or `callRepair`, `observation`, `editFeedback`) switches one helper off so the two runs measure what it is worth. `maskshift bench verify` needs no model: it proves every task fails untouched and passes after its reference solution, and is part of the test suite.

## Terminal interface

| Field | Default | Meaning |
|---|---:|---|
| `ui.density` | `maximal` | Reserved for future layout density presets. |
| `ui.rail` | `plan` | Sidebar tab shown first: `plan`, `telemetry` (the tools in use), `events` or `git`. |
| `ui.railVisible` | `true` | Whether the sidebar starts visible. It hides itself below 108 columns regardless. |
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

Not every prompt gets the full budget. Each prompt is classified into a profile, and
`contextPlanner.scale` sets what fraction of the full budget that profile receives:

| Profile | Triggered by | Default `scale` |
|---|---|---:|
| `conversational` | No meaningful words after stopwords ("hi", "thanks, what can you do?") — retrieval is skipped entirely | `0.04` |
| `focused` | Any ordinary task prompt | `0.12` |
| `broad` | Prompts over 1200 characters, or refactor/migration/architecture/audit/"across the codebase" wording | `1` |

Repository instructions keep a floor of 12 000 characters (capped at their full-budget share) so a
smaller profile never squeezes out `AGENTS.md`/`CLAUDE.md`. The model can still pull in anything
else it needs with `fs_read`, search, and the code graph.

Retrieved source must also clear a relevance bar before it spends budget: at least
`contextPlanner.minSourceOverlap` (default `0.2`) of the prompt's meaningful words must appear in
the chunk or its path, or its embedding similarity must reach `contextPlanner.minSemanticScore`
(default `0.55`). Skill Markdown (`skills/**/*.md`) is never injected as source, since skills have
their own lazy loader, and other Markdown is only injected when the prompt asks about docs.

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

## Model adaptation

MaskShift sizes every run to the model actually running it, including models it has never
seen. For each model it resolves a **context window**, taking the first of:

1. `harness.models["provider:model"].contextWindow`, or `contextWindow` on the provider's
   `models[]` entry.
2. What the provider reports: Ollama's `/api/show` (`*.context_length`), an OpenAI-compatible
   `/models` listing (`context_length`, `max_model_len`, `context_window`,
   `max_context_length`), or Gemini's `inputTokenLimit`.
3. A family default for well-known model names, or a size in the name (`…-128k`).
4. `32768` when nothing else is known.

When a provider rejects a request as too long, MaskShift reads the real limit from the error
(or, if the error names none, assumes a window 25% smaller), resizes the prompt, and retries
the same turn — up to twice. The learned limit is saved in the `modelContextLimits` setting,
so later sessions start with it. To forget a learned limit, remove that model's entry from
the setting or set an explicit `contextWindow`.

For Ollama, which silently truncates to `num_ctx`, MaskShift sends `num_ctx` itself: the
model's trained window, capped at `harness.ollamaContextCap` (default `32768`, to bound
memory use). An explicit `options.num_ctx` on the provider always wins.

From the window (and the parameter count, when the name or Ollama reports it) the model gets a
tier, which shapes the prompt:

| Tier | When | Effect |
|---|---|---|
| `small` | window under 16k, or ≤9B parameters | Short operating contract, a core set of 11 tools (the rest stay reachable through `capability_search`/`capability_activate`), 20% of the window for repository context |
| `medium` | everything between | Full prompt, 35% of the window for repository context |
| `large` | window of 100k+ and ≥30B parameters (or unknown) | Full prompt, 35% of the window for repository context |

Replies are capped at a quarter of the window (and at `harness.maxOutputTokens` or the
model's reported output limit, when lower). Agentic tool use needs roughly an 8k window at
minimum; below that, a run fails with a clear context-budget error rather than sending a
truncated request.

### Long sessions

- Each run reads the whole session back, not a recent slice. What does not fit the window is
  summarized rather than dropped silently.
- The summary uses fixed headings (goal, files touched, decisions, open issues, key facts), is
  sized to the window (400–2 000 tokens), and is saved on the session, so the next prompt
  continues from it and never re-summarizes turns it already covers.
- When history passes half of its budget, large tool results outside the four most recent
  turns are replaced with a short stub naming the tool, so an old file read stops costing its
  full size on every request. The model can re-run the tool if it needs the content again.

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
      "title": "Internal agent",
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

Create and manage them from the Runtime view (`4`), the `maskshift automation` subcommands, or the
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

## Remembered sign-ins

`browser_login` can remember a password after you sign in. The default keeps it in memory until
MaskShift exits; `keychain` stores it in the operating-system credential store when one is available.

```json
{ "secrets": { "backend": "session" } }
```

`session` (default) or `keychain`. Only the names of remembered sites are indexed in MaskShift's own
data; values are never written there. See [web tasks](WEB_TASKS.md).

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
    "SessionEnd": [
      {
        "type": "command",
        "command": "printf '%s\\n' 'MaskShift session ended'"
      }
    ]
  }
}
```

| Event | Fires |
|---|---|
| `SessionStart` | Once, before the first model turn of a run. |
| `UserPromptSubmit` | Right after `SessionStart`, with the run's prompt. |
| `PreToolUse` | Before each tool call executes. |
| `PostToolUse` | After a tool call succeeds. |
| `PostToolUseFailure` | After a tool call throws. |
| `PreCompact` | Before context compaction summarizes turns dropped to fit a smaller context window — the last point to persist state ahead of a lossy summarization. |
| `Stop` | When a run finishes, for any reason (completed, hit `max_steps`, `stagnated`, failed, or cancelled). |
| `RunCompleted` | When a run finishes successfully (a narrower companion to `Stop`). |
| `SessionEnd` | After a run's outcome is finalized, once — the counterpart to `SessionStart`; a good place for hooks that persist or clean up session state, since it always fires exactly once per run regardless of outcome. |

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
