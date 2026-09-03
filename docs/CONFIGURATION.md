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

## Environment variables

```text
MASKSHIFT_HOME
MASKSHIFT_CONFIG
MASKSHIFT_HOST
MASKSHIFT_PORT
MASKSHIFT_MODEL
MASKSHIFT_DEBUG
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
