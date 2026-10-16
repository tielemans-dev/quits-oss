# Organization access

The server billing provider returns `BillingSubscription.organizationAccess` as the access
decision. Payment status and legacy trial timestamps are billing details, never access inputs
for the client. The core write guard consumes this same decision on every mutation. Hosted
operation policies must also consume it rather than maintain a second entitlement predicate.

States are `self_hosted` (unlimited), `trial` (server-calculated days left, dates and progress),
`subscribed`, `complimentary`, and `read_only` with reason `trial_ended`, `payment_failed` or
`canceled`. All reasons block writes; only `trial_ended` uses trial copy. Other reasons link to
billing with neutral read-only copy, ignoring legacy trial dates. The app shares one snapshot across
the banner, form gates, read-only indicator and billing page, refreshing every minute and on
window focus. The server remains authoritative between refreshes. A missing decision refuses
writes. Self-hosters use the noop provider and have unlimited access without hosted gates.
Refresh failures retain the last successful snapshot, including form edits. Only an initial
failure blocks the UI; every mutation still checks current server access.

Providers must return `access.checkoutAvailable` and `access.portalAvailable` explicitly.
The noop provider disables both. Billing controls follow these capabilities, never legacy
payment status or subscription presence, and report a missing redirect URL as an error.
Subscription-gated managed AI and company research use `hasSubscriptionAccess`: subscribed,
complimentary and unlimited self-hosted states qualify; trial and read-only states do not.
Other feature flags and the organization's AI Settings still apply.

Successful onboarding invokes the transactional trial hook even during registry outages,
passing `cvrVerified: false`. Hosted providers must persist one organization trial and preserve
its original start/end on retries and later verification. Trial configuration, persistence,
payment precedence and entitlement transitions belong to the provider, not the core schema.
CVR usage records are separate from the organization trial and cannot suppress its grant.

Manual hosted setup still requires a checksum-valid CVR. Only lookup unavailability permits
pending verification; known unknown/inactive businesses are refused. Pending CVRs retain the
existing login retry, with a five-minute durable lease and uniqueness checks. Settings can
also verify a corrected CVR. Later verification must not restart the trial. Invalid/inactive
results remain recorded for hosted account policy to handle; this change adds no bypass.

This is a breaking provider contract. Publish the app artifact before a hosted consumer adds
the resolver, organization trial storage and write-policy integration. Do not upgrade a hosted
consumer until all its adapters return the decision and honor pending-identity trial hooks.
