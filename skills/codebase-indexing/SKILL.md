---
name: codebase-indexing
description: Build and maintain scalable repository indexes for lexical, structural, symbol, and semantic retrieval with bounded context.
---

# Codebase Indexing

- Use tracked-file discovery and repository ignore rules before reading content.
- Skip binaries, generated outputs, dependency trees, and oversized artifacts by default.
- Chunk on language structure when available, with bounded line overlap and source coordinates.
- Store content hashes for incremental refresh and preserve path/language metadata.
- Combine lexical FTS, symbol/navigation tools, and optional embeddings rather than relying on one retrieval method.
- Evaluate retrieval on real tasks: entry-point discovery, call-chain tracing, correct edit location, and related tests.
