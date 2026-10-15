# Nightly quality reports

`quality-nightly.yml` runs on free GitHub-hosted runners nightly and on demand.
It uses a disposable PostgreSQL service and synthetic documents, without secrets
or external delivery. It adds no PR jobs. Copy checks remain in the existing CI.

The browser report covers `/q`, `/a`, `/pay`, the app invoice page in light and
dark, invoice and credit note emails, and every page of their rendered PDFs.
It checks DA/EN at desktop and mobile widths. PDFs have a fixed paper size.
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
authority until her complete policy is validated. No styling changes are applied.

For local browser runs, install dependencies, generate Prisma, install Chromium
and `pdftoppm`, and use a disposable loopback database named `quits_quality`.
Use the fixture environment and React transform in the workflow. Never use a
shared database: the browser fixtures truncate it.
