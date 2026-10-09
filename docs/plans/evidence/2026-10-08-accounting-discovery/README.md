# Accounting discovery evidence

This directory supports the three decision records for #24, #59 and #51 dated 8 October 2026.
It contains public-source retrieval metadata and **clearly synthetic** arithmetic fixtures.
It contains no customer books, account identifiers, credentials, interview transcripts,
accountant approval or provider-test results. No source code is imported or wired to the app.

- `sources.json` records 24 official sources, their exact retrieval URLs, UTC access times,
  response hashes, sections and short excerpts. Statutory PDF excerpts preserve extracted text,
  including column artifacts. Refer to the linked original sections for the complete wording.
  The manifest records failed legal-source retrievals and the narrower resulting evidence scope.
- `fixtures.json` contains 14 separate advance scenarios, two rounding probes and three retainer
  probes. Each event has integer DKK minor-unit debits and credits. EUR source quantities and
  synthetic rates are explicit in the FX scenario. Missing expected accounts mean zero.
- `validate.py` checks per-event double entry, ending accounts, fiscal VAT/net reconciliation,
  receipt/application/refund conservation, explicit excess, FX conversion and the insufficient-
  credit negative scenario. The retainer probes check units, never contract performance.
- `SHA256SUMS` fixes the exact fixture, source and probe files reviewed with these decisions.

Run from the repository root, without installing packages or starting services:

```sh
python3 docs/plans/evidence/2026-10-08-accounting-discovery/validate.py --negative-controls
```

Expected result: 14 scenarios, 76 balanced events, 30 fiscal documents, one insufficient-credit
refusal, two rounding probes and three retainer probes. Six deliberately corrupted controls must
also be rejected: an unbalanced posting, inconsistent VAT, overspending, wrong FX, a duplicated
scenario and a lost rounding cent. These are arithmetic checks. They do not
prove accounting recognition, VAT entitlement, invoice legality, provider behavior or a production
design. Full runtime suites and browser tests are not applicable to these documentation changes.

The source/base audit used `c0f23c014d0502c44fab9b7ea8b7a748c6b5eee8`. Named draft evidence was
read in sibling checkouts at pinned heads, with no imports or mutations. The decisions identify
those heads and their integration limits. Lint and typecheck were attempted and could not start
because `turbo` is absent in this checkout; no dependencies were installed. The OSS boundary
regression suite and actual boundary script passed. The outside-repository assignment handoff
records exact commands and their outcomes.
