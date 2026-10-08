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
