# Receipt evidence: link first, defer capture

Decision for [#57](https://github.com/tielemans-dev/quits-oss/issues/57), 8 October 2026.
Status: conditional no-go for a native inbox. Propose linking existing accounting evidence first,
subject to validated customer need and future connector [#37](https://github.com/tielemans-dev/quits-oss/issues/37).
No customer interviews, consented workflow observations, provider uploads or accountant review occurred.
This is not a production design approval or a commitment to implement capture.

“Receipt” here means a supplier document supporting a reimbursable cost. It does not mean the
customer-funding `SettlementReceipt` in accepted money draft #72 or Quits's command retry receipt.
The source audit at `c0f23c014d0502c44fab9b7ea8b7a748c6b5eee8` and local `origin/main`
`5174f983047103473ea09c2e4b4763883f47cbdc` found no receipt inbox or expense-ledger model in
[`schema.prisma`](https://github.com/tielemans-dev/quits-oss/blob/5174f983047103473ea09c2e4b4763883f47cbdc/apps/oss/prisma/schema.prisma)
and the domain/contracts search. Existing invoice artifacts and payment provenance must not be
repurposed into a supplier-expense ledger. No application files change in this work.

## Official destination evidence

All sources below were read 8 October 2026. The [source record](evidence/2026-10-08-migration-receipts/provider-sources.json)
contains exact request URLs, HTTP results, full-response hashes and relevant excerpts. Documentation
establishes supported interfaces, not successful handoff under any customer's plan or permissions.
Plain e-conomic REST/Documents URLs initially returned 403; adding the recorded query parameter
with a browser user-agent returned the public documentation. No credentials or account APIs were used.

| Ref | Official source and section | Observation and limit |
| --- | --- | --- |
| E1 | [Documents 4.0.1](https://apis.e-conomic.com/documentsapi/redoc.html?receipt-discovery=1), “Attach PDF/JPG/PNG”, `POST /AttachedDocuments` | Attaches to booked or draft entries using `accountingYear` and `voucherNumber`; PDF/JPG/PNG, maximum 9 MB; response contains attachment `number`. `onConflict=0` merges by default; `1` fails when the voucher already has a document. This is a voucher destination, not evidence of a general inbox API. |
| E2 | Same source, “Retrieve single AttachedDocument” and “Retrieve the pdf file for a single AttachedDocument” | Metadata includes voucher/year/number/page count; `GET /AttachedDocuments/{number}/pdf` returns PDF. Byte preservation of uploaded images or PDFs has not been tested. A returned PDF is not proof of an unchanged uploaded image. |
| E3 | [REST reference](https://restdocs.e-conomic.com/?receipt-discovery=1), `POST /invoices/drafts/:draftInvoiceNumber/attachment/file` | Attaches a PDF to a draft sales invoice, maximum 9 MB. This is a different purpose from storing a supplier voucher. Never choose it merely because its name says attachment. |
| E4 | [Role-based permissions](https://www.e-conomic.com/developer/permissions), role/entity table | SuperUser/Bookkeeping can access journal/voucher entities; Sales covers customers and sales invoices. Entity roles do not make a credential read-only. Accepted #29 separately records Documents roles as Bookkeeping/SuperUser and untested per-plan access. |
| D1 | [Dinero OpenAPI](https://api.dinero.dk/openapi/v1/swagger.json), `POST /v1/{organizationId}/files` and `GET` on the same path | Uploads image/PDF, rejects files above 6 MB, returns file and owning-organization information; adds to the file archive for bookkeeping vouchers/ledger. Accessibility may lag the upload response. Listing supports used/unused/all, page and pageSize. No duplicate-upload guarantee appears in this operation. |
| D2 | Same source, `/files/attachment` and `/attachments/{documentGuid}/{fileGuid}/{fileName}` | The former explicitly does not add to the bookkeeping archive and is only for customer invoice attachments; binding sends the file with the invoice. Wrong endpoint selection can disclose sensitive supplier evidence to a customer. |
| D3 | Same source, `/files/{fileGuid}` and `/vouchers/purchase/fileguid/{fileGuid}` | Download file and obtain purchase-draft GUIDs associated with a file. The latter returns an array, not a documented one-file/one-voucher uniqueness constraint. |
| D4 | [FAQ](https://developer.dinero.dk/documentation/faq/), “What is a købsbilag / purchase voucher?” and “What endpoint should I use?” | Dinero recommends purchase vouchers for expenses and distinguishes ledger items. File arrival alone does not prove a booked expense or a billable cost. |
| D5 | [Getting started](https://developer.dinero.dk/documentation/getting-started/), “Visma Connect”; [Authorization](https://developer.dinero.dk/documentation/authorization/), “Forth” | OAuth is user-based, not organization-based. Scopes include read/write/offline access. A valid Pro trial/paid or Total license is required for the API except `/organizations`. Confirm the selected organization and current entitlement, not just successful login. |

Dinero's upload description mentions owning-organization information, but its `FileSavedReadModel`
schema defines only `FileGuid`. Verify the actual response during the consented pilot; do not rely
on a returned organization field to establish ownership.

The API evidence supports linking an existing remote voucher/file identity and, later, a narrowly
controlled attachment transfer. It does not establish an e-conomic generic inbox endpoint, email
forwarding address, provider-side deduplication guarantee, byte-preserving storage or retention after
subscription cancellation. These remain questions for #37 and the pilot. Dinero's file archive is a
documented destination, but a Dinero adapter is separate follow-up work, not part of e-conomic #37.

The accepted [Danish boundary decision at 7f37ed6](https://github.com/tielemans-dev/quits-oss/blob/7f37ed6ed93ad0d072ada6911c2936fbbf67bd87/docs/plans/2026-10-08-denmark-bookkeeping-boundary-decision.md)
proposes keeping accounting records and required originals in the accounting system. Its retention
finding cites [ERST bookkeeping guidance](https://erhvervsstyrelsen.dk/vejledning-bogfoeringsloven),
sections 6.1 and 6.9, five years from financial-year end, including after switching systems. That
qualified review remains unmet. This worker read the accepted decision, not a new legal opinion.
Do not present “file uploaded” as legal compliance or a complete source-document handoff.

## Problem evidence and contrary evidence

There are no sourced Quits customer loss examples. The issue's competitor and discussion links are
leads, not interviews or proof of demand. The following concrete cases are synthetic research prompts:

- A consultant buys a 375 DKK train ticket for engagement A, emails it to their accountant and forgets
  to add the agreed reimbursement to the customer's next invoice. If the accountant already has the
  file, a second inbox does not solve identification of unbilled work. Linking the voucher to the
  engagement and one explicit billable record could.
- A 1,250 DKK hotel PDF is attached to a billable note but never reaches the accounting tool. A
  verified accounting-destination handoff could solve the missing evidence. General storage alone cannot.
- Two colleagues upload the same parking receipt for engagement A, and the accountant also uploads
  it directly. Creating a billable item for each upload doubles recovery. Identifying one economic
  cost is a different problem from deduplicating identical bytes.

Record the actual path in consented discovery: origin in email/upload/accounting app; who captured
it; organization and engagement; agreed reimbursement rule; billable entry and invoice line;
accounting file and voucher; any missing step. Ask for redacted artifacts and timestamps and measure
actual missed amounts. Do not infer reimbursement permission, markup or VAT from a receipt amount.

Evidence against an inbox matters. The accounting tools already have document destinations, users
may already capture there, and missing engagement/billing links may be the only gap. A capture inbox
would add sensitive storage, identity decisions and retry responsibility. Conversely, linking alone
cannot fix documents that never arrive in accounting, inaccessible remote files or evidence lost
before capture. The pilot must identify which failure actually occurs.

## Conditional decision and first supported route

Default no-go for capture now. Conditional go for a link-only prototype when consented observations
show costs are already in accounting but not reliably attached to billable work. The first proposed
input is an existing e-conomic voucher/attachment selected under an authorized connection, identified
by source agreement, accounting year, voucher and attachment number. The destination remains that
same e-conomic voucher. Quits records a reference to evidence and an explicit billable association;
it sends zero files and creates zero expenses. This does not mean #37 currently implements reading
purchase evidence; that capability must be approved and added to its scope or assigned separately.

If observations instead prove missing delivery from local files, a later limited pilot may accept
one user-selected PDF up to 9 MB for an already identified e-conomic voucher, using E1 with
`onConflict=1`. Exclude email forwarding, image conversion, general storage search and automatic
purchase booking initially. Reuse an existing verified attachment if the voucher already has one;
otherwise stop for review rather than merging. Dinero's corresponding research destination would
be `/files`, not `/files/attachment`, with its 6 MB limit. No Dinero implementation is authorized here.

Do not promise exactly-once provider effects from HTTP retries. A future connector needs one local
operation identity scoped to target organization, remote agreement, evidence identity and intended
voucher, a saved remote ID and hash, plus an outcome of `pending`, `verified`, `unknown` or
`needs_review`. An accepted upload whose response is lost is `unknown`. Read back the intended
voucher and compare evidence before any retry; if identity cannot be proved, stop for operator
review. `onConflict=1` protects existing content but does not prove the existing file is ours.
Provider idempotency retention and concurrency semantics must be independently tested.

## Identity, permissions and retention requirements

Distinguish a physical file hash from an economic receipt identity. Exact-byte duplicates within one
organization may reuse evidence, but a rescanned or cropped receipt can have another hash. Different
receipts can share date, merchant and amount. Suggest matches for human review; never merge on those
fields alone or disclose whether another organization has the same hash. Preserve original bytes and
separate renditions with their own hashes.

One confirmed economic cost may link to several evidence files. One cost gets one billable entry by
default. If an explicit split across engagements is supported later, conserve its approved reimbursable
quantity and record allocation identities. Retrying an upload/link or reconnecting must not create
another billable entry. A supplier receipt is neither revenue, a customer payment nor permission to
rebill; billing follows the existing billable-work owner and approved command contracts. #72 funding
must never be created from a supplier document. Do not implement new billable UI in this discovery.

Authorization proposals require separate evidence-read, evidence-link and transfer capabilities,
organization membership, and existing billable-create permission for the business action. Check
organization, remote account and voucher on every operation; never trust a user-supplied URL as
proof of ownership. Select Dinero organizations from authorized `/organizations` results and bind
that selection to one Quits organization. Reconnect must revalidate, not silently route to the first
company in a token. E-conomic voucher numbers need both agreement and financial year. Denied access
must not reveal another tenant's filename or hash.

Keep sensitive files out of public invoice links, logs, notification bodies and default customer
attachments. Require a separate explicit decision for sharing any evidence with a customer. Proposed
handling includes encrypted transport/storage, least-privilege retrieval, bounded download URLs,
malware and media validation before a future upload, and no unattended fetching of arbitrary URLs.
The first link-only proposal does not copy bytes into Quits.

Retention must distinguish transient unsubmitted uploads from accounting originals and audit metadata.
Before capture, the business and qualified reviewer must approve purposes, access roles, legal hold,
financial-year retention start/end, backups, export and deletion verification. No fixed temporary-upload
TTL is approved here; propose a short documented cleanup window only after a verified destination and
operator recovery path exist. Disconnect stops future API access; it does not delete required accounting
records. A remote deletion or permission loss becomes missing/unavailable evidence. It must not silently
remove the billable association or claim continued availability. No OCR accuracy or extraction promise
is warranted; initial metadata is explicit user input or a selected remote identity.

## Evidence gates and once-per-receipt pilot

Proposed go gates are hypotheses for parent review, not measured findings:

1. Observe at least three consenting Danish service firms and review at least two redacted actual
   lost-billing or failed-handoff cases. Include a firm for which existing accounting capture works.
   Record whether each failure is capture, routing, permission, engagement linking or billing omission.
   No-go if the need is only general receipt storage or the normal accounting workflow already solves it.
2. Have the accountant confirm destination, evidence retention and reimbursement/tax responsibility.
   Have #37's owner confirm plan/role access and the supported read/transfer direction. No provider
   registration, paid service or live credential use is authorized by this document.
3. Under separate authorization, start with one consenting organization, one remote agreement, one
   engagement and one synthetic PDF explicitly marked as a test. For link-only, select a pre-existing
   provider attachment. Snapshot destination counts and identities before linking.
4. Repeat the same link three times, retry a lost local response and reconnect. Expect one local
   evidence identity, one approved economic cost, one billable entry and the same existing remote
   attachment, with zero provider writes. Add another valid receipt of equal amount/date and require
   that it remains separate. Treat a rescan as a review candidate, not an automatic duplicate.
5. Only if file transfer is justified, authorize a separate test voucher and upload once. Repeat after
   lost-response, timeout and concurrent-request injection. Inspect the provider voucher and page/file
   counts, saved remote IDs, read-back bytes/hash and local billable identity. Expect exactly one
   intended attachment and one billable item. Existing-attachment conflict must not merge pages or
   create another voucher. An unverifiable result stays unknown and blocks retries/cutover.
6. Attempt a wrong-organization binding, revoked grant and inaccessible file. Expect no write or
   identity leak, a clear failed/unknown state and no extra billable item. Delete only explicitly
   authorized test resources by their recorded IDs after retention review; do not delete live vouchers.

Pass requires actual provider and local evidence, not a mock returning success. Record before/after
counts, file identities/hashes, actors, request IDs, retry outcomes, accounting voucher and billable
association. Zero unexplained extra artifacts or economic billable entries is the required result.
A pilot that cannot identify a safe retry outcome is no-go for transfer. All pilot execution is unmet.

## Acceptance and UX handoff

| #57 acceptance item | State |
| --- | --- |
| Concrete lost-billing/handoff examples distinguished from storage demand | Synthetic examples and research plan only; actual customer evidence unmet |
| Go/no-go with first input/destination or integration-only rationale | Met as a conditional no-go and link-first proposal, not approved launch scope |
| Pilot demonstrating one arrival and no duplicate billable entries | Protocol defined; real pilot and connector capabilities unmet |
| Permission, sensitive retention and misrouting risks before capture | Documented above; legal/operational validation unmet |

Future UX needs organization/account confirmation, remote evidence identity and availability,
engagement/billable association, duplicate-review explanation, destination transfer outcome,
permissions error and explicit sharing controls. UX owns the Kvit identity and all user-facing design.
No new screens, OCR, scraping, expense ledger, customer emails or provider writes were built.
