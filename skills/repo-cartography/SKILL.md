---
name: repo-cartography
description: Map unfamiliar repositories and identify the correct files, dependency paths, conventions, and verification commands before implementation.
---

# Repository Cartography

1. Read root and nested instruction files first: `AGENTS.md`, `CLAUDE.md`, `MASKSHIFT.md`, package manifests, and build files.
2. Map entry points, package boundaries, generated code, tests, and ownership patterns. Prefer `git ls-files`, `rg`, language manifests, and the repository index over broad file reads.
3. Trace one representative request or data path end to end before deciding where new code belongs.
4. Name the minimal edit set and the tests/build commands that prove the change.
5. Do not create a parallel architecture when an existing extension point already exists.
