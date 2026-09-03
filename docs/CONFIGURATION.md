# Configuration

MaskShift writes its effective configuration to `~/.maskshift/config.json` by default. Set `MASKSHIFT_HOME` to relocate the entire state directory or `MASKSHIFT_CONFIG` to select a different JSON file.

The full example is [`maskshift.config.example.json`](../maskshift.config.example.json).

## Core settings

| Field | Default | Meaning |
|---|---:|---|
| `host` | `127.0.0.1` | HTTP bind address. |
| `port` | `4242` | HTTP port; CLI `--port 0` selects an ephemeral port. |
| `autoOpen` | `true` | Open the cockpit after the daemon starts. |
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

## Repository indexing

`indexing` controls the local SQLite FTS code index and its optional embedding layer.

| Field | Default | Meaning |
|---|---:|---|
| `indexing.embeddings` | `true` | Attempt embedding-based semantic search in addition to lexical FTS. |
| `indexing.embedModel` | `nomic-embed-text` | Ollama model requested for embeddings; override with `MASKSHIFT_EMBED_MODEL`. |
| `indexing.embedBatchSize` | `32` | Chunks embedded per request to the Ollama `/api/embed` endpoint. |
| `indexing.embedMaxChunks` | `4000` | Upper bound on chunks embedded per index run. |

Embeddings are best-effort: if the configured Ollama endpoint or model is unreachable, `repo_search` and repository context construction silently fall back to lexical FTS only. Embeddings are keyed by content hash and carried over across reindexes, so unchanged files are never re-embedded.

## Environment variables

```text
MASKSHIFT_HOME
MASKSHIFT_CONFIG
MASKSHIFT_HOST
MASKSHIFT_PORT
MASKSHIFT_MODEL
MASKSHIFT_DEBUG
MASKSHIFT_EMBED_MODEL
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
