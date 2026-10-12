# QUI-56 review-fix evidence

The saved organization tax rate now initializes new invoice and quote forms. The committed form regressions cover saved 25%, saved 0%, null defaults, and user edits before settings arrive. Hook regressions also cover organization switching, fractional rates, and failed settings loads.

## Screenshot prerequisite blocker

The requested fresh before/after matrix is **missing** for both new invoice and new quote: Danish and English, light and dark, desktop and mobile at 390px.

The isolated baseline is current main `808debcfc95a1a5cf8cd782895e40e6e999baa85`. A short-lived Playwright-managed Vite server started successfully against a dedicated local synthetic database. Authentication succeeded, but the baseline rendered only the application shell. Its client entry returned HTTP 404:

```text
Failed to fetch dynamically imported module: http://127.0.0.1:3077/@id/virtual:tanstack-start-client-entry
```

A bounded 30-second hydration wait still could not find the invoice form. No empty-shell screenshots are submitted as evidence. The comparison could not proceed to after captures. This is a local development-server prerequisite; the implementation's targeted form tests pass. The parent must arrange working browser evidence and obtain Ines sign-off. Existing T3 screenshots were not changed.

## Verification

111 targeted tests pass with one worker through Fleet on a dedicated local disposable database, including both legacy/v2 race orders, registration changes in both directions, frozen issued artifact downloads, provider failure and timeout with existing or absent settings, and a real 60-second confirmation transaction expiry followed by an idempotent retry. App lint, app/test typecheck, i18n, 26 boundary regression cases, the boundary scan, and diff whitespace checks pass.

Billing provisioning and session/settings transport mocks exist only in tests. Issuance/export regressions use the production renderer and disk artifact store. Screenshot fixtures contain only synthetic setup data and never send or issue documents. No production providers or data were used.

## Adopted review 5492626710

The adopted checkout had inherited dependency links pointing at another worktree. Those links were preserved under the local verification directory and replaced with a frozen-lockfile install in this checkout. Verification results using the inherited links are invalid for the new contracts.

Hosted non-VAT confirmation and registration changes require the existing runtime extension mechanism to opt in with `onboardingV2.nonVatEnabled: true`. The default is false. QUI-62 must enable this in the hosted runtime only after its onboarding flow lands. No deployment environment flag was introduced, and self-hosted registration and custom VAT rates remain configurable.

Client registry protection metadata is informational. Until a trusted server lookup is available, confirmation scrubs all registry-sourced contacts, using the authenticated signup email and clearing the phone. Manual entries remain supported. `COPY.md` records the supplied approved invoice declaration and the validation keys.

The requested Linear shot list could not be read. Fleet returned `T3 Fleet: no MCP server linear-kai (mcp/linear-kai.json)`. The generic Linear connection was not used. Ines must supply or confirm the exact shot list and approve the actual-form evidence before readiness for Kai.
