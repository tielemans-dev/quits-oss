# Freelancer Agreements and Deliverables Design

Status: revision 3, after adversarial review rounds 1 and 2 (2026-10-07)

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
  command, `quotes.convertToInvoice` the tRPC procedure): domain commands are
  `agreement.create_draft`, tRPC procedures `agreements.createDraft`, MCP tools
  `agreement.createDraft`. This document uses the MCP form for readability.

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
| `validUntil` | Calendar date. `expiresAt` is derived once at issuance as the start of the following day in the agreement's `timezone` and stored. Every check (tokens, public and internal decisions, the expiry task) compares `now < expiresAt`. Tested across DST boundaries. |
| `issueDate`, `expiresAt` | Set at issuance. |
| `offerRevision` | Integer, starts at 0, incremented on every issuance. Identifies which frozen offer a decision or link refers to. |
| `offerSnapshot`, `offerSnapshotHash` | The **canonical agreement JSON** of the current offer: parties, title, summary, rendered terms, deliverables with agreed dates, prices, `isDeposit`, `billingTrigger`, totals, currency and tax context, payment terms, `validUntil`. SHA-256 over a canonical serialization. Excludes `number`, `issueDate`, `expectedDate` and anything operational. This is what the customer accepts. Cleared on recall; the recalled offer is archived in the `agreement.offer_recalled` event payload. |
| `issuedToEmail`, `issuedVia` | The intended recipient and method (`email` or `manual`) persisted at issuance. The acceptance record cites `issuedToEmail` as the intended recipient. It is not proof of delivery or of signer identity. |
| `publicAccessKeyVersion`, `publicAccessIssuedAt` | Rotated on recall, resend, internal acceptance and cancellation. |
| `acceptedAt`, `acceptedOfferRevision`, `acceptedByName`, `acceptanceIp`, `acceptanceUserAgent`, `acceptanceMethod`, `acceptanceEvidenceNote` | The acceptance record. `acceptedByName` is typed by the customer. IP and user agent come from the request. `acceptanceMethod` is `customer_link` or `internal`; `internal` requires the evidence note. |
| `declinedAt`, `declineReason`, `closedAt`, `closeReason` | |
| `lastEmailAttempt*` | The four document-delivery columns. |
| `notes` | Internal. Never in the public DTO. |

### Deliverable

| Field | Notes |
| --- | --- |
| `agreementId` | Cascade delete; deliverables are never deleted after issuance, they are cancelled. |
| `title`, `description`, pricing columns as `QuoteItem`, `agreedDate`, `isDeposit` | Immutable after issuance; part of the offer snapshot. |
| `expectedDate` | Operational forecast, outside the snapshot, mutable at any time. Shown to the customer labelled "expected", next to the agreed date labelled "agreed". |
| `status` | Fulfillment: `planned`, `in_progress`, `delivered`, `accepted`, `changes_requested`, `cancelled`. |
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
registered as agent tools.

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
| draft | `updateDraft` | draft | Any field. At least one non-cancelled deliverable is required to issue. |
| draft | `deleteDraft` | gone | Refused if an approval request for this agreement is pending. |
| draft | `send` | draft, then sent | **Issuance** (below) plus a document-delivery job. Becomes `sent` when the delivery settles as delivered or unconfirmed; a rejected delivery reopens the draft and keeps number, revision and snapshot so a retry reuses them. |
| draft | `issue` | sent | Issuance without email. `issuedVia = manual`; `issuedToEmail` is taken from the contact at that moment. Outward-facing for agents, because it makes the offer live. |
| sent | customer accepts | accepted | In one transaction: lock the agreement; recheck `status = sent`, key version, `offerRevision` from the token, `now < expiresAt`; write the acceptance record with `acceptedOfferRevision`; emit `agreement.accepted`; queue notifications. **Replay**: a repeat with the same key and revision on an already-accepted agreement returns the existing acceptance with no new event or email. |
| sent | customer declines | declined | Same checks; same replay rule. |
| sent | `recordAcceptance` | accepted | Human-only. Evidence note required. Same rechecks. Rotates the key and queues the accepted notification with a read link so the customer still has access. |
| sent, expired, declined | `recall` | draft | Not from `accepted`. Locks, rotates the key, archives the offer (snapshot, hash, recipient, revision, key version) in the `agreement.offer_recalled` payload, clears the snapshot and decision fields. Old links show the generic "This link is no longer valid" page, same as a stale quote link today. To extend validity: recall, edit `validUntil`, send; that is a new offer revision. |
| sent | `resend` | sent | Same offer, same snapshot, same `validUntil`; rotates the key, queues a new email. Refused after `expiresAt`. |
| sent | scheduler task | expired | Conditional `updateMany` where `status = sent AND expiresAt <= now()`, following `features/overdue.ts`; emits only on change. |
| sent, accepted | `close` with `disposition: cancelled` | cancelled | Human-only. Reason required. Refused while any deliverable is `reserved` (error lists the linked drafts). Non-invoiced deliverables become `cancelled`. Invoiced ones and their invoices are untouched. From `sent`, rotates the key. |
| accepted | `close` with `disposition: completed` | completed | **Phase 2.** Refused unless every deliverable is in a terminal fulfillment state (`accepted` or `cancelled`) and a terminal billing state (`invoiced`, or `unbilled` while `cancelled`). `cancelRemaining: true` cancels remaining unbilled, unaccepted deliverables with the close reason first. |

`completed` is never derived. Progress is computed for display. Fulfillment transitions are
refused once the agreement is `completed`, `cancelled`, `declined` or `expired`.

### Issuance

One operation used by `send`, `issue`, and approval execution:

1. Lock the agreement. Refuse while sending.
2. Refresh seller and buyer snapshots. Build the **prospective offer snapshot** and hash from the
   current draft, excluding number and dates.
3. If this is approval execution, compare the hash and recipient with the reviewed values and
   refuse on mismatch (the existing version check in `execute.ts`).
4. Allocate the number if the agreement has none, increment `offerRevision`, set `issueDate`,
   compute and store `expiresAt`, store `offerSnapshot`, `offerSnapshotHash`, `issuedToEmail`,
   `issuedVia`, rotate the key, set `publicAccessIssuedAt`.
5. For `send`: queue document delivery; status stays `draft` until settlement. For `issue`: set
   `sent` immediately.

The approval context's `version` is `offerSnapshotHash + ":" + recipient`, built by the same
prospective-snapshot builder; `details` carry customer, total, validity and deliverable count; the
approvals UI links to `/app/agreements/:id/preview.pdf`, which renders the prospective snapshot.
Because the hash is recomputed at execution, the approver either sees exactly what is issued or the
approval is refused.

### Deliverable transition table

| From | Command | To | Conditions |
| --- | --- | --- | --- |
| planned | `deliverable.update` | in_progress | Agreement `accepted`. |
| planned, in_progress, changes_requested | `deliverable.markDelivered` | delivered | Agreement `accepted`. Increments `deliveryRevision`, sets `deliveredAt`, clears current acceptance and `changeRequestNote`. In Phase 3 this queues the sign-off email, so it is a **separate, outward-facing** command, not a status value of `update`. |
| delivered | customer accepts (Phase 3) | accepted | Token carries `deliveryRevision`; refused on mismatch or if the agreement is not `accepted`. Sets `acceptedRevision`. Replay rule as above. |
| delivered | customer requests changes (Phase 3) | changes_requested | Same binding; note required. Allowed while `reserved`: the customer is never blocked by billing state. The freelancer sees the reservation flagged. |
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
and scope-specific fields. **Canonical framing is enforced**: a token with any component beyond
the two expected is rejected before any other processing.

| Scope | Issued when | Grants | Expiry |
| --- | --- | --- | --- |
| `decide` | Issuance, resend | Read the offer; accept or decline. Carries `offerRevision`. | `expiresAt` |
| `read` | Acceptance (customer or internal), on request from the detail page | Read the accepted agreement and PDF. | 2 years from issue, renewable by resending the read link. |
| `sign_off` | `markDelivered` (Phase 3) | Read; accept or request changes for one deliverable. Carries deliverable id and `deliveryRevision`. | 90 days |

Rotation of the key version invalidates every earlier token of every scope. The accepted
notification always carries a fresh `read` link, so acceptance evidence stays reachable after the
offer's validity ends. The agreement page never shows decision controls on a `read` token.

### Rate limiting

Decision submissions (`decide` and `sign_off`) are limited by **verified identity**, not by raw
token: after signature verification, a `PublicLinkAttempt` row keyed by `(agreementId, scope,
keyVersion, revision)` is incremented in its own transaction so a refused decision still counts.
More than 10 submissions in a sliding hour return a typed `retry_later`, distinct from `invalid`.
Rows older than a day are swept by the scheduler. Reads are not limited. The quote decision path
gets the same guard keyed by its verified quote identity.

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
permissions, contracts in `packages/contracts/src/agreements.ts` with package exports. Draft
commands (`createDraft`, `updateDraft`, `deleteDraft`, `deliverable.update` for snapshot fields),
pricing adapter, snapshots, prospective snapshot builder and hash, restricted Markdown, seeded
templates. UI: list, editor with template selection, detail. Agent read tools and draft commands.
The navigation entry is not added until PR 1b ships, so drafts cannot be created in production
without a way to issue them.

**PR 1b, issuance and acceptance.** Issuance, `send`, `issue`, `resend`, `recall`, expiry task,
public `decide` and `read` links, rate limiting, public DTO, decision commands with locks, rechecks
and replay, `recordAcceptance`, `close` (cancelled only), PDF and preview route, document delivery
and accepted notifications, approval context, pending-delivery guards. Navigation entry added.

**PR 1c, fulfillment.** `in_progress`, `markDelivered` (no email yet; outward-facing from the
start so Phase 3 does not change its classification), `deliveryRevision`, internal
`deliverable.accept`, `deliverable.cancel`, `expectedDate`, progress on the detail page.

Verification across 1a to 1c: decider tests for every row of both transition tables including
refusals; pending-delivery mutation refused; recall and resend settlement; replay of an identical
decision emits nothing; concurrent accept versus recall and accept versus expire under the lock;
approval hash mismatch after a draft edit; `read` link still valid after `expiresAt`; token suffix
rejected; rate limit by identity; hostile Markdown corpus for page, PDF and email; contracts
export check; Playwright: create, send, open link, accept, see record and PDF; recall and see the
invalid-link page.

### Phase 2: Invoicing from deliverables

Billing link and reservation, `issueInvoice` extraction, `createFromDeliverables`,
`addDeliverables`, linked-invoice edit rules, release on delete, `close` with `completed`,
reopen and cancel refusals while reserved. UI: "Invoice" action preselecting billable deliverables;
billing status on the detail page.

Verification: reservation under concurrency; duplicate ids; cancelled deposit not billable; linked
draft edits cannot change contact or linked values and release omitted lines; unlinked lines priced
with frozen tax context; issuance through delivered, unconfirmed and no-email paths; rejected
delivery keeps the reservation; reopen refused while reserved; close refused while reserved;
completed refused with open fulfillment; credit note leaves billing alone.

### Phase 3: Customer sign-off

`sign_off` links, `deliverable.publicAccept`, `deliverable.publicRequestChanges`,
delivered and sign-off-received notifications. Agent tools surface `changes_requested`.

Verification: stale revision refused; stale key refused; non-accepted agreement refused; change
request allowed while reserved and flagged; rate limit; idempotent resubmission.

### Phase 4: Quote conversion and template editing

`createDraft` from an accepted quote under the quote lock: refused if the quote has invoices or
already has an agreement (unique `sourceQuoteId`); `quote.convert_to_invoice` refused once an
agreement exists. Template create, update, delete under `agreement:manageTemplates`.

## Open questions for review

1. The `read` token lifetime of two years is arbitrary. Is a fixed lifetime right, or should read
   access be tied to the organization's retention and be renewable only from the detail page?
2. Customer change requests are allowed while a deliverable is `reserved`. The alternative is to
   refuse them until the freelancer releases the draft. Which failure is worse: a customer who
   cannot respond, or a draft invoice the freelancer must notice is now disputed?
