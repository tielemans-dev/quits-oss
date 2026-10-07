import { describe, expect, it } from "vitest"
import {
  resolveDocumentEmailEnvelope,
  validateDocumentSendingDomain,
} from "../document-email-sending"

describe("document email sending", () => {
  it("uses a verified branded sender for document emails", () => {
    const result = resolveDocumentEmailEnvelope({
      orgName: "Acme",
      orgBillingEmail: "billing@acme.com",
      sharedFromEmail: "billing@yaip.app",
      branded: {
        status: "verified",
        domain: "billing.acme.com",
      },
    })

    expect(result).toEqual({
      fromEmail: "billing@billing.acme.com",
      fromName: "Acme",
      replyTo: "billing@acme.com",
      usingBrandedDomain: true,
    })
  })

  it("falls back to the shared sender when branded sending is not verified", () => {
    expect(
      resolveDocumentEmailEnvelope({
        orgName: "Acme",
        orgBillingEmail: "billing@acme.com",
        sharedFromEmail: "billing@yaip.app",
        branded: {
          status: "pending_dns",
          domain: "billing.acme.com",
        },
      })
    ).toEqual({
      fromEmail: "billing@yaip.app",
      fromName: "Acme via Quits",
      replyTo: "billing@acme.com",
      usingBrandedDomain: false,
    })
  })

  it("omits reply-to when the organization billing email is missing", () => {
    expect(
      resolveDocumentEmailEnvelope({
        orgName: "Acme",
        orgBillingEmail: null,
        sharedFromEmail: "billing@yaip.app",
        branded: {
          status: "verified",
          domain: "billing.acme.com",
        },
      }).replyTo
    ).toBeNull()
  })

  it("rejects apex domains", () => {
    expect(validateDocumentSendingDomain("acme.com")).toEqual({
      valid: false,
      reason: "Document sending domains must use a subdomain, not the root domain",
    })
  })

  it("accepts subdomains", () => {
    expect(validateDocumentSendingDomain("billing.acme.com")).toEqual({
      valid: true,
      normalizedDomain: "billing.acme.com",
    })
  })
})
