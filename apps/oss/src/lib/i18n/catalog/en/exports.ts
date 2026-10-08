/** Owned by the exports feature. */
export const enExportsMessages = {
  "exports.einvoice.title": "E-invoice",
  "exports.einvoice.description":
    "Download this invoice as a Peppol BIS Billing 3.0 (UBL) file for e-invoicing networks and accounting systems.",
  "exports.einvoice.download": "Download e-invoice (UBL)",
  "exports.einvoice.preparing": "Preparing...",
  "exports.einvoice.error": "Could not create the e-invoice.",
  "exports.einvoice.missing.title": "Add these details before downloading the e-invoice:",
  "exports.einvoice.missing.document.notIssued": "Send or issue the document first. Drafts cannot be exported.",
  "exports.einvoice.missing.document.lines": "The document needs at least one line.",
  "exports.einvoice.missing.seller.name": "Your company name (Settings).",
  "exports.einvoice.missing.seller.country": "Your company country (Settings).",
  "exports.einvoice.missing.seller.address": "Your company address (Settings).",
  "exports.einvoice.missing.seller.taxId": "Your company VAT number (Settings).",
  "exports.einvoice.missing.seller.legalId":
    "Your CVR number. Danish e-invoices must carry it: add a CVR tax ID or a DK VAT number (Settings).",
  "exports.einvoice.missing.seller.legalIdInvalid":
    "Your company registration number (CVR, GLN or DUNS tax ID) is not valid for its scheme, e.g. a wrong check digit. Correct it in Settings.",
  "exports.einvoice.missing.seller.electronicAddress":
    "Your Peppol electronic address. It is derived from your VAT number for supported countries.",
  "exports.einvoice.missing.seller.electronicAddressInvalid":
    "Your Peppol electronic address is not valid. Check your VAT number (Settings).",
  "exports.einvoice.missing.seller.paymentMeansCode":
    "The payment means is not allowed between two Danish parties (DK-R-005). Check your bank details (Settings).",
  "exports.einvoice.missing.seller.paymentAccountBranch":
    "A Danish bank transfer needs both the account and the bank branch (DK-R-006): add the registration number and account number (Settings).",
  "exports.einvoice.missing.buyer.name": "The customer's name.",
  "exports.einvoice.missing.buyer.country": "The customer's country (use a country name or 2-letter code).",
  "exports.einvoice.missing.buyer.address": "The customer's street address or city.",
  "exports.einvoice.missing.buyer.legalIdInvalid":
    "The customer's registration number (CVR, GLN or DUNS tax ID) is not valid for its scheme, e.g. a wrong check digit. Correct it on the customer.",
  "exports.einvoice.missing.buyer.electronicAddress":
    "The customer's Peppol endpoint ID and scheme, or a VAT number they can be reached by.",
  "exports.einvoice.missing.buyer.electronicAddressInvalid":
    "The customer's Peppol endpoint is not valid: use a scheme from the Peppol EAS code list and an ID in that scheme's format.",
  "exports.einvoice.missing.creditNote.invoiceReference": "The credited invoice must be issued.",
  "exports.einvoice.editContact": "Edit customer",
  "exports.accounting.title": "Accounting export",
  "exports.accounting.description":
    "Download invoices, credit notes, or payments for a period as CSV for your bookkeeping. Dates use your organization's time zone.",
  "exports.accounting.from": "From",
  "exports.accounting.to": "To",
  "exports.accounting.dataset": "Data",
  "exports.accounting.dataset.invoices": "Invoices",
  "exports.accounting.dataset.creditNotes": "Credit notes",
  "exports.accounting.dataset.settlements": "Settlement events",
  "exports.accounting.dataset.payments": "Payments",
  "exports.accounting.download": "Download CSV",
  "exports.accounting.preparing": "Preparing...",
  "exports.accounting.invalidRange": "The start date must be on or before the end date.",
  "exports.accounting.error": "Could not create the export.",
  "exports.accounting.forbidden": "Your role does not allow exports.",
  "exports.contact.peppolEndpointId": "Peppol endpoint ID",
  "exports.contact.peppolEndpointScheme": "Peppol scheme (EAS)",
  "exports.contact.peppolEndpointId.placeholder": "5790000000005",
  "exports.contact.peppolEndpointScheme.placeholder": "0088",
  "exports.contact.peppolEndpointScheme.invalid": "Use a Peppol EAS code from the code list, e.g. 0088 or 0184.",
  "exports.contact.peppolEndpointId.invalid": "This endpoint ID does not match the selected scheme.",
  "exports.contact.peppolEndpoint.incomplete": "Enter both the Peppol endpoint ID and scheme, or leave both empty.",
  "exports.contact.peppolHint":
    "Used for e-invoices sent over Peppol. Leave empty to derive it from the customer's VAT number where possible.",
} as const
