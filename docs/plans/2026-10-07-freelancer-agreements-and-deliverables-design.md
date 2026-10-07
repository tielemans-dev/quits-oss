# Freelancer Agreements and Deliverables Design

Status: revision 4, after adversarial review rounds 1 to 3 (2026-10-07). Approved for implementation of Phase 1.

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

Retainers, amendments and addenda of accepted agreements, provider-backed signatures and hosted
plan limits are **deferred** to their own designs; see "Deferred work".

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

- The document is an **Agreement**, not a contract, because `packages/contracts` already means
  TypeScript contracts. The default English UI label is "Agreement".
- Three name spaces, following the existing pattern (`quote.convert_to_invoice` is the domain
  command, `quotes.convertToInvoice` the tRPC procedure, `quote_convert_to_invoice` the MCP tool):
  domain commands are `agreement.create_draft`, tRPC procedures `agreements.createDraft`, MCP
  tools `agreement_create_draft`. This document writes commands in camel case for readability.

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
- Automatic deposit deduction. A deposit is a line that is part of the agreed total; a 300 deposit
  plus a 700 balance line totals 1,000. Quits does not subtract deposits from later invoices.

## Data model

New Prisma models, organization-scoped, following the conventions of `Quote` and `QuoteItem`
(cuid ids, `organizationId` with cascade on the parent, `@@map` snake_case). Child rows carry no
`organizationId`, like `QuoteItem`; they are serialized through their parent's lock (see Locking).

### Agreement

| Field | Notes |
| --- | --- |
| `number` | Allocated at issuance by `allocateDocumentNumber("agreement")`. New counter `agreementPrefix` (default `AGR`) and `agreementNextNum` on `OrgSettings`; `formatDocumentNumber` adds the hyphen. `NumberedDocumentKind`, `lockableTables` and the document-delivery `config` are closed unions and each gains an `agreement` entry. |
| `contactId` | The customer. Immutable after issuance. |
| `status` | `draft`, `sent`, `accepted`, `declined`, `expired`, `completed`, `cancelled`. |
| `title`, `summary` | Short name and optional plain-text scope statement. |
| `termsMarkdown` | The terms as edited. Bounded to 50,000 characters. |
| `templateId` | Optional, informational. |
| `taxRate` | One rate per agreement, like `RecurringInvoice.taxRate`; `priceDocument` takes one document-wide rate. |
| `currency`, `countryCode`, `locale`, `timezone`, `taxRegime`, `pricesIncludeTax` | Same columns as `Quote`, defaulted from `OrgSettings`. Frozen at issuance; the agreement's own `timezone` is used for every later date computation, never the organization's current one. |
| `dueInDays` | Payment terms for invoices raised from this agreement. |
| `billingTrigger` | `on_acceptance` (default) or `on_delivery`. Frozen in the offer snapshot. |
| `subtotalNet`, `totalTax`, `totalGross` | Sum of deliverables, computed by `priceDocument` through an adapter mapping deliverables to `{ description, quantity, unitPrice }`. |
| `sellerSnapshot`, `buyerSnapshot` | Built at draft creation and refreshed at issuance. |
| `validUntil` | Calendar date. `expiresAt` is derived once at issuance as the start of the following day in the agreement's `timezone` and stored. Every **decision** check (`decide` tokens, public and internal decisions, the expiry task, issuance itself) compares `now < expiresAt`. `read` and `sign_off` tokens have their own lifetimes (see Public links). Tested across DST boundaries. |
| `issueDate`, `expiresAt` | Set at issuance. |
| `offerRevision` | Integer, starts at 0, incremented on every issuance. Identifies which frozen offer a decision or link refers to. |
| `offerSnapshot`, `offerSnapshotHash` | The **canonical agreement JSON** of the current offer. SHA-256 over a canonical serialization (sorted keys, decimals as strings, dates as ISO strings). **Included:** seller and buyer snapshots, `title`, `summary`, rendered terms, `validUntil`, `timezone`, `currency`, `countryCode`, `locale`, `taxRegime`, `taxRate`, `pricesIncludeTax`, `dueInDays`, `billingTrigger`, totals, and per deliverable `title`, `description`, `quantity`, `unitPriceNet`, `unitPriceGross`, `lineNet`, `lineTax`, `lineGross`, `taxRate`, `taxCategory`, `taxCode`, `agreedDate`, `isDeposit`, `sortOrder`. Decimals are serialized as their fixed-point string form. **Excluded:** `number`, `issueDate`, `expiresAt`, `offerRevision`, `expectedDate`, `status`, `billingStatus`, `deliveryRevision`, all acceptance, delivery and decision fields, `notes`, `lastEmailAttempt*`, ids and timestamps. Canonicalization fixtures prove that changing an agreed date or `validUntil` changes the hash and changing `expectedDate` or `notes` does not. Cleared on recall; the recalled offer is archived in the `agreement.offer_recalled` event payload. |
| `issuedToEmail`, `issuedVia` | The intended recipient and method (`email` or `manual`). `send` reads the contact's email under the contact lock and freezes it here. `issue` takes an optional explicit recipient; without one, `issuedToEmail` is null. `resend` reuses `issuedToEmail` unless an explicit new recipient is given, which emits `agreement.recipient_changed` and is part of the approval context. Customer notifications go to `issuedToEmail` only; when it is null, no customer email is sent and the detail page offers the link to share by hand. The acceptance record cites `issuedToEmail` as the intended recipient. It is not proof of delivery or of signer identity. |
| `publicAccessKeyVersion`, `publicAccessIssuedAt` | Rotated on recall, resend, internal acceptance, cancellation from `sent`, and the explicit "Revoke links" action. Not rotated on cancellation or completion from `accepted`, so read access to the accepted evidence survives. |
| `acceptedAt`, `acceptedOfferRevision`, `acceptedByName`, `acceptanceIp`, `acceptanceUserAgent`, `acceptanceMethod`, `acceptanceEvidenceNote` | The acceptance record. `acceptedByName` is typed by the customer. IP and user agent come from the request. `acceptanceMethod` is `customer_link` or `internal`; `internal` requires the evidence note. |
| `declinedAt`, `declineReason`, `closedAt`, `closeReason` | |
| `lastEmailAttempt*` | The four document-delivery columns. |
| `notes` | Internal. Never in the public DTO. |

### Deliverable

| Field | Notes |
| --- | --- |
| `agreementId` | Cascade delete. |
| `title`, `description`, pricing columns as `QuoteItem`, `agreedDate`, `isDeposit` | Part of the offer snapshot. Immutable, and the row undeletable, **while an offer is live** (`sent`) and forever once `accepted`. A recalled draft is fully editable again, including removing lines and changing the contact; the archived offer in the event log stands on its own. |
| `expectedDate` | Operational forecast, outside the snapshot, mutable at any time. Shown to the customer labelled "expected", next to the agreed date labelled "agreed". |
| `status` | Fulfillment: `planned`, `in_progress`, `delivered`, `accepted`, `changes_requested`, `cancelled`. **Deposit lines do not participate in fulfillment**: they stay `planned` or `cancelled`, never delivered or accepted, and completion only requires their billing to be terminal. |
| `billingStatus` | `unbilled`, `reserved`, `invoiced`. Orthogonal to `status`. |
| `deliveryRevision` | Starts at 0, incremented on each transition to `delivered`. |
| `deliveredAt`, `acceptedAt`, `acceptedRevision`, `acceptedVia`, `acceptanceEvidenceNote` | Current acceptance, bound to `acceptedRevision`. Cleared on reopen or redelivery; the previous record stays in the event log. |
| `changeRequestNote` | Latest note. |
| `sortOrder` | |

### AgreementTemplate

`name` (unique per organization), `termsMarkdown` with placeholders (`{{seller.name}}`,
`{{buyer.name}}`, `{{agreement.title}}`, `{{agreement.validUntil}}`, `{{agreement.total}}`,
`{{deliverables}}`; values escaped before rendering), `isDefault`. Two templates ("Fixed-scope
project", "Milestone project") are seeded per organization when the editor first opens. Template
editing is Phase 4.

### Changes to existing models

- `InvoiceItem.deliverableId` (nullable, **unique**): the one authoritative billing link.
- `Invoice.agreementId` (nullable).
- `Agreement.sourceQuoteId` (nullable, **unique**): one agreement per quote (Phase 4).
- `Contact.agreements`, `Quote.agreement`.
- `OrgSettings.agreementPrefix`, `OrgSettings.agreementNextNum`.
- Permissions, added to `statement` and the three grant tables in `lib/permissions.ts`:

| Resource | Actions | admin | member | accountant |
| --- | --- | --- | --- | --- |
| `agreement` | `create`, `read`, `update`, `send`, `delete`, `accept`, `close`, `manageTemplates` | all | all except `delete`, `manageTemplates` | `read` |
| `deliverable` | `read`, `update`, `deliver`, `accept` | all | all | `read` |

`agreement:accept`, `agreement:close`, `deliverable:accept` and the cancel and recall commands are
attestations or engagement-ending actions. Their handlers refuse non-user actors and they are not
registered as agent tools. Public (customer) commands require the `system` actor with reason
`customer_link`, as `quote.record_customer_decision` enforces today, and are registered in neither the user
nor the MCP registry.

Schema details for the migration: `number`, `issueDate`, `expiresAt`, `offerSnapshot`,
`offerSnapshotHash`, `issuedToEmail`, `issuedVia` and `publicAccessIssuedAt` are nullable because
drafts have none of them; `@@unique([organizationId, number])` tolerates nulls. Counters are added
with defaults and never touch existing document numbers. `contactId` is `onDelete: Restrict` and
the contact-deletion guard in `commands/contacts.ts` gains agreements. Template seeding is an
upsert on `(organizationId, name)` so concurrent first opens cannot double-seed; a partial unique
index on `(organizationId) WHERE isDefault` keeps one default.

## Locking

`lockDocument(kind, id, { strength })` locks organization-scoped rows only. Deliverables have no
`organizationId`, so **the agreement row is the serialization lock for every child mutation**:
every command or completion callback that reads or writes deliverables first locks the agreement
with `{ strength: "update" }`. Invoice commands that touch deliverables lock the agreement, then
the invoice; commands that touch several invoices lock them in id order. Delivery-completion
callbacks for agreement-linked invoices follow the same order. This is the fixed lock order:
agreement, then invoices by id.

## Pending delivery

The existing `refuseWhileSending` guard applies to every agreement mutation while a send or resend
is pending: draft edits, deletion, `issue`, `resend`, `recall`, `close`, and deliverable
mutations. Customer decisions during a pending resend are refused with `retry_later`, because the
agreement's key version may change when the resend settles. Tests cover rejection, unconfirmed
and delayed completion.

## Lifecycle

### Agreement transition table

| From | Command or trigger | To | Conditions and effects |
| --- | --- | --- | --- |
| draft | `updateDraft` | draft | Any field, including the contact. At least one non-cancelled deliverable is required to issue. |
| draft | `deleteDraft` | gone | Refused if an approval request for this agreement is pending. A draft that once had an offer (recalled or rejected) may be deleted; its archived offers remain in the event log. |
| draft | `send` | draft, then sent | **Issuance** (below) plus a document-delivery job. Becomes `sent` when the delivery settles as delivered or unconfirmed. A rejected delivery reopens the draft and keeps number, revision, snapshot, key and expiry. |
| draft | `issue` | sent | Issuance without email. `issuedVia = manual`, `issuedToEmail` from the explicit input or null. Outward-facing for agents, because it makes the offer live. |
| sent | customer accepts | accepted | Input: `acceptedByName` (1 to 200 characters, trimmed, non-empty) and `confirmed: true`, both validated server-side. **Check order**: token framing, signature, scope `decide`, key version, `offerRevision`; then lock the agreement; then **replay**: if the agreement is already decided for this revision with the same verb, return the existing record, regardless of expiry, with no event, no email and no change to the stored evidence; if decided with the opposite verb, refuse `already_decided`; then `status = sent` and `now < expiresAt`; then write the acceptance record with `acceptedOfferRevision`, emit `agreement.accepted`, queue notifications. |
| sent | customer declines | declined | Same input validation (reason optional), same check order and replay rule. |
| sent | `recordAcceptance` | accepted | Human-only. Evidence note required. Same rechecks. Rotates the key and queues the accepted notification with a read link so the customer still has access. |
| sent, expired, declined | `recall` | draft | Not from `accepted`. Locks, rotates the key, archives the offer (snapshot, hash, recipient, revision, key version, decision fields) in the `agreement.offer_recalled` payload, clears the snapshot and decision fields. Old links show the generic "This link is no longer valid" page, same as a stale quote link today. To extend validity: recall, edit `validUntil`, send; that is a new offer revision. |
| sent | `resend` | sent | Same offer, same snapshot, same `validUntil`; rotates the key, queues a new email to `issuedToEmail` or to an explicit new recipient (audited). Refused after `expiresAt`. |
| sent | scheduler task | expired | Conditional `updateMany` where `status = sent AND expiresAt <= now()`, following `features/overdue.ts`; emits only on change. |
| sent, accepted | `close` with `disposition: cancelled` | cancelled | Human-only. Reason required. Refused while any deliverable is `reserved` (error lists the linked drafts). Non-invoiced deliverables become `cancelled`. Invoiced ones and their invoices are untouched. From `sent`, rotates the key; from `accepted`, does not. |
| accepted | `close` with `disposition: completed` | completed | **Phase 2.** Refused unless every non-deposit deliverable is in a terminal fulfillment state (`accepted` or `cancelled`) and every deliverable is in a terminal billing state (`invoiced`, or `unbilled` while `cancelled`). `cancelRemaining: true` cancels remaining unbilled, unaccepted deliverables with the close reason first. Does not rotate the key. |

`completed` is never derived. Progress is computed for display. Fulfillment transitions are
refused once the agreement is `completed`, `cancelled`, `declined` or `expired`.

### Issuance

One operation used by `send`, `issue`, and approval execution:

1. Lock the agreement, then the contact (`no_key_update`). Refuse while sending. Refuse unless at
   least one non-cancelled deliverable exists and `now < derived expiresAt`.
2. Refresh seller and buyer snapshots. Build the **prospective offer snapshot** and hash from the
   current draft (field contract in the data model table). Resolve the recipient: the contact's
   email for `send`, the explicit input or null for `issue`.
3. If this is approval execution, compare hash and recipient with the reviewed values and refuse
   on mismatch (the existing version check in `execute.ts`).
4. **Unchanged retry after a rejected delivery**: if the agreement already has `offerSnapshotHash`
   equal to the prospective hash and the same recipient, keep number, revision, key, `issueDate`
   and `expiresAt`. Otherwise: allocate the number if missing, increment `offerRevision`, set
   `issueDate`, compute and store `expiresAt`, store snapshot, hash, `issuedToEmail`, `issuedVia`,
   rotate the key, set `publicAccessIssuedAt`.
5. For `send`: queue document delivery; status stays `draft` until settlement. For `issue`: set
   `sent` immediately.

Tests: unchanged retry keeps everything; a draft edit or contact edit after rejection produces a
new revision and key; delayed completion of the first delivery after a second issuance settles
nothing, because the attempt marker no longer matches.

**Approval preview binding.** When an outward-facing issuance is queued, the approval context
stores the full prospective snapshot, its hash and the recipient in `ApprovalRequest.reviewContext`
(the column exists for this). `version` is `hash + ":" + recipient`. The approvals UI links to
`/app/approvals/:approvalId/preview.pdf`, which renders **the stored snapshot**, never the live
draft. Execution recomputes the hash from the draft and refuses on mismatch, so the approver sees
exactly what is issued or nothing is issued. Test: queue A, edit to B, open preview (shows A),
restore A, approve (issues A); queue A, edit to B, approve (refused).

### Deliverable transition table

| From | Command | To | Conditions |
| --- | --- | --- | --- |
| planned | `deliverable.update` | in_progress | Agreement `accepted`. |
| planned, in_progress, changes_requested | `deliverable.markDelivered` | delivered | Agreement `accepted`, not a deposit line. Increments `deliveryRevision`, sets `deliveredAt`, clears current acceptance and `changeRequestNote`. In Phase 3 this queues the sign-off email, so it is a **separate, outward-facing** command from the start. Its approval context: agreement number, deliverable title, current `status` and `deliveryRevision`; `version = deliverableId:status:deliveryRevision`, so an approval goes stale when the work is reopened or redelivered meanwhile. Phase 3 adds the notification recipient to the context. |
| delivered | customer accepts (Phase 3) | accepted | Token carries `deliveryRevision`; refused on mismatch or if the agreement is not `accepted`. Sets `acceptedRevision`. Replay rule as above. |
| delivered | customer requests changes (Phase 3) | changes_requested | Same binding; note required. Allowed while `reserved`: the customer is never blocked by billing state. The linked draft is flagged as disputed, and `invoice.send` on it is refused unless the input carries `acknowledgeDisputed: true`, which is recorded in the event. |
| delivered | `deliverable.accept` | accepted | Human-only, note required. |
| delivered, accepted | `deliverable.update` | in_progress | Reopen. **Refused unless `billingStatus = unbilled`**: release the draft line first. Clears current acceptance. |
| any except cancelled | `deliverable.cancel` | cancelled | Human-only. Refused unless `billingStatus = unbilled`. |
| any | `deliverable.update` | same | `expectedDate` at any time; snapshot fields only while draft. |

### Billing status

| From | Trigger | To |
| --- | --- | --- |
| unbilled | `invoice.createFromDeliverables` or `invoice.addDeliverables` | reserved |
| reserved | linked draft deleted, or `invoice.update` omitting the line | unbilled |
| reserved | linked invoice **issued** | invoiced |

A deliverable is **billable** when `billingStatus = unbilled`, `status != cancelled`, the agreement
is `accepted`, and one of: `isDeposit`; `status = accepted`; `status = delivered` with
`billingTrigger = on_delivery`. **Eligibility is frozen at reservation**: issuance does not recheck
it. The reopen and cancel refusals above are what keep a reservation valid. A credit note is a
financial correction and does not change `billingStatus`.

## Invoice integration (Phase 2)

### One issuance operation

An invoice becomes `sent` in three places today: the delivery completion for `delivered`, the
completion for `unconfirmed`, and send-without-email. Phase 2 extracts `issueInvoice(tx, invoice,
at)` used by all three. For an invoice with `agreementId` it locks the agreement first, sets every
linked deliverable to `invoiced` and emits `deliverable.invoiced`. A rejected delivery leaves the
reservation, because the draft still exists.

The lock order applies **before** the handler too: the invoice `send` approval context and every
helper that loads a linked invoice discover `agreementId` first and lock the agreement before the
invoice. Test: an approved send racing a linked-line edit and an agreement close.

### Reservation

`invoice.createFromDeliverables({ agreementId, deliverableIds, issueDate?, dueDate? })`:

1. Rejects duplicate ids.
2. Locks the agreement.
3. Checks each deliverable belongs to this agreement and is billable.
4. Creates the draft with `agreementId`, the agreement's contact, currency and tax context,
   `dueInDays`, one item per deliverable with `deliverableId` and the frozen line values copied
   (not repriced), and sets each deliverable to `reserved`.

The unique index is the last line of defence against concurrent requests with different client
request ids.

### Edits of linked invoices

For an invoice with `agreementId`:

- `contactId`, `currency`, `taxRegime`, `pricesIncludeTax` are immutable.
- Linked items keep identity and commercial fields. Omitting one releases its deliverable in the
  same transaction.
- Unlinked items (expenses, discounts) may be added, edited and removed. They are priced with the
  **agreement's frozen tax rate and context**, not current organization settings. Totals are the
  sum of frozen linked lines and newly priced unlinked lines.
- `invoice.addDeliverables` applies the reservation rules to an existing draft.

`invoice.deleteDraft` releases linked deliverables.

## Public links

Tokens are signed like quote tokens and carry: agreement id, `scope`, `publicAccessKeyVersion`,
an `exp` instant, and scope-specific fields. **Canonical framing is enforced**: a token with any
component beyond the two expected is rejected before any other processing. The same guard is added
to the quote and pay verifiers; their existing two-component tokens keep working and their payloads
gain no new required fields. The server dispatches every public request by the **verified scope**,
not by which controls the page rendered; a `decide` POST with a `read` token is refused.

| Scope | Issued when | Grants | Agreement states | Expiry | Invalidated by |
| --- | --- | --- | --- | --- | --- |
| `decide` | Issuance, resend | Read the offer and PDF; accept or decline. Carries `offerRevision`. | `sent` | `expiresAt` | Key rotation; a later revision. |
| `read` | Acceptance (customer or internal); "Send read link" on the detail page | Read the accepted agreement and PDF. | `accepted`, `completed`, `cancelled` after acceptance | 2 years from minting. Renewal mints a new token with a new `exp` and **does not** rotate the key. | Key rotation (explicit "Revoke links" only, after acceptance). |
| `sign_off` | `markDelivered` (Phase 3) | Read; accept or request changes for one deliverable. Carries deliverable id and `deliveryRevision`. | `accepted` | 90 days from minting | Key rotation; a later `deliveryRevision`. |

"Revoke links" is an explicit human action on the detail page that rotates the key; its
confirmation states that outstanding sign-off links also stop working and that read links must be
sent again. The accepted notification always carries a fresh `read` link, so acceptance evidence
stays reachable after the offer's validity ends. "Send read link" is outward-facing for agents and
uses a new delivery key per minting, because the outbox deduplicates by key.

### Rate limiting

Decision submissions (`decide` and `sign_off`) are limited by **verified identity**, not by raw
token. After signature verification, one `PublicLinkAttempt` row per submission is inserted in its
own transaction, so a refused decision still counts, keyed by `(documentKind, documentId, scope,
keyVersion, targetId, revision)` where `targetId` is the deliverable id for `sign_off` and null
otherwise. More than 10 rows for one key in the last hour return a typed `retry_later`, distinct
from `invalid`. Rows older than a day are swept by the scheduler. Reads are not limited. The quote
decision path gets the same guard with `documentKind = quote`. Tests: eleven deliverables each get
their own bucket; concurrent submissions count correctly.

### Public DTO and Markdown

An explicit allowlist in `lib/agreements/public.ts`: never `notes`, IP, user agent, evidence
notes or `expectedDate` history. Terms are rendered with a restricted renderer: raw HTML disabled,
only `http`, `https` and `mailto` links, no images, output sanitized, placeholders escaped. The same
renderer feeds page, PDF and email. Tests use a hostile corpus against all three.

## PDF and email

- `agreement-pdf.tsx` renders from `offerSnapshot` and, once accepted, the acceptance block (name,
  intended recipient, timestamp, method, revision, hash). The preview route renders the prospective
  snapshot of a draft.
- PDF access: `read` or `decide` token for the customer, session for the freelancer.
- All emails use the existing `email.deliver` job so they inherit fencing, provider idempotency,
  unconfirmed settlement and abandoned-job recovery. Two kinds of completion:
  - **Document delivery** (`agreement.send`, `agreement.email`): settles the agreement's
    `lastEmailAttempt*` marker and the `sent` transition, like quotes.
  - **Notifications** (`agreement.notification`): a new completion kind that records its outcome on
    the job only and never touches document markers or state. Idempotency keys:
    `agreement-<id>-accepted-<recipient>`, `agreement-<id>-deliverable-<id>-delivered-<revision>`,
    `agreement-<id>-deliverable-<id>-signoff-<revision>`.
- A failed notification never changes agreement or deliverable state.

## Agent API

Tools in `apps/oss/src/domain/agent-tools/tools/agreements.ts`:

- Reads: `agreement.list`, `agreement.get` (deliverables, billing status, acceptance record,
  progress), `deliverable.list`, `agreementTemplate.list`.
- Commands: `agreement.createDraft`, `agreement.updateDraft`, `agreement.deleteDraft`,
  `agreement.send`, `agreement.issue`, `agreement.resend`, `deliverable.update`,
  `deliverable.markDelivered`, `invoice.createFromDeliverables`, `invoice.addDeliverables`.
- Outward-facing (queued in `approval_required` mode): `agreement.send`, `agreement.issue`,
  `agreement.resend`, `deliverable.markDelivered`.

Scopes are exact permission strings. Presets: read-only bookkeeper adds `agreement:read`,
`deliverable:read`; drafting assistant adds `agreement:create`, `agreement:update`,
`agreement:send`, `deliverable:update`, `deliverable:deliver`; full access adds every scope the
creator holds, with attestation commands still refused for agent actors.

## OSS and cloud boundary

Everything in this design is OSS. No capability key, extension point or plan limit is added.
Managed email domains apply to the new emails with no new work.

## Deferred work

- **Retainers.** Needs a schedule-ownership contract: snapshot of cadence, period price, first
  billing date and payment terms; provenance on generated invoices; guards on every recurring entry
  point against a cancelled or unaccepted agreement; behaviour for generated drafts when the
  retainer ends.
- **Amendments and addenda.** Supersession on send destroyed the live engagement; copying
  deliverables lost billing identity; addenda from draft parents or with changed contacts broke the
  parent relationship. Until designed, scope changes are close-and-recreate.
- **Provider-backed signatures.** A future adapter submits verified evidence through a domain
  command; `acceptanceMethod` leaves room for it.
- **Plan limits for the hosted product.**

## Phases and pull requests

### Phase 1: Agreements with acceptance (three PRs)

**PR 1a, foundation.** Schema for `Agreement`, `Deliverable`, `AgreementTemplate`, counters,
permissions, contracts in `packages/contracts/src/agreements.ts` added to the barrel, the `exports` map and the `files` allowlist of the package, verified by importing from the packed artifact. Draft
commands (`createDraft`, `updateDraft`, `deleteDraft`, `deliverable.update` for snapshot fields),
pricing adapter, snapshots, prospective snapshot builder and hash with canonicalization fixtures,
restricted Markdown, seeded templates. UI: navigation entry, list, editor with template selection,
detail with a "Send" control that is disabled with the text "Sending arrives in the next release".
Agent read tools and draft commands.

This is a **deliberate draft-only release**. Users and authorized agents can create and edit
agreement drafts in production before issuance exists. Drafts leave Quits in no way, so that is
acceptable, and it is stated here so nobody mistakes the missing send for a bug.

Verification for 1a alone: migration applies to an existing database and leaves existing document
numbers untouched; organization isolation on every query and command; permission matrix per role
and per agent scope; canonical snapshot fixtures; pricing adapter against `priceDocument`
fixtures; idempotent template seeding under concurrency; single-default invariant; contact
deletion refused while agreements reference it; hostile Markdown corpus for the editor preview;
contracts export check; lint, typecheck and the full test suite green.

**PR 1b, issuance and acceptance.** Issuance, `send`, `issue`, `resend`, `recall`, expiry task,
public `decide` and `read` links with scope dispatch, canonical framing on all public verifiers,
rate limiting, public DTO, decision commands with locks, rechecks and replay, `recordAcceptance`,
`close` (cancelled only), "Revoke links" and "Send read link", PDF, approval preview route bound to
the stored snapshot, document delivery and accepted notifications, pending-delivery guards.

Verification for 1b: every row of the agreement transition table including refusals; issuance
refused after validity; approval crossing the validity boundary refused; A/B/A preview case and
edit-then-approve refusal; unchanged retry versus edited retry after rejection; pending-delivery
mutation refused; recall from sent, expired and declined, then edit, reissue, stale link refused;
resend to a changed recipient audited; replay at expiry returns the record, opposite verb refused,
changed evidence ignored; concurrent accept versus recall and accept versus expire; `read` link
valid after `expiresAt` and after cancellation from accepted; `decide` POST with a `read` token
refused; token suffix rejected on agreement, quote and pay tokens with existing tokens unaffected;
rate limit by identity; hostile Markdown corpus for page, PDF and email; notification recovery and
renewal deduplication; Playwright: create, send, open link, accept, see record and PDF; recall and
see the invalid-link page.

**PR 1c, fulfillment.** `in_progress`, `markDelivered` with its approval context (no email yet;
outward-facing from the start so Phase 3 does not change its classification), `deliveryRevision`,
internal `deliverable.accept`, `deliverable.cancel`, `expectedDate`, deposit lines excluded from
fulfillment, progress on the detail page.

Verification for 1c: every row of the deliverable transition table including refusals; fulfillment
refused in terminal agreement states; deposit line cannot be delivered; stale delivery approval
after reopen or redelivery refused; acceptance cleared on reopen and redelivery with history in
events.

### Phase 2: Invoicing from deliverables

Billing link and reservation, `issueInvoice` extraction, `createFromDeliverables`,
`addDeliverables`, linked-invoice edit rules, release on delete, `close` with `completed`,
reopen and cancel refusals while reserved. UI: "Invoice" action preselecting billable deliverables;
billing status on the detail page.

Verification: reservation under concurrency; duplicate ids; cancelled deposit not billable; linked
draft edits cannot change contact or linked values and release omitted lines; unlinked lines priced
with frozen tax context; issuance through delivered, unconfirmed and no-email paths; rejected
delivery keeps the reservation; reopen refused while reserved; close refused while reserved;
completed refused with open fulfillment; completed succeeds for a delivery-billed project and for
a project with a deposit; approval-time lock order against linked-line edit and close; credit note
leaves billing alone.

### Phase 3: Customer sign-off

`sign_off` links, `deliverable.publicAccept`, `deliverable.publicRequestChanges`,
delivered and sign-off-received notifications. Agent tools surface `changes_requested`.

Verification: stale revision refused; stale key refused; non-accepted agreement refused; change
request allowed while reserved and flagged; rate limit; idempotent resubmission.

### Phase 4: Quote conversion and template editing

`createDraft` from an accepted quote under the quote lock: refused if the quote has invoices or
already has an agreement (unique `sourceQuoteId`); `quote.convert_to_invoice` refused once an
agreement exists. Template create, update, delete under `agreement:manageTemplates`.

## Decisions taken during review

- Read links live two years from minting and are renewed from the detail page, independent of any
  retention policy, which does not exist yet.
- Customer change requests are allowed while a deliverable is reserved; the linked draft is
  flagged and sending it requires an explicit acknowledgement.
- `issue` stays, with an explicit optional recipient.
- One `billingTrigger` per agreement plus `isDeposit` per line.
- `validUntil` is a calendar date with one derived, frozen `expiresAt`.

## Known open issues

- Phase 3 keeps a disputed draft flagged after re-delivery or removal of the disputed line. Each send requires explicit acknowledgement; resolving disputes automatically needs a separate policy.
- A customer can request changes while an invoice email is already in flight. The request is recorded and the draft is flagged, but an email already submitted to the provider cannot be recalled. Subsequent sends require acknowledgement.
- Delivery links shown for manual sharing retain the original delivery's 90-day expiry. Key revocation invalidates existing links; opening the authenticated detail page can recreate a link under the current key.
