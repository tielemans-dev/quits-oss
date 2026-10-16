# Runtime Extension Interface

This document defines how private cloud code can extend OSS behavior without forking core runtime code.

## Goals

- Keep OSS runnable and self-hostable by default.
- Allow cloud/private runtime to add features (for example managed AI) with no OSS duplication.
- Keep entitlement and billing enforcement in private cloud code.

## OSS Contract

`apps/oss/src/lib/runtime/extensions.ts` exports:

- `setRuntimeExtensions(extensions)` to register runtime extensions
- `getRuntimeExtensions()` for inspection/testing
- `getRuntimeCapabilities()` to resolve effective feature capabilities

Each extension provides a stable `id` and optional `resolveCapabilities(base)` patcher.

The OSS baseline exposes capabilities via `trpc.runtime.capabilities`.

## Managed sending-domain rejections

`@quits/oss/runtime/services` exports `ManagedDomainRejectedError` and
`ManagedDomainRejectionReason` alongside `ManagedDocumentDomainProvider`.
Providers may throw `new ManagedDomainRejectedError(reason)` from `createDomain`,
`refreshDomain`, or `deleteDomain` for expected request rejections:

- `invalid_domain` becomes tRPC `BAD_REQUEST` with HTTP 400.
- `not_found` becomes tRPC `NOT_FOUND` with HTTP 404.
- `conflict` becomes tRPC `CONFLICT` with HTTP 409.

Configure, refresh, and disable translate these rejections using the organization's
saved locale, with Danish and English messages owned by core. Provider messages
and diagnostic causes are never forwarded for these rejections. All other errors
remain server failures. Providers must keep outages and configuration failures
outside this rejection contract. Self-hosted defaults require no provider.

## Stripe Connect webhooks

`RuntimeExtension.resolveStripeConnectWebhook` may return a
`StripeConnectWebhookVerifier`: one platform webhook secret and
`resolveOrganizationId(stripeAccountId)`. The first extension that returns a
verifier with a secret wins. Self-hosted runtimes leave the hook unset.

`processStripeWebhookRequest` tries that verifier before the per-organization
BYOK secrets. A signature that matches the platform secret is routed with
`event.account`. The resolved organization must own the invoice. An unknown
account, a missing account, or an invoice owned by another organization is
ignored and is not tried against BYOK secrets. A signature that does not match
falls through to the existing BYOK loop, which is unchanged.

## Checkout session expiry

Registering `resolveStripeCheckoutTarget` gives the runtime Connect card routing
and disables BYOK fallback. Only an active seller Connect account may charge.
Missing, pending, or restricted Connect means bank transfer only, even with
stored BYOK keys. The public page and checkout endpoint share this check.
Self-hosted runtimes leave this hook unset and keep the existing BYOK path.

`resolveStripeCheckoutExpiryTargets` returns the seller's Connect accounts that
may still hold an open Checkout session, including a previous connected account.
If the hook is absent, expiry uses the checkout extension's account without the
new-charge readiness gate. Settlement expiry must still work after restriction.
Hosted expiry never reads BYOK keys. Self-hosted expiry needs only the stored
secret key, even when the other BYOK settings have been removed.

A `resource_missing` result on one account is not proof of expiry. If no account
can locate the session, replacement is refused and settlement jobs retry. A
previous account belongs in the expiry hook, never in the charge resolver.

## Deposit capability

`agreements.depositsEnabled` defaults to `true`. An operator can set
`QUITS_DEPOSITS_ENABLED=false`, with `YAIP_DEPOSITS_ENABLED` as the legacy fallback,
or register an extension patch `{ agreements: { depositsEnabled: false } }`.
The extension patch takes precedence over the environment default.

When disabled, agreement editors hide the deposit/payment-schedule checkbox,
billable selections exclude deposit lines, and prepayment drafts hide sale conversion.
The command layer refuses deposit draft creation or edits, new deposit offer issuance,
first acceptance of frozen deposit offers, selection of deposit lines for invoices, and
converting or issuing existing deposit drafts. Acceptance checks the frozen `v1` lines or
`v2` payment schedule under the agreement lock, preserving existing acceptance replay.
Partial commercial edits check the effective stored deposit flag; agreement-wide
repricing checks the stored lines when no replacement is supplied. Service-line edits
on mixed drafts and explicit removal of deposit flows remain available.
Choosing `scheduleAsSale` does not bypass the restriction. Services remain billable even
when their agreement also has a deposit line.

This capability does not filter stored records, rewrite frozen offers or PDF/UBL artifacts,
or remove issued-document/payment access. Existing public offers retain their agreed
schedule, PDF link and decline action, while acceptance controls are suppressed.
Existing accepted evidence and read links remain available. New offers cannot acquire
a deposit schedule while the capability is disabled.

Agreement issuance checks current locked deposit flags before reservation reuse, each renderer and
artifact storage, and again during committed execution. Numberless agreement drafts are rendered
with a provisional number; only successful issuance advances the counter. Legacy reservations
that already allocated a number retain it on enabled retries. A refusal before preparation leaves
no staging or artifact work. If policy changes after preparation starts, an unbound reservation or
already-written bytes may remain for the artifact sweep, but no agreement, number, event or job is
committed. Renderer/store calls remain outside database transactions.

When a provisional number changes, supersession archives the reservation's exact primary and
alias request ownership in `archivedRequestKeys`, clears live aliases and sets the live primary
`requestKey` to NULL. PostgreSQL uniqueness still applies to every non-NULL live primary key;
archived owners never participate in live lookup or uniqueness. Arbitrary request strings,
including literal suffixes, keep exact ownership. An unchanged, unexpired overlapping attempt owned by that request retries
through the bounded numbering loop without a permanent failed receipt. Foreign identities,
changed inputs, ordinary abandoned reservations and expired leases still fail.

Migration `20261014050000_artifact_request_archive` separates existing legacy suffix tombstones
using the previous exact own-row marker predicate. Legacy marker-shaped abandoned rows keep
their previous supersession interpretation. Other abandoned rows, live and allocated reservations,
render inputs, leases, candidates and receipts remain intact. Historical ownership
already removed by older versions cannot be reconstructed. Stop old writers before migration
and deploy the matching generated client/application together. Older clients requiring a non-NULL
primary cannot safely run against retained archives. The artifact sweep clears unprotected bytes;
it retains staging rows and their archived ownership. Recovery still ends at the original lease.
No new archive table or independent retention job is introduced.

## AI Capability Model

Current capability key:

- `aiInvoiceDraft`
  - `enabled`
  - `byok`
  - `managed`
  - `managedRequiresSubscription`
  - `maxPromptChars`

Default OSS behavior:

- BYOK enabled
- Managed mode disabled

## Cloud Composition Pattern

Cloud/private runtime should register a private extension at startup, for example:

```ts
import { setRuntimeExtensions } from "#/lib/runtime/extensions"

setRuntimeExtensions([
  {
    id: "cloud-managed-ai",
    resolveCapabilities: () => ({
      aiInvoiceDraft: {
        managed: true,
        managedRequiresSubscription: true,
      },
    }),
  },
])
```

The private cloud repo owns managed AI provider implementation, entitlement checks, and billing coupling.

## Seller VAT confirmation

`sellerVatConfirmation.enabled` defaults to false and remains false for self-hosted distributions,
including when an extension attempts to enable it. An operator may opt a hosted distribution in
through a capability patch and exactly one `RuntimeExtension.sellerVatConfirmation` service.
Missing or competing enabled providers fail closed.

The generic service prepares an opaque, bounded token for the reviewed seller, then confirms the
explicit registration choice in the Settings/onboarding transaction using the final seller identity.
The server passes the authenticated organization, user, session and request headers. Distribution
code must recheck session, role, origin and token binding under the transaction's existing settings
lock before recording evidence. Null withdraws confirmation; omitted registration leaves evidence
unchanged. A provider failure rolls back the entire settings save. OSS defines no evidence table.
Hosted extension requests have a bounded streamed body before tRPC parses JSON.

The app owns the company review and Settings company controls, including the unchanged localized
`vatStatus.*` and `sellerCard.body` copy. Company review accepts a mapped lookup result or manual
fallback; lookup never presets registration. Settings starts each confirmation choice unchecked,
keeps unrelated saves available, and offers withdrawal through its ordinary Save action.
Self-hosted keeps its existing general VAT validation and settings API, without this confirmation UI,
evidence, or gate. `onboardingV2` remains a separate hosted opt-in.

An issuance extension may return `sellerVatStatus: registered | not_registered | unset`. Unset
always refuses new issuance; known evidence must match the effective seller snapshot. Existing
artifact reads and accounting behavior are unaffected. Ordinary zero-tax sales remain
`unclassified_zero`; this contract does not invent a legal UBL classification.
