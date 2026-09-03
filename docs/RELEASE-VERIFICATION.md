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

The integration suite covers configuration isolation, SQLite/FTS memory, nullable automation updates, modern stateless MCP, legacy initialized MCP, lazy qualified MCP dispatch, host filesystem/shell tools, repository indexing, trusted plugin hot loading, one-shot automation cleanup, clean-repository Git checkpoint restoration, the local HTTP API, and the model/tool loop.

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

## Browser cockpit QA

The live daemon was exercised in Chromium at 1920×1080, 1366×768, 900×900, and 412×915. The Run, Files, Loadout, MCP, Garage, and Settings views rendered without browser console errors or horizontal viewport overflow. Compact mode retained all primary navigation and session access.

Screenshots are retained under `docs/screenshots/`.

## Operational boundary

MaskShift 1.0.0 is intentionally permissive. The default loopback daemon exposes host-level execution to the model and does not prompt before each tool call. Provider keys, OAuth grants, SSH credentials, cloud sessions, external coding-agent CLIs, and credential-gated MCP servers are not bundled and must be supplied by the operator.
