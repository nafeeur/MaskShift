---
name: code-review
description: Review changes for real correctness, maintainability, regressions, missing tests, and integration defects with low-noise findings.
---

# Code Review

- Start from the diff, then inspect only the surrounding ownership and callers needed to validate behavior.
- Prioritize correctness, data loss, concurrency, lifecycle, API compatibility, resource cleanup, and broken user flows.
- Verify claims against executable paths; do not report style preferences as defects.
- Each finding must include severity, file/line, concrete failure scenario, and a practical fix.
- Check whether tests exercise the changed behavior rather than merely touching lines.
- End with residual risk and verification gaps, not a generic summary.
