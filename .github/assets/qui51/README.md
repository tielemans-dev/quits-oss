# QUI-51 public quote evidence

Synthetic issued quotes in an owned disposable PostgreSQL database, using the real public `/q` route and acceptance handler. No email or payment provider was called. The database and dev server were stopped after the run.

Gross inputs of 22,500 and 5,625 at 25% VAT produce stored net lines of 18,000 and 4,500 and total 28,125. Screenshots cover Danish and English at 390px and 1440px, pending and accepted after reload. Browser assertions check net unit prices, net line amounts, exclusion labels, unchanged totals and line records, and no horizontal overflow.

Before the fix, the component regression reproduced gross lines of 22,500 and 5,625. These screenshots show the fixed state only. They do not verify live delivery, PDF artifacts, payment providers, or real customer accounts.
