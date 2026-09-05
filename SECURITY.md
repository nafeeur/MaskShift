# Security Model

MaskShift is intentionally a **permissive local coding harness**, not a sandbox. The default `overdrive` mode gives the model access to host-level tools without per-action confirmation.

The supported deployment boundary is a trusted local machine or a controlled development environment. MaskShift is a terminal application: it opens no listening socket and exposes no network API. Anyone with access to the terminal running it has the authority of the account running it.

Security-sensitive bug reports should include the affected version, reproduction steps, expected boundary, and whether the issue is reachable from loopback, a configured reverse proxy, a plugin, an MCP server, or a model-generated command.

The following are expected behavior rather than vulnerabilities when running in overdrive mode:

- reading or modifying files accessible to the daemon account;
- executing shell commands and package managers;
- using credentials available in the process environment or standard credential helpers;
- invoking configured MCP servers, browser profiles, SSH hosts, container sockets, or external agents;
- loading explicitly installed plugins in-process.

Unexpected authentication bypasses in an added access layer, path-resolution escapes from a configured restricted mode, secret leakage from redacted API views, or remote code execution without an authorized tool/plugin/MCP path are valid security issues.

See [`docs/PERMISSIVE_MODE.md`](docs/PERMISSIVE_MODE.md) for operational guidance.
