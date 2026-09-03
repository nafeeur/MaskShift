---
name: refactoring
description: Restructure code safely while preserving behavior, reducing duplication, clarifying ownership, and maintaining compatibility.
---

# Refactoring

1. Establish a behavior baseline with tests or reproducible commands.
2. Identify the ownership boundary and dependency direction the code should follow.
3. Move in small compilable steps; avoid simultaneous semantic changes unless explicitly required.
4. Preserve public APIs or provide an intentional migration path.
5. Delete replaced code and update imports, docs, tests, and generated artifacts.
6. Compare behavior and performance before and after.
