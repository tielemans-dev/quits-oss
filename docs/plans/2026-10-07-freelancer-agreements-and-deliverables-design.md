# Freelancer Agreements and Deliverables Design

Status: draft for adversarial review (2026-10-07)

## Summary

Quits models the money half of freelance work: quotes, invoices, payments, reminders, credit notes
and recurring invoices. It does not model what the money is for. A freelancer's actual flow is
**agreement, work, money**. This design adds the first two so that the third falls out of them:

1. **Agreements**: a document the freelancer and the customer both commit to. Scope, terms, price
   model, validity, and an acceptance record with an audit trail.
2. **Deliverables**: the units of work inside an agreement. Each has a description, an amount, a due
   date and a status, and is accepted by the customer.
3. **Invoicing from deliverables**: accepted deliverables become invoice lines, so an invoice can
   always be traced back to what was agreed and what was delivered.
4. **Customer sign-off**: the public agreement page lets the customer accept deliverables or request
   changes, without an account.
5. **Retainers**: an agreement whose billing is recurring, linked to the existing recurring invoice.

Everything is built on the domain core from the invoicing lifecycle design: commands with client
request ids, deciders, domain events, approval gating for outward-facing commands, and agent tools.
Nothing here is cloud-only.

## Why this and not a wider pivot

The scope test for every idea in this area is: **does it sit on the line from agreement to work to
money?** Agreements, deliverables, acceptance and billing from deliverables do. The following do
not, and are explicit non-goals (see below): time tracking, a sales pipeline or CRM, proposals with
cover pages and case studies, project boards, a customer portal with login, and expense tracking.
Each of those is a separate product. Adding them one at a time because each feels adjacent produces
a worse copy of Bonsai or HoneyBook.

The differentiator Quits actually has is the combination of open source, self-hostable, and an agent
API. A freelancer's own agent drafting the agreement, tracking what was delivered, and raising the
invoice is a story the incumbents cannot tell. Every feature below is therefore designed agent-first:
every mutation is a domain command, every command is an MCP tool, and outward-facing commands are
approval-gated.

## Naming

The code calls the new document an **Agreement**, not a contract, because `packages/contracts` already
means TypeScript contracts and the collision would be constant. The UI may label it "Agreement" or
"Contract" per locale; the default English label is "Agreement".

## Non-goals

- Time tracking, timesheets, or hourly billing from tracked time. An hourly agreement is billed from
  deliverables or a manual invoice; tracking the hours is out of scope.
- A CRM, lead pipeline, or proposal builder with marketing content.
- Project management: tasks, boards, assignments, comments.
- A customer portal with accounts and login. Customers act through signed public links, as with
  quotes and invoices today.
- Legal templates per jurisdiction, or any claim that a template is legally sufficient. Quits ships
  neutral default templates with a "not legal advice" notice and lets the organization bring its own.
- Qualified or advanced electronic signatures (eIDAS QES/AdES, DocuSign-class) in OSS. OSS ships
  click-to-accept with an audit trail. A provider-backed signature is a hosted capability behind a
  runtime extension and is designed here only as an interface.
- Replacing quotes. A quote remains a priced offer. An agreement can be created from an accepted
  quote, but quotes keep working on their own.
- Change orders as a first-class document. A changed scope is a new agreement version (see
  versioning). A formal change-order document may come later.

## Data model

New Prisma models, all organization-scoped, all following the existing conventions (cuid ids,
`organizationId` with cascade, `@@map` snake_case, `createdAt` and `updatedAt`).

### Agreement

| Field | Notes |
| --- | --- |
| `number` | Allocated by `allocateDocumentNumber` with a new `agreement` sequence and prefix setting (default `AGR-`). Unique per organization. |
| `contactId` | The customer. Required. |
| `status` | `draft`, `sent`, `accepted`, `declined`, `expired`, `completed`, `cancelled`. See lifecycle. |
| `title` | Short human name, e.g. "Website redesign". |
| `summary` | Optional plain-text scope statement shown above the deliverables. |
| `termsMarkdown` | The terms body as edited. Markdown, rendered server-side for the public page and PDF. |
| `termsSnapshot` | Frozen rendered terms at send time, with `termsHash` (SHA-256). What the customer accepted. |
| `templateId` | Optional reference to the `AgreementTemplate` the terms started from. Informational only. |
| `pricingModel` | `fixed`, `milestones`, `retainer`. Drives validation of deliverables and billing. |
| `currency`, `countryCode`, `locale`, `timezone`, `taxRegime`, `pricesIncludeTax` | Same localization columns as `Quote`, defaulted from `OrgSettings`. |
| `totalNet`, `totalTax`, `totalGross` | Sum of deliverables. Recomputed by the pricing module on every change. |
| `sellerSnapshot`, `buyerSnapshot` | Same as quotes. Frozen at send. |
| `issueDate`, `validUntil` | Validity window for acceptance. After `validUntil` a sent agreement expires. |
| `startDate`, `endDate` | Optional service period. Required for `retainer`. |
| `sourceQuoteId` | Optional. The accepted quote this was created from. |
| `recurringInvoiceId` | Optional. Set for `retainer` once billing is activated. |
| `version`, `supersedesAgreementId` | See versioning. |
| `publicAccessKeyVersion`, `publicAccessIssuedAt` | Signed public link, same mechanism as quotes. |
| `acceptedAt`, `acceptedByName`, `acceptedByEmail`, `acceptanceIp`, `acceptanceUserAgent`, `acceptanceMethod` | The acceptance record. `acceptanceMethod` is `click_to_accept` in OSS; a hosted signature extension may write `provider:<id>`. |
| `declinedAt`, `declineReason` | Mirror of quote rejection. |
| `lastEmailAttempt*` | Same four columns as invoices and quotes, used by document delivery. |
| `notes` | Internal notes, never shown to the customer. |

### Deliverable

| Field | Notes |
| --- | --- |
| `agreementId` | Cascade delete with the agreement while it is a draft; see lifecycle for sent agreements. |
| `title`, `description` | What is being delivered. |
| `quantity`, `unitPriceNet`, `unitPriceGross`, `lineNet`, `lineTax`, `lineGross`, `taxRate`, `taxCategory`, `taxCode` | Identical shape to `QuoteItem` so the pricing module and invoice item snapshotting can be reused unchanged. |
| `dueDate` | Optional. Shown to the customer, used for the dashboard. |
| `status` | `planned`, `in_progress`, `delivered`, `accepted`, `changes_requested`, `invoiced`, `cancelled`. |
| `deliveredAt`, `acceptedAt`, `acceptedVia` | `acceptedVia` is `customer` (public page) or `internal` (the freelancer marks it accepted, e.g. accepted by email). Stored so the audit trail says who accepted. |
| `changeRequestNote` | The customer's note when requesting changes. Cleared when the deliverable is delivered again. |
| `billingTrigger` | `on_acceptance` (default), `on_delivery`, `upfront`, `manual`. Decides when "invoice from deliverables" offers the line. |
| `invoiceItemId` | Set when invoiced. One deliverable maps to at most one invoice item. |
| `sortOrder` | Display order. |

### AgreementTemplate

| Field | Notes |
| --- | --- |
| `name` | Unique per organization. |
| `termsMarkdown` | Body with placeholders: `{{seller.name}}`, `{{buyer.name}}`, `{{agreement.title}}`, `{{agreement.validUntil}}`, `{{agreement.total}}`, `{{deliverables}}`. |
| `isDefault` | At most one per organization. |
| `isBuiltIn` | The two shipped templates ("Fixed-scope project", "Monthly retainer") are seeded per organization on first use and can be edited or deleted like any other. |

### Changes to existing models

- `InvoiceItem.deliverableId` (nullable): back-link so an invoice line knows which deliverable it bills.
- `Invoice.agreementId` (nullable): the agreement an invoice was raised from. An invoice bills
  deliverables of exactly one agreement; mixing agreements on one invoice is refused.
- `RecurringInvoice.agreementId` (nullable): a retainer's billing schedule.
- `Contact` gains `agreements Agreement[]`.
- `OrgSettings` gains `agreementNumberPrefix` and `agreementNextNumber`, following the quote columns.
- Permissions: new resources `agreement` (`read`, `create`, `update`, `send`, `delete`, `cancel`) and
  `deliverable` (`read`, `update`, `accept`). Admin and member get all; accountant gets `read` only.

## Lifecycle

### Agreement

```
draft --send--> sent --customer accepts--> accepted --all deliverables invoiced or cancelled--> completed
  |               |--customer declines--> declined
  |               |--validUntil passes--> expired (scheduler task, like overdue)
  |--delete       |--cancel--> cancelled (from sent or accepted; records reason)
```

- A draft is fully editable. Sending freezes terms (`termsSnapshot`, `termsHash`), seller and buyer
  snapshots, and the deliverables' descriptions and prices. The same `lockDocument` and
  `refuseWhileSending` helpers as quotes apply.
- After sending, deliverable **prices and descriptions are immutable**. Status, `dueDate`,
  `deliveredAt` and the change-request note still change. Adding or removing deliverables after
  sending requires a new version.
- `accepted` is the only state from which deliverables can be delivered, accepted and invoiced.
- `completed` is derived, not set by the user: it is reached when every deliverable is `invoiced`
  or `cancelled`. A retainer never auto-completes; it completes when the freelancer ends it, which
  also deactivates its recurring invoice.
- Cancelling an accepted agreement is allowed and recorded with a reason, because real engagements
  end early. Already-invoiced deliverables stay invoiced; the invoices are untouched. Uninvoiced
  deliverables become `cancelled`.

### Versioning

A sent or accepted agreement cannot be edited. To change scope, the freelancer **creates a new
version**: a new draft agreement with `version + 1`, `supersedesAgreementId` set, deliverables copied
with their current status. On sending the new version, the superseded agreement moves to
`cancelled` with reason `superseded` and its uninvoiced deliverables are cancelled; invoiced ones
are left as they are. The customer accepts the new version through the normal flow. The public
link of the old version shows that it was replaced and links to the new one. This keeps a single
rule, "accepted documents never change", without inventing a change-order document.

### Deliverable

```
planned --> in_progress --> delivered --customer accepts--> accepted --invoiced--> invoiced
                              ^              |--customer requests changes--> changes_requested --+
                              +--------------------------------------------------------------------+
any non-invoiced state --cancel--> cancelled
```

- `planned`, `in_progress` and `delivered` are set by the freelancer (or agent).
- `accepted` is set by the customer on the public page, or by the freelancer with `acceptedVia:
  internal` when the customer accepted some other way. The event records which.
- `changes_requested` returns the deliverable to the freelancer with the note. Delivering again
  moves it back to `delivered` and keeps the note history in the event log.
- `invoiced` is set by the invoicing command, never by hand.
- `upfront` deliverables (a deposit) may be invoiced from `planned`; others only from `accepted`,
  or from `delivered` when `billingTrigger` is `on_delivery`.

## Commands

All in `apps/oss/src/domain/commands/agreements.ts` and `deliverables.ts`, defined with
`defineCommand`, with zod inputs in `packages/contracts/src/agreements.ts`. Outward-facing commands
are marked and go through approval gating for `approval_required` agents.

| Command | Permission | Outward | Notes |
| --- | --- | --- | --- |
| `agreement.createDraft` | `agreement:create` | no | From scratch, from a template, or from an accepted quote (`sourceQuoteId`: copies quote items as deliverables). |
| `agreement.updateDraft` | `agreement:update` | no | Draft only. |
| `agreement.deleteDraft` | `agreement:delete` | no | Draft only. |
| `agreement.send` | `agreement:send` | **yes** | Freezes snapshots, allocates number if missing, queues `email.deliver` via document delivery. |
| `agreement.resend` | `agreement:send` | **yes** | Same link, new email. |
| `agreement.createVersion` | `agreement:create` | no | See versioning. |
| `agreement.cancel` | `agreement:cancel` | no | Reason required. |
| `agreement.recordAcceptance` | `agreement:update` | no | Internal acceptance when the customer accepted out of band. Requires `acceptedByName`. Recorded as `acceptanceMethod: internal`. |
| `agreement.activateRetainer` | `agreement:update` | **yes** | Retainer only. Creates and activates a `RecurringInvoice` from the deliverables. Outward because it will send invoices. |
| `deliverable.update` | `deliverable:update` | no | Status transitions and dates. Description and price only while draft. |
| `deliverable.accept` | `deliverable:accept` | no | Internal acceptance with `acceptedVia: internal`. |
| `deliverable.cancel` | `deliverable:update` | no | |
| `invoice.createFromDeliverables` | `invoice:create` | no | Takes `agreementId` and `deliverableIds`. Validates each is billable (see billing trigger). Creates an invoice draft with one item per deliverable, sets `deliverableId` and `agreementId`, marks deliverables `invoiced` only when the invoice is **sent** (see below). |

**Invoiced timing.** A deliverable is marked `invoiced` when the invoice that bills it is sent, not
when the draft is created, so deleting an unsent draft releases the deliverables. The invoice `send`
decider gains one rule: on send, every linked deliverable moves to `invoiced`. The invoice `delete`
(draft) command clears `invoiceItemId` on linked deliverables. A credit note against an invoice does
not change deliverable status; the money side is handled by the credit note as today.

### Public commands (customer, via signed link)

Mirror `applyPublicQuoteDecision`, with their own module under `apps/oss/src/lib/agreements/`:

- `agreement.publicAccept`: requires `acceptedByName` and an explicit "I accept these terms"
  confirmation. Stores the acceptance record and `termsHash`. Refuses if the link's
  `publicAccessKeyVersion` is stale, the agreement is not `sent`, or `validUntil` has passed.
  Emits `agreement.accepted` and queues a confirmation email to both parties with the PDF attached.
- `agreement.publicDecline`: optional reason.
- `deliverable.publicAccept` and `deliverable.publicRequestChanges`: only on `accepted` agreements,
  only for `delivered` deliverables. Emits events; queues a notification email to the freelancer.

Public commands run as the `system` actor with reason `public_link`, the same as the quote decision
path, so they bypass role checks but still write events and receipts. They are rate-limited per
token like the public pay page.

## Public page and PDF

- Route `/a/$token`, built like `/q/$token`: signed token, key version check, server-rendered.
- Shows title, summary, deliverables with amounts and due dates, totals, rendered terms, validity.
- Before acceptance: name field, checkbox, Accept and Decline. After: the acceptance record and,
  per deliverable, Accept or Request changes for `delivered` items.
- PDF: a new `agreement-pdf.tsx` alongside `invoice-pdf.tsx` and `credit-note-pdf.tsx`. Includes the
  acceptance block (name, email, timestamp, method, terms hash) when accepted. The PDF is the
  artifact both parties keep.

## Email

Three new email compositions in `apps/oss/src/lib/emails/`: agreement sent, agreement accepted
(to both parties), deliverable status (to the freelancer). All go through document delivery and the
existing `email.deliver` job, so delivery outcomes behave exactly as for invoices.

## Agent API

New MCP tools in `apps/oss/src/domain/agent-tools/tools/agreements.ts`, following `define.ts`:

- Reads: `agreement.list` (filter by status, contact), `agreement.get` (with deliverables and
  acceptance record), `deliverable.list` (filter by status, due before), `agreementTemplate.list`.
- Commands: one tool per command above. `agreement.send`, `agreement.resend` and
  `agreement.activateRetainer` are described as outward-facing and queue approval requests in
  `approval_required` mode. The review context for an approval shows the customer, total, validity,
  and the terms hash, so the approver sees what will be sent.

Scopes: `agreement:*` and `deliverable:*` join the scope list and the key presets. "Drafting
assistant" gets `agreement:create`, `agreement:update`, `deliverable:read`, `deliverable:update`;
sends wait for approval as today.

## OSS and cloud boundary

Everything above is OSS: self-hosters get the whole feature. Cloud is involved in exactly two ways,
both through the existing runtime extension interface:

1. **Signature capability.** New capability key `agreementSignature` with `method:
   "click_to_accept" | "provider"` and `providerLabel`. OSS default is `click_to_accept`. A hosted
   extension may set `provider` and register a signature adapter (`startSignature(agreement)`,
   `handleCallback(payload)`) that writes `acceptanceMethod: provider:<id>` and the provider's
   evidence id. The adapter interface lives in OSS; no provider code does. This is designed now so
   the public page can branch on it, but no provider integration is part of this plan.
2. **Plan limits.** If the hosted plan meters agreements, it does so through the existing capability
   patching, as for AI drafting. Nothing in OSS checks a plan.

Managed email domains already apply to the new emails with no new work.

## Phases

Each phase is independently shippable and leaves the app fully working.

### Phase 1: Agreements with acceptance

Schema for `Agreement`, `Deliverable`, `AgreementTemplate`. Numbering, pricing, snapshots. Commands
`createDraft`, `updateDraft`, `deleteDraft`, `send`, `resend`, `cancel`, `recordAcceptance`. Public
page with accept and decline. PDF. Emails for sent and accepted. UI: list, editor, detail with
activity feed, templates in settings. Two seeded templates. Agent tools for all of the above.
Deliverables in this phase are scope lines only: `planned` and `cancelled`, no customer sign-off.

Verification: unit tests for deciders (every transition in both lifecycles), tRPC router tests,
public-session tests mirroring the quote ones, a Playwright flow: create, send, open public link,
accept, see the acceptance record and PDF.

### Phase 2: Invoicing from deliverables

`InvoiceItem.deliverableId`, `Invoice.agreementId`, `invoice.createFromDeliverables`, the send-time
`invoiced` transition, draft-delete release. Deliverable statuses `in_progress`, `delivered`,
`accepted` with internal acceptance. UI: "Invoice" action on the agreement detail that preselects
billable deliverables. Dashboard tile: deliverables due this week and accepted but not invoiced.

Verification: decider tests for billability per trigger, an integration test that sending the
invoice marks deliverables invoiced and deleting the draft releases them, Playwright: accept
deliverable internally, invoice it, send, see status.

### Phase 3: Customer sign-off

`deliverable.publicAccept`, `deliverable.publicRequestChanges`, `changes_requested` state, the
notification email, the public page's deliverable section. Agent tools surface
`changes_requested` with the note so an agent can draft the response.

### Phase 4: Versions and quote conversion

`agreement.createVersion`, supersession rules, the "replaced by" public page state. `createDraft`
from an accepted quote. Quote detail gains "Create agreement".

### Phase 5: Retainers

`pricingModel: retainer`, `startDate` and `endDate`, `agreement.activateRetainer` creating a
`RecurringInvoice`, ending a retainer deactivates it. Retainer deliverables describe the monthly
scope and are not individually invoiced; the recurring invoice's items are generated from them.

## Risks and how the design handles them

- **Legal exposure from templates.** Templates are neutral, carry a visible notice, are editable,
  and are seeded per organization rather than referenced centrally, so a later wording change never
  silently changes what an organization is sending. The `termsHash` on acceptance proves what was
  accepted.
- **Acceptance evidence strength.** Click-to-accept with name, email, IP, user agent, timestamp and
  terms hash is adequate for most freelance work and matches how quotes are accepted today. Stronger
  evidence is the hosted signature capability.
- **Double billing.** A deliverable maps to at most one invoice item, enforced by the unique
  `invoiceItemId` and by the billability check in `createFromDeliverables`. Marking `invoiced` at
  send time, not draft time, prevents stranded deliverables.
- **Drift between agreement and invoice totals.** Invoice items are snapshots of deliverables, like
  quote items become invoice items today. Totals are recomputed by the same pricing module. The
  agreement does not try to track "amount invoiced"; the invoice list filtered by `agreementId` is
  the source.
- **Scope creep.** The non-goals list is part of the design. A request that fails the
  agreement-to-money test is answered with "that is a different product" rather than built.
- **Public token abuse.** Same signing, key rotation, expiry and rate limiting as quotes and pay
  links. Deliverable sign-off is only possible on `accepted` agreements, so a leaked pre-acceptance
  link cannot sign off work.

## Open questions for review

1. Should `completed` really be derived, or should the freelancer close an agreement explicitly even
   with uninvoiced deliverables? The design says derived plus explicit `cancel` with reason; review
   whether that is enough.
2. Is `billingTrigger` per deliverable over-engineered for Phase 2? The alternative is one trigger
   per agreement and a separate `isDeposit` flag.
3. Does versioning by supersession cover change requests well enough, or will users expect to edit a
   sent draft before the customer has accepted it? A possible middle ground: allow `recall` of a
   `sent`, unaccepted agreement back to `draft`, invalidating the public link.
4. Should deliverable acceptance by the customer require the same name-and-checkbox ceremony as
   agreement acceptance, or is a single click enough once the agreement is accepted?
