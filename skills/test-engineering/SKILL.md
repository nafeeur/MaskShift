---
name: test-engineering
description: Design and implement high-signal unit, integration, end-to-end, property, and regression tests for changed behavior.
---

# Test Engineering

- Derive tests from contracts and failure modes, not implementation details.
- Prefer integration tests for orchestration and tool/agent behavior; use unit tests for deterministic transforms and parsers.
- Include cancellation, timeouts, partial output, malformed responses, unavailable dependencies, and retries where relevant.
- Keep fixtures minimal and deterministic. Never depend on live production services in default tests.
- Assert complete results and externally visible behavior where practical.
- Record the exact commands used and distinguish skipped environmental checks from passing tests.
