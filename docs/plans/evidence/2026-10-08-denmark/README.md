# Danish discovery fixture evidence

Research date: 8 October 2026. These are synthetic fixtures for issues #27 and #28. They establish
specific output and schematron results only. No provider exchange, recipient acceptance, qualified
accounting review or legal approval occurred.

`inputs.json` preserves the four exact `buildUblDocument` inputs from the first research round,
including a copy of the existing legacy DK-to-DE fixture. Names, amounts and addresses are synthetic.
The public GLN is the documented Nemhandel demo identity; it is not a verified OpenPeppol test endpoint.
`xml/` preserves the original four outputs byte-for-byte. The two negative controls have only
trailing spaces on blank lines removed for repository whitespace checks; their XML content is
unchanged. The original control files remain in the parent's first-round evidence.

## Reproduce

From the repository root with its existing Bun dependencies:

```sh
bun docs/plans/evidence/2026-10-08-denmark/check-fixtures.ts
```

This calls the current builder and field validator, compares all four outputs with the preserved XML,
and verifies the two invalid mutations. It fails if a fixture changes. It never sends anything.

Download the official
[CIUS 1.17.0 archive](https://git.erst.dk/openebusiness/common/-/raw/master/released/peppol/PEPPOL_DK_CIUS_2026-08-03_v1.17.0.ff275f9.zip)
from the [ERST release directory](https://git.erst.dk/openebusiness/common/-/tree/master/released/peppol).
Its SHA-256 must be
`1e7d01804fcc8e2f1e3464201566a589d5e5c7b24f1362971539b4d0699ab9ba`.
Use a Python environment with `saxonche==13.0.0`, and an owned writable temporary directory:

```sh
TMPDIR=/absolute/owned/tmp /path/to/python-with-saxonche \
  docs/plans/evidence/2026-10-08-denmark/validate.py /absolute/path/to/cius.zip
```

The validator verifies the archive hash, extracts only its three named schematron XSLTs into a
temporary directory, and compares parsed SVRL failed assertions with the expected IDs and severity.
It rejects an incorrect archive, malformed/non-SVRL output, unexpected warnings or different failures.
Exit 0 means the complete expected matrix matched, including the deliberately invalid controls.
Exit 1 means it did not. Temporary extraction is removed on exit. No vendor package or environment is
vendored here. Follow the project's resource queue when installing dependencies.

## Recorded result

On main `c0f23c014d0502c44fab9b7ea8b7a748c6b5eee8` plus this discovery branch:

| Fixture | CEN EN 16931 | Peppol EN 16931 | Danish CIUS |
| --- | --- | --- | --- |
| `dk-b2b-invoice` | No failures | No failures | No failures |
| `dk-public-gln-invoice` | No failures | No failures | No failures |
| `dk-b2b-credit-note` | No failures | No failures | No failures |
| `legacy-fixture-dk-to-de` | No failures | No failures | No failures |
| `negative-control` | No failures | Fatal `DK-R-005` | No failures |
| `negative-control-2` | Fatal `BR-06` | Fatal `DK-R-002`, `PEPPOL-EN16931-R003` | No failures |

SaxonC-HE 13.0 reported no warnings for these six fixtures. The four generated outputs were
byte-identical to the first-round outputs after the PDF/VAT fix merged. `SHA256SUMS` covers the
preserved inputs and XML. Verify it from this directory with `sha256sum --check SHA256SUMS`.

The first negative control changes payment code 42 to 30 and removes BuyerReference while retaining
OrderReference, so only the payment rule fails. The second removes BuyerReference, OrderReference and
the seller's PartyLegalEntity; it retains payment code 42. It therefore also loses the seller's
RegistrationName and triggers BR-06. These are the original mutations, with only blank-line whitespace normalized in the copied files.

The original round also checked the official package's example invoice and credit note, with one
CEN warning each. Those vendor examples are outside this regression matrix. The historical registry
sample is also separate; no raw receiver lists or private deployment details accompany this bundle.

The contract regression command, from `packages/contracts`, is:

```sh
node_modules/.bin/vitest run src/einvoice-delivery.test.ts
```

To repeat the parent's three recovery cases with the explicit acknowledgment events, run
`bun docs/plans/evidence/2026-10-08-denmark/reconcile-probe.ts` from the repository root. All three
assert `queued` with next action `wait`. The original parent probe used `submitted` for all cases;
that event deliberately remains unable to resolve unknown state or acknowledge a retry.

The tests cover uncertainty, explicit retry acknowledgment, required correction review for both document
kinds and recipient-requirement fallback decisions. These are pure contract tests, not evidence of a
provider adapter, execution-journal integration or actual financial correction.
