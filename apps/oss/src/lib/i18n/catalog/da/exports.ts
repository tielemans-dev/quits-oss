/** Owned by the exports feature. */
export const daExportsMessages = {
  "exports.einvoice.title": "E-faktura",
  "exports.einvoice.description":
    "Download fakturaen som en Peppol BIS Billing 3.0-fil (UBL) til e-fakturanetværk og regnskabssystemer.",
  "exports.einvoice.download": "Download e-faktura (UBL)",
  "exports.einvoice.preparing": "Forbereder...",
  "exports.einvoice.error": "E-fakturaen kunne ikke oprettes.",
  "exports.einvoice.missing.title": "Tilføj disse oplysninger, før e-fakturaen kan downloades:",
  "exports.einvoice.missing.document.notIssued": "Send eller udsted dokumentet først. Kladder kan ikke eksporteres.",
  "exports.einvoice.missing.document.lines": "Dokumentet skal have mindst én linje.",
  "exports.einvoice.missing.seller.name": "Jeres virksomhedsnavn (Indstillinger).",
  "exports.einvoice.missing.seller.country": "Jeres virksomheds land (Indstillinger).",
  "exports.einvoice.missing.seller.address": "Jeres virksomheds adresse (Indstillinger).",
  "exports.einvoice.missing.seller.taxId": "Jeres momsnummer (Indstillinger).",
  "exports.einvoice.missing.seller.legalId":
    "Jeres CVR-nummer. Danske e-fakturaer skal have det: tilføj et CVR-nummer eller et DK-momsnummer (Indstillinger).",
  "exports.einvoice.missing.seller.legalIdInvalid":
    "Jeres registreringsnummer (CVR, GLN eller DUNS) er ugyldigt for sit skema, fx et forkert kontrolciffer. Ret det under Indstillinger.",
  "exports.einvoice.missing.seller.electronicAddress":
    "Jeres elektroniske Peppol-adresse. Den udledes af momsnummeret for understøttede lande.",
  "exports.einvoice.missing.seller.electronicAddressInvalid":
    "Jeres elektroniske Peppol-adresse er ugyldig. Kontrollér momsnummeret (Indstillinger).",
  "exports.einvoice.missing.buyer.name": "Kundens navn.",
  "exports.einvoice.missing.buyer.country": "Kundens land (brug et landenavn eller en landekode på 2 bogstaver).",
  "exports.einvoice.missing.buyer.address": "Kundens adresse eller by.",
  "exports.einvoice.missing.buyer.legalIdInvalid":
    "Kundens registreringsnummer (CVR, GLN eller DUNS) er ugyldigt for sit skema, fx et forkert kontrolciffer. Ret det på kunden.",
  "exports.einvoice.missing.buyer.electronicAddress":
    "Kundens Peppol-endpoint-id og -skema eller et momsnummer, kunden kan modtage på.",
  "exports.einvoice.missing.buyer.electronicAddressInvalid":
    "Kundens Peppol-endpoint er ugyldigt: brug et skema fra Peppols EAS-kodeliste og et id i skemaets format.",
  "exports.einvoice.missing.creditNote.invoiceReference": "Den krediterede faktura skal være udstedt.",
  "exports.einvoice.editContact": "Rediger kunde",
  "exports.accounting.title": "Regnskabseksport",
  "exports.accounting.description":
    "Download fakturaer, kreditnotaer eller betalinger for en periode som CSV til bogføringen. Datoer følger organisationens tidszone.",
  "exports.accounting.from": "Fra",
  "exports.accounting.to": "Til",
  "exports.accounting.dataset": "Data",
  "exports.accounting.dataset.invoices": "Fakturaer",
  "exports.accounting.dataset.creditNotes": "Kreditnotaer",
  "exports.accounting.dataset.payments": "Betalinger",
  "exports.accounting.download": "Download CSV",
  "exports.accounting.preparing": "Forbereder...",
  "exports.accounting.invalidRange": "Startdatoen skal ligge før eller på slutdatoen.",
  "exports.accounting.error": "Eksporten kunne ikke oprettes.",
  "exports.accounting.forbidden": "Din rolle giver ikke adgang til eksport.",
  "exports.contact.peppolEndpointId": "Peppol-endpoint-id",
  "exports.contact.peppolEndpointScheme": "Peppol-skema (EAS)",
  "exports.contact.peppolEndpointId.placeholder": "5790000000005",
  "exports.contact.peppolEndpointScheme.placeholder": "0088",
  "exports.contact.peppolEndpointScheme.invalid": "Brug en Peppol EAS-kode fra kodelisten, f.eks. 0088 eller 0184.",
  "exports.contact.peppolEndpointId.invalid": "Endpoint-id'et passer ikke til det valgte skema.",
  "exports.contact.peppolEndpoint.incomplete": "Udfyld både Peppol-endpoint-id og -skema, eller lad begge stå tomme.",
  "exports.contact.peppolHint":
    "Bruges til e-fakturaer sendt via Peppol. Lad feltet stå tomt for at udlede det af kundens momsnummer, hvor det er muligt.",
} as const
