---
name: docker-kubernetes
description: Containerize and operate development services with reproducible images, health checks, persistent state, and clear networking.
---

# Containers and Kubernetes

- Use small pinned base images and deterministic dependency installation.
- Separate build and runtime stages; run as a non-root user when it does not break the intended host-tool access model.
- Persist MaskShift home/state explicitly and document host workspace mounts.
- Add health/readiness checks that exercise the actual HTTP service.
- Keep provider credentials and MCP secrets external to images.
- Verify signal handling, graceful shutdown, port binding, and filesystem ownership.
