import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("../../../lib/i18n/react", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) => {
      const templates: Record<string, string> = {
        "settings.section.emailDelivery.title": "Email Delivery",
        "settings.section.emailDelivery.description":
          "Check outbound email configuration and current availability.",
        "settings.emailDelivery.status.configured": "Configured",
        "settings.emailDelivery.status.missing_configuration": "Missing configuration",
        "settings.emailDelivery.status.managed": "Managed by Cloud",
        "settings.emailDelivery.status.managed_unavailable": "Temporarily unavailable",
        "settings.emailDelivery.sender.label": "Sender",
        "settings.emailDelivery.missing.label": "Missing env vars",
        "settings.emailDelivery.help.configured": "Email delivery is ready to send.",
        "settings.emailDelivery.help.missing_configuration":
          "Configure the missing environment variables to enable delivery.",
        "settings.emailDelivery.help.managed":
          "Email delivery is managed by cloud infrastructure.",
        "settings.emailDelivery.help.managed_unavailable":
          "Email delivery is managed by cloud infrastructure but currently unavailable.",
      }

      let template = templates[key] ?? key
      for (const [name, value] of Object.entries(values ?? {})) {
        template = template.replace(`{${name}}`, value)
      }
      return template
    },
  }),
}))

import { EmailDeliveryCard } from "../email-delivery-card"

describe("EmailDeliveryCard", () => {
  it("renders OSS configured status with the effective sender", () => {
    const html = renderToStaticMarkup(
      <EmailDeliveryCard
        emailDelivery={{
          managed: false,
          configured: true,
          available: true,
          sender: "billing@acme.example",
          missing: [],
          status: "configured",
        }}
      />
    )

    expect(html).toContain("Email Delivery")
    expect(html).toContain("Configured")
    expect(html).toContain("billing@acme.example")
    expect(html).not.toContain("Missing env vars")
  })

  it("renders OSS missing configuration with missing env var names", () => {
    const html = renderToStaticMarkup(
      <EmailDeliveryCard
        emailDelivery={{
          managed: false,
          configured: false,
          available: false,
          sender: "noreply@yaip.app",
          missing: ["FROM_EMAIL", "RESEND_API_KEY"],
          status: "missing_configuration",
        }}
      />
    )

    expect(html).toContain("Missing configuration")
    expect(html).toContain("FROM_EMAIL")
    expect(html).toContain("RESEND_API_KEY")
  })
})
