# YAIP — Yet Another Invoicing App

Source-available invoicing for freelancers and small businesses.

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
   git clone https://github.com/yourusername/yaip.git
   cd yaip
   ```

2. Install dependencies:

   ```bash
   bun install
   ```

3. Copy the env file and fill in values:

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
git clone https://github.com/yourusername/yaip.git
cd yaip

# Set your secrets
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .env
echo "CRON_SECRET=$(openssl rand -base64 32)" >> .env

# Start
docker compose up -d
```

The app will be available at [http://localhost:3000](http://localhost:3000).

### Scheduled Work

YAIP runs its automation from one idempotent endpoint, `/api/cron/tick`, protected by
`Authorization: Bearer $CRON_SECRET`. Each tick, in order:

1. marks issued invoices with a balance due past their due date as overdue,
2. schedules and sends due payment reminders (configure them in **Settings → Payment reminders**),
3. generates due recurring invoices,
4. finishes agent approvals interrupted by a restart,
5. runs queued background jobs: reminder emails, auto-sent recurring invoices, and retries.

`docker compose up` starts a small `scheduler` service that calls the tick every five minutes
(`TICK_INTERVAL_SECONDS` overrides the interval, `TICK_TIMEOUT_SECONDS` the per-request timeout,
240 seconds by default). `CRON_SECRET` is required: set it in `.env` to a random value, and the app
and the scheduler read the same value. Compose refuses to start without it, and the cron endpoints
answer `503` while it is unset or still the placeholder `change-me-in-production`. Without Docker,
call the endpoint from any scheduler, for example cron:

```bash
*/5 * * * * curl -fsS --connect-timeout 10 --max-time 240 -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-yaip-host/api/cron/tick
```

The tick answers `200` with `ok: true` when every task succeeded, and `500` with `ok: false`, the
names of the failed tasks in `failedTasks`, and every task's result when any task failed, so a
monitor or `curl -f` notices. Deliveries that failed but will be retried (for example a brief email
provider outage) are listed in `retryingTasks` and still answer `200`; a delivery that runs out of
retries counts as failed. Each tick does a bounded amount of work (a few hundred invoices per
organization and task, within a time budget), so a large backlog drains over several ticks
instead of making one tick time out. Ticks can overlap or be retried safely: each reminder is sent
at most once, and a reminder policy enabled late sends only the most recent due reminder instead
of the whole backlog. `/api/cron/mark-overdue` remains as a legacy alias that only marks overdue
invoices.

## OSS and Cloud Split

- This repository is the OSS runtime baseline.
- This repository now also owns the versioned app artifact consumed by hosted cloud builds.
- Stable consumer entrypoints are exposed through the versioned `@yaip/oss` release artifact export surface.
- Hosted cloud-specific modules (managed billing/webhooks/infra) belong to a private `yaip-cloud` repository.
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

Run the browser smoke suite against a local PostgreSQL and app server:

```bash
bun run test:e2e
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
| `CRON_SECRET` | Bearer token required by `/api/cron/tick` and `/api/cron/mark-overdue` | Yes (prod) |
| `YAIP_DISTRIBUTION` | Runtime distribution (`selfhost` or `cloud`) | No (defaults to `selfhost`) |
| `YAIP_ONBOARDING_AI_ENABLED` | Enables cloud onboarding AI endpoints | No (defaults by distribution) |
| `YAIP_ONBOARDING_AI_MANAGED_ENABLED` | Marks onboarding AI as managed capability | No (defaults by distribution) |

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

See [CONTRIBUTING.md](CONTRIBUTING.md) for OSS/cloud boundary and PR policy.
Repository-local coding agent instructions live in `AGENTS.md` and `CLAUDE.md`.

## License

[PolyForm Noncommercial 1.0.0](LICENSE)
