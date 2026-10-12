# QUI-65 quote pages verification

## Current status

Screenshot capture is pending. Kai restricted full browser and screenshot suites to GitHub CI on
2026-10-12. No local browser or dev-server run is permitted, and no screenshots have been captured.
The attempted Playwright run found a missing matching Chromium headless-shell executable.
GitHub CI installs the repository's pinned browser with `bunx playwright install --with-deps chromium`.
Ines must sign off on the completed visual evidence before this draft is ready for Martin.

## Screenshot matrix

Capture before from `origin/main` and after from this branch. For each changed screen, use Danish
and English, light and dark, desktop 1440px and mobile 390px. The test captures public pending,
public accepted, admin with a numbered invoice, admin with a draft invoice, and the quote list.
Activity-log evidence also needs before/after captures showing quote and credit events.

The test fixture is labeled MOCK and contains synthetic documents and customers only.
It runs against the dedicated disposable database `qui65` on localhost port 55465.
No mocked data or capture routes are imported into the application.

For the GitHub CI capture runner, run from `apps/oss` against its disposable database:

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

## CI follow-up

At head `818470e`, the boundary and shared-browser jobs passed. Both verify runs failed only in
browser smoke. One public quote assertion still expected the previous English date order; the two
polish fixtures used API sign-in without selecting the organization, unlike the login page.
The follow-up keeps exact heading assertions, uses the existing UI login helper and asserts that
the session names the fixture organization. CI now uploads smoke reports and traces on failure.

The 43 targeted date, public quote and app-layout tests passed locally with one worker and a
worktree-local temp directory. Full browser verification remains in GitHub CI.

Kai owns integration order with #131. Its public quote component/test changes add the opt-in
separator-aware amount renderer to `/q` totals; this PR does not replace DocumentTotals or its VAT markup.
