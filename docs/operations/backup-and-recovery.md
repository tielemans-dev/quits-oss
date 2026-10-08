# Backup, restore rehearsal and cutover

This guide is for people who run Quits themselves. It shows how to take a backup that you can
check, how to prove on a spare machine that the backup restores usable invoices, documents and
balances, and how to switch over to a restored installation safely.

A restored installation **starts with operations held**: it sends no email, takes no payments,
makes no AI requests and runs no scheduled work or queued jobs, even if the backup contained
pending jobs and the machine has working mail settings. You end the hold yourself, after reviewing
what is pending.

This is an operations aid. It is not an archival or compliance certification, and it does not
replace keeping copies of your backups in more than one place.

## What a useful recovery needs

| Needed | Where it lives | In the bundle? |
| --- | --- | --- |
| Invoices, quotes, credit notes, payments, agreements, contacts, settings, users, activity history, queued jobs | PostgreSQL | Yes, as one file per table |
| Issued PDFs and e-invoices | The artifact directory (`QUITS_ARTIFACT_DIR`, default `./data/artifacts`; the `artifacts` volume in Docker Compose) | Yes, each verified against the hash recorded when it was issued |
| `BETTER_AUTH_SECRET` | Your environment | **No.** Needed to read stored provider secrets. Keep it separately |
| `QUITS_PUBLIC_PAYMENT_SECRET`, `QUITS_PUBLIC_QUOTE_SECRET`, `QUITS_PUBLIC_AGREEMENT_SECRET` | Your environment (each falls back to `BETTER_AUTH_SECRET`) | **No.** Needed so links already sent to customers still work. Keep them separately |
| Mail settings (`EMAIL_PROVIDER`, `RESEND_API_KEY` or `SMTP_*`, `FROM_EMAIL`), `BETTER_AUTH_URL`, `CRON_SECRET` | Your environment | **No** (the manifest records which were set, never their values) |

The bundle leaves out sign-in sessions, pending password-reset tokens, rate-limit counters and
scheduler claims. Everyone signs in again after a restore. OAuth tokens saved for social sign-in
are blanked. Password hashes and encrypted provider secrets (Stripe, AI) **are** in the bundle, so
store it as carefully as the database itself, and keep it on encrypted storage.

The manifest records a short keyed fingerprint of each key, never the key. A restore compares the
fingerprints with the keys it is given, and also checks that every stored provider secret decrypts.

## Commands

The `recovery` tool is part of the app. With a source checkout, run it from `apps/oss`
(`bun run recovery <command>`). With Docker Compose, run it in a one-off container; this example
mounts `./backups` for the bundle:

```sh
docker compose run --rm --no-deps -v "$PWD/backups:/backups" -w /app/apps/oss --entrypoint bun app \
  src/selfhost/recovery/cli.ts <command>
```

The examples below write `recovery <command>` for either form.

| Command | What it does |
| --- | --- |
| `recovery prerequisites` | Checks the database, migrations, `BETTER_AUTH_SECRET` and artifact directory, and lists the settings the source relied on |
| `recovery backup create --out DIR` | Writes a bundle from a consistent snapshot and verifies it |
| `recovery backup verify DIR [--record]` | Checks a bundle against its manifest. Needs no database unless you pass `--record` |
| `recovery restore DIR [--dry-run]` | Restores into an **empty, migrated** database and artifact directory, then proves the result |
| `recovery status` | Backup age, artifact completeness, scheduler and mail health |
| `recovery review` | Lists pending work and prints the token that `enable-operations` needs |
| `recovery enable-operations` | Ends the hold |

Add `--json` for machine-readable output. Exit status is 0 on success, 1 on a failed check, 2 on
misuse. `--database-url` and `--artifact-dir` override `DATABASE_URL` and `QUITS_ARTIFACT_DIR`.

## 1. Take and verify a backup

```sh
recovery backup create --out /backups/quits-2026-10-08
recovery backup verify /backups/quits-2026-10-08 --record
```

`backup create` reads the database in one read-only transaction, so tables, totals and pending work
describe the same instant, and the app can keep running. It refuses to overwrite an existing
directory. If an issued document's PDF is missing from the artifact directory, or does not match
its recorded hash, the backup stops and names the document; `--allow-incomplete` records the gap
and continues.

It prints the **manifest SHA-256**. Write it down somewhere other than the bundle. Verification
detects damage, truncation and missing files by itself; the saved digest is what detects a bundle
that was replaced along with its manifest.

The manifest records: the format version, the Quits version and migrations of the source, row
counts and a SHA-256 for every table file, every artifact with its hash and the document that owns
it, **invoice, credit-note and payment totals per currency**, which keys and settings were present,
and the pending work at the time.

Run the backup on a schedule (for example with cron) and `recovery backup verify --record` after
copying it off the machine. `recovery status` and `GET /api/cron/status` report the age of the
newest recorded **snapshot** and warn after 48 hours (`QUITS_BACKUP_MAX_AGE_HOURS` changes the limit).
The snapshot date comes from the manifest, even for a verification recorded today. Verifying an
old bundle cannot refresh its data or replace a newer snapshot in this report. The JSON report
separately exposes `newestSnapshotAt`, `ageHours`, `lastVerifiedAt` and `verificationAgeHours`.
`lastCreatedAt` records when a creation was logged, not the snapshot date. Missing, invalid or
future snapshot dates do not count as fresh backups.

## 2. Rehearse a restore

Do this on a spare machine, or at least a separate database and artifact directory. Never restore
over data you still need: the tool refuses a database that already holds data.

1. Start an empty PostgreSQL and apply the migrations:
   `bunx prisma migrate deploy` (Docker Compose: start `db`, then
   `docker compose run --rm --no-deps -w /app/apps/oss --entrypoint bunx app prisma migrate deploy`).
2. Set `DATABASE_URL`, `QUITS_ARTIFACT_DIR` and **the same `BETTER_AUTH_SECRET`** (and public link
   secrets, if you set them) as the source.
3. Check what is missing without changing anything:

   ```sh
   recovery prerequisites
   recovery restore /backups/quits-2026-10-08 --dry-run
   ```

   Problems are listed with what to do about each. Typical ones: the target is not migrated, the
   target is older than the backup (install the Quits version that made the backup, or newer),
   a key is missing or different, an artifact is missing from the bundle, the target is not empty.
   Nothing has been written at this point.
4. Restore:

   ```sh
   recovery restore /backups/quits-2026-10-08
   ```

   The database part is one transaction. If any check fails, it is rolled back and the database is
   left empty. The checks are:

   | Check | Meaning |
   | --- | --- |
   | `integrity` | Every file matches the SHA-256 in the manifest |
   | `rows` | Every table has the number of rows the manifest recorded |
   | `totals` | Invoice, credit-note and payment totals match the manifest, currency by currency, to the cent |
   | `artifacts` | Every issued PDF and e-invoice exists and matches the hash recorded on its document |
   | `keys` | The keys you supplied are the ones the backup was made with, and stored secrets decrypt |

   The report also shows the source Quits version, when the backup was taken and what was pending.
5. Start the app against the restored database. Do **not** start the scheduler service for a
   rehearsal (`docker compose up -d app`). The scheduler would only be told the hold is on.
   Setting `QUITS_OPERATIONS_HOLD=true` on a rehearsal instance holds it even if the database state
   were changed.

### What "held" stops

While held, these are refused or skipped, whatever is configured:

- outgoing email of every kind, including reminders, document emails and password-reset emails;
- Stripe Checkout creation and expiry, and incoming Stripe webhooks (answered 503 so Stripe retries
  later instead of dropping a payment);
- AI requests, including the local agent;
- the scheduler tick and the overdue endpoint, and the job runner: no job is claimed, retried or
  reclaimed, so the queue stays exactly as restored.

Everything else works, so you can read invoices, open PDFs and check balances. Avoid creating
documents on a rehearsal instance: commands that would email a customer queue the email instead.

### Checklist for the first rehearsal

- [ ] `recovery restore` reports every check as `pass`, and prints the source Quits version.
- [ ] You can sign in (with an account from the backup) and the organization, contacts and settings look right.
- [ ] Open three issued invoices, one credit note and one payment; the PDFs open and their totals match your records.
- [ ] `recovery status` shows `held`, no missing or corrupt artifacts and the pending work you expected.
- [ ] No mail arrived anywhere and your mail provider shows no sends from this machine.
- [ ] You wrote down how long the restore took and anything you had to look up.

If the first rehearsal needed anything you could not find in this guide, that is a gap in the
guide: please report it.

### Rehearsing without production secrets

`--skip-key-check` lets you rehearse on a machine without the production `BETTER_AUTH_SECRET`.
Row, total and artifact checks still run. The `keys` check is recorded as `skipped`, stored
provider secrets stay unreadable, and `enable-operations` refuses such a restore by default.
A **verified cutover** needs every check to pass. An operator can explicitly use `--accept-gate keys`
to enable it anyway. This is an **acknowledged exception**, not proof the keys work. The command
warns about the exception and saves it in `restoreReport.enabled`; `gates.keys` stays `skipped`.
Restore again with the correct keys for a verified cutover.

### Trying it without your own data

`src/selfhost/recovery/fixture.ts` fills an empty, migrated, throw-away database with a made-up
studio, invoices in three currencies with real PDFs, payments, a credit note and queued work. It
exists so that you can practice the steps above before you need them:

```sh
BETTER_AUTH_SECRET=... bun src/selfhost/recovery/fixture.ts --disposable
```

## 3. Cutover

Do this when the source installation is gone or you are moving to a new machine.

1. **Stop the source's scheduler and app.** Nothing prevents two installations from running the
   same schedule and emailing the same customers twice.
2. Take a final backup of the source if it still runs, and restore it as in section 2 on the new
   installation, with the production keys and no `--skip-key-check`.
3. Review the pending work:

   ```sh
   recovery review
   ```

   It lists queued jobs by type (and how many were already attempted), reminders and recurring
   invoices that are due, and the controls that prevent duplicates:

   - a reminder with a sent time is never sent again; there is one reminder per invoice and offset;
   - the database allows one recurring invoice per schedule and run date;
   - a job with a dedupe key exists once; a job that was `running` at backup time is reclaimed
     after 15 minutes and retried;
   - Resend drops a repeated idempotency key for 23 hours; SMTP cannot deduplicate, so an email whose
     first attempt may have reached the relay is not retried.

   Decide what to do with the queued jobs. Cancel them if the source may have run them after the
   backup was taken.

   Also decide about work that came due while the installation was down. A recurring schedule
   generates **every** run it missed on the next tick, not just one: a monthly schedule that was
   due eight months ago creates eight invoices. Pause schedules you do not want to catch up
   before enabling operations. Reminders that came due are sent on the next tick if the invoice
   is still unpaid.
4. Enable operations:

   ```sh
   recovery enable-operations --review-token <token> --jobs keep|cancel --source-stopped
   ```

   The command checks that: the restore passed every check (a failed or skipped check blocks it,
   unless you name it with `--accept-gate`), you chose what happens to queued jobs, you confirmed the
   source is stopped, and the token still matches the pending work, so a review that has gone stale
   is refused. `--accept-gate` produces an acknowledged exception recorded in the cutover result,
   never a passed verification gate. Remove `QUITS_OPERATIONS_HOLD` from the app and scheduler
   environment if you set it.

   Stop target application writers and migration processes during review and cutover. The review
   token covers complete durable database rows and their columns, including job identities and
   payloads, linked documents, contacts, reminder times, recurring terms and event deliveries.
   Only a digest and aggregate counts are displayed. Any durable edit can require another review,
   even if the number of due jobs did not change. Time passing can also make another reminder due.

   Cutover takes PostgreSQL `SHARE ROW EXCLUSIVE` table locks before validation and retains them
   through job cancellation and hold removal in the same transaction. Ordinary Prisma and SQL
   writers need no special cooperation. An already-active writer causes `cutover_busy` and leaves
   operations held. Writers that arrive after the locks wait until the transaction ends. Work
   committed after cutover is new live work. Do not run schema migrations during this process.
   This maintenance operation reads all durable rows and briefly blocks writes across the target;
   size its maintenance window using your own rehearsal.
5. Start the scheduler. The next tick resumes reminders, recurring invoices and queued jobs.
   Watch `recovery status` for a few ticks.

## Monitoring

`GET /api/cron/status` (with the `Authorization: Bearer $CRON_SECRET` header the scheduler uses)
returns the same report as `recovery status`: whether operations are held, backup age, how many
issued documents have a stored artifact and whether those objects are present and match their
hashes, when the scheduler last ran, queued, overdue and failed jobs, and the mail configuration
and recent delivery failures. It answers 503 when something needs attention, so an uptime monitor
can alert on it. It never contacts your mail provider or Stripe.

## When it fails

| Message | What to do |
| --- | --- |
| `Backup format version N is not supported` | The bundle is from a newer or an older, unsupported format. Use the Quits release that made it |
| `The backup needs migration …, which the target database lacks` | Install the Quits version that made the backup (or newer) and migrate the target first |
| `The target database has no applied migrations` | Run `prisma migrate deploy` on the empty target |
| `The target database already holds data` | Restore into a new, empty database; the tool never overwrites |
| `… is not set, but the backup was made with it` / `differs from the key …` | Set the original key. A different key breaks stored provider secrets and sent links |
| `Artifact … is listed in the manifest but missing from the bundle` | The copy is incomplete. Use another copy |
| `… does not match its recorded SHA-256` | The file changed after the backup. Use another copy |
| `Restored totals differ from the backup manifest` | The restore was rolled back. Do not use the bundle; take a new backup and report it |

## Limits

- The bundle is not encrypted. Protect it like the database.
- Integrity checks detect corruption and truncation. They do not prove who made a bundle.
- A restore needs the same or a newer Quits version than the backup, with a schema that can hold
  it. Restoring across a removed column is refused with the version to use instead.
- Backups and rehearsals say nothing about legal retention periods or archival requirements.

### Recovery integration contract

Recovery uses the runtime database and artifact store. It does not change organization scopes,
command authorization, email payloads, job deduplication, invoice rendering or document revisions.
The cutover digest discovers durable tables and columns at runtime, so additional journal records,
consequence records and invoice or quote `editRevision` fields are included without a recovery
schema fork. It does not depend on writers updating `updatedAt`. New outbound providers must still
call `assertOperationsLive` before external effects; job and scheduler entry points already do.

Only the backup exclusions are omitted from the row digest: sign-in sessions, verification tokens,
rate-limit counters, scheduler claims, migration history, backup history and recovery status.
The restore origin and verification gates are bound separately into the token; scheduler heartbeat
telemetry cannot invalidate it. Revisit this exclusion list if an excluded table starts determining
outbound work. Review uses a dedicated connection and a read-only repeatable-read transaction;
cutover uses a dedicated connection and owns its transaction. Neither API accepts an existing
transaction. Application database credentials must be able to read and lock the target tables.

Legacy issued documents with no artifact reference remain recorded gaps. Agreements with an
artifact reference are verified, but an agreement without a reference is not currently counted as
a missing artifact. A successful synthetic rehearsal does not establish historical completeness,
first-time operator usability, accountant approval or large-installation performance.
