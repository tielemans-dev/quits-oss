# Freelancer Agreements and Deliverables Design

Status: revision 2, after adversarial review round 1 (2026-10-07)

## Summary

Quits models the money half of freelance work: quotes, invoices, payments, reminders, credit notes
and recurring invoices. It does not model what the money is for. A freelancer's actual flow is
**agreement, work, money**. This design adds the first two so that the third follows from them:

1. **Agreements**: a document the freelancer and the customer both commit to. Scope, terms, price,
   validity, and an acceptance record with an audit trail.
2. **Deliverables**: the units of work inside an agreement. Each has a description, an amount, an
   agreed date and a fulfillment status, and is accepted by the customer.
3. **Invoicing from deliverables**: deliverables become invoice lines with a reservation that makes
   double billing impossible, so every invoice line traces back to what was agreed and delivered.
4. **Customer sign-off**: the customer accepts or disputes delivered work through a signed link,
   without an account.

Everything is built on the domain core from the invoicing lifecycle design: commands with client
request ids, deciders, domain events, approval gating for outward-facing commands, and agent tools.
Nothing here is cloud-only.

Revision 2 narrows the first implementation. Retainers, amendments of accepted agreements,
provider-backed signatures and hosted plan limits are **deferred** to their own designs; the
reasons are in "Deferred work". The remaining scope is four shippable phases.

## Why this and not a wider pivot

The scope test for every idea in this area is: **does it sit on the line from agreement to work to
money?** Agreements, deliverables, acceptance and billing from deliverables do. Time tracking, a
sales pipeline, proposals with marketing content, project boards, a customer portal with login and
expense tracking do not. Each of those is a separate product; adding them one at a time because
each feels adjacent produces a worse copy of Bonsai or HoneyBook.

The differentiator Quits has is the combination of open source, self-hostable, and an agent API. A
freelancer's own agent drafting the agreement, tracking what was delivered, and raising the invoice
is a story the incumbents cannot tell. Every feature below is designed agent-first: every mutation
is a domain command, drafting commands are MCP tools, outward-facing commands are approval-gated,
and attestations about the customer are human-only.

## Naming

The code calls the new document an **Agreement**, not a contract, because `packages/contracts`
already means TypeScript contracts. The default English UI label is "Agreement".

## Non-goals

- Time tracking, timesheets, or billing from tracked hours.
- A CRM, lead pipeline, or proposal builder.
- Project management: tasks, boards, assignments, comments.
- A customer portal with accounts. Customers act through signed links, as for quotes and invoices.
- Legal templates per jurisdiction, or any claim that a template is legally sufficient. Quits ships
  neutral default templates with a visible "not legal advice" notice and lets the organization
  edit or replace them. This document makes no claim about the legal adequacy of click-to-accept.
- Replacing quotes. A quote remains a priced offer.
- Attachments in email. Emails link to an authorized PDF download; the outbox stores text only.

## Data model

New Prisma models, organization-scoped, following the conventions of `Quote` and `QuoteItem`
(cuid ids, `organizationId` with cascade on the parent, `@@map` snake_case). Child rows carry no
`organizationId`, like `QuoteItem`.

### Agreement

| Field | Notes |
| --- | --- |
| `number` | Allocated by `allocateDocumentNumber("agreement")`. New counter `agreementPrefix` (default `AGR`) and `agreementNextNum` on `OrgSettings`; `formatDocumentNumber` adds the hyphen. `NumberedDocumentKind`, `lockableTables` and the document-delivery `config` are closed unions and each gains an `agreement` entry. |
| `contactId` | The customer. Immutable after send. |
| `status` | `draft`, `sent`, `accepted`, `declined`, `expired`, `completed`, `cancelled`. See lifecycle. |
| `title`, `summary` | Short name and optional plain-text scope statement. |
| `termsMarkdown` | The terms as edited. Bounded to 50,000 characters. |
| `templateId` | Optional, informational: which template the terms started from. |
| `taxRate` | One rate per agreement, like `RecurringInvoice.taxRate`. The pricing module takes one document-wide rate; a per-line rate is not supported. |
| `currency`, `countryCode`, `locale`, `timezone`, `taxRegime`, `pricesIncludeTax` | Same columns as `Quote`, defaulted from `OrgSettings`. |
| `dueInDays` | Payment terms for invoices raised from this agreement. Default from `OrgSettings`. |
| `subtotalNet`, `totalTax`, `totalGross` | Sum of deliverables, computed by `priceDocument` through an adapter that maps deliverables to its `{ description, quantity, unitPrice }` input. |
| `sellerSnapshot`, `buyerSnapshot` | Built at draft creation like quotes, and **refreshed at send** so the customer sees current details. The approval preview is rendered from the refreshed snapshots. |
| `issueDate`, `validUntil` | Validity window for acceptance. `validUntil` is a calendar date interpreted as end of day in the agreement's `timezone`. |
| `sourceQuoteId` | Optional. The accepted quote this was created from (Phase 4). |
| `parentAgreementId` | Optional. For an **addendum**: a separate agreement that adds work to an accepted one. The parent is not changed. |
| `publicAccessKeyVersion`, `publicAccessIssuedAt` | Signed read-and-decide link, same mechanism as quotes. Rotated on recall and resend. |
| `acceptedSnapshot`, `acceptedSnapshotHash` | The **canonical agreement JSON** (terms, deliverables with agreed dates and prices, totals, parties, validity, payment terms) frozen at send and hashed with SHA-256. This, not a terms hash, is what the customer accepts. |
| `acceptedAt`, `acceptedByName`, `acceptanceRecipientEmail`, `acceptanceIp`, `acceptanceUserAgent`, `acceptanceMethod`, `acceptanceEvidenceNote` | The acceptance record. `acceptedByName` is typed by the customer. `acceptanceRecipientEmail` is the address the link was sent to, captured server-side, never typed. IP and user agent are captured from the request. `acceptanceMethod` is `customer_link` or `internal`; `internal` requires `acceptanceEvidenceNote` (e.g. "accepted by email on 3 Oct, forwarded to records"). |
| `declinedAt`, `declineReason` | Mirror of quote rejection. |
| `closedAt`, `closeReason` | Set by `agreement.close`. |
| `lastEmailAttempt*` | The four document-delivery columns. |
| `notes` | Internal. Never serialized to the public DTO. |

### Deliverable

| Field | Notes |
| --- | --- |
| `agreementId` | Cascade delete. Deliverables are never deleted after the agreement is sent; they are cancelled. |
| `title`, `description` | What is being delivered. Immutable after send. |
| `quantity`, `unitPriceNet`, `unitPriceGross`, `lineNet`, `lineTax`, `lineGross`, `taxRate`, `taxCategory`, `taxCode` | Same shape as `QuoteItem`, stored as computed by `priceDocument`. Immutable after send. |
| `agreedDate` | The date in the accepted snapshot. Immutable after send. Nullable. |
| `expectedDate` | Operational forecast the freelancer may update at any time. Defaults to `agreedDate`. Shown to the customer as "expected", never as "agreed". |
| `status` | **Fulfillment** only: `planned`, `in_progress`, `delivered`, `accepted`, `changes_requested`, `cancelled`. |
| `billingStatus` | **Billing** only: `unbilled`, `reserved`, `invoiced`. Orthogonal to `status`. |
| `isDeposit` | A deposit line may be reserved while `planned`. Everything else is billable only when `accepted` (Phase 2) or `delivered` when the agreement's `billingTrigger` is `on_delivery`. |
| `deliveryRevision` | Integer, starts at 0, incremented each time the deliverable moves to `delivered`. Customer sign-off is bound to it. |
| `deliveredAt`, `acceptedAt`, `acceptedVia`, `acceptanceEvidenceNote` | `acceptedVia` is `customer_link` or `internal`; internal requires the note. |
| `changeRequestNote` | The customer's latest note. History is in the event log. |
| `sortOrder` | Display order. |

The agreement carries `billingTrigger`: `on_acceptance` (default) or `on_delivery`. One trigger per
agreement plus `isDeposit` per line replaces the per-line trigger of revision 1. There is no
`manual` trigger.

### AgreementTemplate

| Field | Notes |
| --- | --- |
| `name` | Unique per organization. |
| `termsMarkdown` | Body with placeholders `{{seller.name}}`, `{{buyer.name}}`, `{{agreement.title}}`, `{{agreement.validUntil}}`, `{{agreement.total}}`, `{{deliverables}}`. Placeholder values are escaped before Markdown rendering. |
| `isDefault` | At most one per organization. |

Two templates ("Fixed-scope project" and "Milestone project") are seeded per organization the first
time the agreement editor opens, so a later wording change in Quits never silently changes what an
organization sends. Template editing is Phase 4; Phase 1 only selects.

### Changes to existing models

- `InvoiceItem.deliverableId` (nullable, **unique**). This is the one authoritative billing link. A
  deliverable can be billed by at most one invoice item, enforced by the database.
- `Invoice.agreementId` (nullable). An invoice bills deliverables of exactly one agreement.
- `Contact.agreements`, `Quote.agreements`.
- `OrgSettings.agreementPrefix`, `OrgSettings.agreementNextNum`.
- Permissions, added to `statement` and the three grant tables in `lib/permissions.ts`:

| Resource | Actions | admin | member | accountant |
| --- | --- | --- | --- | --- |
| `agreement` | `create`, `read`, `update`, `send`, `delete`, `accept`, `close`, `manageTemplates` | all | `create`, `read`, `update`, `send`, `accept`, `close` | `read` |
| `deliverable` | `read`, `update`, `accept` | all | all | `read` |

Members do not delete, matching the invoice and quote policy. `agreement:accept`,
`agreement:close` and `deliverable:accept` are attestations about the customer or the engagement;
they are **not exposed as agent tools** in this design (see Agent API).

## Lifecycle

### Agreement transition table

| From | Command or trigger | To | Conditions and effects |
| --- | --- | --- | --- |
| draft | `updateDraft` | draft | Any field. Deliverables may be added, edited, removed. At least one deliverable required to send. |
| draft | `deleteDraft` | (gone) | |
| draft | `send` | draft, then sent | Refreshes snapshots, builds `acceptedSnapshot` and its hash, allocates number, queues `agreement.send` delivery. Becomes `sent` when the delivery settles as delivered or unconfirmed (document-delivery completion, same as quotes). A rejected delivery reopens the draft. |
| draft | `issue` (send without email) | sent | Same freeze, no email. Marks the link issued so it can be shared by hand. Allowed for users; for agents it is outward-facing. |
| sent | customer accepts (public) | accepted | Inside a transaction: lock the agreement, recheck `status = sent`, key version, and `validUntil`. Writes the acceptance record. Emits `agreement.accepted`. Queues notification emails (see Email). Idempotent: a repeat with the same key returns the existing acceptance. |
| sent | customer declines (public) | declined | Same locking and rechecks. |
| sent | `recordAcceptance` | accepted | Internal attestation, human-only. Requires `acceptanceEvidenceNote`. Same rechecks as the public path. Rotates the public link so the stale decision link cannot be used afterwards. |
| sent | `recall` | draft | Only while unaccepted. Locks, rechecks `sent`, rotates `publicAccessKeyVersion`, clears the frozen snapshot. The previous send is kept in the event log. The old link shows "This agreement was withdrawn". |
| sent | scheduler `expire` task | expired | Conditional update `status = sent AND validUntil < now()` per organization timezone, following `features/overdue.ts`. Emits only on actual change. |
| sent, expired, declined | `send` or `resend` with a new `validUntil` | sent | `resend` from `sent` reuses the snapshot and rotates the link. From `expired` or `declined` the command is `send` again: it requires `validUntil` in the future, rebuilds the snapshot, rotates the link. |
| accepted | `close` with `disposition: completed` | completed | Refused while any deliverable is `reserved` (list the linked drafts in the error). Uninvoiced, uncancelled deliverables are refused too, unless `cancelRemaining: true`, which cancels them with the close reason. |
| sent, accepted | `close` with `disposition: cancelled` | cancelled | Reason required. Refused while any deliverable is `reserved`. Remaining non-invoiced deliverables are cancelled. Invoiced ones and their invoices are untouched. From `sent`, rotates the link. |
| draft, sent, accepted | `createAddendum` | (new draft) | Creates a new agreement with `parentAgreementId`, same contact, empty deliverables. The parent is unchanged. |

`completed` is never derived. Progress (delivered, accepted, invoiced counts) is computed for
display from the deliverables.

**Lock order** for every command touching more than one aggregate: agreement, then its
deliverables, then invoices, each with `lockDocument(..., "update")`. Invoice commands that touch
deliverables lock the agreement first too. This prevents the close-versus-issue race.

### Deliverable transition table

| From | Command | To | Conditions |
| --- | --- | --- | --- |
| planned | `deliverable.update` | in_progress | Agreement `accepted`. |
| planned, in_progress, changes_requested | `deliverable.update` | delivered | Agreement `accepted`. Increments `deliveryRevision`, sets `deliveredAt`, clears `changeRequestNote`. Queues a sign-off notification (Phase 3). |
| delivered | customer accepts (public, Phase 3) | accepted | Submission carries `deliveryRevision`; refused if it differs from the current one or the agreement is not `accepted`. Locks the agreement and deliverable. |
| delivered | customer requests changes (public, Phase 3) | changes_requested | Same binding. Note required. |
| delivered | `deliverable.accept` | accepted | Internal, human-only, note required. |
| delivered, accepted | `deliverable.update` | in_progress | The freelancer reopens work. Not allowed when `billingStatus` is `invoiced`. |
| any except cancelled | `deliverable.cancel` | cancelled | Refused when `billingStatus` is `reserved` or `invoiced`. |
| any | `deliverable.update` | (same) | `expectedDate` may change at any time; `title`, `description`, prices and `agreedDate` only while the agreement is a draft. |

Billing status moves independently, only through the invoice commands below:

| From | Trigger | To |
| --- | --- | --- |
| unbilled | `invoice.createFromDeliverables`, or `invoice.update` adding the line to a draft | reserved |
| reserved | linked draft deleted, or `invoice.update` removing the line | unbilled |
| reserved | linked invoice **issued** | invoiced |

A deliverable is **billable** (may move to `reserved`) when `billingStatus = unbilled` and the
agreement is `accepted` and one of: `isDeposit`; `status = accepted`; `status = delivered` and the
agreement's `billingTrigger = on_delivery`. A credit note against the invoice is a financial
correction and does not change `billingStatus`.

## Invoice integration

### One issuance operation

Today an invoice becomes `sent` in three places: the delivery completion for `delivered`, the
completion for `unconfirmed`, and the send-without-email path. Phase 2 extracts one
`issueInvoice(tx, invoice, at)` used by all three. Inside the same transaction it sets
`deliverable.billingStatus = invoiced` for every linked item and emits `deliverable.invoiced`
events. A rejected delivery leaves the reservation in place, because the draft still exists.

### Reservation

`invoice.createFromDeliverables({ agreementId, deliverableIds, issueDate?, dueDate? })`:

1. Rejects duplicate ids in the input.
2. Locks the agreement, then each deliverable in id order.
3. Checks every deliverable belongs to this agreement and organization and is billable.
4. Creates the invoice draft with `agreementId`, `contactId` from the agreement, currency, tax
   settings and `dueInDays` from the agreement, one item per deliverable with `deliverableId` set
   and the frozen line values copied (not repriced), and sets each deliverable to `reserved`.

The unique index on `InvoiceItem.deliverableId` is the last line of defence against two concurrent
requests with different client request ids.

### Edits of linked invoices

The current `invoice.update` replaces every item. For an invoice with `agreementId`:

- `contactId`, `currency`, `taxRegime` and `pricesIncludeTax` are immutable.
- Items with `deliverableId` keep their identity and their commercial fields (description,
  quantity, prices, tax). Omitting one from the update removes it and releases the deliverable to
  `unbilled` in the same transaction.
- Items without `deliverableId` (extra expenses, discounts) may be added, edited and removed freely.
- Adding a deliverable to an existing draft goes through `invoice.addDeliverables`, which applies
  the same reservation rules.

`invoice.deleteDraft` releases every linked deliverable. Both run under the lock order above.

## Public links

### Agreement decision link

Route `/a/$token`, built like `/q/$token`: signed token carrying agreement id and
`publicAccessKeyVersion`, server-rendered. Shows title, summary, deliverables with agreed dates,
totals, rendered terms and validity. Before acceptance: a name field, a checkbox "I accept this
agreement on behalf of {buyer}", Accept and Decline. After acceptance the page is read-only and
shows the acceptance record. It never shows sign-off controls: decision authority after acceptance
comes only from per-delivery links.

Rotation on recall, resend, internal acceptance and cancellation invalidates earlier links.
Tokens also carry `validUntil` as `exp`, and the server rechecks the column. A leaked link grants
nothing after rotation or expiry, and nothing beyond reading before that.

### Sign-off link (Phase 3)

When a deliverable moves to `delivered`, the notification email carries a separate signed token
with agreement id, deliverable id, `deliveryRevision` and the agreement's current key version.
Route `/a/$token/sign-off`. Accept and Request changes submit that revision. A later delivery
invalidates the earlier link by revision; a rotation invalidates it by key version.

### Rate limiting

Neither quote nor pay links are rate-limited today. This design adds a `PublicLinkAttempt`
table keyed by token hash with a sliding count; more than 10 decision submissions in an hour
returns a retry-later response. Reads are not limited. The same guard is wired to the quote
decision path, as a small shared improvement.

### Public DTO

An explicit allowlist in `lib/agreements/public.ts`: never `notes`, never acceptance IP or user
agent, never internal evidence notes. The quote serializer exposes `notes`; it is not copied.

### Markdown

Terms are rendered with a restricted renderer: raw HTML disabled, only `http`, `https` and
`mailto` link protocols, no images, output sanitized, placeholder values escaped before rendering.
The same renderer feeds the public page, the PDF and the email preview. Tests include a corpus of
hostile input for all three.

## Approval and attestation

Outward-facing commands, which queue for approval in `approval_required` mode: `agreement.send`,
`agreement.issue`, `agreement.resend`. Their `approvalContext` has `version = acceptedSnapshotHash
+ ":" + recipient email`, computed from the refreshed snapshots under the agreement lock, and
`details` with customer, total, validity, deliverable count and a link to the rendered PDF so the
approver reviews the actual document, not a digest. Approval execution recomputes the hash and
refuses on mismatch, as `execute.ts` does today.

Human-only commands, not registered as agent tools: `agreement.recordAcceptance`,
`agreement.close`, `deliverable.accept`, `deliverable.cancel`, `agreement.recall`. They assert
things about the customer or end an engagement, which is not drafting. An agent can read their
outcome and draft around it.

Public (customer) commands run as the `system` actor with reason `customer_link`, like
`applyPublicQuoteDecision`, and are excluded from the user and MCP registries.

## PDF and email

- `agreement-pdf.tsx` alongside the invoice and credit note PDFs, rendered from `acceptedSnapshot`
  once it exists, including the acceptance block (name, recipient email, timestamp, method, hash).
- The PDF is fetched through an authorized route: signed public link for the customer, session for
  the freelancer. Emails link to it; the outbox is not extended with attachments.
- Emails: agreement sent (document delivery, settles the `sent` transition); agreement accepted
  (to the freelancer and to the customer); deliverable delivered with sign-off link (customer);
  sign-off received (freelancer). The last three are **notifications**, not document deliveries.
  They run as a new `notification.deliver` job with their own idempotency key
  (`agreement-<id>-accepted-<recipient>`), their own completion record, and no use of the
  document's `lastEmailAttempt*` marker. A failed notification never changes agreement state.
  Managed sender resolution is reused from the invoice email module.

## Agent API

Tools in `apps/oss/src/domain/agent-tools/tools/agreements.ts`:

- Reads: `agreement.list` (status, contact, parent), `agreement.get` (with deliverables, billing
  status, acceptance record, progress), `deliverable.list` (status, billing status, expected
  before), `agreementTemplate.list`.
- Commands: `agreement.createDraft`, `agreement.updateDraft`, `agreement.deleteDraft`,
  `agreement.send`, `agreement.issue`, `agreement.resend`, `agreement.createAddendum`,
  `deliverable.update`, `invoice.createFromDeliverables`, `invoice.addDeliverables`.

Scopes are the exact permission strings; there are no wildcards. Preset changes:

- Read-only bookkeeper: `agreement:read`, `deliverable:read`.
- Drafting assistant: the above plus `agreement:create`, `agreement:update`, `agreement:send`
  (queued for approval), `deliverable:update`, and `invoice:create` as today.
- Full access: every scope the creator holds; attestation commands remain unavailable to agents
  regardless of scope.

## OSS and cloud boundary

Everything in this design is OSS. No capability key, extension point or plan limit is added. If a
hosted plan later meters agreements, that is an injected service with an OSS no-op, like invoice
limits, in its own change. Provider signatures are deferred (below). Managed email domains apply to
the new emails with no new work.

## Deferred work

Each of these needs its own design before implementation. They are listed so the schema above does
not paint them into a corner.

- **Retainers.** Needs a schedule-ownership contract: snapshot of cadence, period price, first
  billing date and payment terms the customer accepted; provenance on generated invoices; guards
  on every recurring entry point (edit, resume, run-now, queued auto-send) against a cancelled or
  unaccepted agreement; and defined behaviour for generated drafts when the retainer ends. The
  "Monthly retainer" template is not seeded until then.
- **Amendments of accepted agreements.** Revision 1 superseded on send, which destroyed the
  current engagement before its replacement was accepted, and copied deliverables without a stable
  billing identity. Until designed, scope changes are an addendum (additive, separate agreement)
  or close-and-recreate.
- **Provider-backed signatures.** A future adapter submits verified evidence through a domain
  command; it never writes acceptance columns. The `acceptanceMethod` column leaves room for it.
- **Plan limits for the hosted product.**

## Phases

### Phase 1: Agreements with acceptance

Schema for `Agreement`, `Deliverable`, `AgreementTemplate`, counters and permissions. Numbering,
pricing adapter, snapshots, canonical snapshot and hash. Commands: `createDraft`, `updateDraft`,
`deleteDraft`, `send`, `issue`, `resend`, `recall`, `recordAcceptance`, `close`, `createAddendum`,
`deliverable.update` (fulfillment statuses and dates), `deliverable.accept` (internal),
`deliverable.cancel`. Expiry scheduler task. Public decision link with accept and decline, DTO
allowlist, restricted Markdown, rate limiting. PDF. Agreement-sent delivery and accepted
notifications. UI: list, editor with template selection, detail with deliverables, progress and
activity, approvals entry. Agent tools for the drafting commands and reads. Contract schemas in
`packages/contracts/src/agreements.ts`, added to the package exports.

No billing in this phase: `billingStatus` exists and stays `unbilled`.

Verification: decider tests for every row of both transition tables including refusals; concurrent
accept-versus-recall and accept-versus-expire tests under the lock; public-session tests mirroring
the quote ones plus key rotation and expiry; hostile Markdown corpus for page, PDF and email;
contracts package export check; Playwright: create, send, open link, accept, see record and PDF;
recall and see the withdrawn page.

### Phase 2: Invoicing from deliverables

`InvoiceItem.deliverableId` (unique), `Invoice.agreementId`, `issueInvoice` extraction,
`invoice.createFromDeliverables`, `invoice.addDeliverables`, linked-invoice edit rules, draft-delete
release, close-while-reserved refusal. UI: "Invoice" action preselecting billable deliverables;
billing status on the detail page.

Verification: reservation under concurrency (two requests, different client ids, one wins);
duplicate ids rejected; edit of a linked draft cannot change contact or linked line values and
releases omitted lines; delete releases; issuance through delivered, unconfirmed and no-email paths
all mark invoiced; rejected delivery keeps the reservation; close refused while reserved; credit
note leaves billing status alone.

### Phase 3: Customer sign-off

`deliveryRevision` binding, sign-off link and route, `deliverable.publicAccept`,
`deliverable.publicRequestChanges`, delivered and sign-off-received notifications. Agent tools
surface `changes_requested` with the note.

Verification: stale revision refused; stale key version refused; sign-off on a non-accepted
agreement refused; rate limit; idempotent resubmission.

### Phase 4: Quote conversion and template editing

`createDraft` from an accepted quote copies quote items as deliverables. Policy: refused when the
quote already has invoices; once a quote has an agreement, `quote.convertToInvoice` is refused with
a message pointing at the agreement. Template create, update, delete under
`agreement:manageTemplates` in settings.

## Risks and how the design handles them

- **Legal exposure from templates.** Neutral, editable, seeded per organization, with a visible
  notice. The canonical snapshot hash proves what was accepted.
- **Double billing.** One authoritative unique link, reservation at draft time under locks, release
  on delete or line removal, issuance in one operation. Quote conversion is policed so a quote
  cannot be billed twice through two paths.
- **Engagement destroyed by a race.** Explicit close, refused while anything is reserved, under a
  fixed lock order; no automatic supersession.
- **Public token abuse.** Rotation on every state change that should invalidate a link, token
  expiry, per-token rate limiting, read-only after acceptance, per-revision sign-off links.
- **Scope creep.** The non-goals and deferred lists are part of the design.

## Open questions for review

1. Is `agreement.issue` (freeze without email) worth having in Phase 1, or should a user who wants
   to share the link by hand just send to themselves? It exists because customers often get the
   link through a channel Quits does not control.
2. Is one `billingTrigger` per agreement plus `isDeposit` the right simplification, or will users
   need to mix acceptance-billed and delivery-billed lines in one agreement?
3. The expiry task and the public accept path both check `validUntil`. Is end-of-day in the
   agreement timezone the right boundary, or should `validUntil` be a timestamp?
