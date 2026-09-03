---
name: debugging
description: Diagnose and repair software failures using evidence, reproduction, instrumentation, and regression tests rather than speculative edits.
---

# Debugging

1. Reproduce the failure with the exact command, input, environment, and observed output.
2. Separate symptom, trigger, and root cause. Inspect logs, stack traces, state transitions, recent diffs, and boundary conditions.
3. Add temporary targeted instrumentation when evidence is missing; avoid broad logging noise.
4. Fix the root cause at the narrowest ownership boundary.
5. Add a regression test that fails before the fix and passes after it.
6. Remove temporary diagnostics and rerun the original reproduction plus nearby tests.
