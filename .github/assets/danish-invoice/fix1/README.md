# Correction round 1 evidence

Synthetic fixtures only, created and issued against disposable local Postgres. No delivery provider or customer mail. These samples are new test invoices; no original product artifacts were regenerated.

[DA PDF](sample-da.pdf) and [EN PDF](sample-en.pdf) show an actual issued DKK 0.01 net sale at 25%, with rounded VAT of 0.00. Text extraction and visual inspection passed. [DA email](email-da.html) and [EN email](email-en.html) use the invoice email composer.

The T3 collaborative browser verified both languages at desktop 1440 × 1100 and mobile 390 × 1600. Every case passed text assertions and had no horizontal overflow. The tiny-invoice public pages and emails preserve the frozen buyer after a contact rename. Missing/malformed historical fixtures have a blank legal buyer/customer and the existing localized company-unavailable wording. Historical fixture setup clears snapshot data only in the disposable test database; its stored PDF bytes remain untouched.

- DA tiny public invoice: [desktop](pay-da-desktop.png), [mobile](pay-da-mobile.png)
- EN tiny public invoice: [desktop](pay-en-desktop.png), [mobile](pay-en-mobile.png)
- DA missing buyer: [desktop](pay-da-null-desktop.png), [mobile](pay-da-null-mobile.png)
- EN missing buyer: [desktop](pay-en-null-desktop.png), [mobile](pay-en-null-mobile.png)
- DA malformed buyer: [desktop](pay-da-malformed-desktop.png), [mobile](pay-da-malformed-mobile.png)
- EN malformed buyer: [desktop](pay-en-malformed-desktop.png), [mobile](pay-en-malformed-mobile.png)
- DA tiny email: [desktop](email-da-desktop.png), [mobile](email-da-mobile.png)
- EN tiny email: [desktop](email-en-desktop.png), [mobile](email-en-mobile.png)

No palette, typography, payment fields or public-link availability changes are included. Full Stop palette reconciliation remains with the parent and WS3a on eventual rebase.
