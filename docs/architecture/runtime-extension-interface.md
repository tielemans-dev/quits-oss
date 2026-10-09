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
selection of deposit lines for invoices, and converting or issuing existing deposit drafts.
Choosing `scheduleAsSale` does not bypass the restriction. Services remain billable even
when their agreement also has a deposit line.

This capability does not filter stored records, rewrite frozen offers or PDF/UBL artifacts,
or remove issued-document/payment access. Existing public offers retain their agreed
schedule. Deployments requiring those historical schedules to disappear need a separate
policy decision before changing their presentation. New offers cannot acquire a deposit
schedule while the capability is disabled.

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
