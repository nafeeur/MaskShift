## What this changes and why

## Checklist

- [ ] `npm run verify` passes locally (`check` + `test` + `smoke`)
- [ ] New or changed tools have precise `inputSchema`s and correct `category`/`readOnly`/`risk`
- [ ] Regression coverage added for any fixed defect
- [ ] Lazy capability loading preserved — no new always-in-context catalog additions without reason
- [ ] Docs updated (`docs/TOOLS.md`/`docs/SKILLS.md` via `npm run docs`, `docs/CONFIGURATION.md`, `docs/CLI.md`, or `README.md`) if externally visible behavior changed
- [ ] TUI still renders at 80×24 and at a wide terminal, if the interface changed

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the full expectations this project holds changes to.
