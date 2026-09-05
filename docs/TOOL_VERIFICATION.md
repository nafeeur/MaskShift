# Tool verification — 2026-09-05

Verified from base commit `1590a5cb85e144d321b8f24081a3434329b2262e`, with the fixes in this branch, on Linux / Node.js v24.19.0.

## Results

- `npm run verify`: syntax checks passed; **68 tests passed, 0 failed, 2 skipped**; end-to-end smoke test passed.
- `npm run test:tools`: **23 tests passed, 0 failed, 0 skipped** on this host.
- **148 / 148 native tools** invoked through `ToolRegistry.execute` with result assertions. This is tool-entry coverage, not complete branch coverage or proof of every live integration.
- Installer exercised with a disposable prefix; the installed CLI's `tools list --json` returned 148 tools.
- Smoke test completed a two-turn agent run against a deterministic local model endpoint, verified its output file with a real shell command, and painted all six terminal views.
- The existing live Chromium and pyright tests were skipped because those executables are not installed.

No live cloud model, external coding agent, remote SSH host, Docker/Podman daemon, Kubernetes cluster, external database service, or systemd service was exercised. Browser contract tests verify argument forwarding and result propagation only; they do not execute Chrome or CDP. LSP and MCP tests use real child-process transports with deterministic protocol fixture servers. Registry/search tests use fixture HTTP responses. No paid model calls were made.

## Reproduce

```sh
npm run verify
npm run test:tools
MASKSHIFT_TOOL_REPORT=/tmp/maskshift-tool-report.json npm run test:tools
```

Node.js 22+ and Git are required. To execute every local integration scenario, install ripgrep, Python 3, tar, rsync, pdftotext, and at least one of ss/lsof/netstat. Optional host dependencies are explicitly skipped and labeled `SKIPPED` in the generated tool report when unavailable. Fixture tests do not need service credentials. Node 22 itself was not tested in this run.

The coverage gate fails if a new native tool lacks a successful assertion or an explicit dependency skip. Results distinguish real local execution, protocol/CLI fixtures, and browser manager contracts. A passing gate with skips is not full execution coverage; inspect the report.

## Confirmed defects fixed

Each of these six regressions failed on the original code and passed after its fix:

1. **File moves overwrote existing destinations by default.** Respect `overwrite: false`; preserve the source and destination on rejection. Also preserve same-path moves and validate the source before removing an overwrite target.
2. **Project trees ignored the requested subdirectory.** Translate the public `path` argument into the workspace manager's `target` argument.
3. **Explicit executable paths were not discovered.** Resolve explicit paths directly and reject executable directories; custom Node/Python paths can now work.
4. **File searches treated zero matches as an error.** Accept ripgrep exit code 1 while continuing to reject actual command failures.
5. **Web fetching did not apply its documented automatic mode by default.** Detect JSON and readable HTML when `mode` is omitted.
6. **LSP workspace edits failed on encoded filenames.** Decode file URIs correctly for both `changes` and `documentChanges`, including spaces and Unicode.

## Coverage levels

| Verification level | Tools |
| --- | ---: |
| CLI adapter fixture; live service untested | 12 |
| HTTP response fixture | 3 |
| local CLI fixture | 4 |
| local integration | 93 |
| local model fixture | 4 |
| manager contract fixture; live browser untested | 17 |
| stdio protocol fixture | 15 |

Local integration includes discovery and state inspection; a successful discovery result does not imply the discovered integration is installed or operational. The 93 local tools include those discovery/state operations. The remaining 55 tools use fixtures at the levels listed above.

## Per-tool results

All rows below passed on this host. The verification level states what was actually tested.

| Tool | Category | Verification level |
| --- | --- | --- |
| `agent_bridge_discover` | agent-bridge | local CLI fixture |
| `agent_bridge_help` | agent-bridge | local CLI fixture |
| `agent_bridge_run` | agent-bridge | local CLI fixture |
| `external_agent_run` | agent-bridge | local CLI fixture |
| `archive_create` | artifacts | local integration |
| `archive_extract` | artifacts | local integration |
| `file_hash` | artifacts | local integration |
| `automation_create` | automation | local integration |
| `automation_delete` | automation | local integration |
| `automation_list` | automation | local integration |
| `automation_pause` | automation | local integration |
| `automation_resume` | automation | local integration |
| `automation_run_now` | automation | local integration |
| `automation_update` | automation | local integration |
| `browser_accessibility` | browser | manager contract fixture; live browser untested |
| `browser_click` | browser | manager contract fixture; live browser untested |
| `browser_close` | browser | manager contract fixture; live browser untested |
| `browser_close_tab` | browser | manager contract fixture; live browser untested |
| `browser_console` | browser | manager contract fixture; live browser untested |
| `browser_discover` | browser | local integration |
| `browser_evaluate` | browser | manager contract fixture; live browser untested |
| `browser_instances` | browser | manager contract fixture; live browser untested |
| `browser_launch` | browser | manager contract fixture; live browser untested |
| `browser_navigate` | browser | manager contract fixture; live browser untested |
| `browser_network` | browser | manager contract fixture; live browser untested |
| `browser_new_tab` | browser | manager contract fixture; live browser untested |
| `browser_print_pdf` | browser | manager contract fixture; live browser untested |
| `browser_screenshot` | browser | manager contract fixture; live browser untested |
| `browser_snapshot` | browser | manager contract fixture; live browser untested |
| `browser_tabs` | browser | manager contract fixture; live browser untested |
| `browser_type` | browser | manager contract fixture; live browser untested |
| `browser_wait_for` | browser | manager contract fixture; live browser untested |
| `lsp_definition` | code-intelligence | stdio protocol fixture |
| `lsp_diagnostics` | code-intelligence | stdio protocol fixture |
| `lsp_discover` | code-intelligence | local integration |
| `lsp_format` | code-intelligence | stdio protocol fixture |
| `lsp_hover` | code-intelligence | stdio protocol fixture |
| `lsp_references` | code-intelligence | stdio protocol fixture |
| `lsp_rename` | code-intelligence | stdio protocol fixture |
| `lsp_status` | code-intelligence | stdio protocol fixture |
| `lsp_stop` | code-intelligence | stdio protocol fixture |
| `lsp_symbols` | code-intelligence | stdio protocol fixture |
| `container_build` | containers | CLI adapter fixture; live service untested |
| `container_compose` | containers | CLI adapter fixture; live service untested |
| `container_engine` | containers | CLI adapter fixture; live service untested |
| `container_exec` | containers | CLI adapter fixture; live service untested |
| `container_list` | containers | CLI adapter fixture; live service untested |
| `container_logs` | containers | CLI adapter fixture; live service untested |
| `container_run` | containers | CLI adapter fixture; live service untested |
| `container_stop` | containers | CLI adapter fixture; live service untested |
| `kubernetes_exec` | containers | CLI adapter fixture; live service untested |
| `database_cli` | database | CLI adapter fixture; live service untested |
| `sqlite_query` | database | local integration |
| `sqlite_schema` | database | local integration |
| `notebook_edit` | documents | local integration |
| `notebook_read` | documents | local integration |
| `pdf_read` | documents | local integration |
| `fs_apply_patch` | filesystem | local integration |
| `fs_delete` | filesystem | local integration |
| `fs_list` | filesystem | local integration |
| `fs_mkdir` | filesystem | local integration |
| `fs_move` | filesystem | local integration |
| `fs_patch` | filesystem | local integration |
| `fs_read` | filesystem | local integration |
| `fs_read_binary` | filesystem | local integration |
| `fs_stat` | filesystem | local integration |
| `fs_write` | filesystem | local integration |
| `git_branch` | git | local integration |
| `git_checkpoint_create` | git | local integration |
| `git_checkpoint_list` | git | local integration |
| `git_checkpoint_restore` | git | local integration |
| `git_commit` | git | local integration |
| `git_diff` | git | local integration |
| `git_log` | git | local integration |
| `git_show` | git | local integration |
| `git_status` | git | local integration |
| `git_worktree_create` | git | local integration |
| `mcp_add` | mcp | local integration |
| `mcp_call` | mcp | stdio protocol fixture |
| `mcp_connect` | mcp | stdio protocol fixture |
| `mcp_disconnect` | mcp | stdio protocol fixture |
| `mcp_list` | mcp | local integration |
| `mcp_prompts` | mcp | stdio protocol fixture |
| `mcp_registry_install` | mcp | HTTP response fixture |
| `mcp_registry_search` | mcp | HTTP response fixture |
| `mcp_resource_read` | mcp | stdio protocol fixture |
| `mcp_resources` | mcp | stdio protocol fixture |
| `mcp_search` | mcp | local integration |
| `memory_delete` | memory | local integration |
| `memory_list` | memory | local integration |
| `memory_optimize` | memory | local integration |
| `memory_save` | memory | local integration |
| `memory_search` | memory | local integration |
| `agent_cancel` | orchestration | local model fixture |
| `agent_delegate` | orchestration | local model fixture |
| `agent_parallel` | orchestration | local model fixture |
| `agent_run_status` | orchestration | local model fixture |
| `capability_activate` | orchestration | local integration |
| `capability_search` | orchestration | local integration |
| `capability_state` | orchestration | local integration |
| `plan_get` | orchestration | local integration |
| `plan_update` | orchestration | local integration |
| `plugin_activate` | plugins | local integration |
| `plugin_deactivate` | plugins | local integration |
| `plugin_install` | plugins | local integration |
| `plugin_list` | plugins | local integration |
| `plugin_reload` | plugins | local integration |
| `plugin_scaffold` | plugins | local integration |
| `plugin_scan` | plugins | local integration |
| `project_index_status` | project | local integration |
| `project_inspect` | project | local integration |
| `project_instructions` | project | local integration |
| `project_read_manifest` | project | local integration |
| `project_tree` | project | local integration |
| `provider_list` | project | local integration |
| `session_history` | project | local integration |
| `usage_report` | project | local integration |
| `rsync_transfer` | remote | local integration |
| `ssh_exec` | remote | CLI adapter fixture; live service untested |
| `node_cell` | runtimes | local integration |
| `python_cell` | runtimes | local integration |
| `dependency_scan` | search | local integration |
| `repo_index` | search | local integration |
| `repo_search` | search | local integration |
| `search_files` | search | local integration |
| `search_text` | search | local integration |
| `symbol_outline` | search | local integration |
| `command_lookup` | shell | local integration |
| `shell_exec` | shell | local integration |
| `shell_exec_parallel` | shell | local integration |
| `shell_process_list` | shell | local integration |
| `shell_process_read` | shell | local integration |
| `shell_process_stop` | shell | local integration |
| `shell_process_write` | shell | local integration |
| `shell_start` | shell | local integration |
| `system_info` | shell | local integration |
| `skill_create` | skills | local integration |
| `skill_improve` | skills | local integration |
| `skill_load` | skills | local integration |
| `skill_read_reference` | skills | local integration |
| `skill_search` | skills | local integration |
| `environment_list` | system | local integration |
| `environment_set` | system | local integration |
| `port_inspect` | system | local integration |
| `system_service` | system | CLI adapter fixture; live service untested |
| `web_download` | web | local integration |
| `web_fetch` | web | local integration |
| `web_search` | web | HTTP response fixture |
