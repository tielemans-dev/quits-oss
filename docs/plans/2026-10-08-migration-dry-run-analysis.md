# Migration dry run: staging, reconciliation and cutover

Decision for [#33](https://github.com/tielemans-dev/quits-oss/issues/33), 8 October 2026.
Status: analysis complete for parent review; implementation and operational cutover are no-go.
This is a discovery prototype, not an approved production design or a completed importer.
No database importer, application contract, command, API or screen changes accompany it.

## Evidence and current source

The initial checkout was `c0f23c014d0502c44fab9b7ea8b7a748c6b5eee8`. The source audit also
inspected local `origin/main` at `5174f983047103473ea09c2e4b4763883f47cbdc`, which includes
UX's document-view change. The source audit is pinned to that commit; later changes require
a fresh integration review before implementation.

Read-only dependency audits used these exact public OSS candidates:

- [#29 extraction discovery at 6d9c9fc](https://github.com/tielemans-dev/quits-oss/blob/6d9c9fcbd678bf4800ad5c21bea791779acdbab2/docs/migration/economic-import-discovery.md), sections 4–10; its `scripts/economic-discovery/types.ts`, `normalize.ts`, matrix and 15 synthetic fixtures. Accepted draft #70 is research, not an approved live extractor.
- [Money at 295d00b](https://github.com/tielemans-dev/quits-oss/blob/295d00bbb856ec79c536e33888569a29592d52dc/docs/architecture/settlement-receipts.md), “Stored quantities and commands” and “Accounting export contract”. Accepted draft #72 separates funding from debt discharge. It is not merged runtime behavior in this baseline.
- [Denmark at 7f37ed6](https://github.com/tielemans-dev/quits-oss/blob/7f37ed6ed93ad0d072ada6911c2936fbbf67bd87/docs/plans/2026-10-08-denmark-bookkeeping-boundary-decision.md), “Classification decision”, “Document inventory” and “Prerequisites and blockers”. Accepted draft #66 still lacks qualified approval, particularly for XML originals and the combined bookkeeping setup.
- #32 provenance is in progress. No mapping here assumes its eventual contract, bank matching or reversals have shipped.

Current-source findings, inspected 8 October 2026:

- [`Invoice`, `Payment`, `RecurringInvoice`](https://github.com/tielemans-dev/quits-oss/blob/5174f983047103473ea09c2e4b4763883f47cbdc/apps/oss/prisma/schema.prisma) have optional invoice numbers, organization/number uniqueness, frozen artifact references and hashes, invoice-linked payments, default `remindersPaused=false` and default recurring `status=active`. There is no source-account/import-batch identity model in these records.
- [`computeSettlement` and `refreshInvoiceSettlement`](https://github.com/tielemans-dev/quits-oss/blob/5174f983047103473ea09c2e4b4763883f47cbdc/apps/oss/src/domain/documents/settlement.ts) sum active payments and issued credits; refreshing may expire checkout sessions. They are not safe historical-import entry points.
- [`reminderOrganizations`](https://github.com/tielemans-dev/quits-oss/blob/5174f983047103473ea09c2e4b4763883f47cbdc/apps/oss/src/domain/features/reminders.ts) selects open, unpaused debt when the organization enables reminders. [`recurring.ts`](https://github.com/tielemans-dev/quits-oss/blob/5174f983047103473ea09c2e4b4763883f47cbdc/apps/oss/src/domain/features/recurring.ts) runs active due schedules. Merely avoiding a send command does not isolate imported history from future ticks.
- [`accounting.ts`](https://github.com/tielemans-dev/quits-oss/blob/5174f983047103473ea09c2e4b4763883f47cbdc/apps/oss/src/lib/exports/accounting.ts) exports non-draft invoices, credits and payments. A future connector needs explicit historical-origin exclusion to avoid posting imported revenue back into its source.
- [`currency.ts`](https://github.com/tielemans-dev/quits-oss/blob/5174f983047103473ea09c2e4b4763883f47cbdc/packages/shared/src/currency.ts) refuses unknown and exponent-three precision in supported operations. Do not copy the discovery normalizer's slightly different currency allowlist into production.

These findings preserve current numbering at issuance, payment details and PDF VAT/price-basis behavior.
No proposed migration should render or reissue a historical tax document through today's renderer.

## Source-neutral staging proposal

Keep extraction, interpretation, persistence and activation separate. Proposed state progression is
`extracted`, `validated`, `needs_review`, `approved_mapping`, `committing_history`,
`history_committed`, then a separate `cutover_approved`. Blocking exceptions prohibit commit.
A history-only view can retain unresolved records without claiming they are operational receivables.

A versioned manifest should carry target organization, provider, source agreement/account, source
API/export version, exact extraction time and time zone, business cutoff date, extraction scope,
page/count evidence, files and hashes, mapping revision and an immutable batch fingerprint.
Preserve raw inputs separately from corrected mapping decisions. Never overwrite source evidence
when the user corrects a contact or account mapping. Re-run reconciliation after each correction;
an approval binds the exact input hashes and mapping revision and expires when either changes.

| Staged item | Identity and mapping | Refusal or visible exception |
| --- | --- | --- |
| Contact | Target organization + source provider + source account + contact ID; explicit target-contact mapping | Never auto-merge by name/email or merge across organizations |
| Invoice or credit | Same scope + source object kind + stable source ID; retain original number, date, issued state, currency and source customer | Repeated source ID within one extraction rejects the whole batch, even identical bytes; number collisions block operational commit |
| Funding and allocation | Preserve source entry IDs and matched-pair evidence; later map once to #72 funding and allocation quantities | A paid flag is not a receipt; receipt and invoice currencies need explicit evidenced quantities; #32 owns evidence identity and reversals |
| Artifact | Source document identity, source URL/reference, fetch outcome, media type, byte length, hash and immutable bytes when obtained | Distinguish missing, denied, failed and not fetched; never regenerate a PDF and call it an original |
| Exceptions | Stable code, source IDs, severity, affected totals, owner, evidence and review decision | Unknown FX, fees, VAT treatment or missing relationships remain explicit; no inferred writeoff |
| Resume record | Batch, mapping revision, item identity, payload hash, transaction outcome and committed target IDs | Same identity/new payload is a source revision conflict, not an overwrite or another financial record |

Historical document numbers belong to the source namespace. Do not advance the live issuance
counter or silently prefix the displayed legal number to satisfy Quits's uniqueness constraint.
An implementation needs an approved storage/read model that can retain both source identity and
original number when a current Quits invoice already uses it. Until then, a collision blocks the
operational import. Source drafts are not issued history. Preserve post-cutoff records as excluded
evidence; do not turn them into live recurrence templates.

A future commit transaction should create one connected financial group and its identity mappings
atomically, with database uniqueness scoped to organization/provider/account/kind/source ID.
Persist its successful outcome in the same transaction. Resume by these identities, not by row
position. A lost commit response must resolve by lookup. Retry unchanged payloads as no-ops;
changed payloads require an explicit reconciliation revision. Do not infer duplicate cash from
equal date/amount. Group membership, correction decisions and actor/time must remain auditable.
Concurrent workers, restart after process death and storage failures need real database tests.
The in-memory example below proves none of those properties.

## Exact constraints inherited from #29

The accepted prototype's `quits.import/economic-draft-1` bundle is deliberately synthetic.
Reuse its field matrix and normalizer concepts; do not replace them with imaginary CSV columns.
Its allocation solver peels tree-shaped matched-pair graphs using `amount - remainder`.
Pairs contain full entry amounts, not the allocated amount. Cycles remain ambiguous. Closed entries
without pairs remain `source_remainder_only`; a zero residual alone proves neither payment nor allocation.
A currency mismatch blocks comparison before numeric totals are added. Duplicate object identities
reject the full extraction. Repeated/reversed match edges are a distinct case handled by #29.

The prototype cannot reconstruct residuals as of a historical business date because pair records
have no match date. An earlier invoice paid after the cutoff retains only its extraction-time
snapshot residual where its counterpart falls outside scope. Do not label that balance “as of cutoff”.
A complete immutable snapshot and a separately agreed operational handover time are required.

Unresolved extraction duties remain planned:

- Traverse every page and reconcile counts to source controls under the same filters and snapshot. A general API introduction is not an endpoint-specific page-size contract. The Documents 4.0.1 `/AttachedDocuments/paged` operation currently documents page size 1–100, default 20, while #29 discusses broader cursor limits. Use endpoint-specific metadata; test multi-page and interrupted extraction.
- Verify `/invoices/totals/booked/unpaid` scope, credit inclusion and currency semantics before comparing it. #29 has no unpaid-total input or executed comparison.
- Reconcile contacts and debtor-line joins as relationships, not naive one-invoice/one-line counts. #29 already reports multiple debtor lines and manual invoices.
- Obtain an authorized export and establish actual filenames, columns, joins, credit signs and allocation coverage. The fallback is not implemented. No invented vendor export accompanies this analysis.
- Verify role/plan access, revocation, source changes during extraction, rate-limit recovery and the treatment of unavailable originals on a consented account.

Official sources underlying #29 are [REST](https://restdocs.e-conomic.com/), sections Booked invoices
and Unpaid totals; [BookedEntries v6](https://apis.e-conomic.com/bookedentriesapi/redoc.html),
BookedEntry and matched pairs; [Documents 4.0.1](https://apis.e-conomic.com/documentsapi/redoc.html),
AttachedDocuments and pagination; and [raw export](https://www.e-conomic.dk/support/artikler/eksporter-data-fra-e-conomic).
#29 records access on 8 October 2026 and public-demo observations. This worker did not repeat any
account request. This worker re-read REST and Documents on 8 October 2026 through the exact query
URLs recorded in [provider-sources.json](evidence/2026-10-08-migration-receipts/provider-sources.json),
after plain URLs returned 403. BookedEntries and export observations here remain attributed to #29.

## Reproducible synthetic worked report

Run from the checkout root, with the accepted extraction checkout present and unmodified:

```sh
bun docs/plans/evidence/2026-10-08-migration-receipts/check.ts ../economic --check
```

The script checks the full `6d9c9fcbd678bf4800ad5c21bea791779acdbab2` SHA and refuses dirty
prototype/fixture paths. It imports the existing pure normalizer and checks all 15 existing scenarios
against their declared document residuals, residual basis, artifact states, allocation edges,
exception identities and `allRowsMatch`. It does not rerun the upstream Vitest suite or matrix checker.
For standalone reproduction, use a separate clean public OSS checkout at that SHA and pass its path.
It reads that checkout only; no dependency install is needed.

The local [synthetic fixture](evidence/2026-10-08-migration-receipts/staging-synthetic.json) is an
analysis input format, not an e-conomic export or proposed application API. The checked
[worked-report.json](evidence/2026-10-08-migration-receipts/worked-report.json) contains the exact
local input byte hash as `stagingFixtureSha256` and the separate pinned upstream extraction fixture
hash as `extractionFixtureSha256`, plus document rows, counts, exceptions, successful simulated item
keys and exclusions. Changing even an unused input field or whitespace invalidates the saved report.
Run without `--check` to print a fresh report to stdout. All values below are invented test data.

| Currency | Issued invoices | Invoiced | Applied credits | Applied cash | Outstanding | Gross receipts | Unapplied cash |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| DKK | 3 | 2,750.00 | 250.00 | 900.00 | 1,600.00 | 1,000.00 | 100.00 |
| EUR | 2 | 300.00 | 0.00 | 220.00 | 80.00 | 220.00 | 0.00 |

For each invoice and currency, `outstanding = invoiced - applied credits - applied cash`.
For each receipt currency, `gross receipts = applied funding + unapplied funding` here, with zero
fees/refunds. DKK is `2750 - 250 - 900 = 1600`; EUR is `300 - 0 - 220 = 80`.
Do not net the 100 DKK unapplied amount against arbitrary invoices or against EUR debt.
For #72 integration the general funding equation is `gross = net + evidenced fee` and
`available = gross - active receipt-currency allocations - active refunds`. An allocation changes
debt once, not revenue or cash twice. Cross-currency funding uses both frozen quantities; there is
no conversion or inferred FX posting in this report. Open credits need their own residual table;
#29's `credit_allocation` scenario covers them, while this smaller dataset has one fully applied credit.

The worked dataset contains 2 contacts, 5 invoices, 1 credit, 4 funding records and 4 allocations,
16 staged identities. It excludes a 75 DKK issued post-cutoff invoice and a 50 DKK draft; neither enters
the totals. The checker requires explicit issuance state and valid dates, validates the exclusion reason,
and rejects overlap with included identities. `after_cutover` requires an issued invoice strictly after
8 October; `not_issued` requires a draft and takes precedence over date. This checks the supplied
partition, not whether a provider export contains every source record.
Three artifacts are available synthetic text bytes with computed SHA-256, one is missing
and one has a fetch error. These text bytes are not PDFs or evidence of a preserved provider original.
Source IDs, original numbers and dates remain visible in the report. Collision `I1`/`1001` blocks commit.

The format profile parses `1.250,00` exactly as 125000 minor units and `30.09.2026` as `2026-09-30`.
It refuses mixed punctuation, sub-minor precision, malformed grouping, invalid calendar dates and
ambiguous short dates. This establishes a specific synthetic Danish profile, not discovered export syntax.
The script exercises a failure after 4 simulated successful identities, resume adding 12 and identical
replay adding zero. Duplicate IDs reject the entire batch and changed payloads refuse without writes.
Keys contain organization/provider/account/kind/source ID, with escaped components. A separate
control combines two invented providers sharing all account/object IDs: 32 identities coexist, replay
adds zero and a same-provider payload conflict refuses without writes. It does not add cash to the
single-provider financial report. The [regression script](evidence/2026-10-08-migration-receipts/regression.ts)
also checks raw-byte drift and negative exclusion examples against the actual checker in temporary copies.
This is an in-memory demonstration, not persisted import or concurrency evidence. The retry exercise
is independent of the commit gates; the colliding dataset remains ineligible for operational commit.

Contrary evidence stays visible: #29 `control_total_disagreement` has matching document rows yet a
customer-control difference. `missing_documents` can have matching money and unavailable evidence.
Neither `allRowsMatch=true` nor the two balanced currency equations proves completeness or approval.

## Operational isolation and cutover proposal

Staging must have no application command dispatch, outbox jobs, checkout/payment-link generation,
reminder enrollment, provider charge or recurrence activation. Historical persistence needs a
separate authorization and an explicit import-origin/activation guard enforced in every scheduler,
communication and accounting-export entry point. Setting reminders paused is defense in depth,
not a substitute for that guard. Do not call normal issuance, settlement refresh or payment commands
and hope their side effects are harmless. The analysis script imports none of these modules;
runtime isolation still needs tests with actual worker ticks and outbox inspection.

Two cutover modes require explicit choice and a frozen ownership record:

| Responsibility | History-only mode | Proposed future-invoicing takeover |
| --- | --- | --- |
| Future issuance | e-conomic | Quits, only after approved timestamp and number-series preflight |
| Reminders and customer debt communication | e-conomic | Quits for explicitly selected debt; e-conomic jobs for that debt manually disabled and evidenced first |
| Accounting and original-record retention | e-conomic | e-conomic; #37 handles only approved new Quits-origin transactions |

One system owns each responsibility for each agreed document scope. Historical source invoices
must never be exported back as new revenue after import, reconnect or retry. Historical corrections
and new credits referring to source invoices need an accountant-approved direction before activation.
Preserve source access/export and artifact manifests even after operational takeover.

Before takeover the business operator inventories and manually disables source recurring invoices,
reminders/dunning, scheduled sends and any automatic collection/payment-provider jobs for transferred
scope. Capture job IDs, schedules, pending deliveries, exact scope, actor, timestamp and source-side
proof. Unknown or still-enabled jobs block takeover; Quits cannot claim a read-only connection
disabled them. Source accounting jobs stay with e-conomic. This worker performed none of these actions.

Freeze issuance, take the final source snapshot, reconcile every document/customer/currency and all
exclusions, settle pending source sends, verify originals and review mappings with the operator and
accountant. Then approve ownership and activation separately from import. On failure before
activation, retain inert history and source ownership. After any new Quits issuance, pause further
actions and review ownership; do not automatically resume source jobs or delete issued records.

## Acceptance and UI handoff

| #33 acceptance item | Evidence now | Still unmet |
| --- | --- | --- |
| Counts, currency equations and exclusions | Synthetic report above | Real source controls and importer report |
| Danish inputs, partials, credits, duplicate IDs, collisions | Local example plus reused #29 scenarios | Authorized source export validation |
| Original identity and artifacts | Proposed manifest and synthetic preservation hashes; missing/error flags | Runtime immutable storage and real originals |
| Failure/resume/repeat without duplicates | In-memory simulation only | Database atomicity, durable restart and concurrency proof |
| No communication/charge/reminder/recurrence | Script cannot call application/provider actions | Runtime import and worker-isolation tests |
| Review/correct mappings; resumable batch | Revision-bound design and traceable simulation | Persistence, authorization and UX implementation |
| Consented e-conomic pilot | Pilot gates defined | Entire pilot and source reconciliation |
| Ownership and source jobs | Explicit two-mode proposal above | Actual chosen owner record, job disable evidence and cutover approval |

UX owns the Kvit interface, document-view contracts, editors and render/PDF work. Future UI needs a
source/target organization confirmation; extraction completeness and last-read time; mapping revision
review; invoice/customer/currency reconciliation with every exclusion; original/download-unavailable
status; a collision/unsupported-data queue; inert-history status; resume outcome by item; and a
separate ownership/cutover confirmation with source-job evidence. This specifies information and
states, not a new screen or branding implementation. #32 must supply final settlement provenance
semantics, #72 funding semantics, #66 qualified retention approval and #29 approved extraction.
Parent review and these dependencies precede any importer implementation.
