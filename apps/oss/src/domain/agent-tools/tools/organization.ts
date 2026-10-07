import { z } from "zod"
import { prisma } from "../../../lib/db"
import { NotFound } from "../../errors"
import { defineQueryTool, type AgentTool } from "../define"

export const organizationTools: AgentTool[] = [
  defineQueryTool({
    name: "organization_read",
    title: "Read organization",
    description:
      "Start here. Returns the company profile, default and base currencies, locale, tax regime, and whether " +
      "prices include tax, plus this agent key's own mode and scopes. Use the currency and tax regime " +
      "when drafting documents, and the mode to know whether sends will wait for human approval.",
    input: z.object({}),
    permission: "settings:read",
    run: async ({ actor }) => {
      const organization = await prisma.organization.findUnique({
        where: { id: actor.organizationId },
        select: { id: true, name: true, settings: true },
      })
      if (!organization) {
        throw new NotFound({ message: "Organization not found", entity: "organization" })
      }
      const settings = organization.settings
      return {
        organization: {
          id: organization.id,
          name: organization.name,
          companyName: settings?.companyName ?? null,
          companyEmail: settings?.companyEmail ?? null,
          companyAddress: settings?.companyAddress ?? null,
          countryCode: settings?.countryCode ?? null,
          baseCurrency: settings?.baseCurrency ?? null,
          currency: settings?.defaultCurrency ?? settings?.currency ?? null,
          locale: settings?.locale ?? null,
          timezone: settings?.timezone ?? null,
          taxRegime: settings?.taxRegime ?? null,
          defaultTaxRate: settings?.taxRate ?? null,
          pricesIncludeTax: settings?.pricesIncludeTax ?? false,
          reminderPolicy: settings?.reminderPolicy ?? null,
        },
        agent: {
          keyId: actor.agentKeyId,
          name: actor.label,
          mode: actor.mode,
          scopes: actor.scopes,
          approvalRequiredFor:
            actor.mode === "approval_required"
              ? "Commands that leave Quits or move money, such as invoice_send, wait for a person to approve."
              : null,
        },
      }
    },
  }),
]
