# Local HTTP API

MaskShift exposes the same local API used by the racing cockpit. It is intentionally unauthenticated because the supported default bind is loopback. Do not publish an overdrive API directly to an untrusted network.

Default base URL: `http://127.0.0.1:4242`

JSON requests use `Content-Type: application/json`. Errors use:

```json
{
  "error": "Human-readable message",
  "code": null
}
```

## State and events

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Version, uptime, and health. |
| `GET` | `/api/state` | Initial cockpit snapshot: configuration, workspaces, sessions, active runs, providers, tools, skills, MCP, plugins, automations, browsers, LSP, and processes. |
| `GET` | `/api/events` | Server-Sent Events stream. Optional `runId`, `sessionId`, and `workspaceId` filters. |
| `GET` | `/api/events/recent` | Buffered recent events. |
| `GET` | `/api/logs` | Recent daemon logs. |
| `GET/PATCH` | `/api/config` | Read or update persistent configuration. Secret-like fields are redacted in responses. |

Example event stream:

```bash
curl -N http://127.0.0.1:4242/api/events
```

## Workspaces and repository context

| Method | Path | Purpose |
|---|---|---|
| `GET/POST` | `/api/workspaces` | List or open a workspace. |
| `GET` | `/api/workspaces/:workspaceId` | Read one workspace. |
| `GET` | `/api/workspaces/:workspaceId/inspect` | Repository, manifest, Git, and instruction summary. |
| `GET` | `/api/workspaces/:workspaceId/tree` | File tree with depth and hidden-file controls. |
| `GET` | `/api/workspaces/:workspaceId/file?path=...` | Bounded text read through the native filesystem tool. |
| `GET/POST` | `/api/workspaces/:workspaceId/index` | Read index statistics or force a rebuild. |
| `GET` | `/api/workspaces/:workspaceId/search?q=...` | Search indexed repository chunks. |
| `GET/POST` | `/api/workspaces/:workspaceId/checkpoints` | List or create checkpoints. |
| `POST` | `/api/workspaces/:workspaceId/checkpoints/:checkpointId/restore` | Restore a checkpoint. |

Open a repository:

```bash
curl -sS http://127.0.0.1:4242/api/workspaces \
  -H 'Content-Type: application/json' \
  -d '{"path":"/absolute/path/to/repository","index":true}'
```

## Sessions and autonomous runs

| Method | Path | Purpose |
|---|---|---|
| `GET/POST` | `/api/sessions` | List or create sessions. |
| `GET/PATCH/DELETE` | `/api/sessions/:sessionId` | Read, update, or delete a session. |
| `GET` | `/api/sessions/:sessionId/messages` | Session conversation and tool history. |
| `GET` | `/api/sessions/:sessionId/runs` | Runs belonging to a session. |
| `POST` | `/api/runs` | Start an autonomous run. |
| `GET` | `/api/runs/active` | List in-flight runs. |
| `GET` | `/api/runs/:runId` | Read run state and plan. |
| `POST` | `/api/runs/:runId/cancel` | Abort an active run. |
| `POST` | `/api/runs/:runId/message` | Add a follow-up instruction to the run's session. |

Start a run after opening a workspace:

```bash
curl -sS http://127.0.0.1:4242/api/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "workspaceId":"workspace-id",
    "prompt":"Inspect the repository, repair the highest-impact defect, add tests, and verify the result.",
    "modelRef":"ollama:auto"
  }'
```

## Providers, tools, and skills

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/providers` | Provider and discovered-model state. |
| `POST` | `/api/providers/discover` | Force model discovery. |
| `GET` | `/api/tools` | Complete native/plugin tool catalog; supports `q` and `category`. |
| `POST` | `/api/tools/execute` | Execute a tool directly with workspace/run context. |
| `GET` | `/api/skills` | Skill catalog or relevance search with `q`. |
| `GET` | `/api/skills/:name` | Load one full skill body and references. |

Direct tool execution:

```bash
curl -sS http://127.0.0.1:4242/api/tools/execute \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"shell_exec",
    "arguments":{"command":"git status --short","cwd":"."},
    "workspaceId":"workspace-id"
  }'
```

## MCP

| Method | Path | Purpose |
|---|---|---|
| `GET/POST` | `/api/mcp/servers` | List or add server definitions. |
| `DELETE` | `/api/mcp/servers/:name` | Remove a configured server. |
| `POST` | `/api/mcp/servers/:name/connect` | Connect and discover capabilities. |
| `POST` | `/api/mcp/servers/:name/disconnect` | Close a workspace-scoped connection. |
| `GET` | `/api/mcp/registry?q=...` | Search the official registry. |
| `POST` | `/api/mcp/registry/install` | Install a selected registry entry. |

## Plugins, automations, browsers, and host processes

| Method | Path | Purpose |
|---|---|---|
| `GET/POST` | `/api/plugins` | List or install trusted plugins. |
| `POST` | `/api/plugins/:name/activate` | Activate a plugin. |
| `POST` | `/api/plugins/:name/deactivate` | Deactivate a plugin. |
| `POST` | `/api/plugins/:name/reload` | Hot reload a plugin. |
| `GET/POST` | `/api/automations` | List or create scheduled work. |
| `GET/PATCH/DELETE` | `/api/automations/:automationId` | Manage one automation. |
| `POST` | `/api/automations/:automationId/run` | Execute immediately. |
| `GET/POST` | `/api/browser/instances` | List or launch persistent Chromium/CDP instances. |
| `DELETE` | `/api/browser/instances/:instanceId` | Stop an instance. |
| `GET/POST` | `/api/browser/instances/:instanceId/tabs` | List or create tabs. |
| `GET` | `/api/lsp` | Discover and list language servers. |
| `GET` | `/api/bridges` | Discover external coding-agent CLIs. |
| `GET` | `/api/processes` | List persistent host processes. |
| `GET` | `/api/processes/:processId` | Read incremental process output. |
| `POST` | `/api/processes/:processId/input` | Write to process stdin. |
| `POST` | `/api/processes/:processId/stop` | Send a termination signal. |
| `POST` | `/api/terminal/exec` | Run an unrestricted foreground host command. |

The API is an overdrive control surface. Calls execute with the authority of the MaskShift daemon account.
