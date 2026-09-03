---
name: prompt-evals
description: Create evaluations for agent prompts, tool routing, context retrieval, and coding outcomes using reproducible tasks and scoring.
---

# Prompt and Agent Evaluations

- Define representative tasks with frozen repositories, initial state, expected behavior, and prohibited regressions.
- Score outcome correctness, tests/build, diff quality, tool efficiency, context size, latency, and recovery from failures.
- Capture full trajectories and normalize nondeterministic fields.
- Include adversarial cases: misleading files, large MCP catalogs, unavailable tools, malformed model calls, and interrupted runs.
- Compare changes against a baseline over multiple seeds/models when variability matters.
- Do not optimize solely for judge prose; verify executable artifacts.
