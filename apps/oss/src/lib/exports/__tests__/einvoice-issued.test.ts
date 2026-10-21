// MOCK: synthetic organization, parties, CVRs and amounts only.
import { beforeEach, describe, expect, it, vi } from "vitest"

const rows = vi.hoisted(() => ({ invoice: null as Record<string, unknown> | null }))
vi.mock("../../db", () => ({ prisma: {
  invoice: { findFirst: async () => rows.invoice },
  orgSettings: { findUnique: async () => ({ companyName: "Synthetic Seller ApS", companyAddress: "Testvej 1\n9000 Aalborg", companyEmail: null, countryCode: "DK", momsRegistered: true }) },
  organizationTaxId: { findMany: async () => [{ scheme: "cvr", value: "12345674", countryCode: "DK", isPrimary: true }] },
} }))
const { EinvoiceArtifactUnavailable, exportEinvoice } = await import("../einvoice")

const contact = { name: "Synthetic Buyer", email: null, company: "Synthetic Buyer ApS", address: "Testvej 2", city: "Aalborg", state: null, zip: "9000",
  country: "DK", taxId: "87654328", peppolEndpointId: null, peppolEndpointScheme: null, taxIds: [] }
const line = { description: "Design", quantity: "1", unitPriceNet: "100", lineNet: "100", taxRate: "25", taxCategory: "standard", vatTreatment: "standard", vatReasonCode: null, vatCountry: null, vatRateInput: "0.25" }
/** An invoice issued before its e-invoice was stored: it has a PDF but no UBL artifact. */
const issuedInvoice = (overrides: Record<string, unknown> = {}) => ({ status: "sent", number: "2026-0005", artifactUblRef: null, artifactUblHash: null,
  issueDate: new Date("2026-10-21"), dueDate: new Date("2026-11-04"), supplyDate: null, timezone: "Europe/Copenhagen", currency: "DKK", countryCode: "DK",
  taxRegime: "eu_vat", locale: "da-DK", notes: null, purchaseOrderRef: null, paymentReference: null, calculationVersion: "legacy_per_line",
  sellerSnapshot: { companyName: "Synthetic Seller ApS", companyAddress: "Testvej 1\n9000 Aalborg", countryCode: "DK", momsRegistered: true, taxIds: [{ scheme: "cvr", value: "12345674", countryCode: "DK" }] },
  buyerSnapshot: null, contact, items: [line], totalGross: "125", amountPaid: "0", ...overrides })

describe("e-invoice download of an issued invoice without a stored UBL", () => {
  beforeEach(() => { rows.invoice = null })
  it("names what the invoice lacked, so the interface can say it in the user's language", async () => {
    rows.invoice = issuedInvoice({ contact: { ...contact, taxId: null } })
    expect(await exportEinvoice("org", "invoice", "inv")).toEqual({ ok: false, issued: true, missing: ["buyer.electronicAddress"] })
  })
  it("reports VAT that no e-invoice category can carry", async () => {
    rows.invoice = issuedInvoice({ items: [{ ...line, taxRate: "0", taxCategory: "unclassified_zero", vatTreatment: "unclassified_zero", vatRateInput: "0" }] })
    expect(await exportEinvoice("org", "invoice", "inv")).toEqual({ ok: false, issued: true, missing: ["document.vatUnclassified"] })
  })
  it("still refuses to render a complete issued invoice again", async () => {
    rows.invoice = issuedInvoice()
    await expect(exportEinvoice("org", "invoice", "inv")).rejects.toBeInstanceOf(EinvoiceArtifactUnavailable)
  })
})
