---
name: ci-cd
description: Create and repair CI/CD pipelines with caching, parallelism, reproducibility, artifacts, and actionable failures.
---

# CI/CD

- Match local commands and pinned runtime versions.
- Split fast validation from expensive integration or release jobs; preserve clear dependency ordering.
- Cache by lockfile/toolchain keys, never by mutable branch alone.
- Keep secrets in provider stores and avoid echoing expanded commands containing them.
- Upload useful logs, test reports, coverage, and build artifacts on failure.
- Use concurrency cancellation for superseded branch builds and protect release jobs from duplicate execution.
