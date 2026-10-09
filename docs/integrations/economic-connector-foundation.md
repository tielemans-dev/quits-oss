# e-conomic read connector foundation

Issue #37, foundation scope only. This internal server API reads e-conomic into isolated,
non-operational staging. It cannot post invoices, credits, payments, attachments or matches.
It cannot cancel source records. It creates no Quits Invoice, Payment, billable item, job,
reminder, delivery or numbering allocation. No new route or Kvit screen is installed.

The human acceptance items are tracked separately in
[#85](https://github.com/tielemans-dev/quits-oss/issues/85). Provider entitlement, qualified
accountant mapping and a consented end-to-end trial remain unmet. Do not close #37 for this
foundation. #77 delivered discovery for #33/#57, not importer or receipt-capture runtime.

## Server entry points

`apps/oss/src/lib/economic/service.ts` exports `EconomicConnector`. Construct it with the
runtime Prisma client. The optional HTTP transport is a test seam; production uses `fetch`.
Only authenticated `UserActor` values from the existing session boundary may be passed.
No body-supplied actor, user ID or organization ID is an authentication mechanism.

- `connect(actor, expectedAccount, credentials, expectedGeneration)` checks current admin
  membership, confirms `/self` agrees with the explicit account, then probes sales and
  bookkeeping reads separately. Pass null for the first generation. Reconnect uses the
  current generation and invalidates old pending work. One agreement per organization is
  supported. Before `/self` verifies the account, `accountVerified` is false and the admin
  may correct the expected agreement using the current generation, with or without disconnect.
  A mismatch stops before all other probes. Successful `/self` verification permanently binds
  the account, even if later role probes fail. SQL also prevents clearing verification or
  changing a verified agreement. Combining two grants is unsupported.
- `dryRun(actor, generation, requestKey)` returns a durable operation ID and state. Repeating
  the same key/generation returns the saved operation, including pending or failed outcomes.
  It never automatically resumes an abandoned worker. Reconnect explicitly interrupts it;
  a new generation performs a full extraction. Different concurrent keys are refused.
- `disconnect(actor, generation)` fences further access and drops encrypted credentials.
  An admitted attempt finishes or loses its fence first. Backoff holds no row lock and every
  retry checks the generation again. Disconnect does not recall a request already sent. After it commits, old requests cannot start and
  old extraction results cannot commit. Saved evidence and issued documents remain intact.
- `readState`, `readReport` and `readArtifact` are available to current admins and accountants,
  scoped by organization. Members and agents have no connector access. These functions have
  no public-link counterpart. The report supplies opaque local evidence IDs for downloads.

Credentials use the existing AES-GCM `encryptSecret` facility and `BETTER_AUTH_SECRET`.
They are never stored in plaintext. Reports and errors exclude tokens, request headers,
provider error bodies and raw transport errors. Credentials are removed after extraction,
failed preflight, extraction failure, revocation or disconnect. A connected but unused grant
remains encrypted until explicitly disconnected; no unattended expiry job is installed.
Production operators must configure the existing encryption secret before wiring this API.

Each HTTP admission checks the live connection generation and membership under the same
organization row lock used by reconnect/disconnect. This intentionally serializes connector
requests and can briefly contend with other organization updates. The transaction timeout
is fifteen seconds. A separate fourteen-second fence deadline starts before pool and row-lock
wait, aborts the HTTP signal and rejects late callback results. Each attempt checks that deadline
immediately before transport and after awaits. This matters because Prisma timeout releases locks
without cancelling its JavaScript callback. Each retry obtains a new fence; an expired callback
cannot send a retry with the old grant. Each HTTP read has a ten-second budget from its first
admitted attempt, including backoff and later admission waits. A whole extraction has a
sixty-second transport budget. Large accounts can fail the bounds; there is
no claim of arbitrary account size or resumable source pagination.

## Data, versions and restrictions

The runtime pins REST as unversioned, BookedEntries 6.0.0 and Documents 4.0.1. See
[economic-connector-sources.json](economic-connector-sources.json) and the unchanged accepted
[API snapshot](../migration/economic/api-snapshot.json) and
[extraction matrix](../migration/economic/extraction-matrix.json).
The discovery normalizer and its expanded 186 tests are inherited unchanged from the pinned parent. The #77 checker remains
pinned to `6d9c9fcbd678bf4800ad5c21bea791779acdbab2`; this runtime does not rewrite that evidence
or pretend its deliberately synthetic contract accepts real provider extracts.

REST collections use next links with the same resource, page size and consecutive page index.
BookedEntries and Documents use opaque continuation cursors, never their bounded `/paged`
variants. Duplicate identities, cyclic links, skipped pages, count drift, malformed required
fields and differing full reads stop extraction. BookedEntries and attachment `/count` reads
must agree before/after traversal and with the number retrieved. When REST supplies a
`pagination.results` count, it must remain stable across pages and equal the retrieved count.
An absent count is explicitly not independent completeness evidence. REST independent control
counts and unpaid-invoice-total semantics remain unresolved. No filter or historical as-of
query is invented. The entire source collection is staged, including dates after a proposed
business cutoff. A future importer must select and justify its own cutoff separately.

The client allows only the documented HTTPS origins and the specific read paths. It refuses
cross-origin, cross-resource, wrong-version, credential-bearing and unexpected query links.
PDF links must identify the exact staged invoice. Redirects are never followed. Methods are
always GET, including on the public demo. There are no provider mutation methods to enable.
At most 500 attempts, 100 pages per collection, 32 MB total, 2 MB per JSON response and 9 MB
per PDF are allowed. HTTP 429 and 500 get at most three attempts, with at most two seconds
per retry delay. Both delta-seconds and HTTP-date Retry-After values are honored. A requested
wait above the cap or remaining deadline stops the operation instead of retrying early.
Numeric call cost is recorded, not used to invent a provider rate entitlement.

JSON numeric tokens retain their decimal lexeme and remain distinct from JSON strings.
Required amounts reject numeric strings, unsupported currency precision, fractional minor
units and exponential notation. Money is handed off as integer minor-unit strings using
`@quits/shared/currency`. Manifest contract `quits.economic.read-staging/2` records
`sourceEncoding: "canonical-json-text"`. Each record's `source` is the complete JSON text,
with sorted object keys and original numeric lexemes, such as `125.00`. Its `sourceHash` hashes
that exact string. Storing source JSON as text prevents JSONB from changing decimal spelling
or conflating a number with an ordinary provider object. `parseExactJson(source)` recovers
its JSON types and exact numbers. Ordinary strings, arrays and objects cannot impersonate
numeric tokens. Unknown additional provider fields remain in that text; required mapped
fields are validated. This is
strict validation of the mapped shape, not a claim that every optional API field is modeled.
Rounding is retained as `roundingAmountInBaseCurrency`, using the agreement base currency,
including for foreign zero-exponent invoices. No floating-point amount conversion or
settlement allocation occurs. BookedEntries date-times retain their exact source timestamp,
including an absent timezone; REST business dates remain date-only. Nullable attachment
page counts remain null. Explicit null cursor items mean an empty page, still subject to
independent count and continuation checks; missing items are refused.

`EconomicSourceEvidence` identities are organization/provider/account/kind/source ID. The
composite foreign key also binds organization and account to the connection. Database checks
fix origin to `historical_import`, intent to `dry_run_only` and provider to `economic`.
An update trigger makes all saved source evidence and PDF bytes immutable. A changed source
hash or artifact on reconnect fails the whole persistence transaction. Unchanged evidence is
reused. There is no revision-approval or deletion API; explicit reviewed revision handling is
future work. These records are structurally separate from invoice and accounting-export
queries, so neither reconnect nor retry can turn history into new exportable revenue.

The report retains canonical source JSON text, normalized source fields, API versions, canonical
source hashes, page-body hashes, byte counts, extraction time, document identity and PDF
fetch state. It is bound to a hash of the saved manifest including local evidence IDs.
Source metadata and all artifact bytes commit atomically with the operation outcome.
A failed read or failed transaction creates no partial staging success. Its saved exception
identifies a safe code and, when known, API area and source document, with a next action.

A 404 PDF is explicitly missing. A denied, timed-out or malformed PDF fails the operation.
Fetched bytes are retained without rerendering. `retrieved` only says that bytes were obtained;
it does not prove statutory original retention. A Documents API PDF can be a rendition of an
uploaded image. Supplier attachments are not customer payment receipts or permission to rebill.
The SQL tables store sensitive source evidence; production database access and encryption at
rest remain deployment responsibilities. No evidence is exposed through customer invoice links.

Two equal scans plus stable counts detect many changes, but the provider offers no snapshot
transaction. The report explicitly says `two_equal_reads_not_atomic`. An operator-confirmed
source freeze, independent control totals and full reconciliation are still required. Residuals
mean extraction-time source remainders, never reconstructed balances as of a past cutoff.
Matched pairs retain full entry amounts as source evidence; no allocation amounts are guessed.
VAT remains unclassified, rounding semantics unapproved and reconciliation `not_performed`.

## Kvit handoff

UX owns the design, document-view contracts, editors and delivery keys. Wire the internal API
through authenticated routes before any screen. No existing invoice/editor component changes
are required by this patch. Suggested state/action requirements are exact about capability:

| State | Required information and allowed action |
| --- | --- |
| Not connected | Show one-account and one-grant limits, documented plan names, and “Quits will only read; e-conomic cannot restrict this connection to reading.” Ask the admin to confirm the agreement number before submitting credentials. |
| Connecting | Show read-only preflight pending and whether the account is verified. No import, post or synchronization action. |
| Unverified account mismatch | Show the attempted agreement and allow the admin to correct it using the current generation. No resource probes have run. Once verified, the agreement cannot be changed. |
| Missing role/no access | Show sales versus bookkeeping probe failures; do not infer plan entitlement from HTTP status. Ask for an appropriate grant or use the still-unimplemented export fallback. Sales-only and Bookkeeping-only grants cannot provide a complete connection individually. |
| Connected/empty | Show confirmed agreement, base currency and each probe outcome. Zero on one endpoint does not mean every source collection is empty. PDF-role access is not verified by connection alone. Offer read-only extraction. |
| Pending extraction | Show durable operation identity. Retry/poll the same key to observe state. A second extraction key is refused while this one is pending. After a crashed worker, offer explicit reconnect/new full extraction, not “resume”. |
| Needs review | Show source records and scoped IDs, document currencies/minor amounts, missing/retrieved originals, hashes, extraction time and unresolved checks. Download only via an authenticated evidence-ID route. This state does not mean reconciled, imported, posted or synchronized. |
| Failed | Show saved exception and its source document/API area when known. No partial success or accounting effect. Changed source payloads require a future reviewed revision path; do not overwrite the first snapshot. |
| Revoked/disconnected/interrupted | Stop future reads; require a new generation to reconnect. Keep saved reports and originals available to authorized readers. Existing issued invoices are unaffected. |
| Unsupported writeback | Show that sale/credit/fees/settlements and document uploads are disabled. No “sync now” or “mark synchronized” action exists. |

Read plans are documented as Basis, Plus, Smart and Komplet, unverified on real accounts.
Write plans are documented as Plus, Smart and Komplet; writeback remains disabled for all plans.
Do not invent modules or advertise the application-selected role as a read-only grant.

## Remaining #37 engineering and approval gates

The following stay open independently of this foundation:

1. Qualified identifiers, currency/precision, VAT code, numbering, sale/credit relationship,
   fee, settlement and original-document mapping. No posting endpoint has been chosen.
2. Connector integration with the merged #72 settlement API and eventual #32 provenance.
   Main's settlement receipts are preserved, but this connector does not map source entries
   into those receipts or approximate funding/allocation semantics.
3. Exactly-once sale/credit/accounting results, uncertain provider write outcomes, durable
   writeback retries, read-back verification, originals archive export and transfer completeness.
4. Authenticated route integration, Kvit screens, accounting exception workflow, independent
   reconciliation, source revision review and operational-history activation design.
5. Authorized real account/plan/role tests, including Basis, Sales-only PDF access, Bookkeeping
   identity verification, provider-side revocation and any two-grant account binding.
6. A separately authorized sandbox trial for the reviewed posting and attachment method,
   partial payment, credits, fees, FX, lost responses and reconnect. Never use the public demo
   for mutation. No trial, live grant or credential was available during this implementation.
7. Qualified Danish retention/classification review. Frozen UBL originals still lack an
   approved e-conomic destination. An attachment PDF or a local hash is not statutory approval.

The accepted Danish decision was read from the sibling discovery checkout only. No sibling
code was imported. Frozen invoice PDF/UBL references, tax/currency semantics, payment snapshots
and nullable draft numbering remain unchanged. The sole pinned parent is #70 at
`8378ce4b2c95f52a3632506ad94429683784e2fe`, based on main
`24911db4c37a0a40db9edc20a983b0450542ae1d`, including dashboard #102.
The unmerged connector migration is provisionally `20261014080000_economic_connection`.
At the actual merge turn, recompute its timestamp to the next free position after then-current
main and queued predecessors, regenerate Prisma, and repeat fresh and main-schema upgrades.
Never rename an existing main migration. Parent review, fresh independent review and later current-main integration remain
required before publication or merge. Only the parent publishes a draft or updates issues.
