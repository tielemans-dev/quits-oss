# Combined 1.0 integration evidence

Fresh captures from the six-source integration. Prior individual before/after captures remain in
[Full Stop](../full-stop/README.md), [signup](../signup-admission/README.md),
[invoice fields](../danish-invoice/README.md) and [bank details](../public-bank-details/README.md).

The signup captures render the actual combined SignupForm with its actual styles/fonts, synthetic
admission/waitlist responses and a local privacy fixture. The full 72-state matrix covers DA/EN,
light/dark and desktop/mobile. It checks code prefill, errors, blocked/joined views, optional waitlist,
26px wordmark/24px gap, consent edges/keyboard/focus, privacy navigation and exact payload.
These fixtures do not establish hosted invitation storage or delivery.

| View | English | Danish |
| --- | --- | --- |
| Form | [Desktop](light-1-default-en-desktop.png) | [Mobile](light-1-default-da-mobile.png) |
| Blocked | [Desktop](light-2-blocked-en-desktop.png) | [Mobile](light-2-blocked-da-mobile.png) |
| Joined | [Desktop](light-4-joined-en-desktop.png) | [Mobile](light-4-joined-da-mobile.png) |

[Dark Danish blocked mobile](dark-2-blocked-da-mobile.png) and
[actual production signup route](production-signup-en-mobile.png) additionally verify typography,
restricted loader configuration and editable code prefill. Default-open self-host route was checked
separately. Final copy matches all 37 supplied strings per locale verbatim.

Public invoice captures use actual command-issued invoices and the production server with owned
local PostgreSQL and disk artifacts. Settings accept 120-character holder/bank and 500-character
note. Only the 191-character reference is seeded directly in the synthetic draft. Current settings
and identities change after issuance; the original fields and PDF bytes remain frozen.

- [DA desktop](public-da-DK-1280.png), [DA mobile](public-da-DK-390.png).
- [EN desktop](public-en-US-1280.png), [EN mobile](public-en-US-390.png), [EN mobile bank detail](public-en-US-390-bank.png).

Native captures show a viewport, so long documents extend vertically. Full-text and bounds checks
verify complete fields and no horizontal overflow. Actual PDF downloads match their stored SHA-256.
Card controls were inspected with fake configuration only; no provider operation occurred.

[English issued PDF](combined-stored-en-US.pdf) and [Danish issued PDF](combined-stored-da-DK.pdf)
are actual stored React PDF issuance bytes from the combined fixture. Queued delivery is intercepted.
They retain CVR, seller/buyer identity/address, issue/supply/due dates, net, 25% VAT with 0.00 amount,
gross, bank details and invoice-number reference. Email carries frozen legal/money fields and the
payment URL; it does not print a separate bank block. No legal certification or hosted acceptance
is claimed.

Validation on source commit `0f5738c564b979236add60f249c7c0455ac7f807`, Bun 1.3.9,
Node 24.21.0 and PostgreSQL 16.15: fresh lint/whole-workspace typecheck, 3,028 full tests with no skips,
five adapted cross-feature probes, 1,722 i18n keys/TM guard, 26 boundary regressions, production build,
packed-artifact verification and 11 production shared-browser scenarios pass. All imported source
commits are retained. This evidence-only follow-up changes no tested product source.

Fresh independent review and final-head CI are required. Four original imported brand commits still
lack original-author DCO sign-offs. No later sign-off certifies them. Merge, release and hosted adoption
remain separate gates. Quits is source-available.
