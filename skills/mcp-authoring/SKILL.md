---
name: mcp-authoring
description: Build and integrate MCP servers and clients across modern 2026 stateless and legacy initialization-based protocol revisions.
---

# MCP Authoring

- Implement JSON-RPC framing exactly for stdio and Streamable HTTP.
- For protocol 2026-07-28, attach protocol version, client capabilities, and client identity in every request `_meta`; use `server/discover` and no initialize session.
- For legacy servers, fall back to initialize/initialized and negotiated protocol version.
- Bound schemas, descriptions, tool outputs, timeouts, and pagination.
- Keep server connections isolated and expose tools through lazy search/activation rather than injecting every schema into model context.
- Test modern, legacy, malformed, timeout, cancellation, and reconnect behavior.
