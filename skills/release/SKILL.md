---
name: release
description: Prepare reproducible production releases with versioning, changelogs, packaging, smoke tests, and rollback notes.
---

# Release Engineering

1. Ensure the working tree and generated artifacts are understood.
2. Run format/static checks, focused tests, complete build, and an installed-package smoke test.
3. Validate first-run configuration, upgrade behavior, ports, filesystem permissions, and service files.
4. Update version, changelog, compatibility notes, and migration instructions together.
5. Produce deterministic archives and checksums; inspect archive contents before delivery.
6. Document known limitations and rollback steps using exact commands.
