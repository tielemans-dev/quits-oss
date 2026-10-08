# Synthetic migration analysis and receipt research evidence

These artifacts support the two 8 October 2026 decision documents one directory above `evidence/`.
They do not implement migration, receipt capture or an accounting connector.

- `staging-synthetic.json` is invented source-neutral analysis data. It is not a vendor export,
  customer record or application contract. Available artifacts are clearly synthetic text, not PDFs.
- `check.ts` reads these inputs and the existing accepted #29 extraction code/fixtures at
  `6d9c9fcbd678bf4800ad5c21bea791779acdbab2`. It does not copy or replace that extractor prototype.
  It refuses a different SHA or modified tracked/untracked prototype paths. Bun needs no packages
  for this script. No application, database, provider or scheduler code is imported.
- `worked-report.json` is deterministic stdout from the script. Financial values use integer minor
  units. The mock source residuals are hand-declared synthetic controls, not independent provider data.
  The in-memory retry exercise is separate from the proposed commit gates. The fixture's number
  collision and unavailable artifacts do not become approved because that protocol exercise passes.
- `provider-sources.json` records public documentation requests, response SHA-256 and text/spec
  excerpts, accessed 8 October 2026. It contains no authenticated account responses. Exact snippets
  retain the vendor's spelling. Dinero API specs are excerpts, not a complete archived specification.

From the repository root:

```sh
bun docs/plans/evidence/2026-10-08-migration-receipts/check.ts ../economic --check
```

Pass an alternative clean public OSS checkout at the pinned SHA as the second path argument.
No sibling checkout is mutated. To review a regenerated report, omit `--check`; output is stdout.
The script validates 15 existing extraction scenarios and additional Danish parsing, duplicate ID,
number-collision and retry examples. It is not the upstream Vitest suite or matrix validator.
No database restart, concurrent import, real provider pagination, original PDF preservation,
customer interview or live pilot is established by these checks.
