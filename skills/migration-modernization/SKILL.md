---
name: migration-modernization
description: Modernize legacy code or frameworks incrementally while preserving behavior, interoperability, and delivery velocity.
---

# Migration and Modernization

- Inventory compatibility constraints, generated interfaces, deployment environments, and consumers.
- Add characterization tests around behavior that must survive.
- Define seams and migrate vertical slices behind compatible interfaces.
- Keep old and new paths observable during transition; avoid dual writes without reconciliation.
- Remove legacy code only after usage and rollback windows are understood.
- Measure build, runtime, and maintenance impact after each phase.
