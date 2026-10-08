# Consequence preview validation

Runtime tests use synthetic fixtures. They do not establish customer comprehension. The eight
moderated scenarios below still require participants and a moderator. No sessions have been
conducted or results claimed by this implementation.

For each scenario, ask the participant to identify what happens now, what stays a draft, every
message recipient, and every manual step before approving or accepting. Record their answer,
confusion, any moderator prompt, and whether their answer changes after the prompt. Preserve
confusion in the report, including confusion that a later prompt resolves. Do not expand command
coverage until the observations have been reviewed.

| Scenario | Intended observation |
| --- | --- |
| Invoice send to customer A | Identifies the document, exact recipient, amount and currency, and queued email rather than guaranteed delivery. |
| Invoice amount edited while pending | Recognizes that the stored review is stale and no invoice is issued or sent. |
| Invoice recipient changed while pending | Recognizes that the new recipient needs a new review. |
| Invoice issue with email unavailable | Identifies issuance and manual sharing, with no outgoing email. |
| Partial payment already received | Identifies the target invoice and resulting balance, and knows that recording does not collect money. |
| Payment review after a balance change or unrelated note edit | Distinguishes a relevant balance change from an unrelated note edit. |
| Agreement acceptance with a payment schedule | Identifies acceptance recipients, future eligibility, no automatically created invoices, blocked prepayment issuance and separate collection. |
| Agreement with existing sale and prepayment drafts | Distinguishes each draft from an issued invoice and collected money, and identifies the explicit choice needed to invoice a schedule as a sale. |

A completed evidence report must list the observed confusion for all eight scenarios, the
participant selection and session method, and any limitations. Leave the comprehension
acceptance criterion open until that report exists.

## Public acceptance compatibility

The public DTO includes `acceptancePreview: { revision, recipients, version }`. Submit that
`version` as `decision.expectedPreviewVersion` when accepting. It binds the organization,
agreement, offer hash and revision, link key version, and deduplicated notification recipients.
Internal notes do not change it. The command compares it under the agreement lock before
recording acceptance and queues notifications from the same checked settings context.

Existing signed links still open and produce a current review. A new acceptance from an old
page or client without a version returns `changed_since_review`; reload, review the recipients,
and confirm again. There is no unbound legacy acceptance fallback. Declining needs no acceptance
review. Retrying an already recorded decision returns that decision without sending more email,
even if the retry lacks a review or settings have since changed.

The public route passes the reviewed version, clears confirmation on a stale response, and
explains that the customer must reload. Consumers replacing this route must preserve those
behaviors, the recipient list, and the existing keyboard and redaction checks.

## Agent authentication compatibility

`refreshPreviewActor` refreshes live key revocation, expiry, membership, roles, and mode. Its
resulting scopes are the intersection of the current key scopes and incoming authenticated actor
scopes. The incoming scopes are an upper bound, including for full-access installations. A null
tool-level permission on `command_preview` does not bypass the selected command's permission.

The integration test in `command-previews.integration.test.ts` exercises the real MCP tool runner
with the attenuated actor contract produced by OAuth authentication. It also checks that the
unattenuated installation succeeds and that key scope removal, revocation, expiration,
read-only mode, and creator membership removal remain enforced. This test does not run an OAuth
exchange. `command-preview-oauth.integration.test.ts` combines the real OAuth authenticator,
a valid opaque token seeded in its prototype store, and the real `command_preview` runner. It is
explicitly skipped until the OAuth modules are integrated into the same checkout. Its combined
result remains unverified here. No OAuth implementation is duplicated or imported from another
checkout. Run that test with a disposable database after integration; a skip is not a pass.

`domain/agent-keys.ts` retains its `resolveAgentActorById` export, backed by `agent-actor.ts`.
`domain/commands/payments.ts` re-exports `parsePaidAt` from `documents/payment-date.ts`; execution
and preview share that implementation. Consumers must not restore a second date parser during
integration. Invoice previews continue to use the shared prospective render input and display a
draft identity until execution allocates the legal number and issue date.
