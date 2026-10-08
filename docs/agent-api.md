# Agent API (MCP)

Quits exposes an [MCP](https://modelcontextprotocol.io) server so AI agents such as Claude can read
your invoicing data, draft documents, and send them with a human in the loop. Every agent call goes
through the same domain core as the UI, so role checks, idempotency, approvals, and the audit log
behave the same for people and agents.

- Endpoint: `POST https://<your-quits-host>/api/mcp`
- Transport: Streamable HTTP, stateless, JSON responses (no sessions, no server-sent events)
- Authentication: `Authorization: Bearer quits_ak_...`

## Create an agent key

1. Open **Settings** and find **Agent keys** (visible to roles with `agent:read`; admins by default).
2. Choose **New agent key**, give it a name, and start from a preset:
   - **Read-only bookkeeper**: `read_only` mode, read scopes only.
   - **Drafting assistant**: `approval_required` mode, can create contacts and drafts; sends,
     credit notes, and payments wait for approval.
   - **Full access**: `full_access` mode with every scope you hold.
3. Optionally adjust the mode, pick individual scopes, and set an expiry.
4. Copy the secret. It is shown once; Quits stores only a SHA-256 hash. If you lose it, revoke the
   key and create a new one.

A key never exceeds the person who created it: its effective permissions are its scopes intersected
with the creator's current role. If the creator leaves the organization the key stops working.
Revoking a key takes effect immediately and expires its pending approval requests.

## Connect a client

### Claude Code

```sh
claude mcp add --transport http quits https://<your-quits-host>/api/mcp \
  --header "Authorization: Bearer quits_ak_..."
```

### Claude Desktop and other MCP clients

Clients that support remote Streamable HTTP servers with custom headers take a config like:

```json
{
  "mcpServers": {
    "quits": {
      "type": "http",
      "url": "https://<your-quits-host>/api/mcp",
      "headers": { "Authorization": "Bearer quits_ak_..." }
    }
  }
}
```

Clients that only speak stdio can use a bridge such as
`npx mcp-remote https://<your-quits-host>/api/mcp --header "Authorization: Bearer quits_ak_..."`.

The server is stateless: `GET` and `DELETE` return `405`, which MCP clients treat as "no
server-initiated stream". Requests without a valid key get `401` with a JSON-RPC error explaining why
(missing, invalid, revoked, or expired key).

## Modes

| Mode | Reads | Drafts and edits | Outward-facing commands |
| --- | --- | --- | --- |
| `read_only` | yes | no (command tools are hidden) | no |
| `approval_required` (default) | yes | yes | queued for a person |
| `full_access` | yes | yes | yes |

Outward-facing commands are the ones that leave Quits or move money: sending and emailing documents,
issuing credit notes, recording or voiding payments, and activating recurring schedules. Every
command tool's description says whether it is outward-facing.

## Invoice dates and frozen evidence

The invoice's top-level `dueDate` is authoritative. It is a calendar date stored
at UTC midnight; read its UTC date without converting it to a local timezone.
`issuanceSnapshot` is the frozen issuance record, not the current invoice state.
For invoices affected by the historical timezone bug, `issuanceSnapshot.dueDate`
may be one day earlier than the authoritative `dueDate`. The snapshot, the
`invoice.issued` event and stored PDF/UBL artifacts remain unchanged as evidence.

## Commands, idempotency, and approvals

Every command tool requires a `clientRequestId` that the agent chooses (a UUID works). Quits stores a
receipt per `(agent key, clientRequestId)`: calling again with the same id returns the first outcome
instead of running the command twice, so agents can retry safely after timeouts.

Command tools return a command record:

```json
{
  "commandId": "cmd_...",
  "commandType": "invoice.send",
  "status": "completed | awaiting_approval | rejected | expired | failed",
  "result": {},
  "error": { "tag": "InvalidState", "message": "Only draft invoices can be sent", "code": "not_draft" },
  "approvalRequestId": "..."
}
```

With an `approval_required` key, an outward-facing command returns `awaiting_approval`. It appears in
the **Approvals** page with the agent, a readable summary (for example "Send invoice INV-0042
(1,250.00 DKK) to billing@acme.dk"), the key facts of the document, and the stored input. Anyone
holding the command's permission (for example `invoice:send`) can approve or reject it with an
optional note. Approving runs the stored command as the agent and records the approver on the
resulting events. Requests expire after 7 days.

Approval is bound to what the person reviewed. If the document changes after the request was queued
(for example the agent edits the draft or the customer's email address changes), approving fails with
`code: "changed_since_review"` instead of sending the changed document. Request approval again after
editing.

The agent follows the outcome with `command_wait` (blocks up to 30 seconds and returns
`{ command, timedOut }`) or `command_status`. Agents can only see their own commands. Do not resend
the command while it is awaiting approval; with the same `clientRequestId` a resend just returns the
same pending record.

Tool failures are returned as MCP tool errors with `{ "error": { "tag", "message", "code?",
"issues?" } }`. Tags: `Forbidden`, `NotFound`, `InvalidState`, `ValidationFailed`,
`ExternalFailure`, `InternalError`. Stack traces are never returned.

## Document numbers

Invoices and quotes are numbered when they are issued, not when the draft is created, so deleting a
draft never leaves a gap in the series.

> **Breaking for typed clients.** `number` on an invoice or quote changed from `string` to
> `string | null`. It is `null` while the document is a draft. A client generated from the previous
> schema, or one that assumes a non-empty string, must accept `null` before upgrading.

- `number` is set by `invoice_send` and `quote_send` (and by `invoice_send` for drafts created from
  deliverables, quotes or a recurring schedule). Read it from the tool's result or from
  `invoice_get` / `quote_get` afterwards.
- A draft created before this change already has a number and keeps it when it is sent. Such
  legacy drafts are issued with their old number, which is lower than the number the next new
  draft receives, so issue dates and numbers can be out of order across them.
- A draft whose email was refused after it took its number keeps that number for the retry.
- Deleting a draft that has a number leaves a gap in the series. It is recorded as a
  `document.number_voided` event with `reason: "draft_deleted"` and shows in the activity log.
- Do not guess or reserve the next number. The `invoice_send` approval summary names a draft as
  "draft invoice"; the number it receives is only known once it is sent.
- `quote_convert_to_invoice` and `quote.invoices[].number` can also be `null` for the same reason.
- The field name is unchanged, so clients that treat `number` as an opaque string only need to
  accept `null` for drafts.
- If many documents are issued at once, a send can fail with `ExternalFailure` and code
  `number_contention` after several attempts. Nothing was changed; call the tool again with the
  same `clientRequestId`.
- Event payloads were widened accordingly. `number` can now be `null` in `invoice.draft_created`,
  `invoice.draft_deleted`, `quote.draft_created`, `quote.draft_deleted` and
  `recurring.invoice_generated`, and `invoiceNumber` in `quote.converted`. `document.number_voided`
  can name a `quote` and can omit `reservationId`. Consumers of these events must accept both.

Rolling this change back is covered in [number-at-issuance-rollback.md](number-at-issuance-rollback.md).

## Tools

Tools are listed per key: an agent only sees tools whose scope it holds, and read-only keys never see
command tools. Money is returned as numbers in the document currency; dates are ISO 8601 strings.

| Tool | Kind | Scope | Notes |
| --- | --- | --- | --- |
| `organization_read` | query | `settings:read` | Company, currency, locale, tax regime, `pricesIncludeTax`, and the key's mode and scopes. Call first. |
| `contacts_list` | query | `contact:read` | `search` (name, email, company), `limit`, `cursor` |
| `contact_get` | query | `contact:read` | `id` |
| `contact_create` | command | `contact:create` | Contact fields + `clientRequestId` |
| `contact_update` | command | `contact:update` | `id`, changed fields + `clientRequestId` |
| `invoices_list` | query | `invoice:read` | `status`, `paymentStatus`, `contactId`, `limit`, `cursor`; includes `amountPaid`, `amountCredited`, `balanceDue` |
| `invoice_get` | query | `invoice:read` | `id`; includes line items and public payment link |
| `invoice_create_draft` | command | `invoice:create` | `contactId`, `dueDate`, `items`, `taxRate`, `currency?`, `notes?`; the draft's `number` is `null` until it is sent |
| `invoice_update_draft` | command | `invoice:update` | `id`, `expectedRevision?` + changed fields; `items` replaces all lines and each line accepts `key?` |
| `invoice_send` | command, outward-facing | `invoice:send` | `id`, `allowSendWithoutEmail?`; assigns the invoice number |
| `invoice_resend_email` | command, outward-facing | `invoice:send` | `id` |
| `quotes_list` | query | `quote:read` | `status`, `contactId`, `limit`, `cursor` |
| `quote_get` | query | `quote:read` | `id`; includes line items and linked invoices |
| `quote_create_draft` | command | `quote:create` | `contactId`, `expiryDate`, `items`, `taxRate`, `currency?`, `notes?`; the draft's `number` is `null` until it is sent |
| `quote_update_draft` | command | `quote:update` | `id`, `expectedRevision?` + changed fields; `items` replaces all lines and each line accepts `key?` |
| `quote_send` | command, outward-facing | `quote:send` | `id`, `allowSendWithoutEmail?`; assigns the quote number |
| `quote_resend_email` | command, outward-facing | `quote:send` | `id` |
| `quote_convert_to_invoice` | command | `invoice:create` | `id` of an accepted quote; creates a draft invoice |
| `payments_list` | query | `payment:read` | `invoiceId`; payments (incl. voided) and `balanceDue` |
| `payment_record` | command, outward-facing | `payment:create` | `invoiceId`, `amount`, `paidAt` (YYYY-MM-DD), `method`, `reference?`, `note?` |
| `payment_void` | command, outward-facing | `payment:void` | `paymentId`, `reason` |
| `credit_notes_list` | query | `creditNote:read` | `invoiceId?`, `limit`, `cursor` |
| `credit_note_get` | query | `creditNote:read` | `id` |
| `credit_note_issue` | command, outward-facing | `creditNote:create` | `invoiceId`, `reason`, `mode` (`full`, `lines` + `lines`, `amount` + `amount`) |
| `credit_note_send` | command, outward-facing | `creditNote:send` | `id` |
| `reminder_send_now` | command, outward-facing | `invoice:send` | `invoiceId` |
| `invoice_pause_reminders` | command | `invoice:update` | `invoiceId` |
| `invoice_resume_reminders` | command, outward-facing | `invoice:send` | `invoiceId`; the approval names the recipient and the next reminder |
| `recurring_list` | query | `recurring:read` | `status?`, `limit`, `cursor` |
| `recurring_create` | command | `recurring:create` | schedule fields; auto-sending schedules from approval-mode keys start paused |
| `recurring_update` | command | `recurring:update` | `id` + changed fields |
| `recurring_set_status` | command | `recurring:update` | `id`, `status` (`paused`, `ended`) |
| `recurring_resume` | command, outward-facing when the schedule auto-sends | `recurring:update` | `id` |
| `recurring_run_now` | command, outward-facing when the schedule auto-sends | `recurring:update` | `id` |
| `export_einvoice` | query | `invoice:read` (+ `creditNote:read` for credit notes) | `kind` (`invoice`, `creditNote`), `id`; Peppol UBL XML or the missing fields |
| `export_accounting` | query | `export:read` | `from`, `to` (YYYY-MM-DD), `dataset` (`invoices`, `creditNotes`, `payments`) |
| `activity_read` | query | `audit:read` | `afterSequence`, `aggregateType`, `aggregateId`, `limit`; page with `nextSequence` while `hasMore` |
| `command_status` | query | any write-mode key | `commandId` |
| `command_wait` | query | any write-mode key | `commandId`, `timeoutMs` (0-30000, default 15000) |

Tool input schemas are generated from the zod contracts in `@quits/contracts` (`agent`, `contacts`,
`invoices`), so the MCP schema always matches what the UI accepts.

List tools return `{ items, nextCursor }`. Pass `nextCursor` back as `cursor` to read the next page;
it is `null` on the last page.

## Security notes

- Keys are stored as SHA-256 hashes; the secret is shown once when the key is created.
- An agent never has more permissions than the person who created its key, now or later.
- Browsers are refused unless the request `Origin` is the app's own origin or listed in
  `QUITS_MCP_ALLOWED_ORIGINS` (comma-separated). CLI and desktop clients send no `Origin` and are not
  affected.

## A typical session

1. `organization_read` to learn the currency, tax regime, and mode.
2. `contacts_list { search: "Acme" }`, then `contact_create` if the customer does not exist.
3. `invoice_create_draft { contactId, dueDate, items, clientRequestId: "draft-acme-oct" }`.
4. `invoice_send { id, clientRequestId: "send-acme-oct" }` returns `awaiting_approval`.
5. A person approves it in **Approvals**.
6. `command_wait { commandId }` returns `status: "completed"` with the sent invoice.

## For developers: adding tools

Tools live in `apps/oss/src/domain/agent-tools/`. The registry (`registry.ts`) documents the steps:
write the domain command, then add one `defineCommandTool` or `defineQueryTool` entry in
`tools/<feature>.ts`. Command tools inherit the command's permission, `clientRequestId` handling,
and approval behaviour. End-to-end tests drive the endpoint with the MCP SDK client in
`domain/agent-tools/__tests__/mcp-endpoint.integration.test.ts`.

### Agreement drafts

Agreement drafting is available before sending. The tools are `agreement_list`, `agreement_get`,
`deliverable_list`, `agreement_template_list`, `agreement_create_draft`, `agreement_update_draft`,
`agreement_delete_draft`, and `deliverable_update`. Each uses its exact agreement or deliverable
permission. Template reads use `agreement:read`. Draft commands never require outward-facing
approval. They do not allocate an agreement number or send anything.

Dates are calendar dates (`YYYY-MM-DD`). Each agreement has one tax rate for all deliverables.
Deposits are lines included in the agreed total. Passing `deliverables` to an update replaces the
lines; omitting it preserves them. `deliverable_update` accepts only draft offer fields and the
expected date; fulfillment and billing transitions arrive in later releases. The included templates
are examples, not legal advice.

### Billing allocation

`agreement_get` and `deliverable_list` include an `allocation` for each deliverable: its state
(`unbilled`, `reserved`, `invoiced`, `partially_credited`, `credited`), the draft or invoice holding
it, credits tied to it and rebill decisions. `deliverable_release_reservation` (`invoice:update`)
takes reserved work out of its draft. Supply `expectedAllocation: { invoiceId, invoiceItemId, generation }`
from the reviewed holder and allocation. A changed allocation receives `allocation_changed`; refresh
before retrying. Missing identity is refused. Releasing the last line leaves an empty draft with
zero totals; issuing or sending it receives `empty_invoice` until a line is added.
`deliverable_authorize_rebill` is for a person: agents receive
`human_review_required`. A refusal such as `deliverable_reserved` carries structured `details`. See
[Billable work and reservations](billable-work.md).

The user-only `invoices.markPaid` and `invoices.undoMarkPaid` conveniences are deliberately absent
from the agent API, MCP tools and approval command registry. Agents use the existing payment
record/void commands and their approval flows. See [mark paid and undo](architecture/paid-moment.md).

`payment_record` accepts `method: "manual"` for a manually recorded payment, in addition to the
existing payment methods. Its permissions and approval flow are unchanged.

### Draft revisions and line keys

Invoice and quote drafts carry `editRevision`, initially `0`. Every draft edit increments it,
including notes-only edits, linked invoice edits, adding deliverables, and changing a draft payment
schedule to a sale. Pass `expectedRevision` on updates to refuse an outdated save with
`InvalidState` / `stale_draft`. Omitting it preserves the previous update behavior. A refused save
changes neither the document nor its revision and emits no draft-update event.

Invoice and quote create/update inputs, and recurring template create/update inputs, accept an
optional `key` on each line, a trimmed, non-empty client-generated string of up to 200 characters.
Keys must be unique within an `items` array, including keys inherited from linked invoice rows.
Reuse each key on later saves to retain line identity when database item IDs change. Stored rows
expose it as `clientKey`; notes-only edits preserve it. Linked rows still require their `id`
or `deliverableId` to identify the reserved work. Extra rows keep their keys when the linked writer
moves them after the reserved rows. Deliverable copies initially use the deliverable ID as their
key. Accepted quote conversion copies existing keys to the invoice.

The app's `invoices.view`, `quotes.view` and `creditNotes.view` queries return
`{ view, revision, canEdit, locks: { agreementLinked, emailSending }, historical, notices }`.
`revision` is the draft's `editRevision`; credit notes return `0`. `canEdit` requires a draft,
update permission, and no email in progress. An agreement link locks individual reserved lines,
not the whole draft. Unreadable stored VAT evidence becomes null in row-based views, with
`"invalid_vat_evidence"` in `notices`. Reading a view does not change the stored evidence.
Draft edits without explicit `vatEvidence` calculate with empty evidence when the stored evidence
is corrupt, preserving the stored value and notice until it is replaced. VAT treatments still come
from the lines and tax rate; issuance still validates evidence. Recurring generation instead returns
`InvalidState` / `invalid_vat_evidence` until the template evidence is repaired.

Issued invoices and credit notes read their money and parties from `issuanceSnapshot`, with
branding from the published issuance candidate. Issued snapshot views return `notices: []`.
If the snapshot is missing, incomplete or corrupt,
`historical: true` tells the future UI to show a historical-document notice. The fallback preserves
stored line amounts and document totals without repricing. Missing historical branding stays null.
Credit-note correction dates come only from the corrected invoice's snapshot, or are null.

Quotes have no issued money snapshot. Once a quote is no longer a draft, its view has
`state: "issued"` and all stored lines are locked. It retains the rows' amounts and the frozen
seller and buyer snapshots, uses settings for phone and logo, and has `historical: false`.
