<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/quits-wordmark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/quits-wordmark-light.svg">
    <img src=".github/assets/quits-wordmark-light.svg" alt="quits." width="200">
  </picture>
</p>

<!-- PNG fallback (2× retina, 400px wide → display at 200px):
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/quits-wordmark-dark.png">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/quits-wordmark-light.png">
    <img src=".github/assets/quits-wordmark-light.png" alt="quits." width="200">
  </picture>
</p>
-->

> [!NOTE]
> Quits is pre-1.0 and under active development, so breaking changes to data, config and APIs may happen until 1.0.
> The hosted version at [quits.dev](https://quits.dev) is not open yet; you can join the waitlist there.

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
- [Vite+](https://viteplus.dev) — Vite, Vitest, linting, formatting, and workspace tasks

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

3. Copy the env file and fill in values:

   ```bash
   cp .env.example .env
   ```

   Ordinary commands in Git worktrees fall back to the main repository's `.env`.
   Worktree Dev and Setup below require explicit process environment settings and skip that fallback.

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

   After the first server request, `bun run dev` also runs the scheduler. Each tick runs the
   same tasks as `/api/cron/tick`, including due jobs and retries, then waits five seconds
   before the next tick. It uses the dev server's database and email configuration, so use
   an isolated local database and test email recipients. No cron secret is needed for this
   in-process runner. Set `QUITS_DEV_SCHEDULER=false` to turn it off. Production builds,
   tests, and direct Vite servers do not enable it; production still needs its cron trigger.

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

### Isolated worktrees in T3 Code

For 60fps route recordings and before/after motion comparisons, see
[Record motion for design review](docs/recording-motion.md).

Run `bun install --frozen-lockfile` in each new worktree before Setup Worktree.
Install Bun and PostgreSQL `psql`, `createdb`, and `dropdb`. Supply
`QUITS_WORKTREE_POSTGRES_URL` explicitly in the process environment: a loopback
Postgres URL with a user, `/postgres`, and no query or fragment. Supply the other
required app settings there too. Setup and Dev never load a workspace `.env`.
Setup allocates port 3100+N and a database with a random allocation suffix, then
migrates it. Dev refuses incomplete setup and uses that port and auth origin.
Setup does not seed data; the Danish fixture is a separate follow-up.

The common Git registry serializes setup, migrations, dev checks, and teardown.
A timeout means retry after the current operation finishes. A crashed holder's
lock requires manual recovery only after confirming all setup/dev/teardown
processes for this clone stopped. Back up the registry before changing it.
A creation attempt is recorded before `createdb`; only a matching database
ownership comment permits retry, migration, or manual Teardown Worktree.
A crash before that comment leaves an unverified database: do not mark it owned.
Have its owner reconcile the database and registry manually. Legacy allocations
also require manual recovery. Teardown never adopts an unverified database.

### Self-Hosting with Docker

```bash
# Clone the repo
git clone https://github.com/tielemans-dev/quits-oss.git
cd quits-oss

# Set your secrets
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .env
echo "CRON_SECRET=$(openssl rand -base64 32)" >> .env

# Start
docker compose up -d
```

The app will be available at [http://localhost:3000](http://localhost:3000).

### Scheduled Work

Quits runs its automation from one idempotent endpoint, `/api/cron/tick`, protected by
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
*/5 * * * * curl -fsS --connect-timeout 10 --max-time 240 -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-quits-host/api/cron/tick
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
- Stable consumer entrypoints are exposed through the versioned `@quits/oss` release artifact export surface.
- Hosted cloud-specific modules (managed billing/webhooks/infra) belong to a private `quits-cloud` repository.
- Ownership and constraints are documented in `docs/architecture/oss-cloud-boundary.md`.
- Release and cutover checklist is documented in `docs/releases/oss-v1-cutover.md`.

## Local commit hook

`bun install` leaves Git hooks untouched. The root `trustedDependencies` allowlist
permits Prisma's runtime checks and engine download and esbuild's binary setup;
it excludes Lefthook's automatic hook installation. This explicit list replaces
Bun's default trust list. When adding a dependency that needs an install script,
review its script and add the package to `trustedDependencies` if required.
Transitive native dependencies need the same review.

To opt in after installing dependencies, first check for an existing hook manager
or custom `core.hooksPath`. Use one hook manager. Then run `bun run hooks:install`
from the repository root to install or refresh Lefthook's pre-commit hook.

The hook runs `bun run lint:staged`, which checks added, copied, modified, and
renamed JavaScript and TypeScript files with the repository's Oxlint settings.
Deleted files and commits without source changes skip lint. Filenames with spaces,
quotes, or newlines are passed as individual arguments. The runner uses the
repository root even when called from another directory. It invokes only the
installed Oxlint binary and never runs the full lint script or downloads tools.

Stage all changes to each source file before committing, or unstage that file.
The hook rejects partial staging, missing working files, and source symlinks;
it does not stash, fix, or stage changes. A lint failure blocks the commit.
Correct the file, stage it again, and retry. CI still owns the full quality gates.
The installed hook uses `scripts/lefthook.sh` to disable Lefthook's automatic
hiding of unstaged changes. For a manual hook run, use
`sh scripts/lefthook.sh run pre-commit` from the root.

To remove this checkout's Lefthook hooks, run `bunx --no-install lefthook uninstall`
from the root. Git worktrees may share their hooks directory, so coordinate
installation and removal with other checkouts. Inspect the hooks directory with
`git rev-parse --git-path hooks` and any override with `git config --get core.hooksPath`.

## Testing

Run the standard test suite:

```bash
bun run test
```

Build, test, integration-test and typecheck commands generate the Prisma client
first, including on a fresh checkout or a repeated root command. Before running
Vitest, TypeScript or `knip:report` directly in a fresh checkout, run
`bun run prisma:generate` from the repository root once; direct tools bypass the
package-script preparation hooks. Root commands that already generated the client
pass `QUITS_PRISMA_PREGENERATED=1` so the app hook skips duplicate work. Direct app
commands still generate; leave this internal flag unset when invoking them.

Run the repo quality gates:

```bash
bun run lint
bun run typecheck
```

Run the full application TypeScript backlog check:

```bash
bun run typecheck:app
```

### Unused code report

After installing dependencies, run Knip from the repository root:

```bash
bun run knip:report
```

This opt-in command reports unused files, exports, and dependencies. Findings
return exit code zero through Knip's `--no-exit-code` option. Invalid configuration,
missing tooling, and execution failures still return a nonzero exit code. The
report is separate from lint, builds, CI gates, and app startup. It does not fix
or delete code.

`knip.json` covers the app, contracts, shared helpers, and repository scripts.
Package manifest exports remain public entrypoints. App routes, tests, config
files, and standalone automation scripts are additional entrypoints. Generated
Prisma code is outside the project globs. Vendored UI component exports and types
are omitted from unused-member findings; their dependency imports are still checked.
Dependencies imported only by unused files can still appear unused in the report.
The app package ships all of `src`, including the vendored form and chart components.
Keep `react-hook-form` and `recharts` while those published files import them.
The two `qui56-baseline-*` capture imports are local Vite aliases and are excluded
from dependency findings.

The app's Vite, Prisma, Playwright, and Vitest plugins are disabled because loading
their executable configs can load environment files or initialize development
services. Knip analyzes their source imports instead. Config-only string references,
dynamic imports, external package consumers, and runtime extensions can cause
false positives. Review each finding before removing anything; entrypoint exports
and generated code are outside this report's unused-export coverage.

Run the DB-backed invoice/quote smoke flow (create/edit/send/convert) against your local PostgreSQL configured in `.env`:

```bash
bun run test:integration
```

Run the browser smoke suite against a local PostgreSQL and app server:

```bash
bun run test:e2e
```

## Bun-Only Repo

Vite+ supplies the local `vp` CLI. Bun remains the package manager; no global Vite+
installation or account is needed. Use a Node.js version accepted by `engines.node`
in the root `package.json`.

`bun run build`, `bun run typecheck`, and `bun run test` run workspace tasks through
`vp run`. Tasks run without caching so database tests and environment-sensitive
builds always execute. The root task is excluded from recursive selection to keep
Prisma generation running once per command.

`bun run lint` uses the bundled Oxlint and the existing motion check. `bun run fmt`
formats files, and `bun run fmt:check` checks formatting. Pass paths to format only
the files you changed. Existing files are not reformatted by this migration.

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
| `QUITS_REMINDER_UNSUBSCRIBE_SECRET` | Optional stable signing key for reminder preference links, at least 32 characters. Falls back to `BETTER_AUTH_SECRET`. Rotating the signing key invalidates existing links; stored opt-outs remain unchanged. | No |
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
| `CRON_SECRET` | Bearer token required by `/api/cron/tick` and `/api/cron/mark-overdue` | Yes (prod) |
| `QUITS_DISTRIBUTION` | Runtime distribution (`selfhost` or `cloud`) | No (defaults to `selfhost`) |
| `QUITS_COMPANY_RESEARCH_AI_ENABLED` | Opts into background onboarding suggestions from public company text supplied by a trusted `CvrLookupProvider.researchSources` adapter. Uses the configured AI provider and hosted AI drafts setting; industry defaults need no model | No (defaults to `false`) |
| `QUITS_ONBOARDING_AI_ENABLED` | Enables cloud onboarding AI endpoints | No (defaults by distribution) |
| `QUITS_ONBOARDING_AI_MANAGED_ENABLED` | Marks onboarding AI as managed capability | No (defaults by distribution) |
| `QUITS_AI_REQUEST_FALLBACK_ENABLED` | Suggests command-bar fields for unparsed requests using the organisation's configured AI provider. No provider is required while disabled | No (defaults to `false`) |
| `QUITS_AI_CUSTOM_ENDPOINT_ENABLED` | Lets organisations point invoice drafting at any OpenAI-compatible endpoint | No (`true` self-hosted, `false` cloud) |
| `QUITS_AI_CUSTOM_ENDPOINT_HOSTS` | Comma-separated hosts (optionally `host:port`) that custom AI endpoints may use, e.g. `localhost:11434,llm.internal`. When unset, any host is allowed. Set it on installs shared by several organisations, because an organisation admin can otherwise make the server send requests to any address it can reach | No |
| `QUITS_AI_LOCAL_AGENT_ENABLED` | Lets organisations draft invoices with a CLI agent on the server; needs `QUITS_AI_LOCAL_AGENT_COMMAND` | No (defaults to `false`, self-hosted only) |
| `QUITS_AI_LOCAL_AGENT_COMMAND` | Command that runs the agent, e.g. `claude -p --tools "" --strict-mcp-config`. It must not be able to use tools; see below. The prompt is sent on stdin; the command is split on whitespace with simple quotes and run without a shell | Only when `QUITS_AI_LOCAL_AGENT_ENABLED=true` |
| `QUITS_AI_LOCAL_AGENT_TIMEOUT_MS` | Time limit for one agent call in milliseconds, clamped to 5000–600000 | No (defaults to `120000`) |
| `QUITS_AI_LOCAL_AGENT_MAX_CONCURRENT` | How many agent runs may be in progress at once; further requests are refused until one finishes. Capped at 16 | No (defaults to `2`) |

The local agent runs the CLI as the user the server process runs as, so that agent must be installed
and logged in for that user. It uses the operator's own agent subscription, not a per-organisation
key. It generally does not work inside the stock Docker image, because the image has no agent CLI and
no login for it. On Windows, point the command at the agent's executable rather than a `.cmd` or `.bat` shim, because the command is never run through a shell.

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

### Document artifacts

Self-hosted servers render invoice, credit note and agreement PDFs on the server and keep the
issued bytes in `QUITS_ARTIFACT_DIR`. `YAIP_ARTIFACT_DIR` remains a supported fallback. The default
is `./data/artifacts`, relative to the server's working directory. Persist and back up this directory
alongside the database. Docker Compose persists the default directory in its `artifacts` named
volume. Files use `<organization>/<kind>/<documentId>/<sha256>.pdf` paths,
with metadata alongside them. The server serves them only after checking the owner's session or
the customer's signed public link. Draft downloads render live. Older issued documents without
stored artifacts render live with `X-Quits-Artifact: reconstructed`.

Runtime hosts can supply `documentRenderer` and `documentArtifactStore` services to
`bootstrapQuitsRuntime`. This release advertises `documents.artifactsRequired: false`; hosts
without both adapters can still issue documents and record `document.artifact_missing`.

### SMTP email for self-hosting

Set `EMAIL_PROVIDER=smtp`, `SMTP_HOST`, and `FROM_EMAIL` to use your own relay. For
port 587, keep `SMTP_SECURE=false` and `SMTP_REQUIRE_TLS=true`. Leave `SMTP_PORT`
empty for automatic port selection. For port 465, set `SMTP_SECURE=true`. If you
override `SMTP_PORT`, pair `SMTP_PORT=587` with `SMTP_SECURE=false`, or
`SMTP_PORT=465` with `SMTP_SECURE=true`. TLS certificates are always validated.
`SMTP_USER` and `SMTP_PASS` are optional for a trusted relay; configure both when authentication
is required. `SMTP_PASSWORD` remains a compatibility alias for `SMTP_PASS`. Docker
Compose forwards these settings to the app.

For a development mail catcher such as Mailpit (port 1025) or a trusted local plaintext
relay, set its port and `SMTP_REQUIRE_TLS=false` (keep `SMTP_SECURE=false`), because the
default requires STARTTLS. Do not use plaintext for a relay reached over the internet.
When the app runs on the host, set `SMTP_HOST=127.0.0.1`, not `localhost`: `localhost`
may resolve to IPv6 `::1` first and time out if the catcher listens only on IPv4. When the
app runs in Compose, `127.0.0.1` is the app container itself; use the Mailpit service
name, or `host.docker.internal` when Mailpit runs on the host (Docker Desktop only; on
Docker Engine for Linux, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the
app service, or run Mailpit as a Compose service).
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
