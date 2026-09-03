---
name: feature-implementation
description: Implement production features end to end, including integration, error states, tests, documentation, and verification.
---

# Feature Implementation

- Convert the request into observable acceptance criteria.
- Inspect adjacent implementations and reuse established types, APIs, styling primitives, logging, and test patterns.
- Implement the smallest coherent vertical slice; wire it into real navigation, configuration, persistence, and runtime paths.
- Remove stubs, demo-only data, dead toggles, and silent catches in touched paths.
- Test success, invalid input, cancellation, timeout, empty state, and recovery paths.
- Run the narrowest relevant formatter, static checks, tests, and build before reporting completion.
