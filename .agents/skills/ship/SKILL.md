---
name: ship
description: Publish an owned Quits branch as a draft PR, gate readiness on CI, and hand off for Kai to land.
---

# Ship

Ship means draft PR, green CI, and ready handoff. Kai lands. Never merge, deploy,
release, tag, enable auto-merge, push main, or delete work.

Read [AGENTS.md](../../../AGENTS.md) and the issue brief. Work only in the owned
worktree/branch and named files. Preserve other owners' work. Never read `.env` files
or print secrets. Keep private hosted code and infrastructure out of this public core.

## Prepare the draft

1. Verify the diff matches scope and contains at most 400 added plus deleted lines,
   excluding generated files, lockfiles, and migrations. Count against the PR base,
   not just the last commit. Stop and report if the budget is exceeded. Keep plans
   and evidence out of git. Preserve files and symlinks without blind replacement.
2. Run the allowed [fast-loop](../fast-loop/SKILL.md) checks. Report exact results,
   skipped checks, and reasons. CI owns the full suite; do not imply unrun checks pass.
3. Commit normally and push only the owned branch. Add no AI coauthor trailer or
   generated attribution to commits or PRs. Create a DRAFT PR against the issue's
   base and immediately register its full URL with T3 `link_pull_request` for both
   the working thread and parent. Verify links with `list_thread_pull_requests`.

Use these PR body sections, within any applicable repository template:

```markdown
## Problem
Concrete issue and affected behavior.

## Change
Final scoped implementation and relevant files.

## Linear
Fixes QUI-n

## Verification
Commands actually run and their outcomes; checks delegated to CI.

## Risk
Material limitations or "Docs only; no runtime change" when accurate.

## Agent
Model: actual implementer model
Harness: actual execution harness
Orchestrator: parent orchestrator ID
Thread: working thread ID
```

Replace all example values, including `QUI-n`, with actual metadata. The Agent footer
is execution metadata, not authorship or generated attribution. Use names plainly
without GitHub @-mentions for the names prohibited by AGENTS.md.

## Gate readiness and hand off

Keep the PR draft until required CI is green on the current head. On push and CI
start, send the parent a concise STATUS with PR URL, head, worktree, verification,
and risks, then end the turn. Use T3 watching through
[babysit-pr](../babysit-pr/SKILL.md); do not poll for CI or request your own review.

The parent owns Claude Sonnet/Opus review after green CI, with a reviewer different
from the Codex implementer, one review per ready head, and a three-round cap. Honor
any issue rule reserving review or readiness actions for the parent. Mark ready only
when CI is green and the assigned review requirements are satisfied. Hand off the
current head and verdict to Kai without landing it. Unwatch before returning control
to the user; the parent can retain its watch while coordinating review.
