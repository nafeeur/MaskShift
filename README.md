<p align="center">
  <img width="150" height="150" alt="MaskShift" src="https://github.com/user-attachments/assets/137393bb-7576-4edd-ac4d-78e19a0215a2" />
</p>

<h1 align="center">MaskShift</h1>

<p align="center">
  <strong>A maximalist, model-agnostic coding harness for the terminal.</strong><br>
  Every tool at the model's disposal — only the ones it needs in its context.
</p>

<p align="center">
  <img alt="npm version" src="https://img.shields.io/npm/v/maskshift?style=flat-square&color=cb3837">
  <img alt="npm downloads" src="https://img.shields.io/npm/dt/maskshift?style=flat-square&color=cb3837&label=downloads">
  <img alt="Node 22+" src="https://img.shields.io/badge/node-%E2%89%A522-3ecf8e?style=flat-square">
  <img alt="Runtime dependencies: none" src="https://img.shields.io/badge/runtime%20deps-0-4aa8ff?style=flat-square">
  <img alt="149 tools" src="https://img.shields.io/badge/tools-149-2bd9c0?style=flat-square">
  <img alt="50 skills" src="https://img.shields.io/badge/skills-50-a78bfa?style=flat-square">
  <img alt="GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-e5384f?style=flat-square">
</p>

![MaskShift interface](docs/screenshots/heist.svg)

MaskShift gives a coding model one control plane for repository understanding, file edits, the
host shell, Git recovery, language servers, browsers, containers, databases, remote machines,
memory, scheduled work, plugins, external coding agents, skills and MCP servers. The full
catalog is always available to the harness; only the capabilities relevant to the current step
are inserted into model context.

It runs on Node.js 22 using only built-in modules — the interface renderer included. No npm
runtime dependency tree, no HTTP server, no browser, no listening socket.

---

## Contents

[Features](#features) · [Install](#install) · [Run it with Ollama](#run-it-with-ollama) ·
[Configure](#configure) · [The interface](#the-interface) · [The command line](#the-command-line) ·
[Documentation](#documentation) · [Development](#development) · [Deployment](#deployment)

## Features

| | |
|---|---|
| **149 native tools** | Filesystem, shell and process control, search and indexing, Git worktrees and checkpoints, LSP, browsers over CDP, containers and Kubernetes, SSH and rsync, databases, runtimes, images, PDF and Jupyter, web retrieval, plugins, automations, memory and orchestration. → [tool inventory](docs/TOOLS.md) |
| **50 bundled skills** | Loaded lazily by description, including 14 Apache-2.0 skills imported from Anthropic, alongside skills from Claude, Codex, Copilot and workspace directories. → [skills](docs/SKILLS.md) |
| **Lazy MCP fabric** | stdio and Streamable HTTP, stateless and legacy initialization, resources, prompts, qualified tools, imported configs, and the live official MCP Registry. Servers connect on demand, so the catalog never floods the context window. → [MCP config](docs/CONFIGURATION.md#mcp-definitions) |
| **Any model** | Ollama, OpenAI Responses, OpenAI-compatible servers, Anthropic, Gemini, OpenRouter, LM Studio and vLLM — with a text protocol that gives models *without* a native tool API the full tool surface. → [providers](docs/CONFIGURATION.md#providers) |
| **Autonomous repo context** | Project instructions, manifests, repository tree, indexed code chunks (lexical plus optional semantic retrieval), stored memory, recent history and Git state. → [architecture](docs/ARCHITECTURE.md) |
| **Parallel agents** | Independent sessions and optional isolated Git worktrees for delegated work. |
| **Cost-aware** | Anthropic prompt-cache breakpoints on the stable prefix, decay- and access-aware memory ranking, and a `usage_report` tool that prices spend from a user-editable table — never a guessed number. |
| **Scheduled work** | Agent runs, direct tool calls or host shell commands on an interval, a cron expression or a one-shot timestamp. → [automations](docs/CONFIGURATION.md#automations) |
| **Extensible** | Plugins register tools, skill directories, MCP servers and event listeners in-process; bridges delegate scoped work to Claude Code, Codex, OpenCode, Copilot CLI, Hermes or Aider. → [extension boundary](docs/ARCHITECTURE.md#extension-boundary) |
| **Permissive by default** | `permissionMode: "overdrive"` — host filesystem scope, no per-command approval dialogs, and recovery through automatic checkpoints and an append-only audit log. → [read this first](docs/PERMISSIVE_MODE.md) |

## Install

**Requirements**

- Node.js 22 or newer
- A terminal at least 80×24 (UTF-8 and truecolour are used when available, and degraded cleanly when not)
- Git and ripgrep recommended
- Any instruction-following model through Ollama or another configured provider

**Install from npm**

```bash
npm install -g maskshift
cd /path/to/repository && maskshift
```

Or run it without installing anything:

```bash
npx maskshift --workspace /path/to/repository
```

**Or run from the source directory**

```bash
git clone https://github.com/nafeeur/MaskShift.git
cd MaskShift
./start.sh --workspace /path/to/repository
```

**Or install to your user account from source**

```bash
./install.sh
cd /path/to/repository && maskshift
```

The installer copies MaskShift to `~/.local/lib/maskshift` and links `~/.local/bin/maskshift`.
It does not run `npm install`, because there is nothing to install — MaskShift has zero runtime dependencies.

## Run it with Ollama

MaskShift's default model reference is `ollama:auto`: it discovers your installed Ollama models
and prefers the strongest coding-oriented one it finds.

```bash
# 1. Pull a coding model
ollama pull qwen3-coder:latest

# 2. Point MaskShift at Ollama and pick the model
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export MASKSHIFT_MODEL=ollama:qwen3-coder:latest

# 3. Open the interface on a repository
./start.sh --workspace ~/code/my-project
```

Type a task into the composer and press `↵`. To run one task headlessly instead:

```bash
./start.sh run "Map this repository, repair the highest-impact defect, add tests, and verify." \
  --workspace ~/code/my-project \
  --model ollama:qwen3-coder:latest
```

A remote Ollama host works the same way — set `OLLAMA_BASE_URL=http://model-host:11434`.

If a model has no native tool API, MaskShift detects it on the first request and switches to an
in-prompt text protocol, so the whole harness still works.
→ [models without native tool calling](docs/CONFIGURATION.md#models-without-native-tool-calling)

## Configure

Model references are `provider:model`:

```text
ollama:auto                 openai:<model-id>            anthropic:<model-id>
lmstudio:auto               openrouter:provider/model    gemini:<model-id>
vllm:auto
```

Cloud providers read their keys from the environment:

```bash
export OPENAI_API_KEY=...      export ANTHROPIC_API_KEY=...
export OPENROUTER_API_KEY=...  export GEMINI_API_KEY=...
```

Everything else lives in `~/.maskshift/config.json` — providers, MCP servers, agent bridges,
hooks, indexing, memory ranking, automations and interface preferences. Press `f2` in the
interface to edit the core settings without touching the file, or use `maskshift config set`.

→ [full configuration reference](docs/CONFIGURATION.md) ·
[environment variables](docs/CONFIGURATION.md#environment-variables) ·
[data locations](docs/CONFIGURATION.md#data-locations)

## The interface

`maskshift` opens a full-screen terminal application built on a bespoke, zero-dependency
renderer, driven equally by keyboard and mouse. Six views switch with `1`–`6`, `ctrl+b` toggles
the right rail, and `ctrl+k` opens a fuzzy command palette over every action.

| View | Holds |
|---|---|
| **01 HEIST** | Transcript and composer — markdown, syntax-tinted code, coloured diffs, live tool calls |
| **02 FILES** | Workspace tree with a syntax-highlighted preview |
| **03 ARSENAL** | Every native tool and skill, searchable, with parameter schemas — and `x` to run one yourself |
| **04 NETWORK** | MCP servers: bundled, workspace-configured, or pulled live from the official registry |
| **05 MOD SHOP** | Automations, plugins, agent bridges, browser profiles and background processes |
| **06 TERMINAL** | The host shell |

<table>
<tr>
<td width="50%"><img width="100%" alt="Tools and skills catalogue" src="docs/screenshots/arsenal.svg"><br><sub><b>03 ARSENAL</b> — see exactly what a run can reach before it uses it</sub></td>
<td width="50%"><img width="100%" alt="MCP network" src="docs/screenshots/network.svg"><br><sub><b>04 NETWORK</b> — connect a server on demand</sub></td>
</tr>
<tr>
<td width="50%"><img width="100%" alt="Command palette" src="docs/screenshots/palette.svg"><br><sub><b>ctrl+k</b> — every action, nothing buried behind a memorised key</sub></td>
<td width="50%"><img width="100%" alt="Live loadout telemetry" src="docs/screenshots/loadout.svg"><br><sub><b>The rail</b> — plan, loadout telemetry, event bus, Git pulse</sub></td>
</tr>
</table>

Below 108 columns the rail hides itself and the header sheds telemetry, so the same six views
work in a narrow split pane. `MASKSHIFT_MOUSE=off` (or `f2`) hands text selection back to the
terminal, and `NO_COLOR`, `MASKSHIFT_COLOR=off` and `MASKSHIFT_ASCII=1` each produce a clean,
aligned fallback.

→ [keys, views and the design system](docs/TUI.md)

## The command line

Everything the interface can do is also a subcommand, and every subcommand takes `--json`:

```bash
maskshift run "make the failing tests pass"      # one headless run, streamed
maskshift tools run shell_exec '{"command":"npm test"}'
maskshift mcp registry playwright && maskshift mcp install io.github.microsoft/playwright-mcp
maskshift automation create nightly --schedule "every 6h" --prompt "Review the diff and fix regressions"
maskshift workspace search "checkpoint restore" --json | jq -r '.[].path'
maskshift doctor
```

```text
maskshift [tui] [PROMPT]     open the interface (the default command)
maskshift run "PROMPT"       one headless run, streamed to stdout
maskshift daemon             resident automation scheduler, no interface
maskshift doctor             environment and provider diagnostics
maskshift <workspace|session|tools|skills|mcp|plugins|automation|browser|config> ...
```

Global flags: `--workspace PATH`, `--model REF`, `--config PATH`, `--json`, `--no-color`.

→ [full command reference](docs/CLI.md)

## Documentation

| Document | Covers |
|---|---|
| [Configuration](docs/CONFIGURATION.md) | Every setting, provider, MCP definition, hook, automation and data location |
| [Tools](docs/TOOLS.md) | The complete native tool inventory |
| [Skills](docs/SKILLS.md) | Bundled skills, and where MaskShift looks for more |
| [Interface](docs/TUI.md) | Keys, views, the design system and its rules |
| [Command line](docs/CLI.md) | Every subcommand and flag |
| [Architecture](docs/ARCHITECTURE.md) | The agent loop, lazy capability fabric, persistence and extension boundary |
| [Permissive execution](docs/PERMISSIVE_MODE.md) | What overdrive means, what stays observable, and where the limits are |
| [Tool verification](docs/TOOL_VERIFICATION.md) | Per-tool coverage and live-integration limits |
| [Release verification](docs/RELEASE-VERIFICATION.md) | What the automated suite covers before a release |

## Development

```bash
npm run check       # syntax validation across every source module
npm test            # unit and integration suite, including renderer tests
npm run test:tools  # all-native-tool scenarios and edge-case regressions
npm run smoke       # end-to-end agent run plus a full interface paint
npm run verify      # check + tests + smoke
npm run docs        # regenerate the tool and skill inventories
npm run capture     # regenerate docs/screenshots from the real renderer
```

The screenshots above are produced by `npm run capture` through the same code path the terminal
uses, so they cannot drift from the product.

## Deployment

- **`deploy/maskshift.service`** — user-level systemd unit running `maskshift daemon` for
  scheduled automations, with no interface.
- **`Dockerfile` / `compose.yaml`** — `/workspace` and `/data` volumes. MaskShift is a terminal
  application, so attach a TTY: `docker run -it`, or `docker compose run --rm maskshift`.

A container limits MaskShift to the files, sockets, devices and credentials mounted into it.
For full host authority, run the user service directly instead.

## License

[GNU General Public License v3.0](LICENSE).
