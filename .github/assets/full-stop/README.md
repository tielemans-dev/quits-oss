# Full Stop browser evidence

Captured on 9 October 2026 from production builds with Chromium, bundled fonts, disposable PostgreSQL and synthetic E2E fixtures. No production data or external provider was used.

Before is main `8d7740e`. After is the supplied four-commit patch plus browser regression checks. Desktop is 1440 × 1000; mobile is 390 × 844. All 72 captures returned HTTP 200 without horizontal document overflow.

The `/pay`, `/q`, `/a` captures use valid synthetic links. Both light and dark preferences render those documents light with ink controls. The dark captures demonstrate that preference override. The automated `/a` regression checks the invalid-link page; valid `/a` is verified in this capture set.

## Light desktop

[Comparison board](board-light-desktop.jpg)

| Page | Before | After |
| --- | --- | --- |
| login | [PNG](before-login-light-desktop.png) | [PNG](after-login-light-desktop.png) |
| signup | [PNG](before-signup-light-desktop.png) | [PNG](after-signup-light-desktop.png) |
| dashboard | [PNG](before-dashboard-light-desktop.png) | [PNG](after-dashboard-light-desktop.png) |
| invoice-list | [PNG](before-invoice-list-light-desktop.png) | [PNG](after-invoice-list-light-desktop.png) |
| invoice-detail | [PNG](before-invoice-detail-light-desktop.png) | [PNG](after-invoice-detail-light-desktop.png) |
| invoice-new | [PNG](before-invoice-new-light-desktop.png) | [PNG](after-invoice-new-light-desktop.png) |
| pay | [PNG](before-pay-light-desktop.png) | [PNG](after-pay-light-desktop.png) |
| quote | [PNG](before-quote-light-desktop.png) | [PNG](after-quote-light-desktop.png) |
| agreement | [PNG](before-agreement-light-desktop.png) | [PNG](after-agreement-light-desktop.png) |

## Light mobile

[Comparison board](board-light-mobile.jpg)

| Page | Before | After |
| --- | --- | --- |
| login | [PNG](before-login-light-mobile.png) | [PNG](after-login-light-mobile.png) |
| signup | [PNG](before-signup-light-mobile.png) | [PNG](after-signup-light-mobile.png) |
| dashboard | [PNG](before-dashboard-light-mobile.png) | [PNG](after-dashboard-light-mobile.png) |
| invoice-list | [PNG](before-invoice-list-light-mobile.png) | [PNG](after-invoice-list-light-mobile.png) |
| invoice-detail | [PNG](before-invoice-detail-light-mobile.png) | [PNG](after-invoice-detail-light-mobile.png) |
| invoice-new | [PNG](before-invoice-new-light-mobile.png) | [PNG](after-invoice-new-light-mobile.png) |
| pay | [PNG](before-pay-light-mobile.png) | [PNG](after-pay-light-mobile.png) |
| quote | [PNG](before-quote-light-mobile.png) | [PNG](after-quote-light-mobile.png) |
| agreement | [PNG](before-agreement-light-mobile.png) | [PNG](after-agreement-light-mobile.png) |

## Dark desktop

[Comparison board](board-dark-desktop.jpg)

| Page | Before | After |
| --- | --- | --- |
| login | [PNG](before-login-dark-desktop.png) | [PNG](after-login-dark-desktop.png) |
| signup | [PNG](before-signup-dark-desktop.png) | [PNG](after-signup-dark-desktop.png) |
| dashboard | [PNG](before-dashboard-dark-desktop.png) | [PNG](after-dashboard-dark-desktop.png) |
| invoice-list | [PNG](before-invoice-list-dark-desktop.png) | [PNG](after-invoice-list-dark-desktop.png) |
| invoice-detail | [PNG](before-invoice-detail-dark-desktop.png) | [PNG](after-invoice-detail-dark-desktop.png) |
| invoice-new | [PNG](before-invoice-new-dark-desktop.png) | [PNG](after-invoice-new-dark-desktop.png) |
| pay | [PNG](before-pay-dark-desktop.png) | [PNG](after-pay-dark-desktop.png) |
| quote | [PNG](before-quote-dark-desktop.png) | [PNG](after-quote-dark-desktop.png) |
| agreement | [PNG](before-agreement-dark-desktop.png) | [PNG](after-agreement-dark-desktop.png) |

## Dark mobile

[Comparison board](board-dark-mobile.jpg)

| Page | Before | After |
| --- | --- | --- |
| login | [PNG](before-login-dark-mobile.png) | [PNG](after-login-dark-mobile.png) |
| signup | [PNG](before-signup-dark-mobile.png) | [PNG](after-signup-dark-mobile.png) |
| dashboard | [PNG](before-dashboard-dark-mobile.png) | [PNG](after-dashboard-dark-mobile.png) |
| invoice-list | [PNG](before-invoice-list-dark-mobile.png) | [PNG](after-invoice-list-dark-mobile.png) |
| invoice-detail | [PNG](before-invoice-detail-dark-mobile.png) | [PNG](after-invoice-detail-dark-mobile.png) |
| invoice-new | [PNG](before-invoice-new-dark-mobile.png) | [PNG](after-invoice-new-dark-mobile.png) |
| pay | [PNG](before-pay-dark-mobile.png) | [PNG](after-pay-dark-mobile.png) |
| quote | [PNG](before-quote-dark-mobile.png) | [PNG](after-quote-dark-mobile.png) |
| agreement | [PNG](before-agreement-dark-mobile.png) | [PNG](after-agreement-dark-mobile.png) |

## Scope kept for Martin

FIT priority 5 is deferred. The double-rule amount signature remains, invoice detail retains its current layout, and landing navigation is not changed. PDF changes are palette styling only and retain the existing Helvetica fonts, identity fields, render inputs and monetary calculations.
