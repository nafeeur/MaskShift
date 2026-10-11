---
name: reverse-engineering
description: Reverse engineer shipped binaries, JavaScript/Electron apps, .NET assemblies, Android APKs, firmware, and websites using the REA MCP server, with evidence-backed findings and a guided investigation workflow.
---

# Reverse Engineering (REA)

Use the REA MCP server when a claim depends on a shipped binary or package, decompilation, passive runtime evidence, or behavior not established by available source. For ordinary analysis of a complete source repository, prefer the normal repository tools and do not start REA.

## Connect lazily

- The `rea` server is in the curated catalog with `lazy: true` — it is not running until you need it. Activate it with `mcp_connect({ name: 'rea' })`, then prefer calling its tools through their activated `mcp__rea__*` names rather than repeated `mcp_call`.
- REA resolves via `npx -y rea-agents@latest mcp`, so the first connect downloads the package and needs Node ≥ 22.19. Do not install or upgrade anything else (Node, Hopper, Ghidra, IDA, JADX, Binwalk) unless the user explicitly asks.
- Static JavaScript/Electron, .NET, web, ELF-layout, and APK-manifest analysis work with no extra engine. Deep native decompilation needs an existing Hopper, Ghidra, or IDA install; if one is missing, say so and continue with the static slices that do work.

## Route the target first

Pick the first tool from the target the user gave you; do not run readiness or setup checks before every investigation.

- JavaScript / Electron / ASAR tree → `analyze_javascript_application`
- Archive/package inventory (ZIP/APK/IPA/MSIX/DMG) → `open_binary`, then `inspect_artifact`
- Android APK code/classes → `inspect_android_package`, then focused Android tools
- .NET / PE-CLI assembly → `inspect_managed_artifact`
- Native executable/library → `open_binary`, then `binary_overview` / `analyze_function` / pseudocode
- ELF layout without a disassembler → `inspect_binary_layout`
- Firmware image → `inspect_firmware_regions` (Linux, Binwalk/Unblob)
- Website or HAR capture → `inspect_web_page` / `inspect_web_network_capture`
- Recorded Linux crash → `inspect_recorded_crash`
- Running browser/Electron target → `list_browser_targets` / `list_electron_targets`

If the user says only "my app" with no path or selected target, ask which app before searching. Never pick an example app on the user's behalf.

## Work summary-first, cite evidence

- Start from the default/summary result and use its inline evidence and graph context. For large targets pass `"detail": "summary"`, then page sections with `inspect_analysis_view` instead of re-running a broad analysis.
- If a result is truncated or reports a transport `resource_constraint`, use the retained `parent_evidence_id` for smaller views or `export_evidence_bundle`; do not repeat the same oversized call.
- Distinguish observations, inferences, and unknowns. Cite evidence IDs, preserve stated limitations and coverage, and never imply static analysis observed execution.
- For multi-feature investigations, turn the request into a checklist of questions and the evidence each needs, reuse existing session state, batch related probes around one hypothesis, and keep a findings ledger linking conclusions to evidence.
- Close a native session with `close_binary` when done.

## Scope and legality

REA is for lawful, authorized reverse engineering. Stay within the target and action the user declared; do not broaden runtime execution beyond the requested fields. When the user asks to build something from findings, use normal coding tools and separate observed behavior from design choices.
