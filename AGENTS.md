# AGENTS.md

Quits OSS is the public, self-hostable Quits core under FSL. It also publishes
`@quits/oss`, the app artifact used by the hosted service. Never describe Quits
as open source.

## Non-negotiables

- Preserve self-host viability. Invoicing, quotes, customer payments, contacts,
  exports, APIs, UI, Settings, and the app schema belong here. Hosted-only plan
  billing and infrastructure enforcement belong in the hosted lane. Stop before
  writing that code and ask the maintainer for the appropriate project.
- For work spanning both lanes, implement the general feature here behind runtime
  extension interfaces or capability patches and hand off hosted wiring after an
  OSS release. Never include private repository names, code, or infrastructure
  identifiers in this public repo.
- Preserve public exports unless the task explicitly changes the release contract.
  During file moves, preserve behavior first and improve structure second.
- Keep every user-facing flow inside the app, including onboarding and Settings.
  Hosted-only requirements use cloud flags and extension points. Self-hosters get
  no hosted gates.
- Prefer correctness and the smallest maintainable change. Make structural
  improvements explicit; share duplicated logic rather than add local variants.

## Glossary

- OSS means the self-hostable runtime, not a claim about the license.
- Hosted means the managed service consuming the published app artifact.
- `apps/oss` is the TanStack Start app and published `@quits/oss` package.
- `packages/contracts` holds schemas, branded identifiers, and DTOs only, with no
  runtime side effects. `packages/shared` exposes helpers through explicit subpaths.
- `scripts` holds shared repository automation and verification.
- A ready head is a commit with green CI and enough verification for review.

## Ways to hurt yourself

- Work in an isolated checkout or worktree on your own branch. In T3 Code, use
  your T3-created worktree. Respect the issue's named files and protected work.
  Do not edit another contributor's checkout.
- Never read `.env` files or print secrets. Do not reset shared databases or run
  migrations against live services. Use an isolated development database.
- Never merge, deploy, release, tag, enable auto-merge, push to main, or delete
  shared resources. Kai lands changes.
- Never @-mention Ines, Mira, Noah, Lumi, or Kai on GitHub, regardless of case.
  This includes PR bodies, comments, reviews, and issues. Write their names plainly;
  those handles ping unrelated people and the bots have no GitHub accounts.
- On managed maintainer workstations, follow the injected machine instructions
  before changing agent tools or configuration; those changes can propagate to
  other machines. External contributors need only this repository's setup.

## Hit every surface

Before calling work done, identify which entries apply and verify the changed
behavior on those entries. Coverage does not require unrelated tests.

- App UI, onboarding, Settings, and public document/payment pages; account for
  self-hosted and hosted capability states and supported languages.
- Document emails, PDFs, and exports; keep amounts, taxes, bank details, and line
  ordering consistent with the UI and persisted document data.
- Agent API and app API; preserve permissions, validation, and DTO contracts.
- Runtime extension interfaces, capability patches, and published package exports;
  keep the default self-hosted behavior usable without hosted integrations.
- Reverse states; when adding a way in, provide a way out and a way to see the
  current state. Check cancellation, failure, retry, and empty states as relevant.

## Dev

- Use `README.md` for prerequisites and environment variable definitions, and
  `package.json` and `apps/oss/package.json` for available scripts. Install with
  `bun install` from the repository root. No maintainer home-directory files or
  hosted checkout are required for self-hosted development.
- Before running `bun run dev` from the repository root, require an isolated local
  database configured through `DATABASE_URL`. The predev hook generates Prisma and
  applies migrations to `DATABASE_URL` via `scripts/predev-bootstrap.mjs` before
  starting the self-hosted app on port 3000. Worktrees can inherit the main
  checkout's environment file via `scripts/workspace-env.js`; a separate worktree
  does not isolate the database. Never start against a shared or live database.
  Avoid ports used by another task. Stop only processes you started, using the
  PIDs you tracked.
- Reuse existing UI components. When a task requires adding a shadcn component,
  follow its current CLI instructions within the authorized dependency scope.

## Verifying

Use the fast loop locally. CI owns the full lint, typecheck, test, build, and browser
suites. Do not run a full suite or build to prove a small change.

- For docs-only changes, run `git diff --check` and inspect the complete diff,
  pointers, required sections, and changed-line budget. No runtime checks needed.
- For behavior changes, run the smallest relevant failing test first, then only
  touched tests. From `apps/oss`, use `node ../../scripts/run-with-workspace-env.mjs
  bunx vitest run -c vitest.config.ts <test-file> --maxWorkers=1`. Use
  `vitest.global.config.ts` instead when that config owns the test.
- Direct `bunx vitest` needs the generated Prisma client. Run
  `bun run prisma:generate` from the root first. T3 worktree setup also
  generates the client.
- Lint changed source files with `bunx oxlint --deny-warnings
  --report-unused-disable-directives <changed-files>` from the owning workspace.
  For app types, use `bun run typecheck:app` from the root. For contracts, shared
  helpers, or scripts, use `bun run --cwd <workspace> typecheck`. The root
  `bun run typecheck` covers all workspaces and belongs in CI.
- Verify setup, auth, public document, payment, and document-sending changes with
  targeted browser checks when needed to prove the changed flow. On Omarchy,
  ask the parent orchestrator to schedule heavy verification. Launch blockers
  take priority; do not run heavy checks alongside their work.
- On managed maintainer workstations, follow injected resource limits and queue
  instructions for heavy commands. External contributors use the repo-local
  commands above; no workstation-specific wrapper is required.
- For packaging or CI changes, verify the affected local script and workflow
  command paths. Report actual checks, omissions, and CI status separately.

## PR rules

- Use conventional commit titles in plain language. One issue is one focused PR.
  Keep additions plus deletions at or below 400 lines, excluding generated files,
  lockfiles, and migrations. Split larger work before pushing it for review.
- Commit and push only your own branch when authorized. Open a draft PR and keep
  it draft until CI is green. Never bypass failing checks to declare work ready.
- Follow `.github/pull_request_template.md`: Problem, Change, Linear,
  Verification, Risk, and Agent. Use `Fixes QUI-<issue number>` for the issue.
  Agent ends the body with Model, Harness, Orchestrator, and Thread metadata.
  Never add AI coauthor trailers or generated-by attribution to commits or PRs.
- UI changes need before/after images; motion needs a short video. Upload PR-only
  assets to GitHub rather than committing them.
- The parent orchestrator schedules review with Claude Sonnet or Opus for a Codex
  implementer. The reviewer model must differ from the implementer. Implementers
  do not request or perform their own review. Review once per ready head, not
  after every push, with at most three rounds.
- A clean rebase that retains the patch ID retains its review verdict. After a
  conflict resolution, verify the conflict delta and review changed behavior;
  do not restart unrelated verification or review without a reason.
- Link the PR to the implementing thread and parent. Once pushed and CI starts,
  send the parent a concise status with PR, head, worktree, actual verification,
  and risks. Use T3's PR watch for updates and end the turn; do not poll.

## Docs rules

- Copy changes: `bun run i18n:check` also runs the copy gates (Danish values left as English, glossary
  wording). Rules and allowlists are in `scripts/i18n/copy-rules.json`; opt out inline with
  `// copy-check: allow <rule-id> <reason>`. Reviewers: when a diff changes price, trial, non-VAT or B2B
  wording or behavior, check `docs/public-promises.md`.

- Do not hardcode version strings in prose; use package metadata as the authority.
- Keep plans, evidence dumps, research notes, scratch files, and PR-only assets
  out of git. Write local captures to `.artifacts/`; upload CI captures as job
  artifacts. The issue and merged PR hold the implementation record.
- Document decisions, cross-cutting constraints, and traps the code does not
  reveal. Rewrite or remove stale guidance rather than append a second account.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
