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

## Deposit capability

`agreements.depositsEnabled` defaults to `true`. An operator can set
`QUITS_DEPOSITS_ENABLED=false`, with `YAIP_DEPOSITS_ENABLED` as the legacy fallback,
or register an extension patch `{ agreements: { depositsEnabled: false } }`.
The extension patch takes precedence over the environment default.

When disabled, agreement editors hide the deposit/payment-schedule checkbox,
billable selections exclude deposit lines, and prepayment drafts hide sale conversion.
The command layer refuses deposit draft creation or edits, new deposit offer issuance,
first acceptance of frozen deposit offers, selection of deposit lines for invoices, and
converting or issuing existing deposit drafts. Acceptance checks the frozen v1 lines or
v2 payment schedule under the agreement lock, preserving existing acceptance replay.
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

Agreement issuance checks current locked deposit flags before reservation reuse, rendering and
artifact storage, and again during committed execution. Numberless agreement drafts are rendered
with a provisional number; only successful issuance advances the counter. Legacy reservations
that already allocated a number retain it on enabled retries. A refusal before preparation leaves
no staging or artifact work. If policy changes after preparation starts, an unbound reservation or
already-written bytes may remain for the artifact sweep, but no agreement, number, event or job is
committed. Renderer/store calls remain outside database transactions.

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
