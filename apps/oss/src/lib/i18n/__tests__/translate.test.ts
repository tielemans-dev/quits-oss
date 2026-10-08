import { describe, expect, it } from "vitest"
import { resolveLanguage, translate } from "../translate"

describe("i18n translate", () => {
  it("resolves supported language from locale", () => {
    expect(resolveLanguage("da-DK")).toBe("da")
    expect(resolveLanguage("en-US")).toBe("en")
    expect(resolveLanguage("fr-FR")).toBe("en")
  })

  it("returns danish translation when locale is da", () => {
    expect(translate("nav.dashboard", "da-DK")).toBe("Overblik")
  })

  it("falls back to english translation", () => {
    expect(translate("nav.dashboard", "fr-FR")).toBe("Dashboard")
  })

  it("interpolates variables", () => {
    expect(translate("auth.welcome", "da-DK", { name: "Martin" })).toBe(
      "Velkommen, Martin"
    )
  })

  it("returns localized contacts labels", () => {
    expect(translate("contacts.title", "en-US")).toBe("Contacts")
    expect(translate("contacts.title", "da-DK")).toBe("Kunder")
  })

  it("interpolates contact delete confirmation", () => {
    expect(
      translate("contacts.delete.description", "en-US", { name: "Emil" })
    ).toBe(
      "Are you sure you want to delete Emil? This action cannot be undone."
    )
    expect(
      translate("contacts.delete.description", "da-DK", { name: "Emil" })
    ).toBe(
      "Er du sikker på, at du vil slette Emil? Denne handling kan ikke fortrydes."
    )
  })

  it("returns localized accept-invitation status", () => {
    expect(translate("acceptInvitation.pending.title", "en-US")).toBe(
      "Accepting invitation"
    )
    expect(translate("acceptInvitation.pending.title", "da-DK")).toBe(
      "Accepterer invitation"
    )
  })

  it("returns localized billing title", () => {
    expect(translate("billing.title", "en-US")).toBe("Billing")
    expect(translate("billing.title", "da-DK")).toBe("Abonnement")
  })

  it("interpolates invoice delete confirmation", () => {
    expect(
      translate("invoices.delete.description", "en-US", { number: "INV-001" })
    ).toBe(
      "Are you sure you want to delete invoice INV-001? This action cannot be undone."
    )
    expect(
      translate("invoices.delete.description", "da-DK", { number: "INV-001" })
    ).toBe(
      "Er du sikker på, at du vil slette faktura INV-001? Denne handling kan ikke fortrydes."
    )
  })

  it("returns localized quote accepted status", () => {
    expect(translate("quotes.status.accepted", "en-US")).toBe("Accepted")
    expect(translate("quotes.status.accepted", "da-DK")).toBe("Accepteret")
  })

  it("returns localized shared document form labels", () => {
    expect(translate("docForm.contact", "en-US")).toBe("Contact")
    expect(translate("docForm.contact", "da-DK")).toBe("Kontakt")
  })

  it("returns localized invoice ai action labels", () => {
    expect(translate("invoices.new.ai.action.generate", "en-US")).toBe(
      "Generate Draft"
    )
    expect(translate("invoices.new.ai.action.generate", "da-DK")).toBe(
      "Generer kladde"
    )
  })

  it("returns localized quote expiry validation", () => {
    expect(
      translate("quotes.new.validation.expiryDateRequired", "en-US")
    ).toBe("Please set an expiry date")
    expect(
      translate("quotes.new.validation.expiryDateRequired", "da-DK")
    ).toBe("Angiv venligst en udløbsdato")
  })

  it("returns localized invoice detail actions", () => {
    expect(translate("invoices.detail.action.markPaid", "en-US")).toBe(
      "Mark as Paid"
    )
    expect(translate("invoices.detail.action.markPaid", "da-DK")).toBe(
      "Marker som betalt"
    )
  })

  it("returns localized invoice detail not-found message", () => {
    expect(translate("invoices.detail.error.notFound", "en-US")).toBe(
      "Invoice not found"
    )
    expect(translate("invoices.detail.error.notFound", "da-DK")).toBe(
      "Faktura blev ikke fundet"
    )
  })

  it("returns localized quote detail convert action", () => {
    expect(translate("quotes.detail.action.convertToInvoice", "en-US")).toBe(
      "Convert to Invoice"
    )
    expect(translate("quotes.detail.action.convertToInvoice", "da-DK")).toBe(
      "Konverter til faktura"
    )
  })

  it("returns localized quote detail not-found message", () => {
    expect(translate("quotes.detail.error.notFound", "en-US")).toBe(
      "Quote not found"
    )
    expect(translate("quotes.detail.error.notFound", "da-DK")).toBe(
      "Tilbud blev ikke fundet"
    )
  })

  it("returns localized quote detail title", () => {
    expect(translate("quotes.detail.title", "en-US")).toBe("Quote")
    expect(translate("quotes.detail.title", "da-DK")).toBe("Tilbud")
  })

  it("returns localized settings title", () => {
    expect(translate("settings.title", "en-US")).toBe("Settings")
    expect(translate("settings.title", "da-DK")).toBe("Indstillinger")
  })

  it("interpolates settings member removal description", () => {
    expect(
      translate("settings.team.remove.description", "en-US", {
        name: "Emil",
      })
    ).toBe("Emil will lose access to this organization immediately.")
    expect(
      translate("settings.team.remove.description", "da-DK", {
        name: "Emil",
      })
    ).toBe("Emil mister adgang til organisationen med det samme.")
  })
})
