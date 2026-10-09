# Operation history and delivery recovery

The operation history on an invoice, quote, agreement or credit note joins its command receipts,
completed document changes and email outbox. It shows the exact record, original recipient,
queue time, request times and provider reference when available. Older emails may have only a
job-run count because their individual request times were not recorded. Recovery and later
retries preserve that older count beside any newly recorded attempts, including when
never-submitted work receives a fresh run budget. The timestamp history may therefore be partial.
A job run is not proof of a provider request. Recorded attempt numbers count only the requests
with recorded timestamps; they do not imply a complete history.

A completed business command does not prove email delivery. Creation and email delivery have
separate outcomes. A provider acceptance means the provider accepted a submission, not that the
recipient read it or that it reached an inbox. If acceptance was stored but document settlement
failed, the history says that recording the document outcome still needs recovery.

## Choose the recovery step

- **Queued:** delivery is waiting for its job runner.
- **Waiting for a prerequisite:** check email configuration and document sending requirements.
  Recover the queued delivery if the action is available. A withdrawn delivery needs a new send
  from the same document page.
- **Failed step:** a provider refusal or stopped job needs attention. Recover the existing job
  only when the history offers that action. For a settled refusal, correct the requirements and
  send the same document from its page. Do not create a replacement invoice.
- **External outcome uncertain:** the customer may already have the email. Check with the
  recipient or provider. SMTP cannot deduplicate a second submission after possible acceptance.
  An original-key retry is offered only when the existing outbox policy proves it remains safe.
- **Provider acceptance confirmed:** submission is confirmed. If recording the document outcome
  is still pending, recovery settles the same job without contacting the provider again.

Recovering a job retains its command ID, message, provider, request count, idempotency key and
completion target. It does not replay creation or financial events. A job currently held by a
runner cannot be recovered manually. The scheduler first reclaims an expired runner lease.

## Verify an uncertain outcome

A distribution can supply the optional `EmailDeliveryStatusProvider` in `RuntimeServices`.
`supports(provider)` declares a trustworthy lookup for the pinned provider. `lookup` receives the
organization, original provider, original idempotency key and provider message ID if known. It
returns a stable evidence ID, observation time and either `accepted` or `unknown`. Acceptance
requires a provider message ID. Adapters must verify the identity of the original submission;
absence from a lookup must return `unknown`, never permission to resend.

Repeated evidence IDs do not produce duplicate events. Once acceptance is confirmed, delayed
unknown evidence cannot regress it. Normal reconciliation refuses rejected or withdrawn outcomes,
including pinned decisions whose settlement is incomplete; contradictory provider evidence requires
verification with the provider and cannot publish a retired candidate or issue an edited draft. A lookup that fails or returns unknown leaves the original
uncertainty in place. OSS does not add a provider lookup adapter or webhook here. Without one,
verify with the recipient or the provider's own logs before deciding whether another copy is needed.

## Explicit manual resend

An authorized person can review a manual resend of the latest uncertain document email. The form
requires a verification note and reason, and acknowledgement that the recipient might receive
both copies. It sends the stored email to its original recipient for the same issued document,
under a new communication identity. A separate `delivery.manual_resend_requested` event and
receipt record the decision, reason and original delivery ID. The original uncertain outcome
remains visible. Revoked public links cannot be replayed. Only one manual recovery is permitted per source delivery, and repeating the
same client request returns the same receipt.

Changing a contact's email alone does not rewrite the stored message. While its link remains
valid, the manual path still targets the shown original recipient. Verify that address before
resending; correcting the contact does not redirect this stored email.

When the earlier email's link has been revoked, the history offers **Review replacement with
current link**. Verify the uncertain delivery first, review the displayed current recipient,
record a reason and acknowledge the risk of another email. This renders the same issued
document through its normal sending checks with the current link. It retains the original
uncertainty, number, issue date and financial events. It does not create or issue a new document.

Both decisions bind the reviewed document revision, recipient and public-link version. The
server checks them again under document and contact locks. If any changes, refresh and review
the new target. A copied email retains its link version even if that new attempt is uncertain.
The new outbox job stores `manualReview` with the mode and reviewed target alongside its reason,
original delivery ID and decision command ID. The original decision event shape stays unchanged.

Ordinary send controls refuse a document whose last email is uncertain and direct the operator
to this documented path. Manual replay of reminders and agreement notifications is not offered;
use their supported document workflow after verification. Paid or closed invoices are not
eligible for replaying an earlier payment request.

Command receipts add a nullable `target` JSON field containing only `documentType` and
`documentId`. It links failed commands and approval waits that have no committed document
event. Existing receipts are joined through their domain events and outbox command IDs.
Successful UI commands now retain receipts even when callers did not supply a request ID.
These references cover only known document IDs. A creation that fails before a new document has
an ID cannot have a document journal yet. Direct receipt targets currently use the command name
and an `id` field, with explicit handling for delivery and reminder inputs. Commands with other
input shapes may have no direct target. For example, mark-paid and undo use `invoiceId`; their
completed receipts appear through invoice events, but their failed receipts have no direct
journal reference.

The journal requires the document's read permission and a record in the active organization.
Recovery additionally requires its send permission and a human actor. It does not expose stored
email bodies or raw command results. The view is bounded to the latest 200 document events, 100 command receipts and
100 deliveries. Older records remain in the existing activity log.

## Moderated recovery scenarios

These are a research protocol, not measured results. Recruit representative operators and run
sessions without explaining which action to choose. Record each participant's first choice,
completion time, assistance requests and explanation of duplicate-delivery risk.

1. Creation completed, submission never started: identify the exact invoice and recover delivery
   without creating another record.
2. Email configuration disappeared after queuing: distinguish a prerequisite from a provider
   refusal, restore configuration and recover the existing step.
3. SMTP disconnected after the message body: explain why the recipient may already have it,
   verify the outcome and choose whether a manual resend is justified.
4. Provider accepted, document settlement stopped: recover settlement without sending again.
5. Provider lookup is unresolved: retain uncertainty instead of interpreting missing evidence as
   a refusal. Repeat with late acceptance evidence followed by an older unknown result.
6. Manual resend after recipient verification: provide a reason, acknowledge duplicate risk and
   identify both communication attempts and the single underlying financial record.
7. Uncertain email followed by link revocation: choose the replacement with the current link,
   verify the displayed recipient and explain the duplicate risk. Repeat with a recipient or
   link change during review and check that a new review is required.

Report correct unaided recovery choices and correct risk identification as separate counts,
with participant count and scenario order. Keep failed or assisted attempts in the results.
Moderated sessions and production provider evidence remain outstanding until collected.
