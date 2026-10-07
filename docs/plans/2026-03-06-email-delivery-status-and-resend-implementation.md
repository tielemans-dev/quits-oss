# Email Delivery Status and Resend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add runtime email status, quote/invoice delivery status, and explicit resend flows without widening scope into full email operations.

**Architecture:** Keep email delivery in the existing Resend-based mail layer and document routers. Extend runtime capabilities so cloud can mark email as managed, extend `settings.get` with server-side delivery diagnostics, add lightweight last-attempt fields on quotes and invoices, and teach quote/invoice send flows to record success, skipped, and failed delivery outcomes while reusing public links.

**Tech Stack:** TypeScript, React, TanStack Router, tRPC, Prisma, Vitest.

---

### Task 1: Add runtime email delivery capability

**Files:**
- Modify: `src/lib/runtime/extensions.ts`
- Modify: `src/lib/__tests__/runtime-extensions.test.ts`
- Modify: `../cloud/src/lib/cloud/bootstrap.ts`
- Modify: `../cloud/src/lib/cloud/__tests__/bootstrap.test.ts`

1. Add failing tests that expect runtime capabilities to include an `emailDelivery` group with unmanaged OSS defaults and managed cloud bootstrap behavior.
2. Run:
   - `pnpm exec vitest run src/lib/__tests__/runtime-extensions.test.ts`
   - `pnpm --dir ../cloud exec vitest run src/lib/cloud/__tests__/bootstrap.test.ts`
   Confirm both fail for missing `emailDelivery` capability expectations.
3. Extend `RuntimeCapabilities`, `RuntimeCapabilityPatch`, default capability resolution, and cloud bootstrap capability patch to include `emailDelivery`.
4. Re-run the same test commands and confirm green.
5. Commit:
   - `git add src/lib/runtime/extensions.ts src/lib/__tests__/runtime-extensions.test.ts ../cloud/src/lib/cloud/bootstrap.ts ../cloud/src/lib/cloud/__tests__/bootstrap.test.ts`
   - `git commit -m "feat: add runtime email delivery capability"`

### Task 2: Add lightweight delivery-status persistence to quotes and invoices

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_document_email_delivery_status/migration.sql`
- Create: `src/lib/email-delivery.ts`
- Create: `src/lib/__tests__/email-delivery.test.ts`

1. Add failing tests for a small helper module that formats and validates document email delivery outcomes (`sent`, `skipped`, `failed`) and maps them to UI-safe codes/messages.
2. Run:
   - `pnpm exec vitest run src/lib/__tests__/email-delivery.test.ts`
   Confirm the helper test fails because the module and types do not exist yet.
3. Add quote and invoice fields for:
   - `lastEmailAttemptAt`
   - `lastEmailAttemptOutcome`
   - `lastEmailAttemptCode`
   - `lastEmailAttemptMessage`
4. Create the Prisma migration SQL for those columns.
5. Implement the shared helper module used by routers and UI mapping.
6. Run:
   - `pnpm exec vitest run src/lib/__tests__/email-delivery.test.ts`
   - `pnpm prisma generate`
   Confirm green.
7. Commit:
   - `git add prisma/schema.prisma prisma/migrations src/lib/email-delivery.ts src/lib/__tests__/email-delivery.test.ts`
   - `git commit -m "feat: persist document email delivery status"`

### Task 3: Expose email status through settings

**Files:**
- Modify: `src/trpc/routers/settings.ts`
- Create: `src/trpc/routers/__tests__/settings-email-status.integration.test.ts`

1. Add failing integration tests for `settings.get` that cover:
   - OSS with both `RESEND_API_KEY` and `FROM_EMAIL`
   - OSS missing one or both env vars
   - cloud distribution reporting managed email status without secret diagnostics
2. Run:
   - `pnpm exec vitest run src/trpc/routers/__tests__/settings-email-status.integration.test.ts`
   Confirm failure because `settings.get` does not yet return `emailDelivery`.
3. Extend `settings.get` to return an `emailDelivery` object with:
   - `managed`
   - `configured`
   - `available`
   - `sender`
   - `missing`
   - a small UI-facing status code
4. Re-run the targeted settings test and confirm green.
5. Commit:
   - `git add src/trpc/routers/settings.ts src/trpc/routers/__tests__/settings-email-status.integration.test.ts`
   - `git commit -m "feat: expose outbound email status in settings"`

### Task 4: Teach quote send and resend to record delivery outcomes

**Files:**
- Modify: `src/trpc/routers/quotes.ts`
- Modify: `src/trpc/routers/__tests__/quote-send-email.integration.test.ts`
- Modify: `src/trpc/routers/__tests__/quote-convert-after-acceptance.integration.test.ts`

1. Extend quote send tests to cover:
   - successful email send records `sent`
   - provider missing without explicit override rejects send
   - provider missing with explicit degraded confirmation marks quote `sent` and records `skipped`
   - provider failure records `failed` and leaves quote `draft`
   - missing contact email blocks email send
   - resend reuses the same public link and updates attempt status
2. Run:
   - `pnpm exec vitest run src/trpc/routers/__tests__/quote-send-email.integration.test.ts src/trpc/routers/__tests__/quote-convert-after-acceptance.integration.test.ts`
   Confirm failure on the new branches.
3. Update `quotes.send` to accept an explicit degraded-send flag and record last-attempt fields.
4. Add `quotes.resendEmail` for publicly shareable quote states and reuse `publicAccessIssuedAt`.
5. Re-run the targeted quote tests and confirm green.
6. Commit:
   - `git add src/trpc/routers/quotes.ts src/trpc/routers/__tests__/quote-send-email.integration.test.ts src/trpc/routers/__tests__/quote-convert-after-acceptance.integration.test.ts`
   - `git commit -m "feat: add quote email delivery status and resend"`

### Task 5: Teach invoice send and resend to record delivery outcomes

**Files:**
- Modify: `src/trpc/routers/invoices.ts`
- Modify: `src/trpc/routers/__tests__/invoice-send-email.integration.test.ts`
- Modify: `src/trpc/routers/__tests__/invoice-payment-link.integration.test.ts`
- Modify: `src/trpc/routers/__tests__/invoice-payment-state.integration.test.ts`

1. Extend invoice tests to cover:
   - successful email send records `sent`
   - provider missing without explicit override rejects send
   - provider missing with explicit degraded confirmation marks invoice `sent` and records `skipped`
   - provider failure records `failed` and leaves invoice `draft`
   - missing contact email blocks email send
   - resend reuses the existing public payment link
2. Run:
   - `pnpm exec vitest run src/trpc/routers/__tests__/invoice-send-email.integration.test.ts src/trpc/routers/__tests__/invoice-payment-link.integration.test.ts src/trpc/routers/__tests__/invoice-payment-state.integration.test.ts`
   Confirm failure on the new branches.
3. Update `invoices.send` to accept the explicit degraded-send flag and record last-attempt fields.
4. Add `invoices.resendEmail` for sent or otherwise publicly payable invoices while reusing `publicPaymentIssuedAt`.
5. Re-run the targeted invoice tests and confirm green.
6. Commit:
   - `git add src/trpc/routers/invoices.ts src/trpc/routers/__tests__/invoice-send-email.integration.test.ts src/trpc/routers/__tests__/invoice-payment-link.integration.test.ts src/trpc/routers/__tests__/invoice-payment-state.integration.test.ts`
   - `git commit -m "feat: add invoice email delivery status and resend"`

### Task 6: Add settings UI for outbound email status

**Files:**
- Modify: `src/routes/_app/settings.tsx`
- Modify: `src/lib/i18n/catalog/en/settings.ts`
- Modify: `src/lib/i18n/catalog/da/settings.ts`
- Create: `src/components/settings/__tests__/email-delivery-card.test.tsx`

1. Add a failing UI test for a settings email-status surface that covers:
   - OSS configured
   - OSS missing configuration
   - cloud managed status
2. Run:
   - `pnpm exec vitest run src/components/settings/__tests__/email-delivery-card.test.tsx`
   Confirm failure because the surface does not exist yet.
3. Add the email-delivery settings card and supporting copy.
4. Use the `settings.get` payload rather than reading env on the client.
5. Re-run the targeted UI test and confirm green.
6. Commit:
   - `git add src/routes/_app/settings.tsx src/lib/i18n/catalog/en/settings.ts src/lib/i18n/catalog/da/settings.ts src/components/settings/__tests__/email-delivery-card.test.tsx`
   - `git commit -m "feat: show outbound email status in settings"`

### Task 7: Add quote and invoice detail delivery UI and resend actions

**Files:**
- Modify: `src/routes/_app/quotes/$quoteId.tsx`
- Modify: `src/routes/_app/invoices/$invoiceId.tsx`
- Modify: `src/lib/i18n/catalog/en/quotes.ts`
- Modify: `src/lib/i18n/catalog/da/quotes.ts`
- Modify: `src/lib/i18n/catalog/en/invoices.ts`
- Modify: `src/lib/i18n/catalog/da/invoices.ts`
- Create: `src/components/documents/__tests__/email-delivery-panel.test.tsx`

1. Add a failing UI test for a reusable delivery panel that covers:
   - send vs resend labels
   - delivery status rendering
   - degraded-path confirmation copy
   - invalid-recipient manual-share fallback
2. Run:
   - `pnpm exec vitest run src/components/documents/__tests__/email-delivery-panel.test.tsx`
   Confirm failure because the panel and behavior do not exist yet.
3. Add a small shared UI panel and integrate it into quote and invoice detail routes.
4. Wire the routes to:
   - call `send` for draft documents
   - call `resendEmail` for shareable documents
   - open a confirmation modal for degraded provider-missing sends
   - surface copy-link fallback when recipient email is invalid or missing
5. Re-run the targeted panel test and then route-adjacent router tests:
   - `pnpm exec vitest run src/components/documents/__tests__/email-delivery-panel.test.tsx`
   - `pnpm exec vitest run src/trpc/routers/__tests__/quote-send-email.integration.test.ts src/trpc/routers/__tests__/invoice-send-email.integration.test.ts`
   Confirm green.
6. Commit:
   - `git add src/routes/_app/quotes/$quoteId.tsx src/routes/_app/invoices/$invoiceId.tsx src/lib/i18n/catalog/en/quotes.ts src/lib/i18n/catalog/da/quotes.ts src/lib/i18n/catalog/en/invoices.ts src/lib/i18n/catalog/da/invoices.ts src/components/documents/__tests__/email-delivery-panel.test.tsx`
   - `git commit -m "feat: surface document email status and resend actions"`

### Task 8: Final verification and release hygiene

**Files:**
- Modify: `README.md` (only if UI or operator setup wording now needs updating)

1. Run the focused verification slice:
   - `pnpm exec vitest run src/lib/__tests__/runtime-extensions.test.ts src/lib/__tests__/email-delivery.test.ts src/trpc/routers/__tests__/settings-email-status.integration.test.ts src/trpc/routers/__tests__/quote-send-email.integration.test.ts src/trpc/routers/__tests__/invoice-send-email.integration.test.ts src/components/settings/__tests__/email-delivery-card.test.tsx src/components/documents/__tests__/email-delivery-panel.test.tsx`
2. Run the cross-feature regression slice:
   - `pnpm exec vitest run src/lib/__tests__/document-email-links.test.ts src/trpc/routers/__tests__/quote-convert-after-acceptance.integration.test.ts src/trpc/routers/__tests__/invoice-payment-link.integration.test.ts src/trpc/routers/__tests__/invoice-payment-state.integration.test.ts`
3. Run:
   - `pnpm build`
   - `pnpm --dir ../cloud exec vitest run src/lib/cloud/__tests__/bootstrap.test.ts`
   - `pnpm --dir ../cloud build`
4. If README wording changed, update the env-var section to mention that outbound mail status is visible in Settings but secrets still come from runtime env.
5. Commit any final doc/test adjustments:
   - `git add README.md`
   - `git commit -m "docs: clarify outbound email status behavior"`
