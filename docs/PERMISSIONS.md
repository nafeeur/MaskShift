# Permissions

MaskShift is deliberately configured for low-friction autonomous work. Its default configuration is:

```json
{
  "permissionMode": "autonomous",
  "filesystemScope": "host",
  "networkAccess": "unrestricted",
  "autoCheckpoint": true
}
```

## Autonomous mode

The model can call the enabled native tool set without an approval dialog for each action. That includes arbitrary shell commands, writes and deletes, Git operations, remote commands, package managers, database clients, container engines, browser automation, plugin activation, and MCP tools.

MaskShift does not attempt to translate every Unix action into a restrictive policy rule. The daemon has the effective authority of the operating-system account that launched it.

## `balanced` and `review` modes

`permissionMode` also accepts `balanced` and `review`. (`overdrive`, the name earlier releases used for autonomous mode, is still read as `autonomous`.) Both are enforced — a gated tool call is blocked (and audited as `tool.blocked`) unless it is explicitly confirmed:

- **`balanced`** requires interactive confirmation only for the tiers that can reach outside the workspace or beyond an automatic checkpoint's undo: shell/host execution, remote (SSH) execution, secrets access, package installs, database writes, persistent background processes, dynamically loaded plugin code, and other "external action" tools. Plain file edits, git operations, reads, and everything else `readOnly` still run without a prompt.
- **`review`** requires interactive confirmation before every tool call that isn't `readOnly` — the strictest mode.

Confirmation currently has one working surface: the TUI, which pauses the run and shows a confirm dialog naming the tool and its risk tier. A headless context with no one to ask — `maskshift run` (the scripted CLI), an armed automation, a plugin-driven call, or an MCP server request — has no confirmation handler wired up, so a gated call in `balanced`/`review` mode fails there with a clear "no confirmation handler is available" error rather than running unattended or silently allowing it. Use `autonomous` for those unattended contexts; `balanced`/`review` are for a human sitting at the TUI.

## What remains observable

Autonomous is not invisible. MaskShift records and exposes:

- tool start/completion/failure events;
- run and message history;
- active and persistent child processes;
- append-only audit JSONL;
- Git status and checkpoints;
- connected MCP servers and activated tools;
- browser instances;
- an immediate run Abort control.

## Recommended operating boundary

MaskShift listens on nothing. There is no HTTP server, no socket and no remote
control surface: the interface and the CLI run in the same process as the agent,
under your account, on your machine.

That removes the network attack surface but not the local one. Anyone who can run
`maskshift` in your shell can run any command your account can run, so treat the
MaskShift home directory and any shared terminal multiplexer session as
credentials. If you run `maskshift daemon` for automations, remember that its
armed automations execute unattended with the same authority.

Run MaskShift as the user whose files and credentials it should access. Running as root gives the agent root authority and is rarely necessary.

## Credentials

Provider keys, MCP credentials, SSH configuration, cloud CLIs, Git credentials, browser sessions, and container sockets remain external to MaskShift. The harness uses them when available; it does not create or bypass missing authentication.

Prefer environment variables or existing credential helpers. Configuration responses and UI state redact common secret fields, but plugins and commands run in-process and can read the daemon environment.

## Containers

Docker provides a stronger operational boundary only to the extent that you limit mounts and sockets. Mounting `/`, the Docker socket, SSH agents, cloud credential directories, or privileged devices restores broad host authority.

The supplied container deployment mounts only `/workspace` and `/data` by default. That is intentionally less capable than direct host mode.

## Recovery limits

Automatic checkpoints help restore files in the workspace. They cannot automatically undo:

- external API calls;
- cloud or database mutations;
- commands against paths outside the workspace checkpoint;
- pushed Git history;
- package installations outside the workspace;
- remote SSH operations.

Use a dedicated account or disposable machine when giving an untrusted model access to sensitive infrastructure.

## Untrusted content

Files, web pages, documents and tool results can contain text written to look like instructions. The
system prompt tells the model to treat all of it as data and to follow directions only from the user.
That is a mitigation, not a guarantee: in autonomous mode a model that is misled can still act with
your account's authority, which is the main reason to use `balanced` or `review` when a task involves
content you do not control, or to run in a container with only the files it needs.
