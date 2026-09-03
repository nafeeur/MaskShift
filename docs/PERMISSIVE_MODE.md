# Permissive Execution Model

MaskShift is deliberately configured for low-friction autonomous coding. Its default configuration is:

```json
{
  "permissionMode": "overdrive",
  "filesystemScope": "host",
  "networkAccess": "unrestricted",
  "autoCheckpoint": true
}
```

## What overdrive means

The model can call the enabled native tool set without an approval dialog for each action. That includes arbitrary shell commands, writes and deletes, Git operations, remote commands, package managers, database clients, container engines, browser automation, plugin activation, and MCP tools.

MaskShift does not attempt to translate every Unix action into a restrictive policy rule. The daemon has the effective authority of the operating-system account that launched it.

## What remains observable

Permissive is not invisible. MaskShift records and exposes:

- tool start/completion/failure events;
- run and message history;
- active and persistent child processes;
- append-only audit JSONL;
- Git status and checkpoints;
- connected MCP servers and activated tools;
- browser instances;
- an immediate run Abort control.

## Recommended operating boundary

The default HTTP bind is `127.0.0.1`. Keep it on loopback unless you place it behind an authenticated reverse proxy or a private access layer that you control.

Do not expose an unauthenticated overdrive daemon directly to a shared network. The HTTP API includes direct tool execution and host terminal endpoints by design.

Run MaskShift as the user whose files and developer credentials it should access. Running as root gives the agent root authority and is rarely necessary.

## Credentials

Provider keys, MCP credentials, SSH configuration, cloud CLIs, Git credentials, browser sessions, and container sockets remain external to MaskShift. The harness uses them when available; it does not create or bypass missing authentication.

Prefer environment variables or existing credential helpers. Configuration responses and UI state redact common secret fields, but plugins and commands run in-process and can read the daemon environment.

## Containers

Docker provides a stronger operational boundary only to the extent that you limit mounts and sockets. Mounting `/`, the Docker socket, SSH agents, cloud credential directories, or privileged devices restores broad host authority.

The supplied container deployment mounts only `/workspace` and `/data` by default. That is intentionally less capable than direct host mode.

## Recovery limits

Automatic checkpoints help restore repository files. They cannot automatically undo:

- external API calls;
- cloud or database mutations;
- commands against paths outside the workspace checkpoint;
- pushed Git history;
- package installations outside the workspace;
- remote SSH operations.

Use a dedicated development account or disposable machine when giving an untrusted model access to sensitive infrastructure.
