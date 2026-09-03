---
name: git-worktrees
description: Use Git worktrees and checkpoints for parallel agents, isolated changes, review, integration, and recovery.
---

# Git Worktrees and Checkpoints

- Create one branch/worktree per independent implementation stream.
- Establish a pre-run checkpoint without altering the user’s current worktree.
- Keep agents from editing the same files unless the integration plan explicitly handles conflicts.
- Run verification inside each worktree, then review diffs before merging or cherry-picking.
- Preserve untracked work in checkpoint manifests.
- Remove completed worktrees and stale refs only after integration is confirmed.
