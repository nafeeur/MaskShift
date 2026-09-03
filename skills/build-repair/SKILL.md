---
name: build-repair
description: Repair broken builds, type checks, packaging, and startup paths across environments with minimal, verifiable changes.
---

# Build Repair

1. Run the exact failing build in a clean-enough environment and capture the first causal error.
2. Check runtime versions, generated files, environment variables, native toolchains, and case-sensitive paths.
3. Fix source ownership rather than patching output artifacts.
4. Re-run the failed target, then the nearest dependent targets.
5. Test the packaged or installed artifact, not only the source-tree command.
6. Document environmental prerequisites that cannot be encoded.
