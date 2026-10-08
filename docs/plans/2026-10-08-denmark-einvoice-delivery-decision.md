# Denmark: first electronic-delivery route

Decision record for [quits-oss#28](https://github.com/tielemans-dev/quits-oss/issues/28). Researched
8 October 2026. Status: **proposed.** Route, profiles, field mapping and the delivery contract are
decided. Transport is **not proven**: no provider credentials were available, so no test exchange was
made. The remaining access dependency is listed under [Sandbox feasibility](#sandbox-feasibility).

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
| P1 | Digisense, [REST API reference](https://api.digisense.dk/ap/api/rest) (OpenAPI `openapi-spec.json`, version 1.0.0) | Fetched 8 October 2026 |
| P2 | Storecove, [API documentation](https://www.storecove.com/docs/) | Fetched 8 October 2026 |
| P3 | e-invoice.be, [Peppol API](https://e-invoice.be/peppol-api) and [OpenAPI](https://api.e-invoice.be/api/openapi.json) (version 1.1.0) | Fetched 8 October 2026 |

Laws referenced by D1 and D2, not read independently here: [lov om offentlige betalinger](https://www.retsinformation.dk/eli/lta/2023/494),
[BEK 206/2011 on electronic settlement with public authorities](https://www.retsinformation.dk/eli/lta/2011/206),
[lov om elektronisk fakturering ved offentlige udbud](https://www.retsinformation.dk/eli/lta/2018/1593) and
[lov om fælles digital infrastruktur](https://www.retsinformation.dk/eli/lta/2023/1764).

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
neither. The sample is small (a 95 % interval for 28 % is roughly 17–41 %) and only indicative, but
the direction is clear: Peppol BIS Billing alone does not reach most Danish private receivers today.

### Quits's current output passes the Danish rules

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
validity for these document shapes, not delivery.

## Decision

**First route:** Peppol BIS Billing 3.0 with the Danish CIUS (`PEPPOL_DK_CIUS` 1.17.0 rules),
`CustomizationID urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0`,
`ProfileID urn:fdc:peppol.eu:2017:poacc:billing:01:1.0`, sent over the **Peppol network** through a
third-party access point.

**Documents:** commercial invoice (`InvoiceTypeCode 380`) and credit note (`CreditNoteTypeCode 381`),
non-negative credit-note totals (DK-R-016).

**First recipients, in order:**

1. Danish public authorities addressed by GLN (`0088`). Suppliers must invoice them electronically
   (D2), and the act on e-invoicing in public procurement requires them to accept EN 16931 invoices.
   The authority checked here registers Peppol BIS Billing; each one is still looked up before sending.
2. Danish businesses whose NHR or Peppol SMP registration advertises the Peppol BIS Billing invoice
   (and, for credit notes, credit-note) document type for the chosen identifier, usually CVR (`0184`).

Every send is preceded by a lookup for the exact identifier and document type. A receiver that is not
registered, or registered only for OIOUBL, is shown as "can't receive this e-invoice format" and the
document is offered by email instead. Nothing is sent on the assumption that it will reach them.

**Why not OIOUBL first.** OIOUBL 2.1 reaches more private receivers today, but it is a second document
format with its own rules, it needs a Nemhandel (MitID-certificate) access point, and ERST has decided
to phase it out for invoices in favour of a Peppol-based format. Peppol BIS 3 is what Quits already
produces and validates, and it serves the public authorities for whom e-invoicing is mandatory. The reach gap is real and is
recorded as the next decision, below.

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
| Seller name, address | BT-27, BG-5 | `PartyName`, `PostalAddress`, `RegistrationName` | Frozen seller snapshot | From 2028, registered systems must use locked CVR data (D10); Quits is not one, but should offer a CVR lookup to avoid mismatches. |
| Buyer electronic address | BT-49 | `AccountingCustomerParty/Party/EndpointID@schemeID` | Contact `peppolEndpointScheme` + `peppolEndpointId`, else derived from the buyer's VAT (`0184` for DK) | Public authorities: their GLN (`0088`), which the user must take from the authority. A receiver with several GLNs needs the user to pick; D10 says systems are not expected to guess. |
| Buyer legal registration | BT-47 | `PartyLegalEntity/CompanyID@schemeID=0184` | Buyer tax IDs | DK-R-017 when given. |
| Buyer VAT, name, address | BT-48, BT-44, BG-8 | as above | Frozen buyer snapshot, live contact as fallback | |
| Buyer reference | BT-10 | `BuyerReference` | `purchaseOrderRef`, else the buyer's name | **Gap.** PEPPOL-EN16931-R003 needs BT-10 or BT-13; the name fallback passes validation but is no reference. Danish public receivers route invoices by a reference such as a contact ("personreference") or requisition number. Add an explicit buyer reference on the contact and the invoice. |
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
| Technical validation | Does the XML meet EN 16931, Peppol and Danish rules? | Quits's validator before issuance; provider validation before sending; the receiving access point's schematron check | "Ready to send" or the failing rule IDs |
| Transport | Did the receiver's access point acknowledge receipt? | The provider's transport status | "Delivered to the customer's e-invoice provider" with the time. Never "received by the customer". |
| Receiver response | Did the receiver reject the message, or answer with an Invoice Response? | Message-level response, or a Peppol Invoice Response (AB, IP, UQ, CA, RE, AP, PD) | The receiver's response with its date and note, or nothing if none arrived. Absence is not acceptance. |
| Commercial dispute | Does the customer disagree with the invoice? | The document's own lifecycle: notes, credit notes, payments | Not delivery state. "Under query" or "accepted" do not close or open a dispute by themselves. |

This is implemented as a pure, provider-neutral contract in
[`packages/contracts/src/einvoice-delivery.ts`](../../packages/contracts/src/einvoice-delivery.ts)
(`@quits/contracts/einvoice-delivery`): schemas for the state, events and recipient lookups,
`applyEinvoiceDeliveryEvent` and `nextEinvoiceDeliveryAction`. It has no database, provider or UI
wiring yet.

### Correction and retry policy

- An issued document is never edited or re-sent with changed content. A technical rejection (failed
  validation, message-level rejection) or an Invoice Response `RE` leads to a credit note and a new,
  corrected invoice (`credit_and_reissue`).
- An uncertain submission (timeout, unknown server error) is **reconciled** with the provider using the
  stored provider reference or the provider's outbound list. It is never sent again blind
  (`reconcile`).
- A failure the provider marks as temporary may be resent (`resubmit`), with the same idempotency key
  where the provider supports one. Other failures need investigation (`investigate`); "no route" needs
  a corrected recipient (`fix_recipient`).
- Duplicate and late callbacks are no-ops; a late transport failure never undoes a delivery; a receiver
  response before the transport receipt implies delivery.
- Proposed retry schedule for retryable transport failures: 1, 5 and 30 minutes, then hourly up to
  24 hours, then `investigate`. To be confirmed against the chosen provider's rate limits.

## Architecture

OSS owns everything a self-hoster also needs. Hosted provisioning lives in the hosted distribution and
plugs in through the existing runtime services (`apps/oss/src/lib/runtime/services.ts`) and
capabilities (`docs/architecture/runtime-extension-interface.md`).

**OSS (this repository), to build in the implementation issue:**

1. `EinvoiceDeliveryProvider`, an optional runtime service next to `documentArtifactStore`:
   - `lookup(participant, documentType)` → `EinvoiceRecipientResolution`
   - `submit({ xml, idempotencyKey, sender })` → provider reference, or an event when the provider
     answers synchronously
   - `status(providerReference)` → events, for polling and reconciliation
   - `parseCallback(request)` → verified events; signature checking is the adapter's job
2. A delivery record per send attempt, holding `EinvoiceDeliveryState`, the provider reference, the
   frozen UBL hash it sent, and every event with its time. It follows the same retained-record rules as
   other financial records.
3. A queue job that submits, polls and reconciles, using `nextEinvoiceDeliveryAction`.
4. A capability flag (`einvoiceDelivery`) that is off unless a provider is configured, so the send
   option is never shown without a working route.
5. Self-host configuration of one adapter with credentials the operator supplies: provider API key,
   the provider's identifier for the sending company, and a webhook signing secret. Self-hosters sign
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

**First concrete adapter: Storecove**, as the provider whose documentation covers everything the first
route needs: a sandbox on the OpenPeppol test network, submission idempotency, Invoice Response events
mapped to our contract, sending evidence and Danish legal-entity identifiers. **Digisense** is the
candidate for the next route, because it alone of the three reaches Nemhandel and OIOUBL receivers;
its lack of documented idempotency and response events must be resolved first. Both choices are
conditional on sandbox access, commercial terms, a data-processing agreement, and the auditor approval
that Nemhandel requires of businesses using a third-party access point (D4). If Storecove's terms or
sandbox fail, the contract lets Digisense or another Peppol access point replace it without changing
OSS domain code.

Mapping of Storecove events to the contract: `succeeded` → `transport_delivered`; `failed` →
`transport_failed` (not retryable); `no_action_taken` → `transport_no_route`; Invoice Response events
→ `receiver_response` with codes `AB`, `IP`, `UQ`, `CA`, `RE`, `AP`, `PD`; HTTP timeout on submission →
`submission_outcome_unknown`, then reconcile by `idempotencyGuid`.

Mapping for Digisense, for the later route: `queued-for-delivery` → `submitted`; `delivered` →
`transport_delivered`; `document-not-valid` → `transport_failed` (not retryable); `unable-to-deliver` →
`transport_no_route` after a lookup confirms the receiver is missing, else `transport_failed`;
`temporary-upstream-error` → `transport_failed` (retryable); `unknown-server-error` or a timeout →
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
2. Look up `0088:5798009811639` (Nemhandel demo GLN, which accepts all profiles) or the provider's
   Peppol test receiver for the BIS Billing invoice and credit-note document types.
3. Submit the validated `dk-public-gln-invoice` fixture with an idempotency key. Record transport
   status and evidence.
4. Repeat the submission with the same key: expect no second delivery.
5. Submit the credit note referencing it.
6. Submit a document that fails Danish rules (the payment-means negative control): expect a provider
   rejection before transport, mapped to `transport_failed`.
7. Look up and attempt a receiver with no Peppol registration: expect `no_route`.
8. Simulate or trigger Invoice Responses `AB`, `UQ`, `RE`, `AP`; replay one late and one duplicate.
9. Kill the connection during a submission and reconcile it from the provider's records.

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
- **Status:** webhooks with signature verification, plus polling for reconciliation; webhook delivery
  identifiers are the deduplication key.
- **Retry:** only on provider-declared temporary failures, with the schedule above and the same
  idempotency key; uncertain outcomes are reconciled, never resent.
- **UI:** the send option appears only when the capability is on and the lookup says `reachable`;
  otherwise email remains the delivery method and the reason is shown.
- **Buyer reference:** an explicit buyer-reference field is added before public-authority sending is
  offered.
- **Bookkeeping:** e-invoiced documents remain excluded from bookkeeping claims until the e-invoice gap
  in the boundary decision is answered.

## Reproducing the evidence

1. Download `PEPPOL_DK_CIUS_2026-08-03_v1.17.0.ff275f9.zip` from ERST's repository and check its
   SHA-256 against D7 above.
2. Render fixtures with the checkout's own builder, `buildUblDocument` from
   `apps/oss/src/lib/exports/ubl.ts`, for the four documents in the validation table.
3. Run each `Schematron/*-UBL.xslt` (CEN, PEPPOL, DK) with an XSLT 3.0 processor such as SaxonC-HE and
   count `svrl:failed-assert` elements with `flag="fatal"`.
4. Look up receivers with `GET https://api.nemhandel.dk/nemhandel-api/search/lookup/{cvr}`
   (production) or `https://api-demo.nemhandel.dk/...` (demo). No authentication is needed. Keep the
   request rate low.
