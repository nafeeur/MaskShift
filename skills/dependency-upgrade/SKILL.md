---
name: dependency-upgrade
description: Upgrade libraries and runtimes with compatibility research, focused changes, lockfile integrity, and regression verification.
---

# Dependency Upgrade

- Read official migration notes and identify breaking changes that affect used APIs.
- Upgrade the smallest coherent dependency group; do not mix unrelated churn.
- Regenerate lockfiles with the repository package manager and inspect transitive changes.
- Exercise build, tests, startup, provider calls, MCP transport, and browser compatibility affected by the upgrade.
- Replace deprecated APIs rather than suppressing warnings without understanding them.
- Record runtime and platform minimums.
