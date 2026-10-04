# Disk use

MaskShift keeps its data in one folder (`~/.maskshift`): a SQLite database, checkpoints, browser profiles, logs and
caches. Left alone, two of those grow without bound — the search index of a big workspace and a checkpoint per run — so
MaskShift manages its own footprint. **No limit is a fixed number of gigabytes.** Each one is worked out from the
machine it is running on, and anything you set in `storage` overrides it.

```bash
maskshift storage            # usage, the budget for this machine, advice
maskshift storage prune      # free space now (add --dry-run to preview)
maskshift storage vacuum     # rebuild the database file so deleted space returns to the disk
```

In the interface: the command palette (`ctrl+k`) has **Disk use** and **Free up space**, and `/storage` opens the report.
A toast appears when disk gets short or MaskShift goes over budget.

## How the defaults are derived

Three measurements are taken: the disk that holds `~/.maskshift` (total and free, via `statfs`), the host's memory, and
how much MaskShift already occupies.

| | Rule |
|---|---|
| **Total budget** | 5% of the disk, but never more than a quarter of what MaskShift could reclaim (free space plus its own usage), clamped to 1–40 GiB. Below 1 GiB only when the disk is that small. If the disk cannot be measured, a quarter of memory (1–8 GiB). |
| **Split** | 35% search index, 45% checkpoints, 20% everything else (browser profiles, logs, artifacts, caches). |
| **Disk pressure** | `roomy` (over 100 GB and 30% free), `normal`, `tight` (under 10 GB or 10% free), `critical` (under 2 GB or 3% free). Retention windows scale by ×1.5 / ×1 / ×0.5 / ×0.25. |
| **Checkpoints kept** | 20 per workspace × pressure factor (minimum 3), and 14 days × factor (minimum 2). |
| **Run events kept** | 30 days × factor (minimum 3). |
| **Stale search indexes** | Dropped after 60 days × factor (minimum 7) without opening the workspace. |
| **Index per workspace** | The smaller of the index share ÷ 7 (the database is about 3.5× the indexed text, and a workspace gets a share) and 3% of RAM, clamped to 20–600 MB of text. RAM matters because the indexer holds a workspace's chunks in memory while it works. |
| **Files per workspace** | 10,000 per GiB of RAM, clamped to 20,000–150,000. |
| **Largest indexed file** | 2 MB; 512 KB when disk is tight or critical. |
| **One checkpoint's untracked copies** | The checkpoint share ÷ (checkpoints kept × 3), clamped to 8–256 MB; files over 10 MB (2 MB when critical) are skipped. |

On a 156 GB disk with 98 GB free and 7 GB of RAM that is a 7.8 GB budget, 225 MB of text and 73,000 files per
workspace, and 20 checkpoints / 14 days. A 128 GB disk with 1.5 GB free gets a 1 GB budget, 5 checkpoints / 4 days and
51 MB of text per workspace.

## What happens automatically

Ten seconds after start, every six hours, and after a run (at most every 15 minutes), MaskShift prunes anything past
its retention and compacts the database. Set `storage.auto` to `false` to turn that off; `maskshift storage prune`
still works.

Indexing and checkpointing respect the limits as they go:

- **Indexing** walks the most useful files first (recognised source before everything else, shallow before deep) and
  stops at the file or size limit, logging how many files it skipped. Opening your home directory or `/` as a workspace
  gets a quarter of the allowance. The code graph uses the same limits.
- **Checkpoints** copy untracked files only up to the per-checkpoint limit and record what they left out.
- **The database** is created with incremental auto-vacuum, and the write-ahead log is truncated after each cleanup, so
  deleting rows returns space to the disk. A database made by an older version keeps its old mode until you run
  `maskshift storage vacuum` once (it needs free disk about the size of the database).
- **Logs** roll over at 25 MB (5 MB when critical), keeping three generations; the audit log keeps eight.

## What is deleted, and what never is

Reclaimable: checkpoints past retention (their copied files and the Git ref that pins their commit go too), checkpoint
folders no checkpoint owns, search indexes for folders that no longer exist or have not been opened lately (they rebuild
on next use), old run events, rolled-over logs, and free pages in the database.

Never touched: chats, messages, runs, memories, workspaces, skills, configuration, any file in a workspace, browser
profiles (counted and reported, not pruned), the newest checkpoint of each workspace, and any checkpoint younger than 24
hours, whatever the pressure.

`maskshift storage prune --dry-run` shows exactly what would go and why.

## Configuration

Every key is optional; `null` means "derive it from this machine".

```json
{
  "storage": {
    "auto": true,
    "maxGb": null,
    "indexMaxMb": null,
    "indexMaxFiles": null,
    "staleIndexDays": null,
    "keepCheckpoints": null,
    "checkpointMaxAgeDays": null,
    "runEventDays": null
  }
}
```

`maxGb` fixes the total budget (the split and everything derived from it follow); the others pin one value each.
