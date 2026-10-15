# Accounting integrations

QUI-77 includes pure e-conomic and Dinero payload preparation, persisted encrypted
connections and scheduled delivery through injectable adapters. There is no live
transport or UI yet. It is available to the self-hostable runtime without hosted gates.
Billy follows e-conomic and Dinero.

## Provider boundary

`AccountingProvider<Settings, Payload>` in `domain/accounting/provider.ts` accepts
a versioned money event, its stable outbox delivery ID and resolved settings.
It returns a prepared payload with expected decimal totals, or an explicit refusal.
The adapter never reads current document rows, recalculates historical prices or
owns transport. The delivery step handles request state; live authorization and
multi-operation remote bookkeeping remain follow-ups.

Use `invoice.issued` v1 and postable `credit_note.issued` v2, not email or cumulative
paid notifications. `postingsFor` validates frozen evidence, equations and base
valuation first. Credits reverse historical amounts; sparse legacy credits and
unsupported applications remain refused. Payment receipts currently use
`payment.recorded` v1. Their payload lacks frozen payment date, base valuation and
settlement detail, so delivery needs a richer money event before it can be safe.
Dinero's pure payment mapper requires that missing evidence as explicit resolved
input; it does not authorize delivery of legacy receipts by themselves.

## Entry mapping

Accounts and VAT codes come from each organization's chart, never fixed account
numbers. Resolve by the complete frozen VAT group key, including treatment,
reason, rate and country. Zero tax alone does not select a VAT code.

| Quits event | e-conomic | Dinero | Accounting effect |
| --- | --- | --- | --- |
| Invoice issued | Create `/invoices/drafts`, then book `/invoices/booked` | Create `/invoices`, then `/{guid}/book` | Debit customer receivable; credit sales net and output VAT |
| Credit note | Negative-quantity draft, then book; retain corrected invoice link in local delivery metadata | `/sales/creditnotes`, with `CreditNoteFor`, then book | Debit original sales/VAT; credit receivable |
| Payment received | Journal `customerPayments`, customer/invoice reference and bank/clearing contra account | Invoice `/{guid}/payments`, `DepositAccountNumber` | Debit bank/clearing; credit customer receivable; no new sales VAT |

For e-conomic, the mapped product's product group selects the sales account for
the recipient VAT zone; that account's `vatAccount.vatCode` determines tax. The
customer group supplies the receivable contra account. Validate these remote
relationships before enabling delivery. No sales-account or VAT-code fields are
invented on invoice lines. In Dinero, select each product line's `AccountNumber`
from the entry accounts and their VAT types. Resolve deposit accounts separately.

25% Danish moms maps to a domestic sales account with 25% output VAT. EU B2B
services map to an EU services sales account with the corresponding zero-tax
reporting treatment and VAT zone, backed by frozen VAT-ID/VIES evidence. EU goods
need their own mapping. Domestic reverse charge and other zero-tax classifications
remain subject to the ledger's existing refusals. Credits retain the original
mapping revision. Fees, refunds, overpayments and FX need separate posting policy;
never treat a net settlement as a gross customer payment.

Slice 1 accepts same-currency DKK v2 sales/credits with 25% or intra-community VAT.
Each line uses quantity 1 and its frozen net as unit price, with negative quantity
for credits. Line order and descriptions survive. Refuse mixed VAT zones,
unrepresentable JSON money, rounding differences or missing mappings. Shared
Decimal pricing helpers check money before conversion to API numbers. The worker
must compare remote draft net, VAT and gross with `expectedTotals` before booking.
`economicBookingPayload` wraps the persisted draft number with `sendBy: none`.
Creation and booking are separate requests; mapping cannot produce a booked ID.
Keep Quits' document number in `references.other`; e-conomic assigns its own number.

### Dinero differences

`dineroProvider` returns a relative `path` and request `body`. It accepts the same
DKK v2 invoice/credit subset and uses the shared Decimal money boundary. Each
frozen VAT group resolves to an entry `AccountNumber`, whose remote VAT type must
match the treatment before delivery. Unlike e-conomic's recipient-wide VAT zone,
Dinero selects tax through each line's account. Lines use frozen net as
`BaseAmountValue`, `Quantity: 1`, `Discount: 0` and `ShowLinesInclVat: false`.
The dedicated `/sales/creditnotes` endpoint reverses positive lines; do not send
negative quantities too. `CreditNoteFor` requires the corrected invoice's booked
GUID from `invoiceLinks`, keyed by Quits invoice ID. Compare credit draft totals
by magnitude against the negative accounting `expectedTotals` before booking.

Invoice terms use `PaymentConditionType: Netto` and the UTC calendar-day difference
between frozen issue/due dates. Refuse earlier due dates. Credits omit payment
terms. Persist the caller-supplied stable document `Guid` before creation, use the
delivery ID as `ExternalReference`, and retain the Quits number in `Comment`.
`dineroBookingPayload` returns the server's version `Timestamp`; it is not a date.
Dinero may assign its own voucher number. Booking stays a separate operation.

Payment preparation accepts `payment.recorded` v1 only with matching payment ID
and invoice number in immutable `settings.payment` evidence. Require a frozen
`paymentDate`, equal DKK `baseAmount`, explicit `gross_no_fees` settlement, booked
invoice GUID, current server version timestamp and resolved deposit account.
Never fill missing evidence from today's date or mutable document rows. Refuse
missing evidence, FX, fees, refunds and overpayments. The request uses the gross
event amount, `RemainderIsFee: false`, and no foreign-currency amount. Payment
`expectedTotals` has zero net revenue/tax and the received amount as gross cash.
A partial receipt leaves the invoice remainder open. Delivery still needs a
richer frozen payment event and reconciliation; no event schema changes here.

## Outbox, idempotency and retries

Reuse `events/consumers.ts` and `EventConsumerDelivery`, scoped by organization and
a connection-specific consumer key. Use delivery ID plus a stable operation suffix
for each remote effect, such as `:draft` and `:book`. Persist the exact prepared
payload, mapping revision and remote draft/booked references before advancing.
These operation records are follow-up schema work, not fields the outbox has today.

e-conomic's `Idempotency-Key` cache lasts one hour. After an uncertain response,
reconcile the stable remote reference before retrying, especially beyond that
window. Dinero allows a supplied document `Guid` and `ExternalReference`; persist
and look up those identities, without assuming uniqueness of free-text references.
Do not blindly repeat payment creation after an uncertain response.

Claim with leases and fence completion with `claimToken`. Retry transient network,
429 and server failures with bounded exponential backoff and jitter, respecting
Retry-After. Stop for authorization, mapping or validation failures. Existing failed
rows require an explicit requeue policy. Keep invoice-before-credit/payment
dependencies; claiming by sequence alone does not enforce them. Only done/skipped
deliveries advance the contiguous acknowledgement cursor. A refusal stays visible
as failed until corrected or explicitly skipped with an audit reason.

## Injectable delivery step

`domain/accounting/delivery.ts` exposes `deliverAccounting`. Callers supply an
`AccountingConnections` lookup and `AccountingTransport`. `accountingConnections`
implements the persisted lookup; transport remains injectable. A missing or
disconnected connection pauses without scanning. Connection keys identify immutable remote-account
generations, and settings must supply frozen event-specific evidence. The lookup
selects the existing pure adapter and converts its prepared result to a relative
HTTP path/body. No credentials may enter that stored request.

The step reuses `EventConsumerDelivery`, uniquely scoped to organization,
connection and event sequence. Its stored request also records the event ID,
mapping revision, expected totals and stable `:request` idempotency key. `pending`,
`done` and `failed` mean pending, delivered and failed; `claimed` is a leased
attempt. Errors contain safe codes, never raw transport responses. The migration
adds pinned request JSON and retry availability to this existing table.

One call processes at most one event. Failed, leased and delayed predecessors
block later requests. Transient transport, 429 and server failures retry with
exponential backoff, jitter and Retry-After, for at most five HTTP sends. Lease
recovery may add reconciliation attempts. Every
replay requires transport reconciliation to prove delivery or authoritative
absence, including in-flight requests; an unknown result fails visibly without
resending. Lease tokens fence persistence and completion.

Delivered means the single prepared draft/payment request was accepted, not that
sales were booked. Draft total validation, booking, remote relationship validation
and provider-specific reconciliation are required before enabling a live worker.
Legacy payments without immutable evidence remain refused. Failed rows have no
automatic requeue or skip policy in this slice.

## Per-organization connections

`AccountingConnection` stores one provider, remote account ID, generation, status,
mapping revision and encrypted credential per organization. `connectAccounting`
encrypts before writing with the existing server secret helper and starts a new
generation on each authorization. `disconnectAccounting` pauses delivery and
clears local credentials idempotently. The lookup selects the pure provider and
returns metadata without reading credentials. Remote revocation remains OAuth work.

`RuntimeServices.accountingDelivery` supplies the transport factory and immutable
event-specific settings resolver. Settings include customer links, layout, dueDate
payment term, product/VAT mappings, receivable and bank/clearing accounts. Requests
pin resolved settings for retries. Configuration remains server-only in this slice.

`scheduler-tasks.ts` registers accounting with the existing cron tick, after
recurring generation. It uses the scheduler's persisted organization claims and
budget, scopes discovery to connected organizations with credentials and processes
one event per organization. Without a configured runtime it returns disabled before
scanning or claiming events. Self-hosted and hosted runtimes use the same optional
interface. There are no default network calls or hosted gates.

Before enabling live delivery, add sync start positions and reconciliation across
connection generations so reconnecting cannot replay history automatically. Add
remote revocation through e-conomic's agreement-grant redirect and Dinero's Visma
Connect authorization code flow, with no pasted keys. Authenticated configuration
stays inside the app.

## Official references

- [e-conomic REST](https://restdocs.e-conomic.com/#post-invoices-drafts),
  [booking](https://restdocs.e-conomic.com/#post-invoices-booked),
  [product-group sales accounts](https://restdocs.e-conomic.com/#get-product-groups-productgroupnumber-sales-accounts),
  [idempotency](https://restdocs.e-conomic.com/#idempotency-tokens).
- [Dinero API reference](https://api.dinero.dk/openapi/index.html) and its
  [OpenAPI schema](https://api.dinero.dk/openapi/v1/swagger.json), including invoices,
  sales credit notes, entry/VAT/deposit accounts and payments. Slice 2 follows
  `InvoiceCreateModel`, `InvoiceLinesCreateModel`, `SalesCreditNoteCreateModel`,
  `PaymentCreateModel` and `BookModel` for the `/v1/{organizationId}/invoices`,
  `/sales/creditnotes`, `/invoices/{guid}/payments` and `/{guid}/book` operations.
- [Dinero authorization](https://developer.dinero.dk/documentation/authorization/)
  and [e-conomic connection flow](https://www.e-conomic.com/developer/connect).

## Follow-ups

- Richer frozen payment events with date, base valuation and settlement evidence.
- OAuth/agreement-grant authorization and remote revocation.
- Live transport/reconciliation, remote total checks, booking operation records,
  invoice dependency resolution, sync start positions and audited requeue/skip.
- Persisted settings resolution and live delivery safeguards before enabling transport.
- Settings UI for connection status, account/VAT mapping, failures and disconnect.
