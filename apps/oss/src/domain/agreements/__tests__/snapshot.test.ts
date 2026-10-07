import { describe, expect, it } from "vitest"
import { Prisma, type Agreement, type Deliverable } from "../../../../generated/prisma/client"
import { buildOfferSnapshot, canonicalizeOffer, hashOfferSnapshot } from "../snapshot"

function fixture() {
  const decimal = (value: string) => new Prisma.Decimal(value)
  const line = {
    id: "line",
    title: "Website",
    description: "Design",
    quantity: decimal("1"),
    unitPriceNet: decimal("100.5"),
    unitPriceGross: decimal("125.625"),
    lineNet: decimal("100.5"),
    lineTax: decimal("25.13"),
    lineGross: decimal("125.63"),
    taxRate: decimal("25"),
    taxCategory: "standard",
    taxCode: null,
    agreedDate: new Date("2026-11-01"),
    expectedDate: new Date("2026-11-02"),
    isDeposit: false,
    sortOrder: 0,
  } as Deliverable
  return {
    title: "Design project",
    summary: "A new website",
    termsMarkdown: "**{{buyer.name}}** agrees to {{agreement.title}} for {{agreement.total}}.",
    validUntil: new Date("2026-10-31"),
    timezone: "Europe/Copenhagen",
    currency: "DKK",
    countryCode: "DK",
    locale: "da-DK",
    taxRegime: "eu_vat",
    taxRate: decimal("25"),
    pricesIncludeTax: false,
    dueInDays: 30,
    billingTrigger: "on_acceptance",
    subtotalNet: decimal("100.5"),
    totalTax: decimal("25.13"),
    totalGross: decimal("125.63"),
    sellerSnapshot: { companyName: "Seller", companyEmail: null, companyAddress: null, taxIds: [] },
    buyerSnapshot: {
      name: "Buyer",
      email: null,
      company: null,
      address: null,
      city: null,
      state: null,
      zip: null,
      country: null,
    },
    deliverables: [line],
    notes: "private",
    number: null,
    status: "draft",
    offerRevision: 0,
  } as unknown as Agreement & { deliverables: Deliverable[] }
}
const hash = (value: ReturnType<typeof fixture>) => hashOfferSnapshot(buildOfferSnapshot(value))
describe("canonical offer snapshot", () => {
  it("sorts nested keys while preserving array order", () => {
    expect(canonicalizeOffer({ z: [2, { z: 1, a: "x" }], a: null })).toBe(
      '{"a":null,"z":[2,{"a":"x","z":1}]}',
    )
    expect(canonicalizeOffer({ a: null, z: [2, { a: "x", z: 1 }] })).toBe(
      canonicalizeOffer({ z: [2, { z: 1, a: "x" }], a: null }),
    )
  })
  it("uses fixed-point decimals, ISO dates, rendered terms and the explicit field allowlist", () => {
    const snapshot = buildOfferSnapshot(fixture())
    expect(snapshot).toMatchObject({
      validUntil: "2026-10-31T00:00:00.000Z",
      taxRate: "25.00",
      subtotalNet: "100.50",
      totalTax: "25.13",
      totalGross: "125.63",
      termsHtml: "<p><strong>Buyer</strong> agrees to Design project for 125.63 DKK.</p>\n",
    })
    expect(snapshot.deliverables[0]).toMatchObject({
      quantity: "1.00",
      unitPriceNet: "100.50",
      unitPriceGross: "125.63",
      agreedDate: "2026-11-01T00:00:00.000Z",
    })
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        "sellerSnapshot",
        "buyerSnapshot",
        "title",
        "summary",
        "termsHtml",
        "validUntil",
        "timezone",
        "currency",
        "countryCode",
        "locale",
        "taxRegime",
        "taxRate",
        "pricesIncludeTax",
        "dueInDays",
        "billingTrigger",
        "subtotalNet",
        "totalTax",
        "totalGross",
        "deliverables",
      ].sort(),
    )
    expect(Object.keys(snapshot.deliverables[0]!).sort()).toEqual(
      [
        "title",
        "description",
        "quantity",
        "unitPriceNet",
        "unitPriceGross",
        "lineNet",
        "lineTax",
        "lineGross",
        "taxRate",
        "taxCategory",
        "taxCode",
        "agreedDate",
        "isDeposit",
        "sortOrder",
      ].sort(),
    )
    expect(hash(fixture())).toBe("2c732d477e0848a3c6bbf605cec37bded75a5348c233d4c046bc073464228909")
  })
  it("changes the hash for agreed dates and validity, not forecasts, notes or lifecycle metadata", () => {
    const original = fixture()
    const originalHash = hash(original)
    expect(hash({ ...original, validUntil: new Date("2026-11-01") })).not.toBe(originalHash)
    expect(
      hash({
        ...original,
        deliverables: [{ ...original.deliverables[0]!, agreedDate: new Date("2026-11-03") }],
      }),
    ).not.toBe(originalHash)
    const operational = {
      ...original,
      notes: "other private notes",
      number: "AGR-0001",
      issueDate: new Date(),
      expiresAt: new Date(),
      status: "sent",
      offerRevision: 2,
      acceptedByName: "someone",
      lastEmailAttemptOutcome: "sending",
      deliverables: [
        {
          ...original.deliverables[0]!,
          expectedDate: new Date("2026-12-01"),
          status: "delivered",
          billingStatus: "reserved",
          deliveryRevision: 2,
        },
      ],
    }
    expect(hash(operational)).toBe(originalHash)
  })
})
