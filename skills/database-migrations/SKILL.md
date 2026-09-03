---
name: database-migrations
description: Evolve persistent schemas safely with compatible migrations, backfills, rollback strategy, and integrity checks.
---

# Database Migrations

- Inspect current schema, data volume, indexes, constraints, and application read/write paths.
- Prefer additive, backward-compatible phases for live systems.
- Wrap compatible changes in transactions; make migrations idempotent and versioned.
- Separate schema change, backfill, and cleanup when locks or runtime compatibility matter.
- Validate row counts, nullability, uniqueness, foreign keys, FTS/index synchronization, and rollback behavior.
- Back up or checkpoint before destructive operations.
