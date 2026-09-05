# MaskShift Command Line

MaskShift is a terminal application. Running `maskshift` with no arguments opens
the full-screen interface (see [TUI.md](TUI.md)); every capability that interface
exposes is also a subcommand, so MaskShift scripts and pipes cleanly.

```bash
maskshift                                  # open the interface here
maskshift "review the current diff"        # open it with the composer pre-filled
maskshift run "make the tests pass"        # one headless run, streamed to stdout
maskshift mcp connect playwright           # scripted capability control
```

## Global flags

| Flag | Meaning |
|---|---|
| `--workspace PATH` | Workspace to operate on. Defaults to the current directory. |
| `--model REF` | Model reference such as `ollama:qwen3` or `anthropic:claude-sonnet-5`. |
| `--config PATH` | Configuration file to load instead of `$MASKSHIFT_HOME/config.json`. |
| `--json` | Emit machine-readable JSON instead of styled output. Every command supports it. |
| `--no-color` | Disable colour. `NO_COLOR` and `MASKSHIFT_COLOR=off` do the same. |
| `-h, --help` | Help for MaskShift or for one command group. |
| `-v, --version` | Print the version. |

Exit codes: `0` success, `1` the operation ran but failed (a red run, a failing
doctor), `2` the command line itself was wrong.

## Core commands

| Command | Description |
|---|---|
| `tui [PROMPT]` | Open the full-screen interface. The default when no command is given. |
| `run "PROMPT"` | Execute one agent run, streaming turns, tool calls and results. |
| `exec "COMMAND"` | Run a shell command through the MaskShift tool layer. |
| `doctor [--json]` | Check the environment, providers and capability counts. |
| `daemon` | Stay resident so scheduled automations keep firing. No interface. |
| `help [COMMAND]` | Full help, or help for one command group. |

`run` streams progress to stderr-safe styled output and finishes with the final
message. With `--json` it emits a single object:

```json
{ "runId": "run_…", "sessionId": "ses_…", "status": "completed",
  "model": "ollama:qwen3", "final": "…", "usage": {}, "cost": {} }
```

## Workspace

| Command | Description |
|---|---|
| `workspace open [PATH]` | Open a workspace, import its configuration, index it. `--no-index` skips indexing. |
| `workspace list` | Every workspace MaskShift knows about. |
| `workspace info` | Git state, languages, project files, imported instruction files. |
| `workspace tree [PATH]` | File tree. `--depth N`, `--hidden`, `--limit N`. |
| `workspace search QUERY` | Search the index (full text plus embeddings). `--limit N`. |
| `workspace index` | Build or rebuild the context index. |
| `workspace read PATH` | Bounded file read. `--start N`, `--end N`, `--no-numbers`. |
| `workspace checkpoint [LABEL]` | Record a restore point. |
| `workspace checkpoints` | List recorded checkpoints. |
| `workspace restore ID` | Restore the working tree to a checkpoint. |

## Heists (sessions)

| Command | Description |
|---|---|
| `session list` | Recent heists with model and status. |
| `session show ID` | Full transcript, including tool calls. |
| `session new [TITLE]` | Create an empty heist. |
| `session rename ID TITLE…` | Rename a heist. |
| `session delete ID` | Delete a heist and its messages. |
| `session runs ID` | Runs inside one heist. |
| `session export ID` | Export session, messages and runs as JSON. `--out FILE` writes to disk. |

## Arsenal

| Command | Description |
|---|---|
| `tools list` | The native tool catalogue. `--category NAME`, `--search QUERY`. |
| `tools show NAME` | Descriptor plus the full parameter schema. |
| `tools run NAME JSON` | Execute a tool directly. `--args JSON` or `--file PATH` for large payloads. |
| `skills list` | Bundled, user and workspace skills. `--search QUERY`. |
| `skills show NAME` | Load and print a skill body. |

## MCP network

| Command | Description |
|---|---|
| `mcp list` | Configured servers with live connection state. |
| `mcp connect NAME` | Connect and cache the server's tools. `--force` overrides `enabled: false`. |
| `mcp disconnect NAME` | Drop a connection. |
| `mcp tools NAME` | Tools a connected server exposes. |
| `mcp call QUALIFIED_NAME JSON` | Call one MCP tool (`mcp__server__tool`). |
| `mcp add NAME --command "…"` | Register a stdio server. |
| `mcp add NAME --url URL` | Register a streamable HTTP server. `--env JSON` supplies headers or environment. |
| `mcp remove NAME` | Remove a definition. |
| `mcp registry [QUERY]` | Search the official MCP registry. |
| `mcp install REGISTRY_NAME` | Install from the registry. `--prefer remote\|package`. |

## Mod shop

| Command | Description |
|---|---|
| `plugins list` | Installed capability packs. |
| `plugins install SOURCE` | Install from a path, git URL or npm package. `--kind`, `--name`. |
| `plugins activate NAME` / `deactivate NAME` / `reload [NAME]` | Lifecycle control. |
| `plugins scaffold NAME` | Generate a plugin skeleton. `--dir`, `--description`. |
| `automation list` | Scheduled automations and their next run. |
| `automation create NAME --schedule SPEC …` | Arm an agent run (`--prompt`), shell command (`--command`) or tool call (`--tool JSON`). `--paused` arms it disabled. |
| `automation run ID` | Execute immediately. |
| `automation pause ID` / `resume ID` / `delete ID` | Lifecycle control. |
| `browser list` | Running browser instances. |
| `browser launch` | Launch a persistent Chrome profile. `--profile`, `--url`, `--headed`. |
| `browser tabs [ID]` / `browser close [ID]` | Tab and instance control. |

## Inventory and diagnostics

| Command | Description |
|---|---|
| `models [--discover]` | Providers and their models. |
| `lsp [--force]` | Discover and list language servers. |
| `bridges [--force]` | Coding-agent CLIs MaskShift can delegate to. |
| `ps [--running]` | Background processes MaskShift started. |
| `logs [--limit N]` | Tail the MaskShift log. |
| `events [--limit N] [--follow]` | Recent runtime events, optionally following the live bus. |
| `config show` / `get KEY` / `set KEY VALUE` / `path` | Read and write configuration. Dotted keys work: `config set indexing.embeddings false`. |

## Scripting

`--json` makes every command pipeable:

```bash
maskshift tools list --json | jq -r '.[] | select(.readOnly == false) | .name'
maskshift run "upgrade the lockfile" --json | jq -r .status
maskshift mcp list --json | jq -r '.[] | select(.status == "available") | .name' \
  | xargs -n1 maskshift mcp connect
```

`maskshift daemon` keeps automations firing without any interface; the bundled
systemd user unit in `deploy/maskshift.service` runs exactly that.
