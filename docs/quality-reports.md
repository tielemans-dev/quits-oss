# Nightly quality reports

`quality-nightly.yml` runs on free GitHub-hosted runners nightly and on demand.
It uses a disposable PostgreSQL service and synthetic documents, without secrets
or external delivery. It adds no PR jobs. Copy checks remain in the existing CI.

The browser report covers `/q`, `/a`, `/pay`, the app invoice page in light and
dark, invoice and credit note emails, and every page of their rendered PDFs.
It also captures accepted quotes, paid invoices and invalid `/q`, `/a`, `/pay`
links in both languages and widths.
It checks DA/EN at desktop and mobile widths. PDFs have a fixed paper size.
Signed payment-link inputs are masked in screenshots and remain in axe checks.
axe checks HTML pages, including contrast and accessible names. Keyboard and
screen-reader review still need human testing. The hosted landing page is outside
this repository and is not covered here.

Screenshots and axe violations start as reports. Missing or changed baselines
produce failures inside the report without blocking PRs. Ines approves baseline
changes through Linear. After approval, generate baselines on the same Linux
runner with `bunx playwright test -c playwright.quality.config.ts --update-snapshots`
from `apps/oss`, and commit the approved test baselines with the Linear sign-off.
Do not treat a green workflow as visual or accessibility approval.

`node scripts/design-check.mjs` reports one-off colours/classes and proposed
font, weight, spacing and radius violations, including email and PDF literals.
It also reports missing Tailwind theme category resets. This is a
source scan, not Tailwind class registration validation. The proposed scales come
from Ines's QUI-66 comment. Existing theme and document colour tokens remain the
authority until her complete policy is validated. Values built from theme custom
properties and background placement (`bg-[length:…]`, `bg-[position:…]`) are not
one-off values. The app, email and onboarding values follow the scales. The PDF
fonts, sizes and spacing, and the Tailwind theme category resets, are still
reported: changing them needs a PDF render and a build.

For local browser runs, install dependencies, generate Prisma, install Chromium
and `pdftoppm`, and use a disposable loopback database named `quits_quality`.
Use the fixture environment and React transform in the workflow. Never use a
shared database: the browser fixtures truncate it.

## Accessibility verification without visual baselines

Set `QUITS_QUALITY_A11Y_ONLY=1` when running the quality Playwright command to
check HTML accessibility without snapshot comparisons or PDF rendering. Screenshots
and axe JSON remain attached. A nonzero exit still means a test or axe check failed.
The default nightly command continues to compare snapshots and render PDFs.

On workstations with a heavy-command queue, start the isolated fixture server
separately, then set `QUITS_QUALITY_EXTERNAL_SERVER=1` for Playwright. This disables
the config's server launcher. Keep the same fixture environment and port 3066,
run migrations before starting Vite, and stop your server when finished. Do not
hold the heavy-command lock with a dev server.

## Before making reports required

QUI-163 remains open until these checks and approvals are complete:

- Reconcile the proposed scales with the complete, validated design policy and
  current app, email and PDF tokens. Review one-off values, font sizes/weights,
  PDF fonts, spacing, radii and theme resets. Findings are proposals, not approved
  exceptions. Fix confirmed violations and require zero
  violations under the approved policy before enabling enforcement.
- Obtain Ines's Linear approval for Linux visual baselines, including the new
  states. Commit only approved baselines. Missing baselines remain report failures.
- Have a human review DA/EN desktop/mobile flows with keyboard only. Check Tab
  and Shift+Tab order, visible focus, horizontal table scrolling with arrow keys,
  link selection/copying, dialog Escape and focus return, and all recipient actions.
- Have a human review with a screen reader. Record browser, screen reader/version,
  locale, width, theme, tested states and findings in Linear. Check document language
  and title, headings, table headers/cells, input names, status announcements, and
  navigation through accepted, paid and invalid-link states. Automated axe results
  cannot supply this sign-off.
- Resolve all remaining axe and human-review findings. Record a clean HTML run
  separately from visual approval before changing the scheduled report's enforcement.

These checks remain nightly/on-demand. The QUI-66 decision to keep visual and
accessibility checks off PR CI still applies.
