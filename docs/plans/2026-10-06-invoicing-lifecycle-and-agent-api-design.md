# Invoicing Lifecycle, Domain Core, and Agent API Design

Status: approved for implementation (2026-10-06)

## Summary

YAIP handles the front half of invoicing well (drafting, sending, public pay/quote links) but stops once an
invoice is sent. This design adds the back half of the lifecycle and makes YAIP operable by AI agents:

1. Credit notes
2. Payment records with partial payments
3. Overdue automation and payment reminders
4. Recurring invoices
5. E-invoice export (Peppol BIS Billing 3.0 / UBL 2.1)
6. Accounting export and an audit log
7. An agent API (MCP) with approval-gated mutations

All seven share one foundation: a **domain core** that every caller (tRPC UI, MCP agents, cron, Stripe
webhooks) goes through. The structure borrows from T3 Code's orchestration model: typed contracts,
commands with client request ids, a pure decider, an append-only event log, runtime permission modes,
pending approval requests, and async command status with wait semantics.

## Problems in the current code

- **No server-side role enforcement.** `orgProcedure` only checks for an active organization. The
  read-only `accountant` role can create, send, and delete documents through tRPC.
- **No way to correct a sent invoice.** Only drafts can be deleted, and there are no credit notes.
- **Binary payment state.** `markPaid` flips a flag; there is no amount, date, method, or history.
- **Overdue is manual.** `/api/cron/mark-overdue` exists but self-hosters have nothing calling it, and no
  reminders are sent.
- **Fat routers.** `invoices.ts` and `quotes.ts` are ~900 lines each, duplicating numbering, snapshotting,
  compliance, totals, and email-sending logic between invoices and quotes.
- **No audit trail.** State changes overwrite columns; there is no record of who did what.

## Non-goals

- Replacing TanStack Start, tRPC, Prisma, Better Auth, or Tailwind.
- Full event sourcing. Documents stay as state rows; events are written alongside state in the same
  transaction and are the audit log and activity feed, not the source of truth.
- Peppol network transmission, reminder delivery infrastructure, and accounting-system integrations
  (e-conomic, Dinero). Those are hosted capabilities behind runtime extensions; OSS ships file exports.

## Architecture

### Domain core (`apps/oss/src/domain`)

```
domain/
  actor.ts              Actor = user | agent | system
  authorization.ts      command -> permission statement; role and agent-scope checks
  commands/             command contracts (zod, from @yaip/contracts) + handlers
  deciders/             pure functions: (state, command, now) -> Either<DomainError, DomainEvent[]>
  events.ts             DomainEvent union + persistence
  execute.ts            executeCommand pipeline
  services/             Effect services: Database, Clock, Mailer, Numbering, Jobs
  queries/              read models for UI and agents
```

`executeCommand(actor, command, { clientRequestId })` runs this pipeline:

1. **Authorize.** Map the command to a permission statement (`invoice:send`, `payment:create`, ...).
   Users are checked against their organization role. Agents are checked against their key's scopes and
   the role of the user who created the key, whichever is narrower.
2. **Deduplicate.** If a `CommandReceipt` exists for `(organizationId, actorKey, clientRequestId)`, return
   its stored result. Retries never repeat side effects.
3. **Gate.** If the actor is an agent in `approval_required` mode and the command is outward-facing
   (sends email, issues a credit note, records or voids a payment, activates a recurring schedule),
   store it as an `ApprovalRequest` and return `{ status: "awaiting_approval" }`.
4. **Decide.** Load state, run the pure decider, get events or a typed `DomainError`.
5. **Commit.** In one transaction: apply state changes, append `DomainEvent` rows (with actor), write the
   receipt, and enqueue follow-up `Job`s (email delivery) in an outbox.
6. **Dispatch.** Jobs run immediately after commit when possible, and are swept by the scheduler tick
   otherwise, so a crashed request never loses an email.

Commands never call the email provider. A sending command renders the exact message, marks the
document's last email attempt `sending` (which freezes a draft), and stores the message with its
provider idempotency key in an `email.deliver` job. The job settles the document:

- **Delivered:** the provider accepted it, so the document becomes sent (or the attempt is recorded
  as sent for a resend).
- **Rejected:** the provider refused the only request ever made, so nothing was delivered. The attempt
  is recorded as failed and the draft can be edited again.
- **Unconfirmed:** some request ended without an answer (a timeout, a lost response, an outage, a
  runner that stopped) and no later request confirmed it. The customer may have the email, so the
  document is issued but its attempt is marked unconfirmed, and it is never reopened. A refusal
  after an unanswered request is unconfirmed too, because it proves only that the last request
  delivered nothing.
- **Withdrawn:** the email is no longer wanted before any request was made (a reminder for an
  invoice that was paid meanwhile).

Unanswered requests are retried with the identical stored message under the same key, so the
provider drops a duplicate, but only while the provider still honors the key (24 hours). The
provider's acceptance is recorded on the job before the document is settled, so a failed
settlement never sends again, and a scheduler sweep settles deliveries whose job died. Each
delivery's outcome is stored on its job, and callers report that outcome, not the document's
current state, which a later attempt may already have changed.

Settlement is conditional on the document still showing that delivery's `sending` marker, so a
delivery can never settle a newer attempt. A delivered or unconfirmed document is
never edited again, and a document only reopens when nothing can have reached the customer.
Revised after review rounds 3 and 4.

Deciders are pure and unit-tested without a database. Handlers are Effect programs over `Database`,
`Clock`, `Mailer`, and `Numbering` services, wired with Layers and run through a `ManagedRuntime`.
tRPC routers become thin adapters: parse input, build the actor, call `executeCommand` or a query.

### Actors and permission modes

```ts
type Actor =
  | { kind: "user"; userId: string; role: "admin" | "member" | "accountant" }
  | { kind: "agent"; agentKeyId: string; mode: AgentMode; scopes: Permission[]; ownerUserId: string }
  | { kind: "system"; reason: "scheduler" | "stripe_webhook" | "recurring" }

type AgentMode = "read_only" | "approval_required" | "full_access"
```

The modes mirror T3 Code runtime modes. The default is `approval_required`: agents can read everything in
scope and create or edit drafts freely, but anything that leaves the system or changes money waits for a
human.

### Event log and audit trail

`DomainEvent` rows carry `organizationId`, a per-organization monotonic `sequence`, `aggregateType`,
`aggregateId`, `type`, `payload`, `actor`, and `occurredAt`. The sequence gives agents and the UI a cursor
(`afterSequence`), the same way T3 thread reads page with `afterPosition`. The document detail pages show
the per-document activity, and settings show the organization audit log.

### Scheduler tick

`/api/cron/tick` (Bearer `CRON_SECRET`) runs, idempotently and in order: mark overdue, schedule and send
due reminders, generate due recurring invoices, and sweep pending jobs. `/api/cron/mark-overdue` stays as
an alias. `docker-compose.yml` gains a small scheduler service that calls the tick every five minutes, so
self-hosted installs get automation without extra setup. Hosted deployments call the same endpoint from
their own scheduler.

## Features

### Credit notes

- `CreditNote` and `CreditNoteItem`, own number series (`creditNotePrefix` default `CN`).
- Credit an issued invoice fully (copies all lines) or partially (chosen lines/quantities or an amount),
  with a required reason. Total credited can never exceed the invoice total.
- Issuing a credit note snapshots seller and buyer, renders a PDF, and can be emailed.
- Invoice gains `amountCredited`; a fully credited invoice gets status `credited`.

### Payments

- `Payment`: amount, currency, `paidAt`, method (`bank_transfer`, `card`, `cash`, `stripe`, `other`),
  reference, note, source actor, optional Stripe ids, `voidedAt` and `voidReason`.
- Invoice gains `amountPaid`; `paymentStatus` becomes `unpaid | partially_paid | paid`.
  `balanceDue = totalGross - amountPaid - amountCredited`.
- Stripe webhooks record a `Payment` for `amount_total` instead of flipping a flag, keyed by checkout
  session id so redelivered webhooks are no-ops.
- `markPaid` remains as a shortcut that records a payment for the remaining balance.

### Reminders

- `OrgSettings.reminderPolicy`: `{ enabled, offsetsDays: number[] }`, default disabled with
  `[-3, 7, 14]` (3 days before due, then 7 and 14 days after).
- `InvoiceReminder(invoiceId, offsetDays)` is unique, so each reminder is sent at most once.
- Reminder emails include the balance due and the public pay link. Paid, credited, or draft invoices
  never get reminders. Per-invoice opt-out via `remindersPaused`.

### Recurring invoices

- `RecurringInvoice` template: contact, line items, tax rate, currency, notes, cadence
  (`interval` + `unit`: week, month, year), `nextRunAt`, optional `endsAt` or `remainingRuns`,
  `autoSend`, and `status` (`active | paused | ended`).
- The tick generates invoices for due schedules and either sends them or leaves drafts.
- Generated invoices link back through `recurringInvoiceId`. Each run is keyed by
  `(recurringInvoiceId, runDate)` so a retried tick never creates duplicates.

### E-invoice export

- Generate Peppol BIS Billing 3.0 UBL 2.1 XML for issued invoices (`Invoice`) and credit notes
  (`CreditNote`), downloadable from the document page and through the agent API.
- Contacts gain an optional electronic address (`peppolEndpointId`, `peppolEndpointScheme`).
- The export validates required BIS fields and returns a list of missing data instead of producing an
  invalid file. Network transmission is a hosted runtime extension.

### Accounting export

- CSV export of invoices, credit notes, and payments for a date range, using stable column contracts
  defined in `@yaip/contracts/exports`. Available to admins and accountants.

## Agent API

### Credentials

`AgentKey`: organization, name, `mode`, `scopes`, `createdByUserId`, secret hash (SHA-256), display
prefix (`yaip_ak_xxxx`), `lastUsedAt`, `expiresAt`, `revokedAt`. Admins manage keys in settings. The
secret is shown once.

### Transport

`/api/mcp` serves the Model Context Protocol over Streamable HTTP using
`@modelcontextprotocol/sdk`, authenticated with `Authorization: Bearer yaip_ak_...`. Tool inputs and
outputs are defined as zod schemas in `@yaip/contracts/agent`; MCP JSON schemas are generated from them,
so the API surface is a typed contract like T3 Code's.

### Tools

| Tool | Purpose | Gated in `approval_required` |
| --- | --- | --- |
| `organization_read` | Settings summary, currency, tax regime, reminder policy | no |
| `contacts_list`, `contact_get`, `contact_upsert` | Customers | no |
| `invoices_list`, `invoice_get` | Read invoices with balance and activity | no |
| `invoice_create_draft`, `invoice_update_draft` | Draft work | no |
| `invoice_send` | Issue and email | yes |
| `payment_record`, `payment_void` | Money in | yes |
| `credit_note_create` | Credit an invoice | yes |
| `quotes_list`, `quote_get`, `quote_create_draft`, `quote_send` | Quotes | send only |
| `recurring_list`, `recurring_upsert`, `recurring_set_status` | Schedules | activation only |
| `activity_read` | Event log page after a sequence cursor | no |
| `command_status`, `command_wait` | Poll or wait (≤ 30s) on a command | no |
| `export_einvoice`, `export_accounting` | File exports | no |

Every mutating tool requires a `clientRequestId`. Every mutation returns a command record:

```json
{ "commandId": "...", "status": "completed | awaiting_approval | rejected | failed", "result": {}, "error": null }
```

### Approval inbox

Pending `ApprovalRequest`s appear in an **Approvals** page with the agent, the command, a readable
summary, and approve and reject actions. Approving executes the stored command as the agent, with the
approving user recorded on the events. Requests expire after 7 days.

## Permissions

The access-control statement grows:

```
invoice:     create read update delete send
quote:       create read update delete send
creditNote:  create read send
payment:     create read void
recurring:   create read update
contact:     create read update delete
settings:    read update
agent:       create read revoke
export:      read
audit:       read
```

`accountant` gets read on everything plus `export:read` and `audit:read`. `member` cannot void payments,
manage agents, or update settings. All tRPC procedures declare their permission.

## Modernization scope

- Routers become adapters over the domain core. Invoice, quote, and credit note creation share one
  document pipeline: numbering, snapshots, compliance, totals.
- Shared contracts move into `@yaip/contracts` (`documents`, `payments`, `agent`, `exports`).
- Effect for all new server code and for the code it replaces (email delivery, numbering, document
  pipeline).
- Large route components (`settings.tsx`, invoice and quote detail) are split into feature components
  as they are touched.
- The published `@yaip/oss` exports stay unchanged.

## Data model changes

One migration adds: `CreditNote`, `CreditNoteItem`, `Payment`, `InvoiceReminder`, `RecurringInvoice`,
`DomainEvent`, `CommandReceipt`, `ApprovalRequest`, `AgentKey`, `Job`; columns on `Invoice`
(`amountPaid`, `amountCredited`, `remindersPaused`, `recurringInvoiceId`), `OrgSettings`
(`creditNotePrefix`, `creditNoteNextNum`, `reminderPolicy`), and `Contact` (`peppolEndpointId`,
`peppolEndpointScheme`). A data step backfills `Payment` rows for invoices already marked paid.

## OSS/cloud boundary

Everything above ships in OSS. Runtime extension points are added for hosted capabilities: Peppol
transmission (`einvoice.transmit`), managed reminder delivery, and accounting integrations. Self-hosting
gets the full lifecycle with file exports and the bundled scheduler.

## Verification

- Pure decider tests for every command.
- Integration tests per feature against Postgres (credit, partial payment, reminder idempotency,
  recurring generation, idempotent command receipts, approval flow, permission denials).
- MCP tests that drive the endpoint with the SDK client.
- UBL output checked against Peppol BIS required fields.
- Playwright coverage for credit note, payment recording, and approval inbox flows.
