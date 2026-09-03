---
name: architecture
description: Design system architecture with explicit requirements, boundaries, data flows, tradeoffs, failure modes, and evolution paths.
---

# Architecture

- Convert goals into functional requirements and measurable qualities: latency, scale, durability, portability, extensibility, and operability.
- Draw ownership and data flow across UI, daemon, agent loop, providers, tools, MCP, persistence, and workspaces.
- Choose boundaries that permit replacement without duplicating policy.
- Describe failure, cancellation, retry, and recovery behavior for every external boundary.
- Prefer incremental migration and compatibility over a clean-room rewrite when an existing system exists.
- Validate the design with one or two concrete end-to-end scenarios.
