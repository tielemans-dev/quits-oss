# Denmark: first electronic-delivery route

Decision record for [quits-oss#28](https://github.com/tielemans-dev/quits-oss/issues/28). Researched
8 October 2026. Status: **proposed.** This record proposes the route, profiles, field mapping and a
pure delivery-contract prototype. Transport is **not proven**: no provider credentials were available,
so no test exchange was made. The remaining access dependency is listed under [Sandbox feasibility](#sandbox-feasibility).

The bookkeeping boundary is decided separately in
[`2026-10-08-denmark-bookkeeping-boundary-decision.md`](./2026-10-08-denmark-bookkeeping-boundary-decision.md).

## Sources

Read on 8 October 2026. Dates are the publisher's own.

| Ref | Source | Publisher date |
| --- | --- | --- |
| D1 | ERST, [Nemhandel – fælles digital infrastruktur](https://erhvervsstyrelsen.dk/nemhandel-faelles-digital-infrastruktur) | 21 September 2026 |
| D2 | Nemhandel, [En teknisk introduktion til Nemhandel](https://nemhandel.dk/vejledning-en-teknisk-introduktion-til-nemhandel), version 2.0 | 11 June 2025 |
| D3 | Nemhandel, [FAQ regarding Nemhandel eDelivery](https://nemhandel.dk/vejledning-qa-regarding-transition-nemhandel-edelivery) | 27 April 2023 |
| D4 | Nemhandel, [Hvad er et adgangspunkt i Nemhandel?](https://nemhandel.dk/adgangspunkter-i-nemhandel) | Undated |
| D5 | Nemhandel, [Vejledning til Nemhandel Demo-miljø](https://nemhandel.dk/vejledning-vejleding-til-nemhandel-demo-miljoe-test-miljoe) | 13 September 2023 |
| D6 | Nemhandel, [Ændringer i NHR API (opslags-API'et)](https://nemhandel.dk/aendringer-i-nhr-api-opslags-apiet-12-august-2026) | 8 July 2026 (in production 15 September 2026) |
| D7 | Nemhandel, [Release af Peppol schematron-pakker 1.17.0 og 1.2.14](https://nemhandel.dk/release-af-peppol-schematron-pakker-1170-og-1214); package `PEPPOL_DK_CIUS_2026-08-03_v1.17.0` from [ERST's repository](https://git.erst.dk/openebusiness/common/-/tree/master/released/peppol), SHA-256 `1e7d01804fcc8e2f1e3464201566a589d5e5c7b24f1362971539b4d0699ab9ba` | 3 August 2026, mandatory 17 August 2026 |
| D8 | DK Core Usage Guideline (EN), version 1.3, inside D7 | November 2022 |
| D9 | Nemhandel, [Afsluttet høring om overgangen til Peppol](https://nemhandel.dk/afsluttet-hoering-om-overgangen-til-peppol-en-faelles-e-faktura) and its [høringsnotat](https://nemhandel.dk/sites/default/files/2026-05/Hoeringsnotat-dokumentstrategi-18052026_WA.pdf) | 27 May 2026 / 18 May 2026 |
| D10 | ERST, [Nye krav til registrerede bogføringssystemer – effektiv og sikker e-fakturering](https://erhvervsstyrelsen.dk/vejledning-nye-krav-til-registrerede-bogfoeringssystemer-effektiv-og-sikker-e-fakturering) | 25 September 2026 |
| D11 | NHR lookup API, OpenAPI at `https://api-demo.nemhandel.dk/nemhandel-api/v3/api-docs` ("This API allows anonymous access") | Fetched 8 October 2026 |
| D12 | [BEK 206/2011](https://www.retsinformation.dk/eli/lta/2011/206/pdf), §§3–6, electronic settlement with public authorities | Original text read 8 October 2026 |
| D13 | [Lov 1593/2018](https://www.retsinformation.dk/eli/lta/2018/1593/pdf), §§1–4, electronic invoicing in public procurement | Original text read 8 October 2026 |
| D14 | OpenPeppol, [BIS Invoice Response, process rules and code policy](https://docs.peppol.eu/poacc/upgrade-3/profiles/63-invoiceresponse/#invoice-response-process-rules), OP-BR111-R008–R011, R014 | Read 8 October 2026 |
| D15 | ERST, [NemHandel Fakturablanket](https://virk.dk/myndigheder/stat/ERST/selvbetjening/NemHandel_Fakturablanket/) and [instructions](https://virk.dk/myndigheder/stat/ERST/selvbetjening/NemHandel_Fakturablanket/Vejledning-Nemhandel-Fakturablanket/) | Read 8 October 2026; instructions updated 19 May 2026 |
| P1 | Digisense, [REST API reference](https://api.digisense.dk/ap/api/rest) (OpenAPI `openapi-spec.json`, version 1.0.0) | Fetched 8 October 2026 |
| P2 | Storecove, [API documentation](https://www.storecove.com/docs/) | Fetched 8 October 2026 |
| P3 | e-invoice.be, [Peppol API](https://e-invoice.be/peppol-api) and [OpenAPI](https://api.e-invoice.be/api/openapi.json) (version 1.1.0) | Fetched 8 October 2026 |

D12 and D13 were read from Retsinformation's original PDFs for this correction. The other laws
referenced by D1 and D2, [lov om offentlige betalinger](https://www.retsinformation.dk/eli/lta/2023/494)
and [lov om fælles digital infrastruktur](https://www.retsinformation.dk/eli/lta/2023/1764), were not
independently reviewed. These readings are not a consolidated legal opinion or qualified approval.

## What the infrastructure looks like

- **Two networks behind one register.** The Nemhandel register (NHR) is an SMP used by both the
  Nemhandel eDelivery network and Peppol. Nemhandel eDelivery is Peppol AS4 with additions: access
  points sign with MitID certificates rather than Peppol certificates, the receiving access point
  validates schema before acknowledging and schematron before forwarding, and senders must be able to
  receive a message-level response. It carries OIOUBL documents. (D2, D3.)
- **Who uses what.** Exchanging business documents with Danish public authorities through Nemhandel
  has been mandatory since 2005, and public authorities must be registered in NHR with one or more
  GLN (EAN) numbers. (D2.) Nemhandel is intended for trade inside Denmark; it needs a Danish CVR number
  and a MitID Erhverv certificate. Trade with foreign businesses uses Peppol. (D4.)
- **Endpoint identifiers.** Receivers are registered by CVR number (most common), P-number, SE-number
  or GLN. (D10.) In Peppol BIS these map to EAS `0184` (CVR) and `0088` (GLN).
- **Format direction.** OIOUBL 2.1 and Peppol BIS 3 are both in use today. ERST has decided to move
  from OIOUBL to Peppol, starting with the invoice, as "Nemhandel Faktura" based on Peppol BIS 4 /
  PINT, with an 18-month migration (test, phase-in, phase-out) still to be scheduled, and completed
  well before the EU cross-border e-invoicing duty of 1 July 2030. (D9.)
- **No universal mandate.** Sending an e-invoice to a business stays voluntary; registered
  bookkeeping systems must *show* the option from 1 March 2027 when the receiver is registered.
  (D10.) Nothing here claims every Danish business must send every invoice electronically.
- **Machine-readable data has legal effect.** Only the structured data of an electronic document in
  the common infrastructure has legal effect. (D9.)

### Recipient landscape (measured)

The NHR lookup API answered anonymously in both environments (D11). Production lookups on
8 October 2026:

| Receiver | Registration (Customer role) |
| --- | --- |
| Erhvervsstyrelsen, CVR 10150817 (state authority) | GLNs registered on both networks: OIOUBL BilSim and related profiles on Nemhandel AS4, and `urn:fdc:peppol.eu:2017:poacc:billing:01:1.0` (Peppol BIS Billing) on Peppol AS4. |
| Visma e-conomic A/S, CVR 29403473 (private company) | GLNs and its CVR registered for OIOUBL `Procurement-BilSim-1.0` on Nemhandel AS4 only. No Peppol BIS Billing. |

A random sample of 60 receiver-owning CVR numbers from the production receiver list (seed 20261008,
one request per second, all private by company form): 17 (28 %) advertise Peppol BIS Billing as
customer; 53 (88 %) advertise OIOUBL BilSim; **36 (60 %) advertise OIOUBL BilSim only**; 7 advertise
neither. The sample is small (a 95 % interval for 28 % is roughly 17–41 %) and only indicative.
These are registrations of sampled receiver-owning CVRs, not market share or
coverage of all Danish businesses, customers or public authorities. No fresh sample was taken in
this correction; the original probes and counts are retained in the review evidence.

### Four fixture shapes pass the pinned Danish schematrons

Quits already renders Peppol BIS Billing 3.0 with the Danish national rules it knows about (DK-R-002,
DK-R-005, DK-R-006, DK-R-014), freezes the XML at issuance and serves the stored artifact afterwards
(`apps/oss/src/lib/exports/ubl.ts`, `einvoice.ts`).

Its builder output was validated against the official D7 package (CEN EN 16931, Peppol and Danish
schematron XSLT, run with SaxonC-HE 13.0):

| Document | CEN | Peppol (incl. DK-R rules) | DK |
| --- | --- | --- | --- |
| DK→DK B2B invoice, CVR endpoints, payment means 42 with reg.nr. and account | 0 errors | 0 errors | 0 errors |
| DK→public authority invoice, GLN endpoint `0088:5798009811639` (Nemhandel demo receiver) | 0 | 0 | 0 |
| DK→DK credit note referencing the invoice | 0 | 0 | 0 |
| Existing `legacy-ubl-input.json` test fixture (DK→DE) | 0 | 0 | 0 |
| Negative control: payment means 30 between Danish parties | — | DK-R-005 fatal | — |
| Negative control: no buyer reference, order reference or seller legal entity | BR-06 fatal | PEPPOL-EN16931-R003, DK-R-002 fatal | — |

The official example invoice and credit note from D7 pass with the same harness. This shows technical
schematron validity for these document shapes and this package version. It does not establish
network delivery, acceptance, an exhaustive invoice matrix or legal compliance. The authored inputs,
exact XML, expected failures and executable checks are now committed in
[`evidence/2026-10-08-denmark`](./evidence/2026-10-08-denmark/README.md). After rebasing on main
`c0f23c014d0502c44fab9b7ea8b7a748c6b5eee8`, including the PDF/VAT fix, the four outputs remain
byte-identical and all 18 fixture/schematron comparisons match their expected results.

## Decision

**First route:** Peppol BIS Billing 3.0 with the Danish CIUS (`PEPPOL_DK_CIUS` 1.17.0 rules),
`CustomizationID urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0`,
`ProfileID urn:fdc:peppol.eu:2017:poacc:billing:01:1.0`, sent over the **Peppol network** through a
third-party access point.

**Documents:** commercial invoice (`InvoiceTypeCode 380`) and credit note (`CreditNoteTypeCode 381`),
non-negative credit-note totals (DK-R-016).

**First recipients, in order:**

1. Danish public authorities addressed by GLN (`0088`) whose exact endpoint and document type are
   reachable through this route. D12 §§3–5 require the authority's addressing/reference information
   and an electronically processable invoice; §5(3) can require an authority's ordering system. D13
   §4 requires EN-standard reception within its §1 procurement scope. Neither fact proves that every
   authority has a Peppol route. Confirm recipient-specific requirements before enabling this route.
2. Danish businesses whose NHR or Peppol SMP registration advertises the Peppol BIS Billing invoice
   (and, for credit notes, credit-note) document type for the chosen identifier, usually CVR (`0184`).

Every send is preceded by a lookup for the exact identifier and document type. Registry presence
and accepted delivery requirements are separate decisions. The caller must establish
`structured_required`, `email_accepted` or `unknown` from the recipient's requirements and applicable
rules, with the basis retained alongside the document. Do not infer `email_accepted` merely because
the recipient is a business or absent from a registry.

For an unavailable route, `nextEinvoiceRecipientAction` applies this contract:

| Requirement | Proposed action | Delivery status |
| --- | --- | --- |
| Structured invoice required, including an in-scope public authority | Show "Quits cannot currently deliver through the required route." Use an appropriate structured path, such as the authority's required procurement portal, an accounting system supporting that endpoint, or ERST's Fakturablanket for a suitable public invoice/credit note. | Incomplete until that path succeeds and evidence is retained. An email can be a copy only. |
| Email established as acceptable | Offer email with the reason the selected e-invoice route is unavailable. | Email has its own lifecycle; it never becomes a Peppol receipt. |
| Requirement unknown | Confirm it before proposing an alternate route. | Incomplete. |
| Lookup failed | Retry the lookup or investigate, regardless of requirement. | No fallback permission follows from a lookup error. |

D12 §5(1) allows a template for senders unable to send from their own system. Its §6 defines receipt
as availability for import into the authority's system and permits delaying payment for missing
§§4–5 requirements. A PDF email is not evidence of that receipt. D15 identifies a concrete manual
structured path, with MitID access and Danish-account limitations. It has not been used here. The
operator must preserve the issued identity/content and retain its original and receipt; no automatic
reissue, conversion, financial correction or Quits transport success may be inferred from using it.
External-route evidence remains separate from this Peppol transport state.

**Why not OIOUBL first.** OIOUBL 2.1 reaches more private receivers today, but it is a second document
format with its own rules, it needs a Nemhandel (MitID-certificate) access point, and ERST has decided
to phase it out for invoices in favour of a Peppol-based format. Peppol BIS 3 is what Quits already
produces. The proposal reaches only authorities that advertise the supported route and accept it
for the transaction. The reach gap remains the next decision, below.

**Exclusions** for this route:

- OIOUBL 2.1 output and OIOUBL-only receivers (shown honestly, not routed).
- Nemhandel AS4 transport, MitID-certificate access points and NHR registration of Quits users as
  receivers. Receiving e-invoices is out of scope.
- Payment reminders and utility statements: they exist only in OIOUBL profiles (D8).
- Orders, catalogues and other Peppol BIS documents.
- Consumers, and any claim that UBL export or this route equals "Nemhandel compliance".
- Embedding the PDF rendering as an attachment (the XML is the legal document; D9).
- Production enrolment and live sending in this issue.

**Next route decision (not part of this issue):** once a provider is under contract, choose between
(a) OIOUBL 2.1 generation for Nemhandel-only receivers, (b) a provider that converts Peppol BIS 3 to
OIOUBL with documented fidelity, or (c) waiting for Nemhandel Faktura 4. Revisit when ERST publishes
the migration timetable (D9).

## Field mapping

`BT` numbers are EN 16931 business terms. "Source" is what Quits freezes at issuance.

| Data | BT | UBL | Quits source | Danish rule / note |
| --- | --- | --- | --- | --- |
| Seller electronic address | BT-34 | `AccountingSupplierParty/Party/EndpointID@schemeID` | Seller VAT `DKxxxxxxxx` → `0184` + 8-digit CVR (`electronicAddressFromVat`) | Must be the CVR (or a GLN) the provider registers for the sender. |
| Seller legal registration | BT-30 | `PartyLegalEntity/CompanyID@schemeID=0184` | Organization tax IDs (`cvr` scheme, `nationalRegistration`) | DK-R-002, DK-R-014. Validated before issuance (`seller.legalId`). |
| Seller VAT | BT-31 | `PartyTaxScheme/CompanyID` | Organization VAT ID | |
| Seller name, address | BT-27, BG-5 | `PartyName`, `PostalAddress`, `RegistrationName` | Frozen seller snapshot | From 2028, registered systems must use locked CVR data (D10); Quits's proposed classification is still unreviewed; CVR lookup may help avoid mismatches. |
| Buyer electronic address | BT-49 | `AccountingCustomerParty/Party/EndpointID@schemeID` | Contact `peppolEndpointScheme` + `peppolEndpointId`, else derived from the buyer's VAT (`0184` for DK) | Public authorities: their GLN (`0088`), which the user must take from the authority. A receiver with several GLNs needs the user to pick; D10 says systems are not expected to guess. |
| Buyer legal registration | BT-47 | `PartyLegalEntity/CompanyID@schemeID=0184` | Buyer tax IDs | DK-R-017 when given. |
| Buyer VAT, name, address | BT-48, BT-44, BG-8 | as above | Frozen buyer snapshot, live contact as fallback | |
| Buyer reference | BT-10 | `BuyerReference` | `purchaseOrderRef`, else the buyer's name | **Gap.** PEPPOL-EN16931-R003 needs BT-10 or BT-13; the name fallback passes validation but is no reference. D12 §§3–4 require the authority's reference person/other reference and any order or requisition number. Add an explicit buyer reference on the contact and the invoice. |
| Order reference | BT-13 | `OrderReference/ID` | `purchaseOrderRef` | One order per invoice; line-level order references are not supported by the standard (D8). |
| Invoice number, dates | BT-1, BT-2, BT-9, BT-72 | `ID`, `IssueDate`, `DueDate`, `Delivery/ActualDeliveryDate` | Number assigned at issuance; issue, due and supply dates | Drafts are never sent: `validateEinvoice` returns `document.notIssued`. |
| Lines | BG-25 | `InvoiceLine`/`CreditNoteLine` | Frozen items: description, quantity, unit net price, line net | |
| VAT | BG-23, BT-151 | `TaxTotal/TaxSubtotal`, `ClassifiedTaxCategory` | Frozen VAT groups (v2) or line rates (v1); categories S, Z, E, AE, K, G, O | DK-R-004 for non-VAT taxes (not produced by Quits). Totals follow the frozen groups. |
| Payment instructions | BG-16, BG-17 | `PaymentMeans` | Frozen bank account: reg.nr. + account as code 42, else IBAN as 58/42/30 | DK-R-005, DK-R-006. FIK (code 93) and giro (50) are not produced. |
| Credit note link | BG-3 | `BillingReference/InvoiceDocumentReference` | The credited invoice's number and issue date | Set only when the credited invoice is issued. |
| Attachments | BG-24 | `AdditionalDocumentReference` | None today | Excluded from the first route. If added later, only as supporting documents, never the PDF rendering of the invoice itself. |

## Four outcomes, never one

| Layer | Question | Source of truth | Quits shows |
| --- | --- | --- | --- |
| Technical validation | Does the XML meet EN 16931, Peppol and Danish rules? | Quits's field checks before issuance; the recorded offline schematron check; future provider validation under its verified contract | "Ready to send" or the failing rule IDs |
| Transport | Did the receiver's access point acknowledge receipt? | The provider's transport status | "Delivered to the customer's e-invoice provider" with the time. Never "received by the customer". |
| Receiver response | Did the receiver reject the message, or answer with an Invoice Response? | Message-level response, or a Peppol Invoice Response (AB, IP, UQ, CA, RE, AP, PD) | The receiver's response with its date and note, or nothing if none arrived. Absence is not acceptance. |
| Commercial dispute | Does the customer disagree with the invoice? | The document's own lifecycle: notes, credit notes, payments | Not delivery state. "Under query" or "accepted" do not close or open a dispute by themselves. |

This is implemented as a pure, provider-neutral contract in
[`packages/contracts/src/einvoice-delivery.ts`](../../packages/contracts/src/einvoice-delivery.ts)
(`@quits/contracts/einvoice-delivery`): schemas for the state, events and recipient lookups,
`applyEinvoiceDeliveryEvent` and `nextEinvoiceDeliveryAction`. It has no database, provider or UI
wiring yet.

### Correction and retry policy

An issued artifact stays immutable. Failed validation, a message-level rejection or Invoice Response
`RE` returns `review_correction` for **both invoices and credit notes**. It supplies no financial
command. A person must investigate the reasons and choose an action supported by the document's
financial lifecycle and applicable rules. No automatic credit, replacement invoice, payment posting
or cancellation follows. D14 OP-BR111-R008–R011 state that an Invoice Response has no legal power,
changes neither invoice content nor commercial responsibilities, and does not remove payment
obligations. R014 binds the response to the original document type.

The proposed acknowledgment contract distinguishes new sends from existing submissions:

| Event | Permitted previous state | Result |
| --- | --- | --- |
| `submitted(ref)` | Validated, `not_sent` | `queued`. Repeated same-reference acknowledgments outside `unknown` are no-ops; they cannot acknowledge a retry. |
| `submission_outcome_unknown` | A possibly submitted validated document with no terminal outcome | `unknown`, action `reconcile`; never a send permission. Ignored after delivery, no route or permanent failure. |
| `submission_reconciled(ref)` | `unknown`, or duplicate evidence for the same `queued` submission | Attaches a discovered reference and sets `queued`; a known reference must match. This event means a trusted provider lookup confirms queued status. |
| `retry_submitted(ref)` | `failed` with provider-confirmed safe retry, or an exact duplicate acknowledgment while `queued` | Clears the failure and sets `queued`, even when the provider reuses the reference. The caller must correlate it to the permitted retry, not an old callback. |

`submitted` and `retry_submitted` are refused while `unknown`. A queued reconciliation cannot reopen
`delivered`, `no_route` or a permanent failure. Delivery remains terminal; older receiver responses
and exact duplicates are ignored, while conflicting terminal transitions throw and must be retained
as rejected evidence. The caller serializes updates and deduplicates events before applying them.
No-route and permanent-failure outcomes also remain terminal through later uncertainty or failure
events. Exact duplicate failures are no-ops. Conflicting failures, delivery receipts and receiver
responses are rejected for investigation; they cannot silently change a terminal failure into a
retryable submission.

`transportRetryable` must mean the provider established non-delivery and a safe retry procedure.
A timeout, generic 5xx or failed lookup does not establish that. A proposed retry schedule of 1, 5
and 30 minutes, then hourly up to 24 hours is conditional on the adapter's documented retry and
idempotency rules. Storecove's `failed` is final and does not use that schedule.

## Architecture

OSS owns everything a self-hoster also needs. Hosted provisioning lives in the hosted distribution and
plugs in through the existing runtime services (`apps/oss/src/lib/runtime/services.ts`) and
capabilities (`docs/architecture/runtime-extension-interface.md`).

**OSS (this repository), to build in the implementation issue:**

1. `EinvoiceDeliveryProvider`, an optional runtime service next to `documentArtifactStore`:
   - `lookup(participant, documentType)` → `EinvoiceRecipientResolution`
   - `submit({ xml, idempotencyKey, sender })` → provider reference, or an event when the provider
     answers synchronously
   - `reconcile({ providerReference?, idempotencyKey, sender })` → trusted status evidence or unresolved;
     a missing reference must be recoverable or remain explicitly unknown
   - `parseCallback(request)` → verified events; signature checking is the adapter's job
2. A logical delivery record holding `EinvoiceDeliveryState`, document kind, scoped document identity,
   recipient requirement and its basis, the frozen UBL hash and stable idempotency key. Attempt and
   evidence identities belong to an append-only history, including every event and its time. It follows the same retained-record rules as
   other financial records.
3. A future queue that submits, polls and reconciles. `nextEinvoiceDeliveryAction` is advice only,
   never authorization to run a financial command or bypass sender/organization checks.
4. A capability flag (`einvoiceDelivery`) that is off unless a provider is configured, so the send
   option is never shown without a working route.
5. Self-host configuration of one adapter with credentials the operator supplies: provider API key,
   the provider's identifier for the sending company, and callback authentication material supported
   by that adapter. The actual verification mechanism must be confirmed before implementation. Self-hosters sign
   their own agreement with the provider and the sending company is their own CVR.
6. The NHR lookup can be used directly without any provider (anonymous, D11), so recipient checks and
   the Danish "can this customer receive an e-invoice?" hint work even before sending is configured.

**Hosted distribution, separately owned:** the platform's agreement with the provider, registering
each customer organization as a sending company, custody and rotation of credentials, the public
webhook endpoint, monitoring and incident handling. It registers its provider adapter through the
runtime service; no hosted detail belongs in this repository.

## Provider comparison

Three providers with public, first-party API documentation were reviewed. None was contacted, signed
up or authenticated against.

| | Digisense (P1) | Storecove (P2) | e-invoice.be (P3) |
| --- | --- | --- | --- |
| Networks | Nemhandel, Peppol, KSeF | Peppol and other networks; no Nemhandel or OIOUBL in the docs | Peppol; no Nemhandel or OIOUBL in the API |
| Formats in | OIOUBL, OIOXML, Peppol BIS 3 XML; **no conversion** between formats or networks | UBL or JSON | JSON, UBL or PDF |
| Sandbox | Test host `test-api.digisense.dk`; API key by contacting the provider (unauthenticated call: HTTP 401) | Sandbox account on request; connected to OpenPeppol test networks; webhook simulation | Test mode validates and emails the XML instead of routing it; self-registered keys |
| Danish sender onboarding | Register company (`DK:CVR`), then an outbound participant per network | Legal entity with Danish identifiers (`DK:DIGST` for CVR, `DK:ERST`) | Tenant accounts and Peppol registration on the customer's behalf |
| Recipient lookup | `lookup-participant` on Nemhandel or Peppol, per document type | Discovery endpoints | `lookup`, `lookup/participants` |
| Validation | `validate-document` (schematron) | On submission | `validate/ubl` |
| Status | Polling: `delivered`, `queued-for-delivery`, `document-not-valid`, `unable-to-deliver`, `temporary-upstream-error`, `unknown-server-error`; `list-outbound-documents` | Webhooks: `succeeded` (corner 3), `failed`, `no_action_taken`, and Invoice Response events `acknowledged` … `paid` when the sender advertises Invoice Response; sending evidence | Timeline: `send_success`, `send_failed`, `mlr_received`, `imr_received`; signed webhooks |
| Receiver responses | Arrive as received `ApplicationResponse` documents for an inbound participant (not verified) | Mapped events | Timeline events |
| Submission idempotency | None documented; reconcile via `list-outbound-documents` | `idempotencyGuid` | Not checked |
| Security note | Says ISO/IEC 27001 certification is planned for Q4 2026 | Not checked | Not checked |

**First concrete adapter candidate: Storecove**, whose documentation covers several needs of the
first route: a sandbox on the OpenPeppol test network, submission idempotency, Invoice Response events
mapped to our contract, sending evidence and Danish legal-entity identifiers. **Digisense** is the
candidate for the next route, because it alone of the three reaches Nemhandel and OIOUBL receivers;
its lack of documented idempotency and response events must be resolved first. Both choices are
conditional on sandbox access, commercial terms and a data-processing agreement. D4's auditor
condition concerns an operator giving customers access to **Nemhandel** through a third party. It
does not establish a blanket duty for sending businesses or this Peppol-only proposal. Applicability
to the actual service roles needs qualified confirmation, as set out in the bookkeeping decision.
If Storecove's terms or sandbox fail, the contract lets Digisense or another Peppol access point replace it without changing
OSS domain code.

Mapping of Storecove events to the contract: `succeeded` → `transport_delivered`; `failed` →
`transport_failed` (not retryable); `no_action_taken` → `transport_no_route`; Invoice Response events
→ `receiver_response` with codes `AB`, `IP`, `UQ`, `CA`, `RE`, `AP`, `PD`; HTTP timeout on submission →
`submission_outcome_unknown`. P2's `DocumentSubmission.idempotencyGuid` specifies **HTTP 422** on
later requests using the same key; only the first submission is processed. A duplicate-key 422 is
neither a fresh success with a guaranteed reference nor a safe-resend signal. A confirmed duplicate
leaves an uncertain send in reconciliation. Other 422 errors need their own validation/error mapping.
Never rotate the key just to bypass a duplicate response.

P2 documents webhook fields `guid` and `idempotencyGuid` and evidence retrieval by known GUID. It does
not establish a queued-status lookup by idempotency key when the original response/GUID was lost.
That recovery path must be demonstrated in the sandbox, for example with authenticated pull-mode
webhook evidence. Until reliable evidence exists, keep `unknown` and expose the access dependency.
Do not manufacture `submission_reconciled` from HTTP 422 or an empty lookup.

Storecove `succeeded` proves corner-3 receipt, not corner-4 receipt or legal receipt under D12 §6.
`no_action_taken` means no recipient/routing problem. Neither code settles buyer acceptance. P2 also
lists partial-payment responses. The prototype does not model response clarification codes such as
D14's `PD` + `PPD`; adapters must preserve these as unsupported evidence, never flatten them to fully
paid. P2 documents push callbacks with optional HTTP Basic Authentication or a custom header, and
authenticated pull-mode webhook retrieval. Require a configured verification mechanism; no signed
webhook implementation was demonstrated. Authentication and richer response semantics remain
implementation prerequisites.

Mapping for Digisense, for the later route: `queued-for-delivery` → `submission_reconciled` when
resolving uncertainty, or
`submitted`/`retry_submitted` only when acknowledging the corresponding send; `delivered` →
`transport_delivered`; `document-not-valid` → `transport_failed` (not retryable); `unable-to-deliver` →
`transport_no_route` after a lookup confirms the receiver is missing, else `transport_failed`;
`temporary-upstream-error` → `transport_failed` (retryable only after its non-delivery/retry semantics
are confirmed; otherwise investigate); `unknown-server-error` or a timeout →
`submission_outcome_unknown`.

## Sandbox feasibility

Done, with no credentials:

- [x] Anonymous NHR lookups in the demo and production environments (D11), including the Nemhandel
      demo receivers from D5. The JSON shape matches the 15 September 2026 change (D6): PascalCase
      `Profile` fields, `IsPeppolEnabled`, `IsNhAs4Enabled`.
- [x] Technical validation of Quits's output against the official Danish CIUS package (table above),
      with negative controls.

Not done, and why:

- [ ] **Authentication and a test exchange with a provider.** Every reviewed provider needs an account:
      a Storecove sandbox account, a Digisense test API key, or self-registered e-invoice.be keys. This
      research was not permitted to register, request access or use credentials. **Remaining access
      dependency:** a sandbox account with the chosen provider, a sending legal entity for a test CVR,
      and a webhook endpoint reachable by the sandbox.
- [ ] **Direct exchange with the Nemhandel demo access point** (`https://edel-demo.nemhandel.dk/as4`).
      It needs an access point signing with a MitID Erhverv (FOCES) test certificate. Out of scope for
      this route.

Validation steps once access exists, in order:

1. Authenticate; record the account's sender identity.
2. Obtain a provider-confirmed receiver on the **OpenPeppol test network** and look up both document
   types there. The Nemhandel demo GLN `0088:5798009811639` in the synthetic XML is not proof that it
   is a reachable Storecove Peppol test endpoint. Substitute the authorized test identity before sending.
3. Submit the validated `dk-public-gln-invoice` fixture with an idempotency key. Record transport
   status and evidence.
4. Repeat the submission with the same key. For Storecove expect the documented duplicate-key HTTP
   422, only the first submission processed, and no assumed GUID in the response. Resolve the first
   submission from trustworthy evidence; verify no second delivery and no blind key rotation.
5. Submit the credit note referencing it.
6. In the authorized sandbox, test rejection of the payment-means negative control before transport.
   Preserve rule IDs and require investigation without a financial command. The current prototype
   uses `validation_failed`/`review_correction` for local pre-send validation; a provider rejection
   after acknowledgment stays `transport_failed` with `retryable: false`/`investigate`. Distinguish
   a validation 422 from a duplicate-key 422. Neither authorizes automatic reissue.
7. Look up and attempt a receiver with no Peppol registration: expect `no_route`.
8. Simulate or trigger Invoice Responses `AB`, `UQ`, `RE`, `AP`; replay one late and one duplicate.
9. Interrupt the connection during submission. Recover a missing GUID from provider evidence keyed
   to the original sender/idempotency key; if queued, apply `submission_reconciled`. If that lookup
   cannot be performed, the criterion fails and the state stays unknown. Repeat with a known GUID.
10. Where the provider supports a safe retry, confirm non-delivery first and correlate the retry
    acknowledgment with `retry_submitted`, testing both reused and new references. Do not treat
    Storecove's final `failed` event as retryable.

Pass criteria: every step's outcome maps to one contract event, and steps 4 and 9 show no duplicate
delivery.

## Assumptions for the implementation issue

- **Partner:** Storecove first (conditional, as above); Digisense evaluated for the OIOUBL/Nemhandel
  route. No partner is signed.
- **Onboarding:** each sending organization is registered as a legal entity with its CVR; the
  provider's KYC requirements are unknown until the sandbox is available. Self-hosters register their
  own. Sending also needs the seller's CVR as legal ID and endpoint (already validated by Quits).
- **Receiving responses:** the sender advertises the Invoice Response document type through the
  provider, or no business response events arrive.
- **Status:** authenticated provider evidence, with its signature/credential mechanism confirmed
  in the sandbox; stable evidence identifiers for deduplication. The reference-lost lookup path
  must be demonstrated before automatic reconciliation is claimed.
- **Retry:** only after evidence of non-delivery and an adapter-specific safe retry contract;
  preserve the logical key according to that contract. Unknown outcomes and duplicate-key 422
  require reconciliation. Storecove's final failures do not authorize resubmission.
- **UI:** sending needs a configured capability, a reachable exact document type and confirmed
  recipient requirements. An unavailable route uses the requirement decision above. A mandatory
  structured recipient stays incomplete until an appropriate structured path succeeds; email is
  only a copy. These decisions have no UI wiring in this discovery.
- **Buyer reference:** an explicit buyer-reference field is added before public-authority sending is
  offered.
- **Bookkeeping:** e-invoiced documents remain excluded from bookkeeping claims until the e-invoice gap
  in the boundary decision is answered.

## Compatibility with execution history and issuance

This is a proposed contract for the implementation issue, not a runtime integration with the
execution-journal work. The state reducer has no authorization checks, I/O, jobs or financial writes.

- A completed issuance command and a delivery outcome are separate. A timeout never replays issuance
  or allocates a new number. Bind each delivery to organization, document kind/ID, frozen UBL hash,
  exact recipient, provider/sending legal entity, logical key, attempt ID and evidence ID.
- Authenticate callbacks, verify all those bindings against stored data, then parse/reduce under a
  serialized update. A different known provider reference is refused. New references are permitted
  only for an explicitly correlated, safe retry. Evidence from another organization, document,
  recipient or old attempt must not reach this reducer as current evidence.
- `queued` means provider submission accepted, not corner-3 delivery. The journal's email
  `accepted` evidence must never be cast to e-invoice `delivered`. `delivered` needs the e-invoice
  transport receipt; receiver/business responses remain separately recorded.
- `unknown` maps to unresolved work and reconciliation. A missing receipt, missing provider lookup
  result or duplicate-key 422 cannot authorize a resend. A journal's explicit human email resend
  workflow grants no e-invoice retry permission. No automatic or manual e-invoice override is
  implemented by this prototype.
- `review_correction` projects a human review need for either document kind. It cannot call a credit,
  cancellation, reissue or payment command. Even `PD` is reported evidence, not a posted payment.
- Keep current read/send permissions and organization scope at the future command boundary. A
  provider capability does not grant permission. Recipient corrections require a new reviewed
  delivery target and must not mutate an uncertain attempt. External structured delivery evidence
  cannot mark this Peppol attempt delivered.
- Schema changes in this unpublished prototype require `documentKind` as the third argument to
  `initialEinvoiceDeliveryState`. Callers use `submission_reconciled` for queued reconciliation and
  `retry_submitted` for a permitted retry acknowledgment. The removed `credit_and_reissue` action
  becomes `review_correction`. No persisted runtime records exist to migrate.

The contract regressions cover the acknowledgment/refusal rules and both document kinds. The fixture
check invokes the current UBL builder and proves the preserved outputs still match after the PDF/VAT
merge. No journal candidate was imported and no cross-stream runtime exchange was tested. Event
binding/authentication, attempt fencing, current response-order/clarification rules and provider
callback security still need implementation and their own integration evidence. Existing immutable
artifacts, numbering and UX document-view/PDF contracts remain owned by their implementations.

## Reproducing the evidence

The [committed fixture bundle](./evidence/2026-10-08-denmark/README.md) contains exact builder inputs,
six XML files, checksums, the byte-comparison command, a validator invocation pinned to the official
CIUS archive and expected results including both negative controls. It is synthetic/offline evidence.
The original 60-CVR registry sample remains historical review evidence; it is not bundled as customer
data or presented as national market coverage. No credentials, environment, provider transport or
qualified legal/accounting review are included or implied.
