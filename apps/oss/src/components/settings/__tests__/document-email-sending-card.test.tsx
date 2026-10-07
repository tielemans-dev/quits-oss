import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("../../../lib/i18n/react", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const templates: Record<string, string> = {
        "settings.section.documentSending.title": "Branded Email Sending",
        "settings.section.documentSending.description":
          "Send quote and invoice emails from a verified customer subdomain.",
        "settings.documentSending.status.not_configured": "Not configured",
        "settings.documentSending.status.pending_dns": "DNS setup required",
        "settings.documentSending.status.verifying": "Verifying",
        "settings.documentSending.status.verified": "Verified",
        "settings.documentSending.status.failed": "Attention needed",
        "settings.documentSending.effectiveSender.label": "Effective sender",
        "settings.documentSending.sharedSender.label": "Shared fallback sender",
        "settings.documentSending.replyTo.label": "Reply-To",
        "settings.documentSending.domain.label": "Sending subdomain",
        "settings.documentSending.domain.help":
          "Use a customer-owned subdomain such as billing.acme.com.",
        "settings.documentSending.requestedDomain.label": "Configured domain",
        "settings.documentSending.records.label": "Required DNS records",
        "settings.documentSending.verifiedAt.label": "Verified at",
        "settings.documentSending.lastSyncedAt.label": "Last synced",
        "settings.documentSending.lastSyncSource.label": "Last sync source",
        "settings.documentSending.lastSyncSource.manual": "Manual check",
        "settings.documentSending.lastSyncSource.webhook": "Webhook",
        "settings.documentSending.failureReason.label": "Provider status",
        "settings.documentSending.actions.configure": "Connect domain",
        "settings.documentSending.actions.refresh": "Check verification",
        "settings.documentSending.actions.disable": "Disable branded sending",
      }

      return templates[key] ?? key
    },
  }),
}))

import { DocumentEmailSendingCard } from "../document-email-sending-card"

describe("DocumentEmailSendingCard", () => {
  it("renders the empty managed state with a domain input", () => {
    const html = renderToStaticMarkup(
      <DocumentEmailSendingCard
        documentSending={{
          managed: true,
          supportsCustomDomain: true,
          status: "not_configured",
          requestedDomain: null,
          records: [],
          failureReason: null,
          verifiedAt: null,
          lastSyncedAt: null,
          lastSyncSource: null,
          sharedSender: {
            fromName: "Acme via Quits",
            fromEmail: "billing@yaip.app",
            replyTo: "billing@acme.com",
            usingBrandedDomain: false,
          },
          effectiveSender: {
            fromName: "Acme via Quits",
            fromEmail: "billing@yaip.app",
            replyTo: "billing@acme.com",
            usingBrandedDomain: false,
          },
        }}
        requestedDomain="billing.acme.com"
        busy={false}
        error={null}
        success={null}
        onRequestedDomainChange={() => {}}
        onConfigure={() => {}}
        onRefresh={() => {}}
        onDisable={() => {}}
      />
    )

    expect(html).toContain("Branded Email Sending")
    expect(html).toContain("Not configured")
    expect(html).toContain("billing@yaip.app")
    expect(html).toContain("Connect domain")
  })

  it("renders dns records when setup is pending", () => {
    const html = renderToStaticMarkup(
      <DocumentEmailSendingCard
        documentSending={{
          managed: true,
          supportsCustomDomain: true,
          status: "pending_dns",
          requestedDomain: "billing.acme.com",
          records: [
            {
              name: "send.billing.acme.com",
              type: "TXT",
              value: "v=spf1 include:amazonses.com ~all",
              ttl: 300,
              status: "pending",
            },
          ],
          failureReason: null,
          verifiedAt: null,
          lastSyncedAt: new Date("2026-03-06T18:05:00.000Z"),
          lastSyncSource: "manual",
          sharedSender: {
            fromName: "Acme via Quits",
            fromEmail: "billing@yaip.app",
            replyTo: "billing@acme.com",
            usingBrandedDomain: false,
          },
          effectiveSender: {
            fromName: "Acme via Quits",
            fromEmail: "billing@yaip.app",
            replyTo: "billing@acme.com",
            usingBrandedDomain: false,
          },
        }}
        requestedDomain="billing.acme.com"
        busy={false}
        error={null}
        success={null}
        onRequestedDomainChange={() => {}}
        onConfigure={() => {}}
        onRefresh={() => {}}
        onDisable={() => {}}
      />
    )

    expect(html).toContain("DNS setup required")
    expect(html).toContain("send.billing.acme.com")
    expect(html).toContain("Last synced")
    expect(html).toContain("Manual check")
    expect(html).toContain("Check verification")
    expect(html).toContain("Disable branded sending")
  })

  it("renders the verified branded sender preview", () => {
    const html = renderToStaticMarkup(
      <DocumentEmailSendingCard
        documentSending={{
          managed: true,
          supportsCustomDomain: true,
          status: "verified",
          requestedDomain: "billing.acme.com",
          records: [],
          failureReason: null,
          verifiedAt: new Date("2026-03-06T18:00:00.000Z"),
          lastSyncedAt: new Date("2026-03-06T18:01:00.000Z"),
          lastSyncSource: "webhook",
          sharedSender: {
            fromName: "Acme via Quits",
            fromEmail: "billing@yaip.app",
            replyTo: "billing@acme.com",
            usingBrandedDomain: false,
          },
          effectiveSender: {
            fromName: "Acme",
            fromEmail: "billing@billing.acme.com",
            replyTo: "billing@acme.com",
            usingBrandedDomain: true,
          },
        }}
        requestedDomain="billing.acme.com"
        busy={false}
        error={null}
        success={null}
        onRequestedDomainChange={() => {}}
        onConfigure={() => {}}
        onRefresh={() => {}}
        onDisable={() => {}}
      />
    )

    expect(html).toContain("Verified")
    expect(html).toContain("billing@billing.acme.com")
    expect(html).toContain("Verified at")
    expect(html).toContain("Last sync source")
    expect(html).toContain("Webhook")
  })
})
