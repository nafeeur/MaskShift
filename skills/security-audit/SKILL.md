---
name: security-audit
description: Audit code and dependencies for concrete exploitable weaknesses while preserving MaskShift’s intentionally permissive local execution philosophy.
---

# Pragmatic Security Audit

- Treat MaskShift as an owner-operated local harness with permissive execution; do not redesign it into an approval-heavy sandbox.
- Focus on accidental remote exposure, credential leakage, path traversal in HTTP routes, command injection in non-agent input, unsafe archive extraction, dependency compromise, and unauthenticated network binding.
- Preserve the overdrive default while making scope and activity visible through audit logs and an emergency stop.
- Verify that secrets are redacted from UI/API/log output and passed to child processes only when needed.
- Report concrete exploit paths and minimal fixes; avoid generic hardening checklists.
