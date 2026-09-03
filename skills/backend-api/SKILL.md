---
name: backend-api
description: Design and implement reliable local or network APIs with validation, streaming, cancellation, observability, and stable contracts.
---

# Backend API

- Define request, response, error, and streaming event contracts before implementation.
- Validate at the boundary and return actionable status codes without leaking secrets.
- Propagate cancellation and deadlines through subprocess, model, database, and network calls.
- Make retries explicit and idempotent where possible.
- Emit structured logs and correlation identifiers for sessions, runs, and tool calls.
- Add contract tests for success, malformed input, missing resources, conflict, timeout, and cancellation.
