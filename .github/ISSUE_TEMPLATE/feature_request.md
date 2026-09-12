---
name: Feature request
about: Propose a tool, skill, provider, or capability MaskShift doesn't have yet
title: ''
labels: enhancement
assignees: ''
---

**What's missing, and what task does it block?**

**Proposed shape**

If this is a new tool: name, `inputSchema`, category, and whether it's `readOnly`.
If this is a new skill or provider: where it fits alongside what's already bundled.

**Alternatives considered**

Could this already be done through the plugin API, an MCP server, or an agent bridge instead
of a core-runtime change? See [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — MaskShift keeps the
runtime dependency-free on purpose, so integrations usually belong in a plugin or MCP server
rather than core.

**Would you be willing to open a PR for this?**
