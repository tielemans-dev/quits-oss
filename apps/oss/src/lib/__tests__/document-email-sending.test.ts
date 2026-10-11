import { describe, expect, it } from "vitest"
import { buildInvoiceEmailContent, buildQuoteEmailContent } from "../email"
import { buildCreditNoteEmailContent } from "../emails/credit-note-email"
import { buildReminderEmailContent } from "../emails/reminder-email"
import {
  resolveDocumentEmailEnvelope,
  validateDocumentSendingDomain,
} from "../document-email-sending"

describe("document email sending", () => {
  it("does not nest a configured sender mailbox inside the document sender", () => {
    const envelope = resolveDocumentEmailEnvelope({
      orgName: "QA Test Co",
      sharedFromEmail: "Quits <noreply@tielemans.dev>",
    })
    const content = buildInvoiceEmailContent({
      ...envelope,
      invoice: {
        number: "INV-1", issueDate: "2026-10-01", dueDate: "2026-10-31",
        subtotal: 100, taxAmount: 0, total: 100, currency: "DKK", items: [],
      },
      org: { companyName: "QA Test Co" },
      contactName: "Buyer",
    })
    expect(content.fromAddress).toBe('"QA Test Co via quits" <noreply@tielemans.dev>')
  })

  it.each([null, undefined, "", "  ", "\r\n"])("uses quits when the organization name is empty", orgName => {
    expect(resolveDocumentEmailEnvelope({ orgName, sharedFromEmail: "Quits <noreply@example.com>" }))
      .toMatchObject({ fromName: "quits", fromEmail: "noreply@example.com" })
  })

  it("extracts the branded local part from a configured display-name mailbox", () => {
    expect(resolveDocumentEmailEnvelope({
      orgName: "Æble ApS",
      sharedFromEmail: "Quits <billing+docs@example.com>",
      branded: { status: "verified", domain: "mail.acme.com" },
    })).toMatchObject({
      fromName: "Æble ApS", fromEmail: "billing+docs@mail.acme.com", usingBrandedDomain: true,
    })
  })

  it.each(["QA Test Co", 'QA "Test" Co', "Æble Øl Århus", "", "  "])(
    "formats the sender consistently for all document builders: %s", orgName => {
      const envelope = resolveDocumentEmailEnvelope({
        orgName, sharedFromEmail: "Quits <noreply@tielemans.dev>", orgBillingEmail: "reply@example.com",
      })
      const document = {
        number: "DOC-1", issueDate: "2026-10-01", dueDate: "2026-10-31", expiryDate: "2026-10-31",
        subtotal: 100, taxAmount: 0, total: 100, currency: "DKK", items: [],
      }
      const common = { ...envelope, org: { companyName: orgName }, contactName: "Buyer" }
      const contents = [
        buildInvoiceEmailContent({ ...common, invoice: document }),
        buildQuoteEmailContent({ ...common, quote: document }),
        buildCreditNoteEmailContent({ ...common, creditNote: { ...document, reason: "Refund" }, invoice: document }),
        buildReminderEmailContent({ ...common, stage: "overdue", invoice: { ...document, balanceDue: 100 } }),
      ]
      const name = orgName.trim() ? `${orgName} via quits` : "quits"
      const expectedName = orgName === "Æble Øl Århus"
        ? `=?UTF-8?B?${Buffer.from(name).toString("base64")}?=`
        : `"${name.replaceAll('"', '\\"')}"`
      for (const content of contents) {
        expect(content.fromAddress).toBe(`${expectedName} <noreply@tielemans.dev>`)
        expect(content.replyTo).toBe("reply@example.com")
      }
    }
  )

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
      fromName: "Acme via quits",
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
