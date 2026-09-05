# MaskShift 1.0.0 Release Verification

Verification date: 2026-09-02

## Automated release gate

`npm run verify` completed successfully:

- JavaScript syntax validation: **60 modules passed**.
- Native integration suite: **9 tests passed, 0 failed**.
- Full daemon/API/model smoke test: **passed**.
- Mock model interaction: **two turns**, including a real native `fs_write` tool call.
- Autonomous run state: **completed**.
- Host terminal verification: **passed**.
- Runtime inventory: **143 native tools, 36 bundled skills, eight curated MCP starters**.

The integration suite covers configuration isolation, SQLite/FTS memory, nullable automation updates, modern stateless MCP, legacy initialized MCP, lazy qualified MCP dispatch, host filesystem/shell tools, repository indexing, trusted plugin hot loading, one-shot automation cleanup, clean-repository Git checkpoint restoration, the CLI command surface, the terminal renderer, and the model/tool loop.

## Distribution checks

- Installer clean install: passed.
- Installer upgrade with stale-file removal: passed.
- Installer path quoting, including spaces: passed.
- Installed `maskshift --version`: passed without Node warning noise.
- Installer uninstall: passed.
- Example telemetry plugin install, activation, and direct execution: passed.
- Generated capability manifest contains portable paths only.
- Documentation-local link validation: passed.
- Secret-pattern and transient-state scan: clean.
- `compose.yaml` parse: passed.
- Dockerfile static assertions: passed. A container image was not built in the release environment because no Docker or Podman daemon was available.

## Terminal interface QA

The interface is verified by rendering real frames against a synthetic terminal.
`tests/tui.test.mjs` paints all six views, all four rail sections and all eleven
overlays at 132×36, then repaints at 72×20, asserting that every row is exactly
the terminal width and that the frame is exactly the terminal height — the
renderer's equivalent of "no horizontal overflow". The same assertions run inside
`npm run smoke` against a completed agent run.

Colour degradation (truecolor, 256-colour, 16-colour, `NO_COLOR`) and the raw-mode
key decoder (control keys, CSI sequences, modifiers, bracketed paste) have direct
unit coverage.

## Operational boundary

MaskShift 1.0.0 is intentionally permissive. The default loopback daemon exposes host-level execution to the model and does not prompt before each tool call. Provider keys, OAuth grants, SSH credentials, cloud sessions, external coding-agent CLIs, and credential-gated MCP servers are not bundled and must be supplied by the operator.
