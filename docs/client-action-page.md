# Client action page

One link that gathers what a customer may do about their work with you: review and decide an
agreement, sign off a delivered revision, pay an invoice, and download the final documents. It is
not a client account or a portal: there is no login, no history of other documents, and nothing
the link was not explicitly granted.

Create links on a contact's page (**Client action page**). The page a recipient opens is
`/c/<link>`.

## Grants

A link belongs to one contact in one organization and holds a list of **grants**, one per record.
A grant names the record and what the holder may do with it:

| Record      | Capabilities                                                              |
| ----------- | ------------------------------------------------------------------------- |
| Invoice     | `view` (read it, download its PDF), `pay` (pay the outstanding balance)   |
| Agreement   | `view` (read it, download its PDF), `approve` (accept or decline it)      |
| Deliverable | `view`, `approve` (accept a delivered revision or request changes)        |

- `view` is always included; paying or approving something the holder cannot read is refused.
- Paying and approving never imply each other. A finance contact holds `pay` on invoices and
  cannot accept an agreement or sign off a delivery, and the server refuses it even for a
  hand-made request. The creation form offers *Finance contact* and *Project approver* as
  starting points, not as roles stored anywhere.
- Authority is per record. Granting one invoice grants nothing about the contact's other invoices,
  other agreements, or any record of another contact or organization. Every read re-checks that
  the record belongs to the link's organization and contact.

## What the page shows

Only an explicit field list per record, never the stored row: no internal notes, cost rates,
acceptance evidence, IP addresses or unrelated project records. Each item shows its state:

- agreements: awaiting decision, accepted, declined, offer expired, closed;
- deliveries: awaiting sign-off, signed off, changes requested, review expired or unavailable;
- invoices: payment due, open, paid, credited (and overdue);
- an item the seller changed after the link was made shows as *access changed*, and one that is
  not in a state to show as *not available*, with no details.

Each page and record is shown in the language of the document itself, as the public invoice,
quote and agreement pages already do. Invoice payment reuses the existing Stripe Checkout
flow and always collects the remaining balance after payments and credit notes; there is no
buyer-chosen amount.

The seller's **Preview** renders the same page from the same builder, from the same grants, with
every button disabled. It is exactly what the recipient sees, and it never decides or pays anything.

## Expiry, revocation and recovery

The link is a reference to a database row, so each request is judged afresh:

- **Expiry**: one to 90 days (default 30). After it the page loads no record details.
- **Revoking** ends the link at once. It is final; make a new link instead.
- **Renewing** (expired or active links) sets a new expiry and moves every grant to the record's
  current state at the same address. A grant whose record can no longer be shared is dropped.

Each undecided delivery revision keeps the existing sign-off lifetime of 90 days from its
`deliveredAt` instant. The summary, detail and submission use that deadline, including refusal at
the exact expiry instant. Renewing a client page does not extend the delivery's review authority.
An expired review stays readable through a view grant, leaves the waiting count, and asks the
recipient to contact the seller to arrange a new review. Missing delivery dates show review
unavailable. Completed decisions keep their recorded state and the public command's replay
behavior after the deadline.

A link that expired or was revoked shows only the seller's name and *Ask {seller} to send you a new
link*. A link that never existed shows a generic invalid-link page.

If the seller revokes or re-issues an agreement's links (resending, recalling, closing or editing
the offer), grants on that agreement and its deliveries stop working until the link is renewed;
they show as *access changed*. This keeps "revoke all links" meaning every link.

## Forwarded links and verification

The link is a **bearer credential**: anyone who has it can open the page, read the granted
records and download their PDFs, and, if `pay` was granted, pay the invoice (paying is
harmless to the seller). Treat it like the public payment link.

Approving is stronger:

- **Deciding an agreement** is a signature, so it needs an identified signer. A link that can
  decide an agreement must be created with a recipient email and email verification. Before the
  first approval the page sends a six-digit code to that address; entering it opens a 12-hour
  verified browser session (an HttpOnly cookie that is never shared between links). A forwarded
  copy opens the page, but without access to the recipient's inbox it cannot approve anything.
  After a cookie expires, the next refused approval or page load restores the code form. A new
  code can be requested and verified in the same tab; server state determines whether approval
  controls are available.
- **Signing off a delivery** follows the link's setting. With verification on (the default when a
  link can approve anything) it needs the code too; with it off, sign-off is a bearer action, as
  the existing delivery sign-off link is.
- Codes expire after 10 minutes, allow five attempts and are limited to five per hour per link.
  Requesting a new code permanently retires earlier challenges, even if sending the new code
  fails. Concurrent requests reserve the five available sends in database transactions. A failed
  send releases only its own reservation. Concurrent checks cannot exceed the attempt limit or
  verify the same challenge twice. Only a digest is stored. Verification needs email sending to be set up; a link that needs it
  cannot be created otherwise.

The acceptance record keeps what the existing public links keep (typed signer name, time, the
offer revision and hash, IP and user agent for the seller). The seller's activity feed also
records each action taken through a client link (`client_link.action_taken`), and creating,
revoking and renewing links.

## Stale or repeated actions

Every action carries the revision the visitor saw. An agreement decision for an offer revision
that has moved on, or a sign-off for a delivery revision that has been replaced, is refused as
*changed* and the page refreshes to the latest version. Repeating an identical action reuses the
existing public commands: the same acceptance is recorded once, a contradicting decision is
refused, and a second payment click reuses and replaces the single open Checkout session.

## Permissions and configuration

- Roles: administrators and members can create, preview, renew and revoke links
  (`clientLink:create`, `clientLink:read`, `clientLink:revoke`). Accountants cannot: a link is a
  working credential. Links are created by people, not by agent keys.
- `QUITS_PUBLIC_CLIENT_ACTION_SECRET` signs links and codes; it falls back to
  `BETTER_AUTH_SECRET` as the other public links do. Changing it invalidates every client link.
- Client links reuse the agreement and payment secrets of the underlying public commands
  internally and never put those links in the browser.

## Integration contracts

### Recovery

The key inventory must include `QUITS_PUBLIC_CLIENT_ACTION_SECRET`, its supported legacy name
`YAIP_PUBLIC_CLIENT_ACTION_SECRET`, and `BETTER_AUTH_SECRET` when it supplies the fallback.
The current variable takes precedence when defined; the legacy variable is read only when the
current one is absent. A missing or shorter-than-16-character selected value falls back to the
auth secret, which also needs at least 16 characters. The effective key signs three separate
purposes: link references, verification-code digests and verified-browser cookies. Rotating it
invalidates all three. Restoring the same key preserves their signatures and does not reverse
expiry checks. Link and grant rows contain authority; the signature alone contains none.

Recovery should discard `client_action_verification` rows. They are short-lived challenges, not
business evidence. Deleting them refuses every outstanding code but leaves the explicit link
grants intact so recipients can request a new code. It also resets the hourly challenge count.
Deleting challenges does **not** invalidate already verified cookies. A recovery that must
invalidate browser sessions needs to rotate the effective key or revoke the affected link rows.
Restoring a snapshot can restore an earlier `revokedAt` or grant key version; the recovery owner
must choose whether to revoke restored links before serving traffic. Never refresh grants to
current versions or add capabilities automatically during restore.

These are requirements for the recovery integration. This page does not implement a backup or
restore workflow. Token tests cover key precedence and rotation; database tests cover challenge
purging, refusal and re-verification. No recovery candidate has been imported here.

### Public actions and consequence previews

The authenticated seller preview is a read-only projection. It grants no visitor credentials.
A future consequence preview must use the same record, contact, organization, capability and
verification checks as the submission, then recheck them on submission. It must identify the
revision the visitor saw. Preview output must use the public projection and omit internal notes,
cost rates and other records.

| Client request | Existing execution path | Required authority |
| --- | --- | --- |
| `agreement.accept`, `agreement.decline` | `decidePublicAgreementByToken` | Agreement `approve`, verified email, matching offer revision and key version |
| `deliverable.accept`, `deliverable.request_changes` | `decidePublicDeliverableByToken` | Deliverable `approve`, link's verification requirement, matching delivery revision and agreement key version |
| `invoice.pay` | `resolvePublicInvoiceCheckout` | Invoice `pay`, matching payment key version; collect the current outstanding balance |

The adapter mints the scoped underlying token only after authorization. No caller may pass an
underlying token, organization override, extra capability or buyer-selected amount. Existing
database tests execute these command paths and refuse payer approval, foreign records, stale
revisions and unverified signatures. Payment tests cover outstanding balance and the client-page
return URL. They use a captured Stripe adapter and do not establish provider sandbox completion.
Consequence-preview integration remains pending in its owning stream.

### Editable documents

This change adds only contact/organization back-relations and the three client-action models.
Its migration is independent of Invoice/Quote `editRevision`. The document-view contracts,
invoice/quote commands and PDF renderers remain owned by the editable-document work. Adapt this
page to those contracts after they merge; preserve document locale, payment details, public
projections, nullable draft numbers and invoice balances. The payment seams are
`loadPublicInvoice`, `serializePublicInvoiceSession`'s optional logo path, and
`resolvePublicInvoiceCheckout`'s optional return URL. Embedded document components retain their
standalone defaults.
