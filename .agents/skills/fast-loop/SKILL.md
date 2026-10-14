---
name: fast-loop
description: Verify touched Quits code with scoped tests, typecheck, and lint while reserving full suites for CI.
---

# Fast loop

Read [AGENTS.md](../../../AGENTS.md), the issue brief, and
`~/Projects/fleet/dotfiles/projects-AGENTS.md`. On Omarchy, read
`~/Projects/fleet/docs/OMARCHY_LOAD.md` before scheduling resource-heavy checks.
The issue's stricter verification limits take precedence. Never read `.env` files
or print secrets to diagnose tooling.

## Select the smallest useful checks

- For docs-only work, inspect the scoped diff and whitespace. For skills, validate
  frontmatter, reachable pointers, and relative symlink resolution. Count added plus
  deleted lines against the base, with the 400-line budget excluding generated files,
  lockfiles, and migrations. No build, browser round, or full test suite is needed.
- For behavior changes, run the relevant failing test first, then tests for touched
  behavior. Select existing commands from package scripts and runner help. Avoid
  tests that only mirror implementation details.
- Run targeted typecheck and lint for changed code where supported. The repository's
  `bun run typecheck:app` covers app sources only; do not present it as whole-repository
  verification. Do not invent file-level typecheck flags unsupported by the tool.
- CI owns the full suite and broad lint/typecheck gates. Record any locally skipped
  repository requirement and confirm its CI result before claiming full completion.
  If a required check has no scoped mode or CI coverage, report the gap to the parent.

## Respect the workload queue

Launch blockers take priority. Do not run heavy local checks while launch-blocker
work runs. Ask the parent to schedule any necessary heavy verification; while waiting,
continue scoped inspection or static checks. Run one heavy command at a time, wrap
only its outermost command with `fleet-heavy --`, and wait for it to finish.

Use one worker for test/browser runners, for example:

```sh
fleet-heavy -- bun run test --maxWorkers=1 path/to/touched.test.ts
```

Use that example only if the installed script and runner support those arguments;
otherwise select their documented equivalent. Do not nest `fleet-heavy`, increase
workers, or broaden into a full suite/build/browser round to fill idle time.

Stop after relevant checks pass unless edits, failures, or unresolved concerns justify
another run. Report actual commands/results, scope, skipped checks, and CI status to
the parent. Use [ship](../ship/SKILL.md) for draft PR handoff. Keep temporary evidence
outside git and changes within the issue's named files.
