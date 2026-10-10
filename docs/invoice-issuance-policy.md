# Invoice issuance policy

New invoices print seller identifiers, seller and buyer postal identity, issue and supply dates, stored net unit prices, and the stored net, tax-rate, tax and gross breakdown. Issued artifacts remain immutable. Sparse historical data is not backfilled by this change.

An operator may restrict new invoice issuance through `RuntimeExtension.resolveInvoiceIssuancePolicy`, exported with its context and result types from `@quits/oss/runtime/extensions`. With no hook, the existing self-host invoice scope is preserved. This hook does not authorize account access, purchases or jobs, and does not affect reminders, read/export, existing payment links or resends.

The hook receives the organization ID and the effective seller and buyer snapshots. Agreement- and accepted-quote-backed invoices retain their agreed identities. Other invoices freeze current identities at issuance. Payment details still come from issuance-time settings. The hook runs before artifact preparation and again under commit locks, before the invoice number is allocated or delivery effects are queued. Manual, API, agent approval and recurring auto-send use this issuance path.

For a Danish VAT-registered seller issuing ordinary domestic business invoices, an adopter can return:

```ts
{
  sellerCountry: "DK",
  buyerCountries: ["DK"],
  currencies: ["DKK", "EUR"],
  standardVatRate: "25",
  requireCvr: true,
  requireBusinessBuyer: true,
  requireIdentity: true,
  requireSupplyDate: true,
  sellerVatRegistered: registrationConfirmedForThisEffectiveSeller,
}
```

`standardVatRate` is a nominal percentage. A line without an explicit VAT country uses the document's country; an explicitly foreign country is rejected. Nonstandard treatments, mixed/exempt supplies, other currencies and other purposes are rejected with `invoice_issuance_policy` and an actionable message. Existing monetary validation remains separate.

`registrationConfirmedForThisEffectiveSeller` must be affirmative evidence for the seller passed to the hook. A CVR is a national identifier, not evidence that the business is VAT registered. The current organization settings and tax-ID rows have no explicit VAT-registration status or confirmation history. The adopter must collect/store that missing datum and associate it with the effective seller identity. It must return false or leave confirmation absent until that requirement is satisfied. Changing settings must not turn an old agreement seller's CVR into confirmation for a different seller. Missing frozen country or identity data on an old agreement/quote also requires correction through a new supported document; this change does not manufacture historical values.

Adoption requires a published OSS release containing this contract, a dependency bump to that released artifact, registration confirmation storage/collection and policy wiring on every runtime handling commands or recurring jobs. Until adoption, the restrictions are inactive. Local testing may use the documented sibling-link workflow, but committed dependencies and CI must use the published package. No hosted configuration or private implementation belongs in this repository.

The supported invoice-field baseline comes from [Skattestyrelsen A.B.3.3.1.4](https://info.skat.dk/data.aspx?oid=2068789) and [momsbekendtgørelsen §§58, 62 and 97](https://www.retsinformation.dk/eli/lta/2023/1435). This bounded scope does not add support for special tax schemes, exempt/mixed invoice presentation or non-DKK/non-EUR Danish VAT reporting. Those existing self-host capabilities are not restricted by default, and this change does not claim their invoices meet every Danish special-case rule.
