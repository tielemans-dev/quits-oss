# Synthetic invoice evidence

All names, addresses and CVR values here are synthetic test fixtures. The example CVR does not assert a real business or VAT registration. PDFs were produced by the actual issuance renderer with a disposable local Postgres database; emails were rendered locally without a delivery provider.

- [Danish sample PDF](sample-da.pdf)
- [English sample PDF](sample-en.pdf)

Before screenshots use main at `8d7740eb9abcbae07a5db8e8969c6c1edecd6ec8`. After screenshots use this change. Desktop is 1440 × 1100 CSS pixels; mobile is 390 × 1600. The browser reported no horizontal overflow. Public-link fixture activation is local evidence setup; this change does not enable bank-only links.

| Surface | Language / viewport | Before | After |
| --- | --- | --- | --- |
| pay | DA / desktop | [Before](before-pay-da-desktop.png) | [After](after-pay-da-desktop.png) |
| pay | DA / mobile | [Before](before-pay-da-mobile.png) | [After](after-pay-da-mobile.png) |
| pay | EN / desktop | [Before](before-pay-en-desktop.png) | [After](after-pay-en-desktop.png) |
| pay | EN / mobile | [Before](before-pay-en-mobile.png) | [After](after-pay-en-mobile.png) |
| email | DA / desktop | [Before](before-email-da-desktop.png) | [After](after-email-da-desktop.png) |
| email | DA / mobile | [Before](before-email-da-mobile.png) | [After](after-email-da-mobile.png) |
| email | EN / desktop | [Before](before-email-en-desktop.png) | [After](after-email-en-desktop.png) |
| email | EN / mobile | [Before](before-email-en-mobile.png) | [After](after-email-en-mobile.png) |

Correction round 1 adds [zero-rounded VAT and absent historical buyer evidence](fix1/README.md), including new actual-issued DA/EN PDFs and public/email desktop/mobile captures.
