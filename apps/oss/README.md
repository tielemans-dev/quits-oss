# Quits

Source-available invoicing for freelancers and small businesses.

> **Upgrading from YAIP?** Quits was previously called YAIP. Nothing needs to change to upgrade:
> `YAIP_*` environment variables are still read when the matching `QUITS_*` variable is not set,
> and agent keys starting with `yaip_ak_` keep working (new keys start with `quits_ak_`). The
> packages are now published as `@quits/*`. Database names and credentials are unchanged.

## Features

- **Invoicing** — Create, send, track, and download invoices as PDF
- **Quotes** — Create quotes and convert them to invoices with one click
- **Contacts** — Manage your customer database
- **Dashboard** — Financial overview with stats and recent activity
- **Organizations** — Multi-user support with roles (admin, member, accountant)
- **Self-hosted** — Deploy anywhere with Docker Compose

## Tech Stack

- [TanStack Start](https://tanstack.com/start) — Full-stack React framework
- [tRPC](https://trpc.io) — Type-safe API layer
- [Prisma](https://www.prisma.io) + PostgreSQL — Database ORM
- [Better Auth](https://www.better-auth.com) — Authentication with organization support
- [shadcn/ui](https://ui.shadcn.com) + Tailwind CSS — UI components
- [Turbo](https://turbo.build/repo) — Repository task orchestration

## Getting Started

### Prerequisites

- Bun 1.3.9 (see `.bun-version`)
- PostgreSQL (or Docker)

### Development Setup

1. Clone the repo:

   ```bash
   git clone https://github.com/tielemans-dev/quits-oss.git
   cd quits-oss
   ```

2. Install dependencies:

   ```bash
   bun install
   ```

3. From the workspace root, copy the env file and fill in values:

   ```bash
   cp .env.example .env
   ```

   Git worktrees also fall back to the main repository's `.env` if the worktree does not have its own copy.

   Generate a secure auth secret:

   ```bash
   openssl rand -base64 32
   ```

4. If `DATABASE_URL` points to localhost, Docker will be used to auto-start Postgres when running `bun run dev`.
   You can still start it manually:

   ```bash
   docker run -d --name yaip-postgres \
     -e POSTGRES_USER=postgres \
     -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=yaip \
     -p 5432:5432 \
     postgres:16-alpine
   ```

5. Start the dev server:

   ```bash
   bun run dev
   ```

   `bun run dev` now runs a preflight that applies Prisma migrations automatically.
   In `yaip-oss`, this command is pinned to `selfhost` distribution mode.

6. If you want the full hosted simulation (cloud shell + cloud-configured OSS), run this from the workspace root:

   ```bash
   cd /path/to/yaip
   bun run dev
   ```

   Then use:
   - `http://yaip.localhost:3000` for `yaip-cloud`
   - `http://app.yaip.localhost:3000` for cloud-configured `yaip-oss`
   - `http://localhost:3000` and `http://app.localhost:3000` will redirect to the canonical hosts above

7. Open [http://localhost:3000](http://localhost:3000)

### Self-Hosting with Docker

```bash
# Clone the repo
git clone https://github.com/tielemans-dev/quits-oss.git
cd quits-oss

# Set your secrets
echo 'BETTER_AUTH_SECRET=your-secret-here' > .env

# Start
docker compose up -d
```

The app will be available at [http://localhost:3000](http://localhost:3000).

## OSS and Cloud Split

- This repository is the OSS runtime baseline.
- This repository now also owns the versioned app artifact consumed by hosted cloud builds.
- Stable consumer entrypoints are exposed through the versioned `@quits/oss` release artifact export surface.
- Hosted cloud-specific modules (managed billing/webhooks/infra) belong to a private `quits-cloud` repository.
- Ownership and constraints are documented in `docs/architecture/oss-cloud-boundary.md`.
- Release and cutover checklist is documented in `docs/releases/oss-v1-cutover.md`.

## Testing

Run the standard test suite:

```bash
bun run test
```

Run the repo quality gates:

```bash
bun run lint
bun run typecheck
```

Run the full application TypeScript backlog check:

```bash
bun run typecheck:app
```

Run the DB-backed invoice/quote smoke flow (create/edit/send/convert) against your local PostgreSQL configured in `.env`:

```bash
bun run test:integration
```

## Bun-Only Repo

This repository is Bun-native. Use `bun install` and `bun run ...` commands for local development, CI reproduction, and self-host deployment workflows.

## Onboarding Behavior

- `selfhost` distribution keeps onboarding manual and local.
- `cloud` distribution hard-blocks invoice/quote creation until organization onboarding is complete.
- Completion requires invoice-readiness fields (company identity, locale/timezone/currency, tax regime, numbering defaults).
- Cloud-only onboarding AI endpoints are available under `onboardingAi.*` and only suggest/apply patches through the same canonical readiness checks.

## Environment Variables

| Variable | Description | Required |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `BETTER_AUTH_SECRET` | Secret for auth (min 32 chars) | Yes |
| `BETTER_AUTH_URL` | App URL (e.g. `http://localhost:3000`) | Yes |
| `BETTER_AUTH_GOOGLE_CLIENT_ID` | Google OAuth client ID (optional) | No |
| `BETTER_AUTH_GOOGLE_CLIENT_SECRET` | Google OAuth client secret (optional) | No |
| `BETTER_AUTH_GITHUB_CLIENT_ID` | GitHub OAuth client ID (optional) | No |
| `BETTER_AUTH_GITHUB_CLIENT_SECRET` | GitHub OAuth client secret (optional) | No |
| `RESEND_API_KEY` | Resend API key for sending invoice/quote/invite emails | No |
| `FROM_EMAIL` | Sender email address used for outgoing emails | No |
| `CRON_SECRET` | Bearer token required by `/api/cron/tick` (and the legacy `/api/cron/mark-overdue`); the bundled `scheduler` service calls the tick every 5 minutes | Yes (prod) |
| `QUITS_DISTRIBUTION` | Runtime distribution (`selfhost` or `cloud`) | No (defaults to `selfhost`) |
| `QUITS_ONBOARDING_AI_ENABLED` | Enables cloud onboarding AI endpoints | No (defaults by distribution) |
| `QUITS_ONBOARDING_AI_MANAGED_ENABLED` | Marks onboarding AI as managed capability | No (defaults by distribution) |

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

See [CONTRIBUTING.md](CONTRIBUTING.md) for OSS/cloud boundary and PR policy.
Repository-local coding agent instructions live in `AGENTS.md` and `CLAUDE.md`.

## License

[Functional Source License 1.1, Apache-2.0 future license (FSL-1.1-ALv2)](LICENSE).

Quits is source available. You can self-host it for your own business, inspect the code,
modify it and contribute. The license restricts competing commercial uses. Each version
becomes available under Apache-2.0 two years after its publication under FSL.
Previously published releases retain their original license.
