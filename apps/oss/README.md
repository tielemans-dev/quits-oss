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

### Password recovery

Password recovery uses Better Auth's verification records and the installation email sender. Reset links expire after 30 minutes. A successful reset consumes the link and revokes existing sessions. Database admission limits are shared across app instances.

The Node runtime uses the direct connection address for recovery limits and ignores forwarding headers. If no peer address is available, requests share a conservative bucket. Deployments behind a trusted proxy can provide `AuthHooks.getRecoveryClientKey` using metadata that the proxy overwrites. Do not read an arbitrary client-supplied forwarding header.

Long-running Node processes keep reset email delivery in the background. Runtimes with request-scoped lifetimes must provide `AuthHooks.runInBackground` to keep the delivery task alive after the response. Custom auth adapters must provide `createTransactionDatabaseAdapter` bound only to the supplied transaction client.

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
| `EMAIL_PROVIDER` | `resend` (default) or `smtp`; SMTP requires Node/Bun | No |
| `RESEND_API_KEY` | Resend API key, required when sending through Resend | No |
| `SMTP_HOST` | SMTP relay hostname, required with `EMAIL_PROVIDER=smtp` | No |
| `SMTP_PORT` | Relay port; defaults to 587, or 465 when `SMTP_SECURE=true` | No |
| `SMTP_SECURE` | `true` for implicit TLS, `false` for STARTTLS (default) | No |
| `SMTP_REQUIRE_TLS` | Require STARTTLS; defaults to `true` for non-implicit TLS | No |
| `SMTP_USER`, `SMTP_PASS` | Optional relay authentication; set both or neither | No |
| `SMTP_PASSWORD` | Compatibility alias for `SMTP_PASS`; `SMTP_PASS` takes precedence when nonempty | No |
| `FROM_EMAIL` | Sender email address used for outgoing emails | No |
| `CRON_SECRET` | Bearer token required by `/api/cron/tick` (and the legacy `/api/cron/mark-overdue`); the bundled `scheduler` service calls the tick every 5 minutes | Yes (prod) |
| `QUITS_DISTRIBUTION` | Runtime distribution (`selfhost` or `cloud`) | No (defaults to `selfhost`) |
| `QUITS_ONBOARDING_AI_ENABLED` | Enables cloud onboarding AI endpoints | No (defaults by distribution) |
| `QUITS_ONBOARDING_AI_MANAGED_ENABLED` | Marks onboarding AI as managed capability | No (defaults by distribution) |
| `QUITS_AI_CUSTOM_ENDPOINT_ENABLED` | Lets organisations point invoice drafting at any OpenAI-compatible endpoint | No (`true` self-hosted, `false` cloud) |
| `QUITS_AI_LOCAL_AGENT_ENABLED` | Lets organisations draft invoices with a CLI agent on the server; needs `QUITS_AI_LOCAL_AGENT_COMMAND` | No (defaults to `false`, self-hosted only) |
| `QUITS_AI_LOCAL_AGENT_COMMAND` | Command that runs the agent, e.g. `claude -p --tools "" --strict-mcp-config`. It must not be able to use tools; see below. The prompt is sent on stdin; the command is split on whitespace with simple quotes and run without a shell | Only when `QUITS_AI_LOCAL_AGENT_ENABLED=true` |
| `QUITS_AI_LOCAL_AGENT_TIMEOUT_MS` | Time limit for one agent call in milliseconds, clamped to 5000–600000 | No (defaults to `120000`) |

The local agent runs the CLI as the user the server process runs as, so that agent must be installed
and logged in for that user. It uses the operator's own agent subscription, not a per-organisation
key. It generally does not work inside the stock Docker image, because the image has no agent CLI and
no login for it.

**Treat the local agent as untrusted.** Any member who can create invoices writes part of its prompt,
and a prompt can tell an agent to read files, use its login or run commands. The server only removes
its own secrets from the agent's environment; it does not sandbox the process. Configure a command
that cannot use tools, such as `claude -p --tools "" --strict-mcp-config`. For agents without a
reliable no-tools mode, such as `codex exec`, point the command at a wrapper script that runs the
agent in a container or sandbox with no network access beyond its model API and no access to the
server's files.

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

### SMTP email for self-hosting

Set `EMAIL_PROVIDER=smtp`, `SMTP_HOST`, and `FROM_EMAIL` to use your own relay. For
port 587, keep `SMTP_SECURE=false` and `SMTP_REQUIRE_TLS=true`. Leave `SMTP_PORT`
empty for automatic port selection. For port 465, set `SMTP_SECURE=true`. If you
override `SMTP_PORT`, pair `SMTP_PORT=587` with `SMTP_SECURE=false`, or
`SMTP_PORT=465` with `SMTP_SECURE=true`. TLS certificates are always validated.
`SMTP_USER` and `SMTP_PASS` are optional for a trusted relay; configure both when authentication
is required. `SMTP_PASSWORD` remains a compatibility alias for `SMTP_PASS`. Docker
Compose forwards these settings to the app.

For a development mail catcher or a trusted local plaintext relay, set its port and
`SMTP_REQUIRE_TLS=false`. Do not use plaintext for a relay reached over the internet.
Settings shows missing or invalid SMTP configuration using environment variable names;
it never returns relay credentials. Configuration readiness does not test relay connectivity.

SMTP is supported by the Node/Bun self-host runtime. Worker runtimes continue to use
Resend. Selecting SMTP on a Worker reports delivery unavailable and identifies
`EMAIL_PROVIDER` as the setting to change before sending documents. Nodemailer loads
only when SMTP is selected, so Worker builds do not include its socket modules.
All email helpers, including organization invitations, use the selected provider.
SMTP supports rendered HTML or text and inline attachments.

SMTP servers do not deduplicate email by an idempotency key or Message-ID. If a
connection is lost after submission, the outbox records the delivery as unconfirmed
and stops automatic retries. The customer may have received the message. Check your
relay's logs before choosing to resend it. Explicit server refusals, DNS failures,
refused connections, and initial connection or greeting timeouts record a failed
send and leave drafts editable. A relay that accepts only some recipients records an unconfirmed delivery and
stops retries, because retrying could duplicate the recipients it accepted. Fully
accepted messages settle without contacting the relay again. Resend keeps its
existing idempotent retry behavior. A queued delivery keeps the provider recorded
before its first submission even if deployment settings later change.

### Password recovery behind a reverse proxy

Recovery admission uses the actual direct connection peer by default and ignores
forwarding headers. If your Node/Bun deployment sits behind a reverse proxy, set
`QUITS_AUTH_TRUSTED_PROXIES` to a comma-separated list of its literal IP addresses
or CIDR ranges (for example `127.0.0.1,::1,10.20.0.0/24`). Docker Compose passes
this setting through. `YAIP_AUTH_TRUSTED_PROXIES` remains an alias.

Only allow networks controlled by your proxy infrastructure. The proxy must append
the actual connecting address to `X-Forwarded-For` or replace that header with a
verified chain. Quits walks the chain from right to left, skipping trusted proxy
hops and using the first untrusted address. Headers from untrusted direct peers
are ignored. Do not allow arbitrary client networks or `0.0.0.0/0`. If the direct
peer cannot be determined, recovery uses one conservative shared bucket.

Password-reset requests are limited to three per minute per client, and reset
attempts to five. The counters use atomic database admission across instances.
A successful reset revokes sessions and all outstanding reset links for that user
in the same transaction. Requesting a fresh link after that reset remains possible.
