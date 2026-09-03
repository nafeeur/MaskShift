---
name: plugin-authoring
description: Create modular MaskShift plugins that add tools, skills, providers, hooks, UI panels, or MCP catalog sources without coupling core policy.
---

# MaskShift Plugin Authoring

- Declare plugin identity, version, entry point, capabilities, configuration schema, and compatibility range.
- Register through public registries; do not import internal singleton state.
- Make optional dependencies lazy and report unavailable capabilities without crashing startup.
- Provide cleanup for processes, timers, subscriptions, and UI mounts.
- Namespace tools and events to prevent collisions.
- Include a smoke fixture proving load, activation, execution, and unload.
