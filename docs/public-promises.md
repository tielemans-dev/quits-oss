# Public promises

Statements Quits makes to users in copy, on the pricing page or at checkout. Reviewers: if a change touches
one of these (code, settings, or the wording that states it), check the entry below still holds and update the
entry in the same PR. Do not invent numbers here; point to the code or setting that owns them.

Copy wording rules live in `scripts/i18n/copy-rules.json`, checked by `bun run i18n:check` and, for every PR, by the `paths` job in `ci.yml`.

| Promise | Where users see it | What makes it true | Status |
| --- | --- | --- | --- |
| Price (per month, excl. VAT, billed monthly) | `trial.billing.priceMeta`, `trial.billing.cta` in `catalog/*/billing.ts` | The amount is `plan.unitAmount` from the billing provider, formatted by `formatPlanPrice` in `apps/oss/src/lib/billing/trial-format.ts`. Plan and amount are configured in the hosted lane. | TODO: name the hosted setting that owns the amount |
| Trial (Nothing is deleted when it ends) | `trial.billing.trial`, `trial.billing.end`, `trial.billing.data` | `startTrial` in the billing provider interface (`apps/oss/src/lib/billing/types.ts`), `trialEnd` on the subscription. The self-host provider is `noop-provider.ts`. | TODO: trial length and the check that data survives expiry |
| Non-VAT: no VAT is charged when the seller is not VAT-registered | `invoice.noVatNote` (approved wording in `COPY.md`), `pdf.nonVatRegistered` | `withNonVatStatement` in `apps/oss/src/lib/documents/non-vat-note.ts`, driven by the seller's VAT registration (`apps/oss/src/lib/documents/seller-vat.ts`). | Known |
| B2B audience (unresolved: not a stated promise yet) | `auth.onboarding.identity.business`, `auth.onboarding.identity.individual` in `catalog/*/auth.ts` | Onboarding supports invoicing through a registered business and as an individual without a company. Nothing in the code limits signup to registered businesses. | TODO for Mira (copy owner): decide the wording, and whether B2B-only is a promise at all |
| Unlimited invoices, quotes and agreements on the paid plan | `trial.billing.include1`, `billing.selfHost.description` | Self-host has no limits. Hosted limits come from the billing provider. | TODO: point to the hosted limit setting |
| Source-available (FSL), never "open source" | Whole product, `AGENTS.md` | `LICENSE`. Enforced in copy by the `open-source` rule. | Known |
