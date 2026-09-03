# Contributing to MaskShift

MaskShift has a deliberately small runtime dependency surface. Keep the daemon and cockpit usable with Node.js 22 and built-in modules unless a dependency provides a substantial, measurable capability that cannot be implemented safely in the existing architecture.

Before submitting a change:

```bash
npm run verify
```

Core expectations:

- preserve lazy capability loading; do not inject the full catalog into every model request;
- add tools through a focused registration module and provide precise input schemas;
- mark tools with correct category, read-only state, and risk label even though overdrive does not prompt;
- bound model-facing output and include actionable errors;
- add regression coverage for fixed defects;
- keep the browser UI framework-free and responsive;
- avoid hiding failed operations behind optimistic UI state;
- document configuration and externally visible behavior.

New bundled skills belong in `skills/<name>/SKILL.md`. New optional integrations normally belong in a plugin or MCP server rather than the core runtime.
