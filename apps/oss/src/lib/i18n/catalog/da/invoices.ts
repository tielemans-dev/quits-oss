export const daInvoicesMessages = {
  "invoices.title": "Fakturaer",
  "invoices.loading": "Indlæser...",
  "invoices.action.new": "Ny faktura",
  "invoices.action.create": "Opret faktura",
  "invoices.empty.title": "Ingen fakturaer endnu",
  "invoices.empty.description":
    "Opret din første faktura for at begynde at fakturere dine kunder.",
  "invoices.table.number": "Nummer",
  "invoices.table.contact": "Kontakt",
  "invoices.table.issueDate": "Udstedelsesdato",
  "invoices.table.dueDate": "Forfaldsdato",
  "invoices.table.total": "Total",
  "invoices.table.status": "Status",
  "invoices.status.draft": "Kladde",
  "invoices.status.sent": "Sendt",
  "invoices.status.paid": "Betalt",
  "invoices.status.overdue": "Forfalden",
  "invoices.delete.title": "Slet faktura",
  "invoices.delete.description":
    "Er du sikker på, at du vil slette faktura {number}? Denne handling kan ikke fortrydes.",
  "invoices.action.cancel": "Annuller",
  "invoices.action.delete": "Slet",
  "invoices.new.title": "Ny faktura",
  "invoices.new.field.dueDate": "Forfaldsdato",
  "invoices.new.validation.dueDateRequired":
    "Angiv venligst en forfaldsdato",
  "invoices.new.error.createFailed": "Kunne ikke oprette faktura",
  "invoices.new.notes.placeholder":
    "Betalingsbetingelser, takkenote osv.",
  "invoices.new.ai.label": "Kladde med AI",
  "invoices.new.ai.placeholder":
    "Eksempel: Opret en faktura til Acme for 8 timers design á 1200 DKK/time, forfalder om 14 dage.",
  "invoices.new.ai.action.generate": "Generer kladde",
  "invoices.new.ai.action.generating": "Genererer...",
  "invoices.new.ai.availability.checking":
    "Tjekker AI-tilgængelighed...",
  "invoices.new.ai.availability.disabled":
    "AI BYOK er i øjeblikket deaktiveret for denne distribution.",
  "invoices.new.ai.error.promptRequired":
    "Beskriv først fakturaen.",
  "invoices.new.ai.error.generateFailed":
    "Kunne ikke generere kladde med AI.",
  "invoices.new.ai.info.contactNotMatched":
    "Kladde genereret. Kontakt \"{name}\" blev ikke matchet automatisk.",
  "invoices.detail.editTitle": "Rediger faktura",
  "invoices.detail.companyLogoAlt": "Virksomhedslogo",
  "invoices.detail.warning.emailSkipped":
    "Faktura markeret som sendt — e-mail ikke leveret: {reason}",
  "invoices.detail.error.notFound": "Faktura blev ikke fundet",
  "invoices.detail.error.updateFailed": "Kunne ikke opdatere faktura",
  "invoices.detail.error.sendFailed": "Kunne ikke sende faktura",
  "invoices.detail.error.markPaidFailed": "Kunne ikke markere som betalt",
  "invoices.detail.error.paymentLinkFailed": "Kunne ikke oprette betalingslink",
  "invoices.detail.error.deleteFailed": "Kunne ikke slette faktura",
  "invoices.detail.error.pdfFailed": "Kunne ikke generere PDF",
  "invoices.detail.action.back": "Tilbage til fakturaer",
  "invoices.detail.action.print": "Udskriv",
  "invoices.detail.action.edit": "Rediger",
  "invoices.detail.action.send": "Send",
  "invoices.detail.action.resendEmail": "Send e-mail igen",
  "invoices.detail.action.sending": "Sender...",
  "invoices.detail.action.createPaymentLink": "Opret betalingslink",
  "invoices.detail.action.generatingPaymentLink": "Opretter link...",
  "invoices.detail.action.delete": "Slet",
  "invoices.detail.action.updating": "Opdaterer...",
  "invoices.detail.action.markPaid": "Marker som betalt",
  "invoices.detail.email.title": "E-maillevering",
  "invoices.detail.email.description":
    "Send eller gensend kunde-e-mailen for denne faktura.",
  "invoices.detail.email.status.sent": "Sendt",
  "invoices.detail.email.status.skipped": "Sprunget over",
  "invoices.detail.email.status.failed": "Mislykket",
  "invoices.detail.email.lastAttempt": "Sidste forsøg: {status} den {at}",
  "invoices.detail.email.reason.sent": "Faktura-e-mail sendt.",
  "invoices.detail.email.reason.provider_missing":
    "E-maillevering er ikke konfigureret.",
  "invoices.detail.email.reason.send_failed":
    "E-maillevering mislykkedes.",
  "invoices.detail.email.degraded.trigger": "Send uden e-mail",
  "invoices.detail.email.degraded.title": "E-maillevering er utilgængelig",
  "invoices.detail.email.degraded.description":
    "Dette markerer fakturaen som sendt uden at levere en e-mail.",
  "invoices.detail.email.degraded.confirm": "Fortsæt uden e-mail",
  "invoices.detail.email.degraded.cancel": "Annuller",
  "invoices.detail.email.fallback.invalidRecipient.title":
    "Kundens e-mail mangler eller er ugyldig",
  "invoices.detail.email.fallback.invalidRecipient.description":
    "Tilføj en gyldig kunde-e-mailadresse før afsendelse, eller del betalingslinket manuelt.",
  "invoices.detail.email.fallback.invalidRecipient.descriptionNoLink":
    "Tilføj en gyldig kunde-e-mailadresse før du sender denne faktura.",
  "invoices.detail.email.fallback.invalidRecipient.fix": "Ret kontakt",
  "invoices.detail.email.fallback.providerMissing.title":
    "E-maillevering er ikke konfigureret",
  "invoices.detail.email.fallback.providerMissing.description":
    "Du kan stadig dele betalingslinket manuelt.",
  "invoices.detail.paymentLink.title": "Betalingslink til kunde",
  "invoices.detail.paymentLink.description":
    "Del dette hostede link med kunden for at modtage betaling via Stripe.",
  "invoices.detail.paymentLink.copy": "Kopiér link",
  "invoices.detail.email.status.sending": "Sender",
  "invoices.detail.email.reason.sending": "Afsendelsen blev afbrudt, før den blev bekræftet. Send igen for at fuldføre; kunden får ikke en dublet. Indtil da kan fakturaen ikke redigeres.",
} as const
