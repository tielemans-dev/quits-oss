# Agreement QA follow-up

This consolidated follow-up starts from main `c42c4e7b61a1f1b1cce0d130cf46f94cc585c9c6` in the isolated `qa-agreement-followup` worktree. The existing PR132 coverage audit identifies the remaining agreement copy and default issues. Its localized activity descriptions and public agreement screen are already covered and are not reimplemented here.

## Scope and preservation

- Future built-in agreement templates seed in the organization's DA/EN language through the existing catalog. Listing an unchanged built-in template also localizes its name and terms for presentation. Both the original name and complete original terms must match a known seed. Renamed or edited templates stay verbatim. No persisted template, existing agreement terms or historical event is migrated or rewritten.
- New agreement delivery completions use the locale captured with their outbox target. Existing successful delivery messages use the catalog when presented in agreement actions; stored evidence and domain event payloads stay intact. Provider failures retain their details.
- Raw public agreement PDF and decision failures use the existing invalid-link translation. Unknown links take the visitor's Accept-Language through the existing DA/EN resolver; domain decisions use the organization's language, then the known agreement's language. Invalid PDF responses remain 404 and use private/no-store and Vary headers. No token validity, authorization, public artifact or financial behavior changes.
- New agreements use the configured organization tax rate. An explicit non-registered EU-VAT organization uses zero. The registration field is optional on current main and becomes available through PR129. Other self-hosted tax regimes retain their configured rates. Saved agreement rates and explicit line classifications remain authoritative. Shared pricing and VAT legal classifications are unchanged; PR129 continues to own registration/backend classification behavior.
- The invoice's customer-link panel uses the exact bank-only DA/EN addendum when the existing `stripeByokConfigured` setting is false. Only configured Stripe organizations use the existing Stripe wording. The URL and frozen bank/payment data are unchanged. Current main exposes BYOK configuration; future Connect payment semantics remain owned by the existing payment PRs.

## Overlap and dependency inspection

The open PR diffs were fetched before implementation. The inspected heads were PR121 `e7ba391ea9757dd270fffe5d4f54e3455e4c45dc`, PR122 `21b23763a227b3f30998102d81a8d74352ba7825`, PR129 `26dbeedb9924a47a780b32bd6d0c759415e99071` and PR132 `ac3a6c2faa0eadbee9e17fab68810124f962b233`. None implements this follow-up's template, delivery-producer, raw invalid-link, agreement-editor default or exact bank-link wording changes. The branches and their existing worktrees were not changed. Adjacent PR128/135/137/139 payment diffs were also inspected for the link-copy/configuration item.

This branch is independent of those branches. Shared catalog and invoice-route files need normal integration after the existing dependency order 121 → 122 → 129 → 132 stabilizes. No registration schema, invoice VAT writer, required label, new-invoice policy default, onboarding flow or payment-provider implementation is duplicated. Only public OSS source and its runtime configuration are used; there is no hosted-only gate or private source dependency.

## Date decision

Kai's clarification is to allow past document dates in 1.0, including backdated B2B invoices and credit notes. `LocalizedDateField` passes no minimum or disabled-day rule to `Calendar`, and `Calendar` adds none. Calendar-date validation checks valid dates rather than comparing them with today. The picker therefore does not need a repair or a new past-date regression for this follow-up. No date constraint was changed. The separately specified due-date-at-or-after-issue-date requirement and other field constraints are preserved as separate concerns, with no new past-date restriction.

## Verification

Six narrow Vitest files cover new configured rates, explicit registration zero, self-hosted rates, user edits, saved zero/line classifications, untouched and edited seed templates, captured delivery locale, historical message presentation, provider details, raw invalid-link PDF/decision/domain failures and exact DA/EN link copy for both configuration states. They use one worker and synthetic fixtures only. They do not start a server, browser or database or send email.

The original targeted tests pass 25 cases. Changed-file lint, catalog parity, translation-memory guard and whitespace checks pass. The initial synthetic saved-line fixture had an invalid reason code and was corrected to the existing null reason. Incomplete cached Better Auth files required reinstalling the locked dependencies before the original successful runs; no dependency manifest or lockfile changed.

## Scoped review fixes

The follow-up review found two missing paths. Quote conversion read persisted template terms directly, bypassing the template-list localization. The conversion resolver now applies the same untouched-seed localization when terms are omitted, using the organization's current language. Both built-in templates are covered in DA/EN through the real resolver and quote lock. Explicit terms, including empty terms or the English seed text, renamed and edited templates, quote prices, VAT classifications and backdated supply dates remain authoritative. No template or historical agreement is rewritten.

Authenticated stale sign-off tokens reached the real command handler, whose English invalid-link error was forwarded by the public dispatcher. The dispatcher now presents errors with code `invalid` through the existing DA/EN catalog for both offer and sign-off decisions. Domain error codes and internal messages remain unchanged. Synthetic signed-token tests exercise revoked keys, obsolete offer/delivery revisions and expiry through the real domain handlers and public PDF access. Both sign-off actions reject without writing, and invalid PDFs retain their 404 and private/no-store behavior. Only command persistence, rate-limit storage and database access are replaced with synthetic fixtures.

The scoped review run passes 31 tests across seven files with one Vitest worker, including all 25 original regressions. The two Danish regressions first failed with English template terms and an English authenticated sign-off error, then passed after the fixes. Scoped lint over the four changed source/test files, catalog parity, translation-memory guard and whitespace checks pass. No dependencies were installed during this round.

Full lint, typecheck, suites, integration, build and browser checks are required on the exact PR head in existing CI. No local full suite, typecheck, build, server or browser run is claimed. Review approval and green exact-head CI remain required; this follow-up is not READY.
