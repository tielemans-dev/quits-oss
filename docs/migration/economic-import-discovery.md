# e-conomic import: feasibility discovery

Status: discovery, 8 October 2026. Covers issue #29. It does not build the importer.

## What this establishes, and what it does not

e-conomic can probably be read well enough to import issued history with correct open balances, **if** the customer grants a role that reaches both the sales and the bookkeeping APIs, and **if** the account's matched entries behave on a real account the way they did on the vendor's public demo company. Neither condition has been tested on a customer account. This document separates three kinds of evidence, and every claim below carries one of them:

| Label | Meaning |
| --- | --- |
| **Documented** | Stated in the vendor's public documentation, read on 8 October 2026. Not fetched from any account. |
| **Executed (demo)** | A read-only `GET` on 8 October 2026 against the vendor's published public demo agreement (`X-AppSecretToken: demo`, `X-AgreementGrantToken: demo`, which the vendor documents as `GET`-only). It is a shared vendor demo company, not a customer account. It presents broad read access, so it says nothing about narrower roles, plan gating, large accounts, credit notes (the demo has none) or foreign-currency matching. |
| **Unverified** | Neither of the above. Listed as an open gap. |

No customer grant, token or credential was available or used. No write method was sent. Nothing was cancelled or changed in any provider account. The fixtures are **invented**; they test Quits-side logic and are not a migration of anything.

Machine-readable companions in [`economic/`](./economic/):

- [`api-snapshot.json`](./economic/api-snapshot.json): endpoints, fields, versions, roles and the executed probes, with the SHA-256 of each source page read.
- [`extraction-matrix.json`](./economic/extraction-matrix.json): the field-level mapping of emitted draft fields, prospective importer requirements and required normalization inputs.
- [`fixtures/synthetic-scenarios.json`](./economic/fixtures/synthetic-scenarios.json): 15 synthetic scenarios with hand-declared expectations.
- Code: `scripts/economic-discovery/` (draft contract types, normaliser, matrix checker) and `scripts/__tests__/economic-discovery.test.ts`.

## 1. Surfaces and versions

No single API holds everything. A full read needs three.

| Surface | Version (8 Oct 2026) | Used for | Notes |
| --- | --- | --- | --- |
| REST, `restapi.e-conomic.com` | none; the vendor says it offers no versioning | customers, booked invoices and credit notes, original PDFs, accounting years, control totals | Hypermedia JSON. Follow the links the API returns instead of building URLs. |
| BookedEntries, `apis.e-conomic.com/bookedEntriesapi/v6.0.0/` | 6.0.0 | customer ledger lines with `remainder`, and matched pairs | Matched-pair retrieval arrived in 4.0.0 (February 2026); `remainder` in 3.2.0 and filterable in 3.3.0. |
| Documents, `apis.e-conomic.com/documentsapi/v4.0.1/` | 4.0.1 | documents attached to vouchers | Keyed on accounting year and voucher number. |

The version is part of the OpenAPI URL path and the vendor reserves the right to deprecate versions. The extractor must pin the three versions, record them in the import provenance (the draft contract does), and stop on a response that does not match the pinned shape rather than tolerate drift.

`POST /booked-entries/match` (matching) exists in BookedEntries. The importer never calls it, and the matrix test fails if any row cites it.

## 2. Access: app registration, roles, plans

All **documented**, except where marked.

**Registration and grant.** The vendor's connection guide: sign up for a free developer agreement; create an app there and choose its role; the app gets an `AppSecretToken`; the accounting user (an administrator first clicks "Administer" on the agreement) opens the app's Installation URL, which yields an `AgreementGrantToken`. Requests carry both as headers. URL-parameter authentication is not supported. A redirect URL on the app, or the vendor's PartnerAPI, can automate collecting the grant. The guide says "required modules" matters only for apps listed in the vendor's marketplace; whether a commercial integration used by many customers needs listing or approval is **unverified** (the Requirements and Publishing pages were not read).

**Roles are entity-scoped, not verb-scoped.** The role is picked when the app is created. The permissions page lists four: SuperUser, Bookkeeping, Sales, Project employee. For the entities this import needs:

| Needed | REST path or API | Roles that may read it |
| --- | --- | --- |
| Customers | `/customers` | SuperUser, Sales |
| Booked invoices and credit notes | `/invoices/booked`, `/invoices/booked/:n` | SuperUser, Sales |
| Accounting years | `/accounting-years` | SuperUser, Bookkeeping |
| Ledger entries and matched pairs | BookedEntries v6 | SuperUser, Bookkeeping |
| Attached documents | Documents v4 | SuperUser, Bookkeeping |
| Booked-invoice PDF | `/invoices/booked/:n/pdf` | **not listed** on the permissions page; unverified for Sales |

Consequences:

1. **No single non-SuperUser role reaches both halves.** Customers and invoices need Sales or SuperUser. Entries, matching and attachments need Bookkeeping or SuperUser. A complete read therefore takes either one SuperUser app, or two apps (Sales and Bookkeeping) and two grants from the customer. Whether one app can hold two roles is **unverified**; the guide describes choosing one.
2. **A read-only grant does not exist.** SuperUser can also write. The read-only property of the importer is Quits' own: it issues `GET` only, and the matrix test enforces that no source cites another method. The connection screen must say so plainly: "Quits will only read; e-conomic cannot restrict this connection to reading."
3. The vendor's demo token reaches both halves, so it cannot be used to learn what Sales or Bookkeeping alone returns.

**Plans.** The vendor's full feature list (columns Komplet, Smart, Plus, Basis):

- "Free access to integrations, extra functionality and open API" is included in Komplet, Smart and Plus, not in Basis.
- The same page says Basis has *limited* API access: only payroll and year-end tools may write accounting data into e-conomic. It states there is no restriction on integrations that **retrieve** data from e-conomic on Basis.
- Data export (Excel or CSV, "all data as a zip") is a core feature in all four.
- Other places on the page still say "Avanceret" where the table says Komplet. Treat the plan naming as inconsistent and show the customer the vendor's current names.

So, on the documentation alone: **read-only import is allowed on every plan; writing back (ongoing accounting handoff) needs Plus, Smart or Komplet**, because Quits is neither a payroll nor a year-end tool. This is marketing copy, not a contract, and no Basis account was tested. The importer and a later accounting writeback must be gated separately: connect-to-import checks read access only; connect-to-write is a second capability with its own preflight and its own plan message.

**Presenting an account that cannot be read.** Run a preflight per granted role, read-only, and map the result to a state the customer can act on:

| Probe | Result | State shown |
| --- | --- | --- |
| any call | `401` | **Access revoked or token wrong**: reconnect. The vendor documents `401` as what an agreement that revoked the grant sees. |
| Sales app: `/self`, `/customers?pagesize=1`, `/invoices/booked?pagesize=1`. Bookkeeping app: `/accounting-years`, BookedEntries `/booked-entries/count`, Documents `/AttachedDocuments/count` | `403` | **Missing role**: name the half that is missing (sales data or bookkeeping data). The vendor documents `403` as role-dependent. |
| the same | other `4xx` on a documented endpoint | **Provider reports no access** and offer the export fallback (section 6). What a Basis or trial account returns is unverified, so do not guess the cause. |
| the same | `2xx`, count 0 | **Connected, nothing to import.** |
| the same | `2xx` | Connected. |

## 3. Pagination, rate and error recovery

- **REST** collections return 20 items by default and up to 1,000 with `pagesize`, with `skippages` and first/next/last links (executed on the demo: `maxPageSizeAllowed: 1000`).
- **BookedEntries and Documents** prefer cursor pagination: up to 1,000 items per call, repeat with `?cursor=` until none is returned. The `/paged` variants are classic pagination and only reach the first 10,000 items; sorting works only there. The demo's single page of 138 entries returned no cursor.
- Filters use the vendor's `$eq:`/`$in:` syntax (a list in `$in:` is capped at 200). `remainder` and the `$null:` escape were executed.
- **Incremental sync is not available for entries.** The BookedEntry schema has no `lastUpdated` and `objectVersion` is not filterable. Customers expose `lastUpdated`. Re-extraction of entries is full.
- **Errors:** `400` bad filter, `401` token wrong or grant revoked, `403` role, `404` no such resource (also a missing PDF), `409` conflict (writes), `415`, `429` over quota, `500`, `501` documented but not implemented. `429` says to check the response headers; **no numeric rate limit is published** on the pages read. The demo returned `x-callcost` (3 for an entries page, 13 for a PDF), so the extractor should log it and back off on `429`.
- Recovery policy for the importer: retry `429`/`500` with backoff and a cap; stop and ask for reconnect on `401`; stop and name the role on `403`; record a `404` on a PDF as `original_pdf_missing` rather than failing the run. `Idempotency-Key` applies to writes only and does not apply to `GET`.
- **Revocation.** The vendor documents the `401` outcome. Where the customer revokes a grant in e-conomic's own interface is **unverified**. On the Quits side: keep the tokens only while an import or sync needs them, store them encrypted, and delete them when the run completes or the customer disconnects.

## 4. Field-level extraction matrix

[`economic/extraction-matrix.json`](./economic/extraction-matrix.json) has 64 rows: 48 semantic mapping rows and 16 source-input rows. `inDraftContract` means the field is represented in the emitted TypeScript draft, not merely required by a future importer. Unsupported VAT treatment, credit links, payment method, match dates, FX differences and planned unpaid totals are explicitly absent. Exhaustive typed key maps group identity, exponent and diagnostic output fields under their semantic rows. Input rows describe extraction dependencies and are not output fields.

Each row records status, source endpoint and field, required roles, probes and notes. `scripts/economic-discovery/matrix.ts` fails the test run when a row cites an endpoint or field that is not in the snapshot, uses roles that differ from the permissions page or OpenAPI roles, when a semantic field or required input has no row, or when an emitted-field flag disagrees with the typed draft.

Derivation dependencies may reference mapped output fields or explicit input rows. New accounting-year input mappings use the existing saved REST field inventory and permission table; they claim no new provider execution. Condensed:

| Quits field | Source | Status |
| --- | --- | --- |
| Contact: key, name, address, zip, city | REST `/customers` | executed (demo) |
| Contact: email, country, VAT number, CVR, EAN | REST `/customers` | documented; optional; omitted when empty, so a populated value was never seen |
| Document: number, dates, currency, rate, net, VAT, gross, base gross, customer | REST `/invoices/booked/:n` | executed (demo) |
| Document: supply date | REST `delivery.deliveryDate` | documented; supplied value preserved, absent becomes null, never inferred from issue date |
| Document: rounding | REST `roundingAmount` | executed; whether gross includes it is undocumented |
| Document: original PDF | REST `/invoices/booked/:n/pdf` | executed (demo): `application/pdf` |
| Document: kind (invoice or credit note) | sign of `grossAmount` | derived: the vendor documents negative totals for credit notes; there is no type field |
| Document: voucher, ledger line | BookedEntries `voucherNumber`, `entryNumber` | executed (demo) |
| Document: accounting year | entry date inside `/accounting-years` bounds | derived; BookedEntries has no year field; assumption: a voucher sits in the year of its date |
| Document: attached files | Documents v4 `/AttachedDocuments` | executed (demo); supplementary evidence, not the invoice PDF |
| Document: residual | REST `remainder`, cross-checked with the ledger line's `remainder` | executed (demo) |
| Ledger item: payments, opening balances, manual invoices | BookedEntries `type`, `amount`, `amountInBaseCurrency`, `currencyCode`, `date`, `remainder` | executed (demo) |
| Unapplied cash | a payment entry whose `remainder` is non-zero | derived; no separate resource |
| Allocation: which entries are matched | BookedEntries `/matched-pairs` | executed (demo) |
| Allocation: amount | solved from `amount − remainder` over the pair graph | derived; see section 5 |
| Control totals | REST customer `balance`; `/invoices/totals/booked/unpaid` | executed / documented |

### Unsupported or partial, to surface in the importer

| Case | Why | What the importer must do |
| --- | --- | --- |
| Credit-to-invoice link | No field on a credit note names an invoice; only a matched pair links them; an unmatched credit has no link | Import a matched credit with its pair; report an unmatched one as an open credit with no invoice. Quits credit notes require an invoice today. |
| Allocation date and match id | Absent from pair and entry | Never invent a payment date for an allocation. Residual "as of" a past date cannot be rebuilt. |
| FX difference on matching | Not in the pair; where e-conomic books it is undocumented | Report `fx_difference_unattributed` with the base-currency delta. |
| VAT treatment and evidence | Only rate and amount per line | Import as unclassified and non-postable. |
| Payment method and bank reference | Free text only | Method `other`, text kept as a note. |
| Manual (journal) customer invoices | Entry type 10 has no booked-invoice resource and no PDF | Open balance only, flagged. |
| Reminder fee lines and other ledger entry types | Not mapped | Reported; visible only through control totals. |
| Allocation history when pairs form a cycle | Per-entry applied totals are exact; pair amounts are not unique | Mark the cluster ambiguous and report; do not choose a solution. |
| Applied amounts with no pair | e-conomic shows the entry closed; the extraction has no pair | Report `applied_without_match_pair`; the close state is real, who paid what is unknown. |

## 5. What the demo showed about matching

Executed on the demo company, 8 October 2026, shapes only:

- A matched pair returns **each entry's full amount**, not the amount applied between them. An invoice of 1,187.50 matched to a payment of −2,000.00 appears as `1187.5` and `−2000.0`; the invoice's `remainder` is 0 and the **payment's** remainder is −812.50. The unapplied cash is visible only as that remainder.
- One entry matched to two others appears as two pairs sharing the entry, each showing the full amount of the shared entry.
- In all three observed match clusters, the sum of entry amounts equalled the sum of remainders. That is an observation on three clusters, not a documented guarantee; the validator uses it as a conservation check and blocks on a violation.
- A booked invoice appears as several lines (revenue, VAT, debtor). Only the debtor line carries `customerNumber`. Treating every line as a receivable would double count.
- Payment-typed entries can be positive (a +5,000 payment-typed entry was matched against a −7,000 one).
- `customer.balance` matched the sum of ledger remainders for two customers and was 500.00 away for a third, cause unidentified. It is a control to report on.

The solver in `normalize.ts` uses these: applied amount per entry is `amount − remainder`; pairs form a graph; when pairs ≤ entries − 1 the graph is a tree and peeling leaves yields unique pair amounts; a cycle yields no unique solution and is reported. It is **not** a proof of the vendor's remainder: recomputing a residual from the solved allocations is an internal consistency check (pairs exist, signs agree, flows fit the entries, clusters conserve). The independent anchors checked by this validator are the REST invoice remainder against the ledger-line remainder and the customer balance. The unpaid-invoice control total is a planned extractor check, not implemented here.

Before normalization, the validator checks source identities for customers, booked invoices, entries, attached documents and accounting years. Any repeated identity rejects the entire batch with a blocking `duplicate_source_identity` exception and no import records. This applies to identical and conflicting payloads; the validator never chooses a first or last copy. Repeated matched pairs, including reversed pairs, represent one graph edge and are checked against their entry amounts.

An invoice and every debtor line must have the same currency before their amounts or residuals can be compared. A missing ledger currency code uses the agreement's base currency. A currency mismatch blocks with `debtor_line_currency_mismatch` and leaves the document's recomputed residual null.

All customer-ledger entries in a match cluster must belong to the same customer. Cross-customer matches block with `cluster_customer_mixed`; this draft has no supported customer-transfer rule. Invalid pair endpoints or amounts make the entire cluster inconsistent, including invalid repeated or reversed pairs. This includes sub-minor precision such as 625.001 DKK even when rounding would equal the entry amount. These clusters emit no allocations and retain source-only residuals even when the source reports zero residuals and balanced customer controls.

Ledger amounts and remainders must also have supported currency precision, and remainders must be present and within the signed entry amount. An invalid remainder cannot supply an applied amount to the solver, even when it would round to zero. Its entire connected cluster is inconsistent and emits no allocations; an unmatched invalid entry also gets no recomputed residual. Valid unrelated clusters remain eligible. Rounded diagnostic values in a blocked batch do not establish an exact source balance or import approval.

## 6. Export fallback

When the API cannot be used (no grant, role refused, Basis account where the provider reports no access, a customer who will not grant access), the same contract can be filled from files. All **documented**; none was downloaded.

| Source | What it gives | Limits |
| --- | --- | --- |
| "Eksportér data" (All settings > Company), complete export | Raw CSV per register, as a zip e-mailed to the superuser unencrypted, or each register downloaded encrypted; optional from/to dates; "all relevant data": customers, suppliers, invoices, VAT codes, items, accounts | The vendor says raw invoice data is postings on the accounts the invoice touched and is not a PDF archive. The **file list and column names are not published**; the only file named on the page is `FakturaKladdeLinje.csv` (draft invoice lines). Whether the raw postings carry match identifiers and remainders is **unverified and decides how much allocation history the fallback preserves.** |
| Quick export ("Vis i Excel") | Visible columns only | Omits fields such as postcode and city. Not acceptable for import. |
| Sales Archive (Salg > Arkiv) | PDFs of invoices and credit notes, combined into one PDF per view | At most 200 per file; the vendor's own steps repeat per page; per-document files must be split and matched by number. |
| "Eksportér bilag" | Voucher and attached-document PDFs | At most 100 per file; selected per accounting year only, not per date range; option to include attached documents. |

Requirements before the fallback is promised: obtain one real export from a consenting customer, record the file names and columns, and add them to the matrix as a second source column. Until then the fallback is a plan, not a mapping. The importer should accept an extraction from either source into the same bundle, reject an incomplete batch (a missing file, a duplicate, a gap in invoice numbers) and report missing PDFs one by one.

## 7. Fixtures

[`fixtures/synthetic-scenarios.json`](./economic/fixtures/synthetic-scenarios.json) holds 15 scenarios in the shape of the vendor's payloads. Every field name is checked against the documentation snapshot. Each has hand-written expected documents, allocations, clusters, exceptions and reconciliation rows.

| Scenario | What it pins down |
| --- | --- |
| `unpaid`, `fully_paid`, `partially_paid` | Residual from the remainder; paid state proven by a pair and a payment line; applied 400.00 of a 1,000.00 invoice taken from amount minus remainder |
| `credit_allocation` | Credit fully offset, partly offset, and still open; the only link is the pair |
| `unapplied_cash` | Overpayment and a payment on account: residual lives on the payment |
| `rounding` | `roundingAmount` with undocumented semantics: accepted either way, flagged |
| `foreign_currency` | EUR partial payment; exchange difference visible only in base amounts and reported as unattributed; base-currency control total within one minor unit |
| `missing_documents` | PDF missing, PDF fetch failed, PDF not fetched, voucher outside every extracted year |
| `many_to_one` | One payment for two invoices and two payments for one invoice, solved exactly |
| `ambiguous_cycle`, `unsupported_history` | Allocation history that cannot be recovered is reported, not invented |
| `inconsistent_match` | A non-conserving pair and a REST remainder that disagrees: both block |
| `cutover_boundary` | A document after the cutover is excluded; a match across the boundary keeps only its snapshot residual |
| `manual_and_opening` | Opening balance, journal-posted invoice, reminder line |
| `control_total_disagreement` | A 500.00 difference in the vendor's customer balance is reported |

The validator also has mutation tests: a missing entry, a changed pair amount, a missing remainder, a remainder larger than the amount, mixed currencies, an unknown currency exponent, sub-minor precision, an invoice without a ledger line and the reverse. Regression tests cover equal numeric amounts in different invoice/ledger currencies, identical and conflicting source identities, repeated pairs, and allocations whose counterpart is excluded by cutover or an unsupported entry type. Every emitted allocation endpoint must be represented by an imported document or ledger item.

What the fixtures do **not** prove: that a real account returns this shape, that match clusters conserve on real data, anything about credit notes on a real account, or that rounding works the way the validator tolerates.

## 8. Reconciliation test plan and cutover boundary

**Boundary.** An extraction is a snapshot: residuals are as of the extraction, not as of any earlier date, because no match carries a date. Therefore:

1. Choose the cutover date C = the last business date on which e-conomic issues documents for the customer. Documents dated after C are not imported as history and are listed.
2. Freeze matching and payment booking in e-conomic from the final extraction until Quits goes live, or extract again. Entries have no incremental sync, so a re-run is a full extract.
3. Documents use their REST issue date; non-document ledger items use their entry date. Dates equal to C are included. A match cluster is importable only if every endpoint is represented in the output, every entry is dated on or before C, and its document joins and allocation solution are valid. Otherwise the entire cluster's allocations are omitted. Affected documents keep only their source snapshot residual with `recomputedResidual: null`, `residualBasis: source_remainder_only` and a `snapshot_residual_only` exception. Affected ledger-item reconciliation rows likewise have null recomputed residuals. No allocation date is inferred. Full-extraction `clusters` remain diagnostic evidence and may name excluded entries; they are not import records. This also handles a pre-C payment matched to a document issued after C.
4. Nothing is cancelled in e-conomic. The dry run is read-only and writes a report, not Quits records.

**Levels**, in order; stop at the first level with a `blocking` exception:

| Level | Check | Tolerance |
| --- | --- | --- |
| 0 completeness | REST booked-invoice count equals BookedEntries debtor lines with an invoice number; `/count` endpoints against pages read; every PDF fetched or listed missing; attachment count joined | exact |
| 1 per document | debtor-line currency and customer match the invoice before comparing amounts; REST `remainder` equals the ledger-line `remainder`; invoice totals add up; the voucher's revenue, VAT and debtor lines net to zero | exact in the document currency; reported invoice base gross equals the debtor base sum exactly; voucher net within one base minor unit |
| 2 per allocation | each pair endpoint exists; pair amounts equal entry amounts, including repeated/reversed evidence; cluster entries belong to one customer; clusters conserve; solved flows fit both entries and agree with their signs; every emitted endpoint is represented in import scope | exact |
| 3 per customer and currency | per-document and ledger-item residual rows stay in their own currencies; compare the complete extraction's ledger residuals converted to base against `customer.balance`. Planned: compare unpaid booked-invoice residuals with the vendor unpaid-invoice total after verifying its scope and currency semantics | one base minor unit per partially applied foreign entry for the customer check; any other difference is reported with its amount. Unpaid-total tolerance requires verified endpoint semantics |
| 4 after a Quits dry run | per customer, document and currency: Quits residual equals source residual; unapplied cash and open credits equal their source sums; allocations reproduce each entry's applied amount | exact, per currency; never netted across currencies |

A type 1 customer-ledger entry with a null or absent invoice number produces blocking `ledger_entry_without_invoice`. It remains in the full-snapshot customer control but creates no invented document or ledger item. All supplied entry customer references are checked before date or type exclusions, including post-cutover debtor entries.

Reported invoice `grossAmountInBaseCurrency` is checked against the sum of debtor `amountInBaseCurrency`, including negative credit notes and foreign-currency documents. Both are converted to base minor units and must agree exactly. Sub-minor precision invalidates this proof even if rounding gives equal integers. A failure blocks, omits allocations involving that document and leaves its recomputed residual null. The validator infers no conversion from `exchangeRate`, and `roundingAmount` does not excuse disagreement between reported base gross amounts.

A null or absent debtor voucher number produces degraded `voucher_number_missing`. The original invoice PDF and residual checks can still be available, but attachment completeness cannot be established. Empty `attachedDocumentNumbers` then means the join could not be made, not that the voucher has no attachments. Accounting year uses the first debtor entry's date within the inclusive extracted `fromDate` and `toDate` bounds, returning `year`. This remains the stated voucher-year assumption, not a vendor guarantee.

Synthetic payload field validation recursively checks documented paths through objects and every array element. It rejects nested typos such as `pdf.dwonload` while accepting documented invoice line, product and unit shapes. This checks names against the saved inventory, not provider schema types or real-account behavior.

**Pass.** No `blocking` exception; every `degraded` exception acknowledged by an operator decision; every control-total difference recorded with its amount. `allRowsMatch` describes only the emitted reconciliation rows; a source-only row has a null match and makes it false. It is not an overall import approval. An empty row set can still have `allRowsMatch: true` while blocking extraction exceptions reject the batch. Customer controls cover the full extraction snapshot, including entries excluded at cutover; they must not be claimed as totals for imported history.

The validator executes levels 1 and 2, the customer-balance part of level 3, the join and PDF-evidence parts of level 0, and produces the reconciliation rows level 4 will compare against. `SourceBundle` has no unpaid-total input and the unpaid-invoice control-total comparison is **planned, not executed**. Before implementing it, verify whether the endpoint includes credits and which currency it returns, then compare it with the same complete snapshot scope. Never compare it with cutover-filtered records or net different currencies. Comparing page totals with the `/count` endpoints is also a planned extractor duty.

## 9. Acceptance criteria for #29

| Criterion | State |
| --- | --- |
| Field-level extraction matrix linking each required field to an official endpoint or export column, recording unsupported cases | **Met for the API.** 64 rows, checked against a documentation snapshot and the typed draft, including normalization dependencies. **Export columns are not met**: the vendor does not publish them and no export was obtained. |
| Fixture set: unpaid, fully paid, partially paid, credit allocation, unapplied cash, rounding, foreign currency, missing documents | **Met**, synthetic only (15 scenarios). |
| Fixture verifies matched-pair amounts and joins rather than inferring from a paid flag; unsupported history reported | **Met** in the validator and its tests. Real-account behaviour unverified. |
| Read-only access and writeback entitlements documented separately, including how to present an inaccessible account | **Met on documentation** (section 2). Plan gating **not tested** on any account. |
| Test plan reconciling residuals per customer, document and currency, with the cutover boundary | **Met as a test plan** (section 8). Levels 1 and 2, the customer-balance part of 3 and part of 0 run on synthetic fixtures. The unpaid-total and page-count checks are planned; level 4 needs the importer. |
| No production mutations or source-provider cancellations required | **Met.** Only `GET`; the demo agreement is `GET`-only by the vendor's rule. |

## 10. Still needed from outside the codebase

These cannot be produced by code or documentation and keep the issue's real-world claims open:

1. A **sandbox or consenting customer extraction** with credit notes, partial payments, foreign-currency invoices and matched entries, to confirm shapes, cluster conservation, rounding, FX difference handling and credit numbering.
2. Behaviour per **role and plan**: a Sales-only and a Bookkeeping-only grant, the PDF endpoint under Sales, and a Basis account's read access.
3. One real **raw export** to record file names, columns, and whether match identifiers and remainders are present.
4. The vendor's **marketplace or partner requirements** for a multi-customer integration, the numeric rate limits, and the customer-side path to revoke a grant.
5. A **qualified accountant** on the cutover rule, the treatment of unmatched credits and unapplied cash, and the "unclassified" VAT stance for imported documents.

## 11. Running the checks

```sh
cd scripts && bunx vitest run __tests__/economic-discovery.test.ts
```

The documentation snapshot was extracted from the pinned source pages (hashes in `api-snapshot.json`). It has no generator in the repository; refresh it by re-reading those pages and updating the file together with the matrix, then let the tests tell you what drifted.
