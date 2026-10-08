# Contributing

Thanks for contributing to Quits OSS.

## Scope and Boundary Rules

This repository is the OSS runtime baseline. Hosted-only features belong in the private cloud repo.

Do not submit changes that:

- Add hosted Quits plan billing, subscription lifecycle or managed billing webhook handlers
- Add hosted auth enforcement logic that belongs in cloud edge infrastructure
- Add private cloud module imports into OSS runtime code
- Add managed AI subscription entitlements or billing coupling into OSS core

Use extension interfaces in `apps/oss/src/lib/runtime/extensions.ts` when you need cloud-specific behavior.

Customer invoice payments belong in OSS. The existing Stripe Checkout provider in
`apps/oss/src/lib/payments/stripe.ts` and invoice webhook at `/api/payments/stripe-webhook`
use an organization's own payment credentials. This does not permit hosted Quits subscription
billing. The boundary check allows only the existing `import Stripe from "stripe"` line in that
provider; other Stripe SDK imports and hosted subscription or billing portal calls remain forbidden.

## Pull Request Expectations

- This is a Bun repo. Use Bun for install, scripts, and local verification.
- Keep OSS runtime self-deployable.
- Keep cloud-specific logic outside OSS runtime paths.
- Add or update tests for behavior changes.
- Ensure CI and boundary checks pass.
- Install ripgrep, then run `bash scripts/__tests__/oss-boundaries.test.sh` and
  `bash scripts/check-oss-boundaries.sh`. Missing tools and search errors fail the check.
- Use the pull request template and include screenshots for UI changes.
- `bun run lint`, `bun run typecheck`, and `bun run test` should pass before asking for review.

PRs that weaken OSS/cloud boundaries will be closed.

## Contribution license and sign-off

By submitting a contribution, you agree to license it under this repository's
[FSL-1.1-ALv2 license](LICENSE), including its grant of an Apache-2.0 license effective
two years after we make that version available. You retain copyright in your contribution.

Certify that you have the right to submit your contribution by signing off each commit
under the [Developer Certificate of Origin 1.1](https://developercertificate.org/).
Use `git commit -s` with your own name and email. The sign-off records your certification;
it does not transfer copyright or grant additional relicensing rights.
