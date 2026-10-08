import { describe, expect, it } from "vitest"
import {
  clientActionGrantInputSchema,
  clientActionLinkCreateInputSchema,
  clientActionNeedsVerification,
  clientActionRequestSchema,
  normalizeCapabilities,
} from "./client-actions"

const invoiceGrant = { kind: "invoice", recordId: "inv_1", capabilities: ["view", "pay"] } as const
const agreementGrant = { kind: "agreement", recordId: "agr_1", capabilities: ["view", "approve"] } as const
const base = { contactId: "c_1", recipientName: " Pia ", expiresInDays: 30, verification: "none" } as const

describe("client action grants", () => {
  it("only offers each kind of record its own capabilities", () => {
    expect(clientActionGrantInputSchema.safeParse(invoiceGrant).success).toBe(true)
    // A payer never gets an approval capability, and an agreement is never paid.
    expect(clientActionGrantInputSchema.safeParse({ kind: "invoice", recordId: "i", capabilities: ["view", "approve"] }).success).toBe(false)
    expect(clientActionGrantInputSchema.safeParse({ kind: "agreement", recordId: "a", capabilities: ["pay"] }).success).toBe(false)
    expect(clientActionGrantInputSchema.safeParse({ kind: "deliverable", recordId: "d", capabilities: [] }).success).toBe(false)
  })

  it("always keeps view, and drops nothing a record can hold", () => {
    expect(normalizeCapabilities("invoice", ["pay"])).toEqual(["view", "pay"])
    expect(normalizeCapabilities("agreement", ["approve", "view"])).toEqual(["view", "approve"])
    expect(normalizeCapabilities("deliverable", ["view"])).toEqual(["view"])
  })

  it("rejects unknown fields, so a grant cannot smuggle in broader access", () => {
    expect(clientActionGrantInputSchema.safeParse({ ...invoiceGrant, organizationId: "other" }).success).toBe(false)
  })
})

describe("client link creation", () => {
  it("normalizes the recipient and applies the defaults", () => {
    const parsed = clientActionLinkCreateInputSchema.parse({ ...base, recipientEmail: " Pia@Example.TEST ", grants: [invoiceGrant] })
    expect(parsed).toMatchObject({ recipientName: "Pia", recipientEmail: "pia@example.test" })
  })

  it("requires a verified email recipient to decide an agreement", () => {
    const decide = { ...base, recipientEmail: "pia@example.test", grants: [agreementGrant] }
    expect(clientActionNeedsVerification(decide.grants)).toBe(true)
    expect(clientActionLinkCreateInputSchema.safeParse(decide).success).toBe(false)
    expect(clientActionLinkCreateInputSchema.safeParse({ ...decide, verification: "email_code" }).success).toBe(true)
    expect(clientActionLinkCreateInputSchema.safeParse({ ...decide, verification: "email_code", recipientEmail: null }).success).toBe(false)
  })

  it("does not need verification to view or pay", () => {
    expect(clientActionNeedsVerification([invoiceGrant])).toBe(false)
    expect(clientActionLinkCreateInputSchema.safeParse({ ...base, grants: [invoiceGrant] }).success).toBe(true)
  })

  it("limits the lifetime, the number of grants and duplicates", () => {
    expect(clientActionLinkCreateInputSchema.safeParse({ ...base, expiresInDays: 91, grants: [invoiceGrant] }).success).toBe(false)
    expect(clientActionLinkCreateInputSchema.safeParse({ ...base, grants: [] }).success).toBe(false)
    expect(clientActionLinkCreateInputSchema.safeParse({ ...base, grants: [invoiceGrant, invoiceGrant] }).success).toBe(false)
  })
})

describe("client action requests", () => {
  it("names the revision the visitor saw and requires explicit confirmation", () => {
    expect(clientActionRequestSchema.safeParse({ type: "deliverable.accept", deliverableId: "d", deliveryRevision: 2, confirmed: true }).success).toBe(true)
    expect(clientActionRequestSchema.safeParse({ type: "deliverable.accept", deliverableId: "d", confirmed: true }).success).toBe(false)
    expect(clientActionRequestSchema.safeParse({ type: "deliverable.accept", deliverableId: "d", deliveryRevision: 2, confirmed: false }).success).toBe(false)
    expect(clientActionRequestSchema.safeParse({ type: "agreement.accept", agreementId: "a", offerRevision: 1, acceptedByName: "  ", confirmed: true }).success).toBe(false)
  })

  it("pays only the balance: there is no amount a visitor can choose", () => {
    expect(clientActionRequestSchema.safeParse({ type: "invoice.pay", invoiceId: "i" }).success).toBe(true)
    expect(clientActionRequestSchema.safeParse({ type: "invoice.pay", invoiceId: "i", amount: 1 }).success).toBe(false)
  })
})
