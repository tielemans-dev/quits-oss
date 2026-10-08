# OSS and Cloud Ownership Boundary

This document defines ownership boundaries between the public OSS runtime (`yaip-oss`) and the private hosted runtime (`yaip-cloud`).

## Ownership Matrix

| Area | OSS (`yaip-oss`) | Cloud (`yaip-cloud`) |
| --- | --- | --- |
| Invoicing, quotes, contacts, catalog | Owns | Consumes |
| Auth core (users/sessions/org roles/invites) | Owns | Extends only |
| OAuth provider setup | Optional + documented | Enabled by default in hosted |
| Billing abstraction | Owns interface + noop provider | Owns Stripe provider |
| Customer invoice Stripe Checkout and payment webhooks | Owns, using organization payment credentials | Consumes |
| Hosted Quits plan Stripe subscriptions, billing portal and lifecycle webhooks | Not present | Owns |
| Runtime extension contracts | Owns stable extension interfaces | Owns private extension implementations |
| Managed AI providers + entitlements | Not present | Owns |
| Self-host setup wizard | Owns | Consumes + may bypass in hosted |
| Docker compose + self-host docs | Owns | N/A |
| Managed infrastructure/runbooks | Not present | Owns |

## Import Constraints

- OSS runtime code must not import cloud-only modules.
- OSS billing code may only depend on billing interfaces and OSS providers.
- Cloud-specific Stripe, webhook, and managed infra logic must stay out of OSS runtime paths.
- The customer invoice provider at `apps/oss/src/lib/payments/stripe.ts` may retain its exact
  `import Stripe from "stripe"` line. This exception applies to that line only. It does not exclude
  the file or payment directory from checks. The customer payment webhook uses
  `/api/payments/stripe-webhook`; hosted `/api/webhooks/stripe` routes remain forbidden.
- Cloud distribution code may consume OSS interfaces, but OSS code must remain cloud-agnostic.
- Cloud/private behavior should be integrated through OSS runtime extension interfaces, not by embedding private imports in OSS runtime modules.

## Enforcement

- A dedicated CI workflow (`oss-boundary.yml`) installs ripgrep and runs the executable boundary
  regression tests, then the repository check. A missing tool, unreadable path or other search error
  fails the check; only ripgrep's no-match exit status passes a search without matches.
- Static checks restrict SDK imports to the exact invoice provider import and reject hosted Stripe
  subscription, subscription schedule and billing portal calls, subscription event names and Checkout
  subscription mode. These text checks supplement review; they do not parse TypeScript or prove that
  aliased, computed or multiline code is free of hosted behavior.
- Boundary checks run alongside tests and build to prevent regressions.
- CODEOWNERS protection is applied on boundary-sensitive files and extension contracts.
