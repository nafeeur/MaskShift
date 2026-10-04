# Agent fleet

The fleet runs any mix of coding-agent harnesses — **Claude Code, Codex, OpenCode, Hermes, Copilot CLI, Aider**,
any custom CLI you configure, and MaskShift's own engine — as one team. You can have several members on the same
harness (two Claude Codes and a Codex), give each a role, and let them message each other to get a task done. The
fleet is controlled from the **Fleet** view (`7`), the `maskshift fleet` commands, or by the model itself through the
`fleet_*` tools.

A harness is used when its executable is on `PATH`; nothing is vendored. `maskshift fleet harnesses` shows what was found.

## Concepts

| | |
|---|---|
| **Member** | A named seat (`claude-1`, `reviewer`) held by one harness, with a role, a working directory, an access mode (`inspect` or `edit`), a history and an inbox. Optionally in its own Git worktree. |
| **Message** | Text from one member (or you) to another. Queued in the recipient's inbox, delivered with its next turn. |
| **Turn** | One member consumes its inbox, runs its harness once, and its reply is routed. |
| **Relay** | A bounded loop that keeps taking turns for whoever has mail until the team says it is done, falls quiet, or hits a limit. |

The CLIs are stateless between invocations, so each turn's prompt carries what the harness needs to behave like a
teammate: who it is, who else is on the team, the team objective, its own recent replies and the mail that arrived.
MaskShift-engine members keep a real session instead.

## How agents talk to each other

Every harness is reachable only as text in, text out, so the shared channel is the text itself. A member addresses a
teammate by writing a block into its reply:

```text
[[send to=reviewer]] Please review src/auth.mjs for race conditions. [[/send]]
[[send to=*]] I changed the config schema; re-read it before you continue. [[/send]]
[[done]] Auth fixed, reviewed and tests green. [[/done]]
```

Every briefing explains this, so no harness needs configuring. Parsing is lenient (case, quotes, `@name`, several
recipients). A member that just *answers* a teammate's message without writing a `[[send]]` is still handled: its
reply goes back to whoever asked. Replies are never answered again, so two agents cannot thank each other forever.

## Using it

### Interface

Press `7`. `n` adds an agent (any harness, name, role, access, optional own worktree). `t` starts a whole team from
`claude, codex:reviewer, hermes`. `↵` or `a` asks the selected member; `m` queues a message between members; `g` hands
the whole team a task; `o` reads a member's transcript; `s` stops the selected member or relay; `x` resets a member;
`del` removes it. The sidebar follows the team's chatter live. Asking and relaying run in the background and report by
toast, so the interface never waits on a harness.

### Command line

```bash
maskshift fleet harnesses
maskshift fleet spawn claude codex:reviewer hermes:research --role "Careful and terse"
maskshift fleet ask reviewer "Review the diff on this branch"
maskshift fleet relay "Add rate limiting to the API and have it reviewed" --lead claude
maskshift fleet relay "Fix the flaky test" --with claude:fixer,codex:checker   # create the team for this one task
maskshift fleet log
```

Members persist between invocations. See [CLI](CLI.md#fleet) for every subcommand.

### From a MaskShift run

The model sees `fleet_harnesses`, `fleet_spawn`, `fleet_list`, `fleet_ask`, `fleet_send`, `fleet_relay`,
`fleet_messages` and `fleet_stop`, so a normal MaskShift chat can assemble and drive a team itself — MaskShift as the
coordinator, the CLIs as workers — or hand the whole job to a relay.

## Robustness

- **One thing at a time per member.** Asks to a busy member queue behind it instead of fighting over its directory.
- **Retries.** A turn that fails is retried (`fleet.maxRetries`, default 1) with backoff. Unread mail goes back in the
  inbox when a turn fails, so nothing is lost.
- **Fallbacks.** A member can name fallback harnesses; if its harness is missing at spawn time or disappears later it
  moves to the first installed fallback. MaskShift's engine is never substituted silently.
- **Loop control.** Messages are de-duplicated, carry a hop count (`fleet.maxHops`, default 10) and are dropped, with the
  reason recorded, beyond it. A relay stops at `fleet.maxRounds` (12) or `fleet.relayTimeoutMs` (2 h), and gives up on a
  member that fails twice in the same relay.
- **Cancellation.** Stop a member, a relay or the whole fleet at any time; the harness process group is killed.
- **Isolation.** `isolated` gives a member its own Git worktree and branch. Branches are never merged for you.
- **Persistence.** The roster, mail, recent history and relay records survive a restart. A turn interrupted by a
  restart is simply idle again.

`edit` members run their CLI with the harness's own non-interactive edit flags (`--permission-mode acceptEdits` for
Claude Code, `--full-auto` for Codex; set `editArgs` on a bridge to change or add them). Use `inspect` for members that
should only read.

## Configuration

All keys are optional. Defaults shown.

```json
{
  "fleet": {
    "maxMembers": 12,
    "maxParallel": 4,
    "maxRounds": 12,
    "maxHops": 10,
    "maxRetries": 1,
    "retryDelayMs": 1500,
    "turnTimeoutMs": 1200000,
    "relayTimeoutMs": 7200000
  }
}
```

Add a harness the same way as any bridge (`agentBridges` in [configuration](CONFIGURATION.md#external-agent-bridges));
it immediately becomes available to the fleet. A bridge may set `modelArgs` (appended with the member's model) and
`editArgs` (appended for `edit` members).

## Limits

- Members cannot see each other's files except through the shared working directory (or by describing them in messages).
  Two `edit` members in one directory can step on each other; give them `isolated` worktrees for parallel edits.
- The CLIs are driven non-interactively and one turn at a time. A harness that stops to ask a question is answered by
  its own policy flags, not by you.
- Continuity for CLI members is a rolling summary of their own replies, not the harness's native session.
