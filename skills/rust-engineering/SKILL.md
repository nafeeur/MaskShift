---
name: rust-engineering
description: Implement reliable Rust systems with ownership-aware design, errors, async cancellation, tests, and workspace conventions.
---

# Rust Engineering

- Follow workspace crate boundaries and existing error conventions.
- Avoid unnecessary cloning and blocking operations on async executors.
- Make process, channel, and task shutdown explicit.
- Prefer typed states and narrow public APIs.
- Add focused unit tests plus integration tests for protocol/orchestration behavior.
- Run fmt, clippy with repository flags, and scoped tests.
