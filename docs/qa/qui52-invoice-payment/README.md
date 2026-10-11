# QUI-52 invoice payment screenshots

These 16 light-theme screenshots compare origin/main at `4931661dd7e53d83555590e06a2e2cf97448743b` with the implemented payment block and mobile fix at `72c518da2f5fac04cc04c0b20769b54c13283928`.

Each pair uses synthetic invoice INV-0042, amount 250.00, Danish/DKK or English/USD. The seller snapshot has Issue-time Seller ApS, CVR 12345678, registration number 0040, account number 0440116243 and a synthetic payment note. Current organization settings deliberately contain a different seller, bank account and note. No logo is configured. No customer or production data is used.

Email captures come from actual UI resend to local Mailpit. Chromium renders the HTML returned by Mailpit. Invoice captures come from the authenticated in-app detail page. Viewports are 1440×1000 and 390×844, with full-page screenshots, so image height may exceed viewport height.

The baseline mobile invoice read-view expands horizontally. The explicit single grid column fixes this expansion and keeps the seller, totals and payment instructions within the 390px viewport. The existing invoice items table remains horizontally scrollable.

[Before manifest](before-manifest.json) and [after manifest](after-manifest.json) record code commits, pixel dimensions and SHA256 hashes. The shared browser regression is in [invoice-payment-block.spec.ts](../../../apps/oss/tests/shared/invoice-payment-block.spec.ts).

| View | Language | Viewport | Before, origin/main | After |
| --- | --- | --- | --- | --- |
| Email | DA | desktop | [Before](before/email-da-desktop.png) | [After](after/email-da-desktop.png) |
| Email | DA | mobile | [Before](before/email-da-mobile.png) | [After](after/email-da-mobile.png) |
| Email | EN | desktop | [Before](before/email-en-desktop.png) | [After](after/email-en-desktop.png) |
| Email | EN | mobile | [Before](before/email-en-mobile.png) | [After](after/email-en-mobile.png) |
| Invoice | DA | desktop | [Before](before/invoice-da-desktop.png) | [After](after/invoice-da-desktop.png) |
| Invoice | DA | mobile | [Before](before/invoice-da-mobile.png) | [After](after/invoice-da-mobile.png) |
| Invoice | EN | desktop | [Before](before/invoice-en-desktop.png) | [After](after/invoice-en-desktop.png) |
| Invoice | EN | mobile | [Before](before/invoice-en-mobile.png) | [After](after/invoice-en-mobile.png) |
