# Learning and judgement

MaskShift learns from what actually happened in your runs and uses it the next time. None of this changes what the model is;
it changes what the harness around it does: who gets the task, what is put in front of them, what runs without asking, and
when a run is stopped. All of it is local to your machine, visible, removable, and on by default.

```bash
maskshift learn                    # what has been learned, and how each model and harness has done
maskshift learn lessons            # lessons from earlier runs (with how often they were shown and how those runs went)
maskshift learn preferences        # what it noticed you want
maskshift learn skills             # repeated workflows it could turn into skills
maskshift learn routing "fix the parser bug"   # how a task would be routed, and the evidence
maskshift learn forget ID          # remove a lesson or preference
```

In the interface: `/learned` (or the palette) shows the same, and the palette has **Skills found in your repeated workflows**.
Set `learning.enabled` to `false` to switch the whole layer off; every part below also has its own switch.

## 1. Learning from history

**Outcome ledger.** Every finished run records which model did it, what kind of task it was, whether it succeeded (completed
*and* its verification, if any, passed), how many steps, tokens and dollars it took, and how many times it needed correcting.
Every fleet turn records the same for the harness that ran it. Nothing is invented: the ledger is what happened.

**Learned routing.** With `routing.autoSelect` or `router:auto`, and for choosing a harness (`agent_route`, `fleet_suggest`),
each candidate is scored from its record on *similar* tasks (weighted by how alike, and fading with age). The score is a
success estimate pulled toward the candidate's overall record by a few pseudo-trials, so one lucky run proves little; a small
exploration bonus keeps an under-tried candidate from being starved; and cost is subtracted, so among equals the cheaper one
wins. With no history it says so and defers to your configuration. `maskshift learn routing TASK` shows the ranking.

**Escalation.** A run that was routed automatically and cannot get anywhere — it keeps repeating itself, its verification
keeps failing, or it makes no progress — is handed to the next-best candidate for that kind of task, mid-run, with a note of
what happened and its working state. It happens at most `routing.maxEscalations` times (default 1) and **never for a model
you chose yourself**.

**Lessons.** After a run, lessons are derived from the trace, not from the model's opinion of itself:

- a command that passed at the end of a successful run becomes *how to check this project*;
- a command that failed and was then fixed by a different one, with the error generalised (no paths, numbers or hashes);
- verification that failed first and passed later, or never passed;
- patches that kept failing to match (read the file first);
- a loop the harness had to break, and a run that got stuck.

They are stored as ordinary memories (so `memory_list` shows them and `memory_delete` removes them) tagged with the kind of task
they came from, and shown in a later run only when the task is similar. Each carries a trust score: when a lesson was shown and
the run went well it gains trust; when it was shown and the run went badly it loses it, and distrusted lessons stop being
shown and are eventually deleted.

**Learned context.** After each run, the files the planner offered are compared with the files the run actually opened and
changed. Mostly-unused context shrinks the source budget for that kind of task; needed-but-missing files grow it. Slowly, in
bounds (0.6×–1.4×), and only after at least five runs of that kind.

## 4. Doing more with the tools

**Skill mining.** Repeated sequences of steps are found across runs (the same steps in the same order in at least three runs,
mostly successful, not just reading), trimmed to the longest form, and drafted as a skill from what those runs did. They are
only proposed: install one with `maskshift learn skills accept NAME`, or set `learning.skills.autoAccept`. An accepted skill is
then tracked — how runs that loaded it did compared with similar runs that did not.

**Batching and caching.** When a model asks for several calls at once, consecutive read-only calls run together and anything
that might change something runs alone, in the order asked, so a write is still visible to the reads after it. Identical calls
in a batch run once. A repeat of a deterministic read inside one run (file reads, listings, searches, git status/diff/log, LSP
queries) is answered from the first result, with a note saying so, until a write, a changed file, or 30 seconds make it stale.
A repeat is still judged as a repeat by the stagnation detector.

**Neighbour hints.** The first time a file is read in a run, the result ends with a line saying what depends on it and where its
tests are (from the code graph), which saves the searches that would find out.

**Language-server refactors.** `lsp_code_actions` lists what the server offers at a place — fix this error, extract a function,
add a missing import — and applies one by index, title or the server's preferred choice; `lsp_organize_imports` is the common
case. Rename and format were already there.

## 5. Memory and context

**Preferences.** Your own messages are read for standing statements ("always…", "never…", "I prefer…", "from now on…") and
corrections ("don't…", "use X instead of Y"). An explicit statement is kept at once; a one-off correction only counts once it
has been said more than once, because it may have been about that task alone. Style statements with no file in them apply
everywhere, the rest to the workspace. Only your words are read.

**Consolidation.** `memory_optimize` now also merges memories that say the same thing in different words (not just identical
titles), within the same scope and kind, combining the useful sentences and tags. It is a dry run unless you apply it; the
machine-written kinds (lessons, preferences) are consolidated automatically every ten runs.

**Working state.** When old turns are dropped to fit the window, the model's prose summary is no longer the only record: the
harness reads the files changed, commands run and how they ended, and errors still open straight off the tool calls and appends
them, so they survive a summary that fails or forgets. A later success supersedes an earlier failure. The same state goes into
the hand-off file and into an escalation.

## 6. Knowing what it doesn't know

**Ask before the irreversible.** In the `autonomous` permission mode nothing asks before running a command. The guard reads what a
call would actually do and separates what a checkpoint can undo from what nothing can. For the second kind — force-pushing,
dropping or emptying database data, `rm -rf` of the root, home or anything outside the workspace, piping a download into a
shell, publishing a package, `terraform apply`, `kubectl delete`, deleting cloud resources, writing to credential or system files
— the run asks you first (a yes covers that exact action for the rest of the run; a no tells the model not to retry a
variation). With nobody attached to ask it stops and says why; `learning.uncertainty.headless: "allow"` lets unattended runs do
it. Softer cases (`git reset --hard`, `sudo`, overwriting a file it never read) get a caution note on the result.
`learning.uncertainty.mode` is `guard` (default), `advise` (notes only) or `off`. The balanced and review modes already ask.

**Ask when the request is thin.** A request that names an action but not what it applies to ("fix it") or leans on something the
conversation has not established gets a note telling the model to work it out from the repository first and, if it is still
genuinely unclear, to ask one short question instead of guessing. It only advises, and not mid-conversation.

**Stop when going nowhere.** Alongside the repeat detector, a progress monitor counts new information (a file read, a result not
seen before, an error of a new kind), changes, and passing checks. After `progress.warnAfter` turns (default 8) without any, or
`errorStreak` turns of nothing but failures, the run is nudged to take stock and change tack; after `progress.stopAfter` (16) it
is stopped with a plain report of what was tried and what is needed, instead of spending the rest of its budget — unless it can
be escalated to another model first.

## Configuration

```json
{
  "learning": {
    "enabled": true,
    "lessons": true, "preferences": true, "prefetch": true, "consolidate": true,
    "routing": { "learned": true, "escalate": true, "maxEscalations": 1, "explore": 0.1, "costWeight": 0.15, "minEvidence": 3 },
    "skills": { "mine": true, "minRuns": 3, "autoAccept": false },
    "context": { "adapt": true },
    "progress": { "enabled": true, "warnAfter": 8, "stopAfter": 16, "errorStreak": 5 },
    "uncertainty": { "mode": "guard", "headless": "block", "ambiguity": true },
    "tools": { "cache": true, "batch": true }
  }
}
```

## Honest limits

- The record is only as good as its sample: with few runs the router says "not enough history" and does what you configured.
- Success means the run completed and any verification you configured passed. A run with no verification that "completed" but was
  wrong still counts as a success — configure `guardrails.verification` so success means something.
- Lessons and preferences are matched by wording and task kind, not understanding; the trust score is what keeps a wrong one
  from lingering, and `learn forget` is there for the rest.
- The command guard is a pattern list, not a sandbox. It catches the common irreversible commands; it cannot know what an
  arbitrary script does.
- Skill drafts are starting points, written from tool names and commands, not from understanding why they worked.
