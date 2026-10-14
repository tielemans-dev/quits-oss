---
name: babysit-pr
description: Monitor a Quits PR through T3 notifications, verify findings, and hand off when checks and review are green.
---

# Babysit PR

Read [AGENTS.md](../../../AGENTS.md) and the issue brief. Preserve its file ownership,
protected work, budget, and verification limits. Use [fast-loop](../fast-loop/SKILL.md)
for fixes and [ship](../ship/SKILL.md) for metadata and readiness gates. Never read
`.env` files, print secrets, or access private hosted implementation.

## Watch and react

1. Link the PR to the working thread and parent with `link_pull_request`. Inspect
   existing checks and comments once, recording the current head and review round.
2. Call T3 `watch_pull_request` and end the turn. T3 wakes the thread for check,
   comment, review, or conflict changes. Do not poll, sleep, or run a CLI watcher.
   A delegated child cannot watch; send the PR/head to its parent to own the watch.
   If T3 watching is unavailable, report that limitation and hand off.
3. On a wake, inspect the current head and changed evidence. Reproduce or substantiate
   each bot/reviewer finding against the code and issue before editing. Record why a
   finding is accepted, already fixed, or unsupported. A bot comment is not proof.
4. Gather verified, in-scope findings into one fix batch for that round. Run scoped
   checks, commit/push the owned branch, update actual verification, then watch again
   and end. Escalate out-of-scope findings rather than broadening the patch.

## Bound review work

The parent schedules independent review only after required CI is green. Use a
Claude Sonnet or Opus reviewer different from the Codex implementer; never substitute
self-review. Launch blockers have priority over workflow reviews and heavy checks.

Allow one review per ready head, with at most three review rounds for the PR. Do not
request review after every push. After a fix batch, wait for green CI on the new head
before the parent schedules the next necessary round. Each T3 delegated review is a
new `delegate_task` with a distinct retry-stable `clientRequestId`; include the original
brief, prior findings, responses, and unresolved objections. Retain every task ID.
Do not use the previous child's thread to start an independent review round.

For a clean rebase, compare stable patch IDs for the full reviewed patch before and
after. An unchanged patch retains its review verdict; record the new head and let CI
check it. If conflict resolution changes the patch, identify the resolution delta,
run targeted verification for that delta, and ask the parent for delta-only review.
Do not claim the old verdict covers changed code. These reviews count toward the cap.

At three rounds with unresolved findings, stop and report the findings and evidence
to the parent. Do not open an extra round or continue speculative fixes.

## Stop and hand off

Green means required CI passes on the current head, verified findings are resolved,
and the applicable independent verdict covers the patch. Stop fixing when green.
Follow the authorized draft-to-ready handoff in `ship`; Kai lands. Never merge,
deploy, release, tag, enable auto-merge, push main, or delete work.

When returning control to the user, call `unwatch_pull_request` first. For a child
handoff, the parent retains its own watch. Report at most 200 words with PR URL,
head/worktree, actual checks, CI, review round/verdict, and unresolved risks.
