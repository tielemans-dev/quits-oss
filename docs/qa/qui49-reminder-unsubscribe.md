# QUI49: automatic reminder unsubscribe

Quote, invoice and reminder emails offer a link to stop automatic reminders from the same organization to the same recipient address. Seller-initiated sends, resends and manual reminders continue, including delivery retries. Unsubscribing neither deletes contacts nor changes invoice state or the organization's reminder policy.

The OSS app owns the confirmation screen at `/reminders/unsubscribe` and the RFC 8058 handler at `/api/reminders/unsubscribe`. There is no cloud-only page or self-hosted gate. QUI26's waitlist deletion copy does not apply. The reminder-specific DA/EN copy below needs Ines's UI/copy approval before this PR leaves draft; the parent coordinates that approval and an independent green Codex gpt-6.1-sol review.

## Proposed copy

| State | Danish | English |
| --- | --- | --- |
| Email link | Afmeld automatiske påmindelser | Unsubscribe from automatic reminders |
| Email scope | Dette stopper automatiske påmindelser fra denne virksomhed til denne e-mailadresse. Tilbud, fakturaer og påmindelser sendt af sælgeren kommer stadig frem. | This stops automatic reminders from this organization to this email address. Quotes, invoices and reminders sent by the seller will still arrive. |
| Confirm title | Stop automatiske påmindelser? | Stop automatic reminders? |
| Confirm body | Stop automatiske påmindelser fra {organization} til denne e-mailadresse. Tilbud, fakturaer og påmindelser sendt af sælgeren kommer stadig frem. | Stop automatic reminders from {organization} to this email address. Quotes, invoices and reminders sent by the seller will still arrive. |
| Button | Stop automatiske påmindelser | Stop automatic reminders |
| Submitting | Stopper automatiske påmindelser… | Stopping automatic reminders… |
| Done title | Automatiske påmindelser stoppet | Automatic reminders stopped |
| Done body | Du modtager ikke længere automatiske påmindelser fra {organization} på denne e-mailadresse. Tilbud, fakturaer og påmindelser sendt af sælgeren kommer stadig frem. | You will no longer receive automatic reminders from {organization} at this email address. Quotes, invoices and reminders sent by the seller will still arrive. |
| Broken title | Linket virker ikke | This link doesn't work |
| Broken body | Brug linket til at afmelde automatiske påmindelser i en e-mail fra sælgeren. Hvis det stadig ikke virker, kan du bede sælgeren stoppe automatiske påmindelser. | Use the reminder unsubscribe link in an email from the seller. If it still does not work, contact the seller to stop automatic reminders. |

The screen uses the existing wordmark, Card and Button components, a 400px card, a full-width 40px primary button, and no success-green treatment. It supports plain form submission without JavaScript. With JavaScript the submit button disables and the done heading receives focus. Organization names are rendered as escaped React text. No recipient address appears in the URL or confirmation response.

## Persistence and protocol

- The new `recipient_reminder_preference` table has one row per organization and normalized email address, with a random UUID and nullable first-unsubscribe time. Addresses are trimmed and lowercased consistently. The organization foreign key cascades deletion.
- Email construction upserts the binding in the command's transaction and preserves existing unsubscribe state. The footer and headers are stored in the outbox and replayed unchanged on retries.
- Tokens carry only a version, random row ID and HMAC-SHA256 signature. The signature binds the ID, organization, normalized recipient and `automatic-reminders-unsubscribe-v1` action. The handler looks up the row, verifies the signature with constant-time comparison and fails closed. There is no expiry, so old emails keep working.
- Signing uses `QUITS_REMINDER_UNSUBSCRIBE_SECRET` with `YAIP_` compatibility, falling back to `BETTER_AUTH_SECRET`. The secret must have at least 32 characters. Configure a stable dedicated key to keep old links valid when rotating the auth key. Signing-key rotation invalidates existing links but does not reset persisted suppression.
- Absolute links use the existing app-origin resolution and runtime environment reader. HTTPS deployments advertise `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; HTTP self-hosted deployments offer the confirmation link without advertising RFC 8058 one-click support. Outbound infrastructure must DKIM-sign both list headers for clients that require RFC 8058 authentication.
- GET only reads. The API's GET redirects to the app confirmation flow without changing preferences. POST requires a bounded URL-encoded body. One-click POST uses the token in the header URL and exactly one `List-Unsubscribe=One-Click` field, needs no session cookie, returns 204, and is idempotent. The visible form POST redirects to the app's done or broken-link state.
- Responses are private/no-store, no-referrer and noindex/nofollow. Neither tokens nor recipient addresses are logged by the new handlers.
- Suppression is checked when an automatic reminder would enter the email outbox and again before provider requests, against the queued recipient address. Existing queued reminders and retries therefore cannot bypass it. A request already in flight cannot be recalled. An earlier uncertain attempt remains unconfirmed when further attempts stop.

## Verification and rollout

Focused CI regressions cover token scope and tampering, GET scanner safety, idempotent form/one-click POST, stored locale, privacy headers, bounded bodies, DA/EN footer scope, HTTP/HTTPS behavior, SMTP/Resend header propagation, queued reminder withdrawal, automatic retry suppression, unaffected organizations/recipients, and continued direct sends/manual retries.

Local checks are limited to dependency-free token assertions, translation parity/TM guard, syntax inspection and `git diff --check`. This isolated worktree has no installed dependencies. No installation, Prisma execution, local database, full suite, typecheck, build, browser or server was run. CI must validate Prisma, apply the additive migration and run lint, typecheck and regressions. The parent owns CI follow-up and browser/design verification.

For a targeted CI rerun after dependencies and Prisma are available:

```sh
cd apps/oss
bunx vitest run -c vitest.config.ts --maxWorkers=1 src/lib/reminders/__tests__/unsubscribe-token.test.ts src/lib/reminders/__tests__/unsubscribe.test.ts src/lib/reminders/__tests__/unsubscribe-transport.test.ts src/domain/__tests__/reminders.integration.test.ts src/domain/__tests__/email-outbox.integration.test.ts
bunx oxlint --threads=1 --deny-warnings --report-unused-disable-directives .
```

This is one OSS PR. Hosted rollout follows the normal OSS release, then a cloud package upgrade. No unreleased cloud pin or second adapter PR is included. No production changes or email sends are part of this work.
