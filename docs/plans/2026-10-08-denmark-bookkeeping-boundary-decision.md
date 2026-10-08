# Denmark: bookkeeping-system boundary and source-document retention

Decision record for [quits-oss#27](https://github.com/tielemans-dev/quits-oss/issues/27). Researched
8 October 2026. Status: **proposed, pending qualified review.** Nothing here is legal advice, and no
accountant, auditor or the Danish Business Authority (Erhvervsstyrelsen, ERST) has reviewed it. Until
that review exists, every claim marked *blocked* below must stay out of product copy, sales material
and documentation.

The electronic-delivery route is decided separately in
[`2026-10-08-denmark-einvoice-delivery-decision.md`](./2026-10-08-denmark-einvoice-delivery-decision.md).

## Sources

All were read on 8 October 2026. Dates are the publisher's own "last updated" dates.

| Ref | Source | Publisher date |
| --- | --- | --- |
| B1 | ERST, [Vejledning til bogføringsloven](https://erhvervsstyrelsen.dk/vejledning-bogfoeringsloven) | Page updated 5 March 2026 (guide version 16 June 2025) |
| B2 | ERST, [Nye krav til registrerede bogføringssystemer – effektiv og sikker e-fakturering](https://erhvervsstyrelsen.dk/vejledning-nye-krav-til-registrerede-bogfoeringssystemer-effektiv-og-sikker-e-fakturering) | 25 September 2026 |
| B3 | [BEK nr. 811 af 2026](https://www.retsinformation.dk/eli/lta/2026/811), amending the requirements for registered standard systems (linked from B2) | 2026 |
| B4 | [Lov om bogføring](https://www.retsinformation.dk/eli/lta/2022/700) | 2022 |
| B5 | [BEK nr. 1383 af 2023](https://www.retsinformation.dk/eli/lta/2023/1383), duty to keep vouchers in a digital bookkeeping system | 2023 |
| B6 | [BEK nr. 205 af 2024](https://www.retsinformation.dk/eli/lta/2024/205), requirements for non-registered systems | 2024 |
| B7 | ERST, [Standardkontoplan og SAF-T](https://erhvervsstyrelsen.dk/standardkontoplan-saf-t) | 8 September 2026 |
| B8 | Nemhandel, [E-fakturering bliver den nye fælles måde at fakturere](https://nemhandel.dk/e-fakturering-bliver-den-nye-faelles-maade-fakturere) | 28 September 2026 |
| B9 | ERST, [Høringsnotat – dokumentstrategi](https://nemhandel.dk/sites/default/files/2026-05/Hoeringsnotat-dokumentstrategi-18052026_WA.pdf) | 18 May 2026 |
| B10 | e-conomic, [REST API documentation](https://restdocs.e-conomic.com/) (voucher and draft-invoice attachments, booking with `sendBy`) | Undated, read 8 October 2026 |

B3 to B6 were identified through the links in B1 and B2. Their text was not read independently in
this research; the duties below are taken from ERST's guides that summarise them.

## What the rules say

1. **Who must keep books digitally.** Businesses that file annual reports, and others with net
   turnover above DKK 300,000 in two consecutive income years, must record transactions and keep
   vouchers in a digital bookkeeping system. For businesses outside the Danish Financial Statements
   Act (for example sole proprietorships) the duty started on 1 January 2026, judged on the two
   preceding income years. Businesses founded after 1 January 2026 are not covered from founding.
   (B1, chapter on digital bookkeeping and Annex A.)
2. **Original issued version.** All sales invoices and sales credit notes must be stored digitally in
   the version in which they were originally issued to the customer. (B1 §2.2.)
3. **Which vouchers.** The digital-storage duty covers actual purchase and sales invoices between
   businesses that carry date, description of supply, amount, VAT, payment details and the names,
   addresses and CVR numbers of buyer and seller. Documents without all six are kept under the general
   retention rules instead. (B1, Annex B, applying B5.)
4. **What a bookkeeping system is.** Software that lets a business record all its transactions and
   store those records with their vouchers, or at least a complete backup, on a server with a provider
   or third party. Its architecture does not matter. A specialised application covering only part of
   the transactions, for example project management, is not a bookkeeping system. (B1 §2.7.)
5. **Functions outside the system.** The requirements apply only to functions for bookkeeping,
   storing vouchers and backups, and automating those processes. Other modules are outside them,
   *even when they supply data to the part that is the bookkeeping system*. The booked transactions
   and the vouchers that must be stored digitally must be stored in what constitutes the digital
   bookkeeping system. (B1, Annex B.)
6. **Combinations.** A business that records its transactions in a registered system but keeps its
   purchase and sales invoices in another system is, in law, using a **non-registered** system.
   (B1, Annex B.)
7. **Responsibility.** With a registered system, the provider is responsible for IT security,
   including daily backups. With a non-registered system the business itself must meet the technical
   requirements, including a backup of all booked transactions and vouchers no later than one week
   after booking, kept with an unrelated party on a server in the EU or EEA. (B1 §6.2, B6 §4.)
8. **Retention.** Five years from the end of the financial year the material concerns, including
   after a change of system, bankruptcy or dissolution. After the duty ends, the last management
   keeps the material. (B1 §6.1, §6.9.)
9. **Marketing.** Providers should state clearly whether a system is a "registered digital bookkeeping
   system that meets the requirements of the Bookkeeping Act", or a non-registered system that may only
   be used by businesses not subject to digital bookkeeping. (B1 §2.8.) Registration is required for a
   standard system marketed in or towards Denmark on uniform terms to an indefinite group of
   businesses. (B1 §2.9, §2.11.)
10. **New duties for registered systems.** MitID validation of customers and opt-out enrolment of end
    customers for receiving e-invoices in Nemhandel by 1 March 2027, together with showing the e-invoice
    option when a user invoices a receiver registered in Nemhandel. From 1 January 2028: locked CVR
    master data on sent electronic documents, search and full export per end customer, MitID on changes
    to supplementary master data, and no user deletion of sent and received documents. Sending an
    e-invoice stays voluntary; the option must be shown. Automated sending through API integrations
    where invoicing starts outside the bookkeeping system is exempt from the display duty. (B2, B3, B8.)
11. **Machine-readable data has legal effect.** For an electronic business document in the common
    infrastructure, only the machine-readable data has legal effect; a visual rendering that disagrees
    with it misleads the receiver. (B9, p. 3.) A PDF is not an e-invoice. (B1 §2.15.)
12. **SAF-T.** Registered systems must support SAF-T 2.1 from 1 January 2027; non-registered systems
    may use the older header format. (B7.) Quits is not a ledger and does not produce SAF-T.

## Classification decision

**Quits is not a digital bookkeeping system and does not seek registration.** It issues, delivers and
collects sales documents and records payments against them. It keeps no general ledger, no purchase
side, no bank reconciliation, no VAT return and no SAF-T. Under rule 4 it is a specialised application
covering part of the transactions, and under rule 5 its functions fall outside the bookkeeping
requirements *only if* the booked sales transactions and the sales vouchers are stored in the
customer's bookkeeping system.

The intended arrangement for the Danish launch is therefore:

| Party | Role | Duties |
| --- | --- | --- |
| The business using Quits | Bookkeeping-obligated party | Digital bookkeeping if over the threshold; five-year retention; written description of bookkeeping procedures; choosing a registered system or accepting responsibility for a non-registered one. |
| e-conomic (registered standard system) | System of record for transactions and sales vouchers | Registered-system requirements, backups, export, the 2027 and 2028 duties. |
| Quits | Billing application feeding e-conomic | Issue documents with their frozen original artifacts; hand every issued sales voucher and its transaction to e-conomic; prove the handoff; keep its own copy readable and exportable; never present itself as the bookkeeping system. |
| Electronic-delivery provider | Access point | Transport and its evidence only. Under Nemhandel's guidance, a business that uses a third-party access point needs its auditor to approve the access point and the arrangement. |

The arrangement stays a registered-system setup only while rule 6 is not triggered: **the original of
every in-scope sales invoice and credit note must be in e-conomic, attached to its booked
transaction.** If an original exists only in Quits, the combination is a non-registered system and the
business carries the B6 duties itself. Quits must not let that happen silently.

### Alternatives considered

| | Arrangement | Assessment |
| --- | --- | --- |
| A | **Quits issues; e-conomic is the ledger** (chosen). Quits numbers, renders and delivers; it posts each issued document to e-conomic with the original file attached. | Keeps Quits's own issuance, numbering and delivery. Depends on every original reaching e-conomic intact, and on e-conomic accepting the original's format. See the e-invoice gap below. |
| B | **e-conomic issues.** Quits prepares a draft invoice in e-conomic, which books it, numbers it and sends it by email or EAN (`POST /invoices/booked` with `sendBy`, B10). | The original never leaves the registered system, so rule 6 cannot be triggered. Quits loses document numbering, layout and its own delivery; Peppol routing and delivery status then belong to e-conomic. Needs an e-conomic package that allows writing integrations. Keep as the fallback if A's review fails. |
| C | **Quits as part of a non-registered combination.** | The business takes on the B6 duties (weekly backup with an unrelated EU/EEA party, documentation). Not a default for small businesses. Allowed only as an explicit, informed choice for a business that is outside the digital-bookkeeping duty, or that accepts those duties. |
| D | **Register Quits as a standard bookkeeping system.** | Out of scope (#27). It would mean building a ledger, purchase side, bank reconciliation, SAF-T 2.1 and the 2027/2028 duties. |

### The e-invoice gap (blocker for A)

e-conomic's voucher attachment endpoint accepts `.jpg`, `.jpeg`, `.pdf`, `.gif` and `.png`, up to
9 MB; draft-invoice attachments accept PDF only (B10). When Quits sends an invoice as a Peppol
e-invoice, the legally effective original is the UBL XML (rule 11), which Quits already freezes as
`artifactUblRef` with a hash. A PDF rendering attached in e-conomic is not that original.

Until a qualified reviewer answers the following, documents delivered electronically by Quits cannot
be described as kept in a registered system:

1. Does attaching Quits's frozen PDF rendering in e-conomic, while Quits keeps the frozen XML, satisfy
   rule 2 for an e-invoice? Or does it make the combination non-registered under rule 6?
2. If not, can the XML be stored in e-conomic as the voucher by another route (for example e-conomic's
   own e-invoice handling, or alternative B for e-invoiced customers)?
3. Does Quits's retention of the XML, with export, count as the "complete backup" route of rule 4?

Documents delivered by email as PDF do not have this gap: the issued PDF *is* the original, provided
e-conomic stores exactly those bytes (verified by hash, see below).

## Document inventory

"Authoritative" names the system whose copy wins in a dispute about content. Quits's frozen artifacts
are immutable from issuance (`artifactPdfRef`/`artifactPdfHash`, `artifactUblRef`/`artifactUblHash`),
and financial records cannot be physically deleted (see
[`docs/financial-deletion-guards.md`](../financial-deletion-guards.md)).

| Record | Authoritative system | Retention responsibility | Readable export from Quits today | Failure policy |
| --- | --- | --- | --- | --- |
| Sales invoice, PDF original | Quits issues it; e-conomic must hold the same bytes as the voucher | Business; e-conomic as the registered system once handed off | PDF download per document; accounting CSV (`invoices`) by period | Handoff is pending until e-conomic confirms the voucher and the attachment hash matches. Unconfirmed after 24 hours: shown as an exception. Unconfirmed at 7 days: blocking alert, because rule 6 would then apply. |
| Sales invoice, e-invoice original (UBL) | Quits (frozen XML) | **Blocked** pending the e-invoice gap | UBL download per issued document (`exportEinvoice` serves the stored artifact and checks its hash) | As above for the PDF rendering; the XML has no e-conomic destination until the review answers. |
| Sales credit note | As for invoices | As for invoices | PDF and UBL per document; accounting CSV (`creditNotes`) | As for invoices. A credit note must reference its invoice in e-conomic. |
| Payment recorded in Quits | e-conomic once posted; Quits until then | Business; bank statement is the external voucher | Accounting CSV (`payments`), voided payments flagged | A payment never posts before its invoice. Reversal is a corrective entry, never deletion. |
| Customer master data (name, address, CVR, electronic address) | Quits for billing; e-conomic for its debtor ledger | Business (master-data changes can be accounting material, B1 §2.6) | Contacts in the app; no bulk export today | Changes after issuance never alter frozen buyer snapshots. Divergence from e-conomic is shown, not overwritten. |
| Payment reminder | Quits | Business, as correspondence about the invoice. Quits reminders carry no fee today, so they create no transaction | Reminder history per invoice | Not handed off. If reminder fees are added, the fee becomes a sales transaction and follows the invoice handoff rules. |
| Quotes, agreements, recurring schedules | Quits | Business, only where they document a transaction (B1 §2.5) | Per-document PDF | Not handed off as vouchers. |
| E-invoice delivery evidence (receipts, MLR, Invoice Response) | Quits | Business | Not exported yet | Kept with the document; see the delivery decision. |
| Audit log of document actions | Quits | Business, as control-trail support | Activity export | Append-only. |

**Gap:** Quits has no single bulk export of every issued original with its hash and the related
records. Rule 8 requires that the business can still read its material after leaving Quits. The
accounting integration issue must add an archive export: every issued PDF and UBL artifact, a manifest
with document number, kind, issue date, hashes and handoff state, and the accounting CSVs for the same
period.

## Copying originals into e-conomic, and detecting failures

Yes: in arrangement A, the original of every in-scope sales invoice and credit note **must** be copied
into e-conomic and attached to its booked transaction. Supplementary attachments that are not vouchers
(time sheets, deliverables) are optional.

Detection design for the accounting integration:

1. **One handoff record per issued document**, created in the same transaction as issuance. States:
   `pending`, `posted` (e-conomic voucher identifier stored), `verified` (attachment fetched back and its
   hash equals the frozen artifact's hash), `failed_retryable`, `needs_review`.
2. **Idempotent posting.** Each handoff carries a stable key derived from the document identity, sent
   as e-conomic's `Idempotency-Key` header (B10). An uncertain response is reconciled by looking the
   voucher up, never by posting again.
3. **Read-back verification.** After upload, fetch `GET .../attachment/file` and compare hashes. If
   e-conomic re-encodes PDFs so the bytes differ, the review must decide whether a rendering match
   suffices; until then the handoff stays `needs_review`.
4. **Completeness check.** Per period and per currency, compare issued documents with verified
   handoffs: counts, gross totals and a list of every gap. Shown to the owner and the accountant (the
   review queue in #25), and required before any "period complete" state.
5. **Disconnect and cancellation.** Revoked or expired e-conomic access turns every new handoff into
   `needs_review` and shows a banner. Cancelling Quits offers the archive export first.

## Launch claims

| Claim | Status |
| --- | --- |
| "Quits is a registered bookkeeping system" or "meets the Bookkeeping Act" | **Never.** Quits is not one. |
| "Works with e-conomic: every invoice and credit note, with its original PDF, is posted to your e-conomic account, and Quits shows you any that did not arrive." | Allowed once the accounting integration ships with verified handoffs and the completeness check. |
| "Using Quits with e-conomic keeps you compliant with the Bookkeeping Act" | **Blocked** until a qualified reviewer approves arrangement A, including the hash/re-encoding question. |
| Anything about bookkeeping compliance for invoices Quits sends as e-invoices | **Blocked** by the e-invoice gap. |
| "Quits generates Peppol BIS Billing 3.0 invoices that pass the Danish validation rules" | Supported by the validation evidence in the delivery decision, scoped to the tested document shapes. |
| "Send e-invoices through Nemhandel/Peppol from Quits" | **Blocked** until a provider transport exchange succeeds (delivery decision). |
| "Your customers receive and accept your e-invoices" | **Never as a blanket claim.** Show each document's actual receiver response. |

## Four separate questions

The launch must not let one answer stand in for another:

1. **Bookkeeping-system obligations** belong to the business and its registered system (rules 1–10).
   Quits's part is the handoff and its proof.
2. **Invoice file generation** is Quits producing a valid Peppol BIS Billing 3.0 document.
3. **Network delivery** is an access point accepting and delivering the file to the receiver's access
   point.
4. **Recipient acceptance** is the receiver's own response, if any. Delivery is not acceptance, and
   acceptance does not settle a commercial dispute.

## Prerequisites and blockers

For the accounting integration issue:

- [ ] Qualified review (accountant or auditor, or a written answer from ERST) of arrangement A,
      including the three e-invoice-gap questions. **Blocks** every compliance claim.
- [ ] e-conomic sandbox or demo test that posts a voucher with a Quits PDF and reads it back: does the
      returned file match the uploaded bytes? This research wrote nothing to any e-conomic agreement,
      including the public demo.
- [ ] The minimum e-conomic role and package for voucher posting with attachments, and whether booking
      sales invoices through `invoices/booked` or vouchers through journals is the reviewed method.
- [ ] Archive export (originals, hashes, handoff manifest, accounting CSVs).
- [ ] Handoff records, idempotent posting, read-back verification and the completeness check.

For the electronic-delivery issue:

- [ ] Auditor approval of the chosen third-party access point and arrangement, which Nemhandel's
      guidance requires for businesses using one ([Hvad er et adgangspunkt i Nemhandel?](https://nemhandel.dk/adgangspunkter-i-nemhandel)).
- [ ] The e-invoice gap answer, before e-invoiced documents can be part of any bookkeeping claim.

Out of scope here, unchanged: registering Quits as a bookkeeping system, a general ledger, tax
filing, and rules for countries other than Denmark.
