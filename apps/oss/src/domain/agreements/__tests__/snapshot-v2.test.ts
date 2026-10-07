import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { readAgreementOfferSnapshot } from "@quits/contracts/agreements"
import { buildOfferSnapshot, canonicalizeOffer, hashOfferSnapshot } from "../snapshot"
import { v2Fixture } from "./v2-fixture"
const fixture = JSON.parse(readFileSync(new URL("./fixtures/offer-v2.json", import.meta.url), "utf8"))
describe("offer format v2", () => {
  it("pins a separate snapshot, original decimals, service groups and VAT-attributed schedule", () => {
    const snapshot = buildOfferSnapshot(v2Fixture())
    expect(canonicalizeOffer(snapshot)).toBe(canonicalizeOffer(fixture.snapshot))
    expect(hashOfferSnapshot(snapshot)).toBe(fixture.hash)
    expect(snapshot).toMatchObject({ offerFormatVersion: 2, calculationVersion: "v2",
      serviceTotal: { net: "0.02", tax: "0.01", gross: "0.02", payableRounding: "-0.01", vatBasis: "gross" },
      originalInputs: [{ quantity: "1.000001", unitPrice: "0.0100" }, { quantity: "1" }, { unitPrice: "20" }],
      paymentSchedule: [{ amount: "20.00", vatBasis: "gross", trigger: "on_agreement_acceptance", vatGroupKey: '["standard",null,"0.25",null]' }],
    })
    expect(readAgreementOfferSnapshot(snapshot)).toEqual(snapshot)
  })
  it("dispatches missing version to v1 without injecting defaults; rejects unknown versions", () => {
    const legacy = buildOfferSnapshot({ ...v2Fixture(), offerFormatVersion: null })
    expect(readAgreementOfferSnapshot(legacy)).toEqual(legacy)
    expect(legacy).not.toHaveProperty("offerFormatVersion")
    expect(() => readAgreementOfferSnapshot({ ...legacy, offerFormatVersion: 3 })).toThrow()
  })
})
