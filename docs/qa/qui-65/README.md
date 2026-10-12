# QUI-65 quote pages verification

## Current status

Screenshot capture is pending. Kai paused local browser, dev-server, typecheck and suite work on
2026-10-12 to give QUI-64 exclusive heavy-work priority on the VPS. No screenshots have been captured.
The attempted Playwright run found a missing matching Chromium headless-shell executable.
Install the repository's pinned browser with `bunx playwright install chromium` after Kai clears the host.
Ines must sign off on the completed visual evidence before this draft is ready for Martin.

## Screenshot matrix

Capture before from `origin/main` and after from this branch. For each changed screen, use Danish
and English, light and dark, desktop 1440px and mobile 390px. The test captures public pending,
public accepted, admin with a numbered invoice, admin with a draft invoice, and the quote list.
Activity-log evidence also needs before/after captures showing quote and credit events.

The test fixture is labeled MOCK and contains synthetic documents and customers only.
It runs against the dedicated disposable database `qui65` on localhost port 55465.
No mocked data or capture routes are imported into the application.

After the host is available, run from `apps/oss`:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55465/qui65 \
  QUI65_CAPTURE_DIR=/absolute/path/to/docs/qa/qui-65 \
  bun run test:e2e quote-polish-qui65.spec.ts --workers=1
```

Use the same test file against a separate main-branch checkout with `QUI65_SCREENSHOTS=before`.
Use separate local app ports when needed. Do not point the fixture at a shared or production database.

## Dependencies

PR #127 is unmerged. This branch stays based on main and minimally reuses its presentation patterns:
content-sized public cards, flat email sections, postal ordering, activity catalogs and payload handling.
The activity catalog additions and missing-payload handling are copied unchanged to ease merging.
The embedded email variant applies the flat presentation only within quote detail.

The brief requires `11 Oct 2026`; #127 currently uses `Oct 11, 2026` for English.
`formatShortDate` builds on the existing formatter to honor the quote brief without changing other
screens. Public issue/decision instants use the document timezone; expiry dates stay calendar dates in UTC.
QUI-64's public VAT-breakdown markup is untouched.
