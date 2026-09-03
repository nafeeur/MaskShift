# Native Tool Inventory

Generated from the MaskShift 1.0.0 runtime. **148 native tools** are available before plugins or MCP servers add more capabilities.

Only activated descriptors enter a model request; this document is the complete local catalog.

## agent-bridge (4)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `agent_bridge_discover` | read | normal | Detect locally installed Claude Code, Codex, OpenCode, Copilot, Hermes, Aider, and configured coding-agent CLIs. |
| `agent_bridge_help` | read | normal | Read the installed command help for an external coding-agent bridge before delegating. |
| `agent_bridge_run` | write | host-exec | Run an installed Claude Code, Codex, OpenCode, Copilot, Hermes, Aider, or configured agent against the current workspace. Can wait or return a persistent process. |
| `external_agent_run` | write | host-exec | Execute any configured or ad-hoc coding-agent command with placeholder arguments such as {prompt}, {cwd}, and {workspace}. |

## artifacts (3)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `archive_create` | write | write | Create tar.gz, tar.zst, tar, or zip archives from arbitrary host paths. |
| `archive_extract` | write | write | Extract zip, tar.gz, tar.zst, tar, and common compressed archives. |
| `file_hash` | read | normal | Calculate SHA-256, SHA-512, SHA-1, or MD5 for a file without loading it all into model context. |

## automation (7)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `automation_create` | write | persistent-exec | Schedule a recurring or one-time autonomous agent prompt, tool call, or unrestricted shell command. Schedules accept cron, ISO timestamps, or strings like every 15m. |
| `automation_delete` | write | write | Permanently remove a scheduled automation. |
| `automation_list` | read | normal | List scheduled agent, tool, and shell automations with next/last run state. |
| `automation_pause` | write | persistent-exec | Disable an automation without deleting it. |
| `automation_resume` | write | persistent-exec | Enable an automation and compute its next run. |
| `automation_run_now` | write | host-exec | Immediately execute an automation regardless of its next scheduled time. |
| `automation_update` | write | persistent-exec | Edit an automation schedule, action, name, metadata, or enabled state. |

## browser (18)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `browser_accessibility` | read | normal | Return the Chrome accessibility tree for semantic page understanding. |
| `browser_click` | write | external-action | Click a CSS selector or page coordinate through the Chrome input pipeline. |
| `browser_close` | write | process | Terminate a MaskShift browser instance and its CDP connections. |
| `browser_close_tab` | write | process | Close one browser page target. |
| `browser_console` | read | normal | Read recent console messages, exceptions, and browser log entries from the page. |
| `browser_discover` | read | normal | Detect an installed Chromium, Chrome, or Edge executable for dependency-free CDP automation. |
| `browser_evaluate` | write | external-action | Execute arbitrary JavaScript in the active page and return a serializable value. |
| `browser_instances` | read | normal | List browser processes launched by MaskShift. |
| `browser_launch` | write | process | Launch a persistent-profile Chromium browser with DevTools automation. Headless by default; visible mode supports interactive logins. |
| `browser_navigate` | write | network | Navigate a browser tab and wait for the document to load. |
| `browser_network` | read | normal | Read recent Chrome DevTools Network events for the page. |
| `browser_new_tab` | write | network | Create a new browser tab at a URL. |
| `browser_print_pdf` | read | normal | Render the current browser page to a PDF artifact using Chrome print layout. |
| `browser_screenshot` | read | normal | Capture a viewport or full-page screenshot to a workspace artifact file. |
| `browser_snapshot` | read | normal | Return page title, URL, visible text, and a selector map of interactive elements. |
| `browser_tabs` | read | normal | List all page targets in a browser instance. |
| `browser_type` | write | external-action | Focus an optional CSS selector, type text, and optionally submit with Enter. |
| `browser_wait_for` | read | normal | Wait for a CSS selector to become visible, hidden, attached, or detached. |

## code-intelligence (10)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `lsp_definition` | read | normal | Resolve the definition location for a symbol at a source position. |
| `lsp_diagnostics` | read | normal | Return language-server errors, warnings, hints, and related information for a file. |
| `lsp_discover` | read | normal | Detect installed language servers for TypeScript, Python, C/C++, Rust, Go, Java, Ruby, Lua, JSON, HTML, CSS, and YAML. |
| `lsp_format` | write | write | Ask the language server to format a document and optionally apply the edits. |
| `lsp_hover` | read | normal | Get type, signature, and documentation information at a 1-based source position. |
| `lsp_references` | read | normal | Find language-aware references for a symbol at a source position. |
| `lsp_rename` | write | write | Compute and optionally apply a workspace-wide language-aware symbol rename. |
| `lsp_status` | read | normal | List active workspace language server processes and capabilities. |
| `lsp_stop` | write | process | Stop one or all lazy language server processes for the workspace. |
| `lsp_symbols` | read | normal | Return language-server document symbols and hierarchy for a source file. |

## containers (9)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `container_build` | write | host-exec | Build a Docker/Podman image from a Dockerfile or Containerfile with build args and tags. |
| `container_compose` | write | host-exec | Run Docker Compose or Podman Compose actions such as up, down, build, logs, ps, and config. |
| `container_engine` | read | normal | Detect Docker or Podman and return version and runtime information. |
| `container_exec` | write | host-exec | Execute a command in an existing Docker/Podman container. |
| `container_list` | read | normal | List running or stopped Docker/Podman containers as structured records. |
| `container_logs` | read | normal | Read recent container logs with timestamps, tail, and since controls. |
| `container_run` | write | host-exec | Run any Docker/Podman image with ports, volumes, environment, network, privilege, and detach controls. |
| `container_stop` | write | host-exec | Stop, kill, restart, pause, unpause, or remove a container. |
| `kubernetes_exec` | write | remote-exec | Execute any kubectl operation with a structured argument list and optional context, namespace, and kubeconfig. |

## database (3)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `database_cli` | write | database-write | Execute a command through psql, mysql, redis-cli, mongosh, duckdb, or another installed database client. |
| `sqlite_query` | write | database-write | Open any SQLite database directly through Node native SQLite, execute parameterized SQL, and return structured rows. Write statements are allowed. |
| `sqlite_schema` | read | normal | Return tables, views, indexes, triggers, and CREATE statements from a SQLite database. |

## documents (3)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `notebook_edit` | write | write | Replace, insert, or delete one cell in a Jupyter (.ipynb) notebook by index. Replacing or inserting a code cell clears its stale outputs and execution count. |
| `notebook_read` | read | normal | Read a Jupyter (.ipynb) notebook and return each cell's index, type, source, and a bounded summary of its outputs. |
| `pdf_read` | read | normal | Extract text from a PDF using pdftotext (poppler-utils), with optional page range and layout preservation. |

## filesystem (10)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `fs_apply_patch` | write | write | Apply a unified diff using git apply. The patch can update multiple files and is checked before application. |
| `fs_delete` | write | destructive | Delete a file or directory recursively. Overdrive mode executes immediately without an approval prompt. |
| `fs_list` | read | normal | List a directory tree with file sizes and types. Paths may be workspace-relative or absolute in overdrive mode. |
| `fs_mkdir` | write | write | Create a directory and missing parent directories. |
| `fs_move` | write | write | Move or rename a file or directory, optionally replacing the destination. |
| `fs_patch` | write | write | Apply one or more exact oldText/newText replacements to a file atomically. Fails on missing or ambiguous text unless replaceAll is requested. |
| `fs_read` | read | normal | Read a UTF-8 text file with optional 1-based line range and hard output bounds. |
| `fs_read_binary` | read | normal | Read a bounded binary file as base64 with MIME-relevant metadata. |
| `fs_stat` | read | normal | Return file type, size, timestamps, mode, target and hash metadata. |
| `fs_write` | write | write | Create or overwrite a file atomically. Parent directories are created automatically. |

## git (10)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `git_branch` | write | write | List, create, switch, rename, or delete branches. MaskShift runs these directly without permission prompts. |
| `git_checkpoint_create` | write | local-snapshot | Snapshot tracked and untracked workspace changes so an agent run can be rolled back without interrupting normal Git history. |
| `git_checkpoint_list` | read | normal | List reversible MaskShift workspace checkpoints. |
| `git_checkpoint_restore` | write | destructive | Restore a prior MaskShift checkpoint. This is destructive to current workspace changes. |
| `git_commit` | write | write | Stage selected or all changes and create a commit. Optional amend and no-verify modes are supported. |
| `git_diff` | read | normal | Show working-tree, staged, commit-range, or selected-file diffs with configurable context and output bounds. |
| `git_log` | read | normal | Read compact commit history, optionally for a branch, range, author, grep expression, or path. |
| `git_show` | read | normal | Show a commit, tag, tree, or file at a revision. |
| `git_status` | read | normal | Inspect branch, upstream, staged, modified, deleted, renamed, conflicted, and untracked files. |
| `git_worktree_create` | write | write | Create a branch-backed Git worktree for isolated subagent or experimental work. |

## mcp (11)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `mcp_add` | write | install | Add any stdio or HTTP MCP server definition, including command, arguments, environment, URL, headers, and lazy loading settings. |
| `mcp_call` | write | external-tool | Invoke a connected MCP tool directly. Prefer activating its qualified tool so the model can call it natively on later turns. |
| `mcp_connect` | write | external-connect | Lazily start or connect an MCP server, negotiate modern or legacy protocol, and discover its tools. |
| `mcp_disconnect` | write | external-connect | Close a workspace-scoped MCP connection and unload its tool schemas. |
| `mcp_list` | read | normal | List curated, imported, project, and configured MCP servers with live connection status and tool counts. |
| `mcp_prompts` | read | normal | List prompt templates provided by an MCP server. |
| `mcp_registry_install` | write | install | Resolve a server from the official registry and add its remote or package transport to MaskShift configuration. |
| `mcp_registry_search` | read | normal | Search the live official MCP Registry instead of relying on a stale built-in server list. |
| `mcp_resource_read` | read | normal | Read a URI exposed by an MCP server. |
| `mcp_resources` | read | normal | Connect to a server and list its MCP resources. |
| `mcp_search` | read | normal | Search discovered MCP servers and tools already known to MaskShift. Servers remain lazy until connected. |

## memory (5)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `memory_delete` | write | write | Delete a memory by ID. |
| `memory_list` | read | normal | List memories ordered by effective importance: raw importance blended with a recency decay so stale, untouched memories sink without being deleted. |
| `memory_optimize` | write | write | Find duplicate-title memories to merge and stale, low-importance, never-accessed memories to prune. Defaults to a dry run that only reports candidates; set dryRun to false to apply the merge and prune. |
| `memory_save` | write | write | Save a durable project or global fact, architectural decision, convention, result, or reusable lesson. Automatically merges into an existing memory with the same title in the same scope instead of creating a duplicate, unless dedupe is set to false. |
| `memory_search` | read | normal | Search project and global long-term memory, ranked by a blend of text relevance, importance, and recency (older, untouched memories decay in rank without being deleted). |

## orchestration (9)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `agent_cancel` | write | agent | Cancel a running subagent or other active MaskShift run. |
| `agent_delegate` | write | agent | Run a focused subagent with its own session and capability context. Optionally isolate editing in a Git worktree and branch. |
| `agent_parallel` | write | agent | Delegate multiple independent research, review, test, or implementation tasks concurrently and aggregate their final results. |
| `agent_run_status` | read | normal | Inspect active and recent agent runs, including parent/subagent relationships. |
| `capability_activate` | write | dynamic-load | Load selected capabilities into the current model context. Local tools add schemas, skills add instructions, and MCP servers connect lazily and expose their tools. |
| `capability_search` | read | normal | Search local tools, reusable skills, imported MCP servers, and discovered MCP tools. Use this whenever the current tool set is insufficient. |
| `capability_state` | read | normal | Show the exact tools, skills, and MCP servers currently loaded for this run. |
| `plan_get` | read | normal | Return the current run plan and progress. |
| `plan_update` | write | state | Create or update the run plan with concise steps and statuses. Use it for multi-step work and keep it synchronized with actual progress. |

## plugins (7)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `plugin_activate` | write | host-exec | Load a plugin directly into the MaskShift process with full tool registration access. |
| `plugin_deactivate` | write | process | Run a plugin cleanup hook and remove its registered tools. |
| `plugin_install` | write | host-exec | Install a plugin from a local directory, Git repository, or npm package and activate it. |
| `plugin_list` | read | normal | List discovered runtime plugins, their status, tools, and skill directories. |
| `plugin_reload` | write | host-exec | Deactivate and re-import one plugin, or every discovered plugin, without restarting MaskShift. |
| `plugin_scaffold` | write | write | Generate and activate a complete single-tool MaskShift plugin scaffold. |
| `plugin_scan` | write | host-exec | Rescan user and workspace plugin directories and activate newly discovered plugins. |

## project (8)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `project_index_status` | read | normal | Show local indexed file, chunk, character, and freshness statistics. |
| `project_inspect` | read | normal | Summarize repository shape, dominant languages, build manifests, instructions, Git state, and local index health. |
| `project_instructions` | read | normal | Load AGENTS.md, CLAUDE.md, MASKSHIFT.md, Copilot instructions, and other configured context files from repository root through the working directory. |
| `project_read_manifest` | read | normal | Read and optionally parse a package/build manifest such as package.json, pyproject.toml, Cargo.toml, go.mod, or CMakeLists.txt. |
| `project_tree` | read | normal | Render a bounded source tree for any workspace subdirectory. |
| `provider_list` | read | normal | Inspect configured model providers, connectivity status, and discovered models. |
| `session_history` | read | normal | Read messages and recent runs from the current MaskShift session. |
| `usage_report` | read | normal | Aggregate model token usage and estimated spend across recent runs, grouped by model, using the pricing table in config. Models without a configured price are reported as token counts only (priced:false), never guessed. |

## remote (2)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `rsync_transfer` | write | remote-exec | Synchronize local and remote files with rsync over SSH. |
| `ssh_exec` | write | remote-exec | Run a command on any SSH host with user, port, identity, jump host, environment, and timeout controls. |

## runtimes (2)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `node_cell` | write | host-exec | Execute arbitrary JavaScript as an ES module in a temporary script with workspace cwd. |
| `python_cell` | write | host-exec | Execute an arbitrary Python code cell in a temporary script with workspace cwd and return stdout/stderr. |

## search (6)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `dependency_scan` | read | normal | Inspect imports across selected source files and return a compact file-to-dependency graph without installing parsers. |
| `repo_index` | write | local-index | Build or refresh MaskShift’s local SQLite FTS code index for structure-aware context retrieval. |
| `repo_search` | read | normal | Search the local repository index using full-text ranking, blended with embedding-based semantic similarity when a local Ollama embedding model is available, and return bounded source chunks. |
| `search_files` | read | normal | Find files by fuzzy substring or glob across a workspace while respecting common repository ignores. |
| `search_text` | read | normal | Fast recursive source search using ripgrep when available, with regex, glob, case, hidden-file, and context controls. |
| `symbol_outline` | read | normal | Extract a lightweight outline of classes, functions, interfaces, structs, methods, and test blocks from source files. |

## shell (9)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `command_lookup` | read | normal | Find whether one or more commands are installed and return their executable paths. |
| `shell_exec` | write | host-exec | Run any Unix shell command on the host with the full user environment. Use for builds, tests, package managers, compilers, scripts, system inspection, and repository automation. |
| `shell_exec_parallel` | write | host-exec | Run multiple independent shell commands concurrently and return every result. |
| `shell_process_list` | read | normal | List processes launched by MaskShift, optionally limited to the current workspace or active processes. |
| `shell_process_read` | read | normal | Read current status and incremental output from a persistent process. |
| `shell_process_stop` | write | host-exec | Terminate a persistent process and its Unix process group. |
| `shell_process_write` | write | host-exec | Send text or control sequences to a persistent process stdin. |
| `shell_start` | write | host-exec | Start a persistent host process with live stdout/stderr streaming. Returns a process ID for later reads, input, or termination. |
| `system_info` | read | normal | Return operating system, CPU, memory, process, shell, runtime, and workspace information. |

## skills (5)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `skill_create` | write | write | Create a durable user skill from a successful workflow so future runs can discover it automatically. |
| `skill_improve` | write | write | Append a validated lesson or refinement to an existing skill. |
| `skill_load` | read | normal | Load the full instructions and metadata for a selected skill into the current run. |
| `skill_read_reference` | read | normal | Read a file referenced by a skill while preventing path escape from the skill directory. |
| `skill_search` | read | normal | Search all bundled, project, Claude, Codex, Copilot, and user skill catalogs. Skill bodies are loaded only when selected. |

## system (4)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `environment_list` | read | secrets | List process environment variable names and optionally values. MaskShift overdrive mode permits direct secret-bearing environment access. |
| `environment_set` | write | secrets | Set or delete environment variables for this running MaskShift daemon and future child processes. |
| `port_inspect` | read | normal | Inspect listening sockets and processes using ss, netstat, or lsof. |
| `system_service` | write | host-exec | Inspect, start, stop, restart, reload, enable, or disable a systemd service on the host. |

## web (3)

| Tool | Access | Risk | Description |
|---|---|---|---|
| `web_download` | write | write | Download an HTTP(S) response directly to a host or workspace file, creating parent directories. |
| `web_fetch` | read | normal | Fetch any HTTP(S) URL with custom method, headers, and body. Returns bounded text, JSON, or readable text extracted from HTML. |
| `web_search` | read | normal | Search the public web through Brave, Tavily, or Exa when an API key is configured, falling back to DuckDuckGo HTML otherwise. For specialized search, activate an MCP search provider. |

