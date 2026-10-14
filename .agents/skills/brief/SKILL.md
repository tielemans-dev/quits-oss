---
name: brief
description: Turn a Quits issue into a self-contained child brief before delegating repository work.
---

# Brief

Read [AGENTS.md](../../../AGENTS.md), `~/Projects/fleet/dotfiles/projects-AGENTS.md`,
and the authoritative issue summary first. Use the summary when a referenced plan is
unavailable; report missing requirements rather than inventing them.

Write a brief with the following fields. The child must be able to act without the
parent's conversation or files on another machine.

- `goal`: the issue key, intended outcome, and observable acceptance criteria.
- `context`: issue URL, relevant facts, repository, parent orchestrator/thread ID,
  priority, and any unavailable sources. Describe quits-oss as the public,
  self-hostable core under FSL; do not claim it is open source.
- `scope`: exact permitted files, exclusions, ownership, change budget, authorized
  actions, and verification limits. Preserve the issue's OSS/hosted boundary.
- `done_when`: required implementation, actual verification, commit/push and draft
  PR expectations, CI gate, review ownership, and explicit stopping condition.
- `report`: at most 200 words covering status, files, head, worktree, actual checks,
  CI, PR URL, risks, and open questions.

Include the QUI key in the thread title, for example `QUI-98 Add repo workflow skills`.
Record the chosen implementer model/provider and reviewer model/provider. Query T3's
live model catalog before selecting a delegated model; do not invent model IDs.
Use a single focused implementer unless the issue authorizes more. Workflow work
has at most two children in total; launch blockers take slots, reviews, and attention.

Require a T3-created worktree off `origin/main`, an owned branch, and changes only
within the issue's scope. Separate checkout delegation uses T3 `delegate_task` with
`isolation: "worktree"`; it starts at the parent commit without uncommitted edits.
Retain the task ID. A child task is not a new top-level conversation.

Carry these constraints into the brief rather than assuming the child inherits them:

- At most 400 added plus deleted lines, excluding generated files, lockfiles, and
  migrations. Keep plans and evidence out of git. Add no dependencies or abstractions
  unless required by the issue.
- Never read `.env` files or print secrets. Keep private hosted implementation out
  of this public repository. Preserve protected work and other owners' changes.
- Never merge, deploy, release, tag, enable auto-merge, push main, or delete work.
  Kai lands. Commit normally without AI coauthor or generated attribution.
- Use [fast-loop](../fast-loop/SKILL.md) for scoped checks and
  [ship](../ship/SKILL.md) for PR handoff. Copy any stricter issue limits into the brief.
- The parent owns independent review after CI is green. A Claude Sonnet or Opus
  reviewer must differ from the Codex implementer. Reserve launch review capacity.

Stop before dispatch if file ownership, repository choice, or required permissions
are unclear. Report the unresolved constraint to the parent without expanding scope.
