import { beforeEach, describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import type { TaxId } from "../../../lib/compliance"
import { Prisma } from "../../../../generated/prisma/client"
import { Db, Command, type CommandScope } from "../../services"
import { sendInvoice } from "../invoices"
import { requireVatIssuance } from "../../documents/vat-issuance"
import { buildInvoiceSellerSnapshot } from "../../documents/snapshots"
import { sendQuote } from "../quotes"
import { issuanceApproval, issueAgreementOffer } from "../../agreements/issuance"
import { prospectiveRenderInput } from "../../documents/render-input"
import { priceAgreementV2 } from "../../agreements/pricing"
import { createEmailDeliveryAttempt } from "../../../lib/email-delivery"

// Keep the command, identity refresh, pricing and VAT validation real. Observe outward effects.
vi.mock("../../documents/numbering", async importOriginal => ({
  ...await importOriginal<typeof import("../../documents/numbering")>(),
  numberForIssuance: vi.fn(() => Effect.succeed("DOC-0001")),
}))
vi.mock("../../documents/document-delivery", () => ({
  refuseWhileSending: () => Effect.void,
  queueDocumentEmail: vi.fn(() => Effect.succeed({ document: {}, deliveryKey: "delivery" })),
}))
vi.mock("../../../lib/quotes/public-url", () => ({ getPublicQuoteUrl: () => "https://example.test/quote" }))
vi.mock("../../documents/quote-email", async importOriginal => ({
  ...await importOriginal<typeof import("../../documents/quote-email")>(),
  resolveQuoteEmailContext: () => ({ emailDelivery: { available: true } }),
  composeQuoteEmail: vi.fn(() => ({ message: {}, usingBrandedDomain: false })),
}))

import { numberForIssuance } from "../../documents/numbering"
import { queueDocumentEmail } from "../../documents/document-delivery"
import { composeQuoteEmail } from "../../documents/quote-email"

const decimal = (value: string | number) => new Prisma.Decimal(value)
const contact = { id: "buyer", name: "Buyer", email: "buyer@example.test", company: "Buyer ApS", address: "Testvej 2", city: "Copenhagen", zip: "1000", state: null, country: "DK", taxIds: [{ scheme: "vat", value: "DK12345678", countryCode: "DK" }] }
const sellerTaxIds: TaxId[] = [{ scheme: "vat", value: "DK24256790", countryCode: "DK" }, { scheme: "cvr", value: "24256790", countryCode: "DK" }]

function harness({ registered = false, rate = "25", isDeposit = false, tiny = false, exempt = false } = {}) {
  const priced = priceAgreementV2({ currency: "DKK", pricesIncludeTax: false, taxRate: rate, deliverables: [{ title: "Work", description: "Work", quantity: "1", unitPrice: tiny ? "0.01" : "100", isDeposit, vat: { treatment: exempt ? "exempt" : rate === "0" ? "out_of_scope" : "standard", reasonCode: exempt ? "health" : null, rate: rate === "0" ? "0" : "0.25", country: "DK" } }] })
  const items = priced.deliverableRows.map(row => ({ ...row, id: "line", status: "planned", taxCode: null,
    quantity: decimal(row.quantity), unitPriceNet: decimal(row.unitPriceNet), unitPriceGross: decimal(row.unitPriceGross), taxRate: decimal(row.taxRate),
    lineNet: decimal(row.lineNet), lineTax: decimal(row.lineTax), lineGross: decimal(row.lineGross),
  }))
  const document = {
    id: "document", contactId: contact.id, contact, status: "draft", number: null,
    quoteId: null as string | null, agreementId: null as string | null, purpose: "standard", supplyDate: new Date("2026-10-12"),
    title: "Work agreement", summary: null, termsMarkdown: "Work", validUntil: new Date("2099-01-01"), expiryDate: new Date("2099-01-01"),
    timezone: "Europe/Copenhagen", locale: "en-US", countryCode: "DK", currency: "DKK", taxRegime: "eu_vat", taxRate: decimal(rate),
    pricesIncludeTax: false, dueInDays: 30, billingTrigger: "on_acceptance", offerFormatVersion: 2, calculationVersion: "v2",
    subtotalNet: decimal(priced.subtotalNet), totalTax: decimal(priced.totalTax), totalGross: decimal(priced.totalGross),
    sellerSnapshot: { momsRegistered: !registered, taxIds: sellerTaxIds }, buyerSnapshot: { country: "SE", taxIds: [] }, vatEvidence: exempt ? { statementText: "Health exemption" } : {},
    items, deliverables: items, publicAccessIssuedAt: null, publicAccessKeyVersion: 1,
  }
  const settings = { momsRegistered: registered, countryCode: "DK", companyName: "Current Seller", companyEmail: "seller@example.test", companyAddress: "Testvej 1" }
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...document, ...data }))
  const db = {
    $queryRaw: vi.fn(async () => []), invoice: { findFirst: vi.fn(async () => document), update }, quote: { findFirst: vi.fn(async () => document), update }, agreement: { findFirst: vi.fn(async () => document), update },
    contact: { findFirstOrThrow: vi.fn(async () => contact) },
    orgSettings: { upsert: vi.fn(async () => settings) }, organizationTaxId: { findMany: vi.fn(async () => sellerTaxIds) },
  }
  const command: CommandScope = { organizationId: "org", commandId: "command", actor: { kind: "user", organizationId: "org", userId: "user", roles: ["admin"], label: "User" },
    now: new Date("2026-10-12"), approvedByUserId: null, emit: vi.fn(), enqueue: vi.fn() }
  const run = <A, E>(effect: Effect.Effect<A, E, Db | Command>) => Effect.runPromise(Effect.either(effect.pipe(
    Effect.provideService(Db, db as unknown as Prisma.TransactionClient), Effect.provideService(Command, command),
  )))
  return { document, db, command, update, run }
}

beforeEach(() => vi.clearAllMocks())

function expectNoIssuanceEffects(h: ReturnType<typeof harness>) {
  expect(numberForIssuance).not.toHaveBeenCalled()
  expect(h.update).not.toHaveBeenCalled()
  expect(queueDocumentEmail).not.toHaveBeenCalled()
  expect(composeQuoteEmail).not.toHaveBeenCalled()
  expect(h.command.emit).not.toHaveBeenCalled()
  expect(h.command.enqueue).not.toHaveBeenCalled()
}

describe("quote issuance uses the identities it sends", () => {
  it.each([false, true])("refuses stale registered VAT quotes before effects, allowSendWithoutEmail=%s", async allowSendWithoutEmail => {
    const h = harness()
    expect(await h.run(sendQuote.handle({ id: "document", allowSendWithoutEmail }))).toMatchObject({ _tag: "Left", left: { code: "seller_not_vat_registered" } })
    expectNoIssuanceEffects(h)
  })
  it("uses current registration instead of rejecting an old unregistered draft", async () => {
    const h = harness({ registered: true })
    expect(await h.run(sendQuote.handle({ id: "document" }))).toMatchObject({ _tag: "Right" })
    const queued = vi.mocked(queueDocumentEmail).mock.calls[0]![0]
    await queued.markSending(createEmailDeliveryAttempt({ at: h.command.now, outcome: "sending", code: "sending", message: "Sending quote" }))
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sellerSnapshot: expect.objectContaining({ momsRegistered: true, taxIds: sellerTaxIds }), buyerSnapshot: expect.objectContaining({ country: "DK", taxIds: contact.taxIds }) }) }))
  })
  it("allows an unregistered seller's zero-tax quote", async () => {
    const h = harness({ rate: "0" })
    expect(await h.run(sendQuote.handle({ id: "document" }))).toMatchObject({ _tag: "Right" })
  })
})

describe("agreement offers validate current registration before issuance and preparation", () => {
  it.each(["email", "manual"] as const)("refuses VAT for %s issuance and approval before effects", async method => {
    const h = harness()
    expect(await h.run(issuanceApproval({ id: "document" }, method))).toMatchObject({ _tag: "Left", left: { code: "seller_not_vat_registered" } })
    expect(await h.run(issueAgreementOffer({ id: "document" }, method))).toMatchObject({ _tag: "Left", left: { code: "seller_not_vat_registered" } })
    expectNoIssuanceEffects(h)
  })
  it.each([{ isDeposit: true }, { tiny: true }])("rejects VAT schedule lines and rates rounded to zero: %j", async options => {
    const h = harness(options)
    expect(await h.run(issueAgreementOffer({ id: "document" }, "manual"))).toMatchObject({ _tag: "Left", left: { code: "seller_not_vat_registered" } })
    expectNoIssuanceEffects(h)
  })
  it("refuses the preparation input before an artifact can be rendered", async () => {
    const h = harness()
    expect(await h.run(prospectiveRenderInput({ kind: "agreement", documentId: "document", commandInput: {}, number: "AGR-0001", issuedAt: h.command.now, method: "manual" }))).toMatchObject({ _tag: "Left", left: { code: "seller_not_vat_registered" } })
    expectNoIssuanceEffects(h)
  })
  it.each([{ registered: true }, { rate: "0" }])("issues valid registered or zero-tax offers: %j", async options => {
    const h = harness(options)
    expect(await h.run(prospectiveRenderInput({ kind: "agreement", documentId: "document", commandInput: {}, number: "AGR-0001", issuedAt: h.command.now, method: "manual" }))).toMatchObject({ _tag: "Right", right: { snapshot: { sellerSnapshot: { momsRegistered: options.registered ?? false } } } })
    expect(await h.run(issueAgreementOffer({ id: "document" }, "manual"))).toMatchObject({ _tag: "Right" })
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sellerSnapshot: expect.objectContaining({ momsRegistered: options.registered ?? false, taxIds: sellerTaxIds }) }) }))
  })
})

describe("zero-tax exemption cannot bypass nonregistered issuance", () => {
  it("refuses a quote with complete exemption evidence before numbering and delivery", async () => {
    const h = harness({ rate: "0", exempt: true })
    expect(await h.run(sendQuote.handle({ id: "document" }))).toMatchObject({ _tag: "Left", left: { code: "seller_not_vat_registered" } })
    expectNoIssuanceEffects(h)
  })
  it("refuses agreement approval, issuance and artifact preparation before effects", async () => {
    const h = harness({ rate: "0", exempt: true })
    expect(await h.run(issuanceApproval({ id: "document" }, "manual"))).toMatchObject({ _tag: "Left", left: { code: "seller_not_vat_registered" } })
    expect(await h.run(issueAgreementOffer({ id: "document" }, "manual"))).toMatchObject({ _tag: "Left", left: { code: "seller_not_vat_registered" } })
    expect(await h.run(prospectiveRenderInput({ kind: "agreement", documentId: "document", commandInput: {}, number: "AGR-0001", issuedAt: h.command.now, method: "manual" }))).toMatchObject({ _tag: "Left", left: { code: "seller_not_vat_registered" } })
    expectNoIssuanceEffects(h)
  })
})


describe("linked invoice rechecks registration after offer issuance", () => {
  it.each(["quoteId", "agreementId"] as const)("refuses deregistered %s conversion before numbering or delivery", async link => {
    const h = harness()
    h.document[link] = "issued-offer"
    const frozen = structuredClone(h.document.sellerSnapshot)
    expect(await h.run(sendInvoice.handle({ id: "document" }))).toMatchObject({ _tag: "Left", left: { code: "seller_not_vat_registered" } })
    expect(await h.run(prospectiveRenderInput({ kind: "invoice", documentId: "document", commandInput: {}, number: "INV-1", issuedAt: h.command.now }))).toMatchObject({ _tag: "Left", left: { code: "seller_not_vat_registered" } })
    expectNoIssuanceEffects(h)
    expect(h.document.sellerSnapshot).toEqual(frozen)
  })
  it.each(["quoteId", "agreementId"] as const)("rejects VAT-bearing %s conversion with a retained CVR-only identity before effects", async link => {
    const h = harness({ registered: true })
    h.document[link] = "issued-offer"
    h.document.countryCode = "SE"
    h.document.sellerSnapshot = { momsRegistered: false, taxIds: [{ scheme: "cvr", value: "24256790", countryCode: null }] }
    const frozen = structuredClone(h.document.sellerSnapshot)
    // Current IDs contain VAT, but silently substituting them would change agreed identity.
    expect(await h.run(sendInvoice.handle({ id: "document" }))).toMatchObject({ _tag: "Left", left: { code: "evidence_incomplete" } })
    expect(await h.run(prospectiveRenderInput({ kind: "invoice", documentId: "document", commandInput: {}, number: "INV-1", issuedAt: h.command.now }))).toMatchObject({ _tag: "Left", left: { code: "evidence_incomplete" } })
    expectNoIssuanceEffects(h)
    expect(h.document.sellerSnapshot).toEqual(frozen)
  })
  it.each(["quoteId", "agreementId"] as const)("allows zero-tax %s conversion with a retained CVR-only identity", async link => {
    const h = harness({ registered: true, rate: "0" })
    h.document[link] = "issued-offer"
    h.document.sellerSnapshot = { momsRegistered: false, taxIds: [sellerTaxIds[1]!] }
    const seller = buildInvoiceSellerSnapshot(h.document, { companyName: null, companyEmail: null, companyAddress: null, momsRegistered: true }, sellerTaxIds)
    expect(await h.run(requireVatIssuance({ ...h.document, sellerSnapshot: seller }))).toMatchObject({ _tag: "Right" })
  })
  it("accepts a Danish CVR that the electronic invoice renderer can resolve as VAT", async () => {
    const h = harness({ registered: true })
    h.document.quoteId = "issued-offer"
    h.document.sellerSnapshot = { momsRegistered: false, taxIds: [sellerTaxIds[1]!] }
    const seller = buildInvoiceSellerSnapshot(h.document, { companyName: null, companyEmail: null, companyAddress: null, momsRegistered: true }, sellerTaxIds)
    expect(await h.run(requireVatIssuance({ ...h.document, sellerSnapshot: seller }))).toMatchObject({ _tag: "Right" })
  })
  it("retains agreed identity while applying current registration without mutating history", () => {
    const saved = { companyName: "Agreed Seller", companyAddress: "Agreed address", taxIds: sellerTaxIds, momsRegistered: true }
    const settings = { companyName: "Changed Seller", companyAddress: "Changed address", companyEmail: null, momsRegistered: false }
    expect(buildInvoiceSellerSnapshot({ quoteId: "offer", sellerSnapshot: saved }, settings, [])).toEqual({ ...saved, momsRegistered: false })
    expect(saved.momsRegistered).toBe(true)
  })
})
