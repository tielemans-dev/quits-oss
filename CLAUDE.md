# AGENTS.md

## Task Completion Requirements

- `bun run lint` must pass before considering work complete.
- `bun run typecheck` must pass before considering work complete.
- Use `bun run typecheck:app` when working in the application surface that still carries legacy TypeScript backlog.
- `bun run test` must pass before considering behavior work complete.
- Run targeted browser verification when changing setup, auth, public document, payment, or document-sending flows.

## Project Snapshot

Quits OSS is the self-deployable runtime baseline for Quits. This repository also produces the versioned app artifact consumed by hosted cloud builds.

## Core Priorities

1. Preserve OSS/cloud boundaries.
2. Prefer correctness over convenience.
3. Keep the published `@quits/oss` surface stable while refactoring internals.
4. Make maintainability improvements explicit instead of hiding them in local shortcuts.

## Package Roles

- `apps/oss`: The TanStack Start application package and published `@quits/oss` artifact.
- `packages/contracts`: Shared schemas, branded identifiers, and DTO contracts only. No runtime side effects.
- `packages/shared`: Shared helpers with explicit subpath exports.
- `scripts`: Shared repository automation and verification scripts.

## OSS/Cloud Boundary

- Hosted-only billing lifecycle behavior and cloud infrastructure enforcement stay outside this repository.
- Use runtime extension interfaces and capability patches for cloud-specific behavior.
- Do not weaken self-host viability to make hosted behavior easier.

## Migration Rules

- When moving files, preserve behavior first and improve structure second.
- Keep public exports stable unless the task explicitly changes the release surface.
- Prefer extracting duplicated logic into a shared module over adding one-off local variants.

## Verification Expectations

- For documentation-only changes, verify the diff is scoped correctly.
- For runtime changes, run the smallest relevant failing test first, then the targeted suite, then broader verification.
- For packaging or CI changes, verify both local scripts and workflow command paths.
