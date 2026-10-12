# QUI-61 review evidence

All documents, people, addresses, bank details and activity in these captures are synthetic test data. The fixtures are marked `MOCK` and live under `apps/oss/tests`; application code never imports them.

The before PDF renders use `origin/main` at `4931661dd7e53d83555590e06a2e2cf97448743b`. The after renders use the implementation in this branch. Both are A4, in Danish and English. PNGs are rasterized from the accompanying PDFs at 130 dpi.

Reproduce the after PDFs from the repository root:

```sh
bun apps/oss/tests/visual/render-qui61-pdf.tsx after
```

For before PDFs, archive that main commit into a temporary directory and pass its invoice PDF module as `QUI61_PDF_MODULE` to the same script with `before`. Resolve the module's workspace dependencies first. Rasterize each PDF with a PDF viewer or PyMuPDF.

Browser coverage lives in `apps/oss/tests/e2e/alignment-qui61.spec.ts`. It checks Danish/English signed-out language, invoice activity and dates, email-card nesting, search alignment, Settings save states, and desktop/mobile public-payment layout. `QUI61_SCREENSHOTS=after` writes captures here. Use `QUI61_SCREENSHOTS=before` only against the baseline app; it skips assertions for the new layout. Browser fixtures truncate their database and must use a dedicated disposable local database.

## Coordination and review

No open PR was identified as QUI-60 or QUI-52 when work started. Potential overlaps are the invoice detail route, shared email-delivery panel, email templates, payment details, and i18n catalogs. New-invoice form changes, the public-payment country-code change, and Settings payment-reference preview are excluded.

PDF review images are available. Screen captures and the signed-out-language browser result remain pending local browser verification. The available Linear connector identifies as Martin, not the authorized linear-kai account, so issue state, PR linking, mock disclosure and reviewer mentions cannot be posted through it.

The PR remains a draft until checks pass and Ines approves the design. Mira's reminder strings are final and implemented verbatim; the usual copy review is still required.
