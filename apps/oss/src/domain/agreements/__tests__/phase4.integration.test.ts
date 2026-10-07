import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../../lib/db"
import {
  createTestOrganization,
  hasTestDatabase,
} from "../../../test-utils/organization"
import { executeCommand } from "../../execute"
import { createAgreementDraft } from "../../commands/agreements"
import { convertQuoteToInvoice, createQuoteDraft } from "../../commands/quotes"
import { appRouter } from "../../../trpc/router"
import { buildOfferSnapshot } from "../snapshot"
import { calculateDraft } from "@quits/shared/pricing"
import { agreementTools } from "../../agent-tools/tools/agreements"
import type { AgentActor } from "../../actor"

function completed<T>(outcome: { status: string; result?: T }): T {
  expect(outcome.status, JSON.stringify(outcome)).toBe("completed")
  return outcome.result!
}
function caller(
  org: Awaited<ReturnType<typeof createTestOrganization>>,
  role: "admin" | "member" | "accountant" = "admin",
) {
  return appRouter.createCaller({
    session: {
      user: {
        id: org.actors[role].userId,
        name: "Test",
        email: "test@example.test",
      },
      session: { activeOrganizationId: org.organizationId },
    },
  } as never)
}
describe.runIf(hasTestDatabase)(
  "Phase 4 quote conversion and templates",
  () => {
    const cleanups: Array<() => Promise<void>> = []
    afterEach(async () => {
      while (cleanups.length) await cleanups.pop()?.()
    })
    async function setup(pricesIncludeTax = false) {
      const org = await createTestOrganization({
        roles: ["admin", "member", "accountant"],
        settings: {
          countryCode: "DK",
          currency: "DKK",
          locale: "da-DK",
          timezone: "Europe/Copenhagen",
          taxRegime: "eu_vat",
          pricesIncludeTax,
        },
      })
      cleanups.push(org.cleanup)
      const contact = await prisma.contact.create({
        data: { organizationId: org.organizationId, name: "Buyer" },
      })
      const items = [
        {
          description: "Design and build",
          quantity: "1.234567",
          unitPrice: "123.4567",
          vat: { treatment: "standard" as const, rate: "0.25" },
        },
        {
          description: "Review",
          quantity: "2",
          unitPrice: "0.03",
          vat: { treatment: "standard" as const, rate: "0.25" },
        },
      ]
      const quote = completed(
        await executeCommand(
          createQuoteDraft,
          {
            contactId: contact.id,
            expiryDate: "2099-12-01",
            taxRate: "25",
            items,
          },
          { actor: org.actors.admin },
        ),
      )
      await prisma.quote.update({
        where: { id: quote.id },
        data: { status: "accepted", supplyDate: new Date("2099-10-20") },
      })
      return {
        org,
        contact,
        quote,
        items,
        input: { sourceQuoteId: quote.id, validUntil: "2099-12-10" },
        api: caller(org),
      }
    }
    for (const gross of [false, true])
      it(`maps original decimal inputs and quote context to v2 services, gross basis=${gross}`, async () => {
        const { org, quote, items, input, api } = await setup(gross)
        // Current organization defaults must not overwrite the accepted quote's tax context.
        await prisma.orgSettings.update({
          where: { organizationId: org.organizationId },
          data: {
            defaultCurrency: "USD",
            pricesIncludeTax: !gross,
            timezone: "UTC",
          },
        })
        const result = await api.agreements.createDraftDecimal(input)
        const agreement = await prisma.agreement.findUniqueOrThrow({
          where: { id: result.id },
          include: { deliverables: { orderBy: { sortOrder: "asc" } } },
        })
        const price = calculateDraft({
          items,
          taxRate: "25",
          currency: "DKK",
          pricesIncludeTax: gross,
        })
        expect(agreement).toMatchObject({
          sourceQuoteId: quote.id,
          status: "draft",
          number: null,
          offerRevision: 0,
          offerFormatVersion: 2,
          calculationVersion: "v2",
          currency: "DKK",
          pricesIncludeTax: gross,
          timezone: "Europe/Copenhagen",
        })
        expect(agreement.totalGross.toFixed(2)).toBe(price.gross)
        expect(agreement.deliverables[0]).toMatchObject({
          title: "Design and build",
          description: "Design and build",
          quantityInput: "1.234567",
          unitPriceInput: "123.4567",
          isDeposit: false,
          agreedDate: new Date("2099-10-20"),
          billingStatus: "unbilled",
        })
        expect(agreement.termsMarkdown).toContain("{{deliverables}}")
        expect(buildOfferSnapshot(agreement)).toMatchObject({
          offerFormatVersion: 2,
          serviceTotal: { gross: price.gross },
          paymentSchedule: [],
        })
        expect(
          await prisma.domainEvent.findFirst({
            where: { aggregateId: result.id, type: "agreement.draft_created" },
          }),
        ).toMatchObject({
          schemaVersion: 2,
          payload: { sourceQuoteId: quote.id },
        })
      })
    it("reprices backfilled legacy inputs with the v2 service total without changing the quote", async () => {
      const { org, quote, input } = await setup()
      await prisma.quoteItem.deleteMany({ where: { quoteId: quote.id } })
      await prisma.quote.update({
        where: { id: quote.id },
        data: {
          calculationVersion: "legacy_per_line",
          subtotalNet: "0.04",
          totalTax: "0.02",
          totalGross: "0.06",
          items: {
            create: [0, 1].map((sortOrder) => ({
              description: "Legacy line",
              quantity: "1",
              unitPriceNet: "0.02",
              unitPriceGross: "0.03",
              lineNet: "0.02",
              lineTax: "0.01",
              lineGross: "0.03",
              taxRate: "25",
              sortOrder,
            })),
          },
        },
      })
      const agreement = completed(
        await executeCommand(createAgreementDraft, input, {
          actor: org.actors.admin,
        }),
      )
      expect(agreement.totalGross.toFixed(2)).toBe("0.05")
      expect(
        agreement.deliverables.every(
          (line) => line.inputPrecision === "backfilled",
        ),
      ).toBe(true)
      expect(buildOfferSnapshot(agreement)).toMatchObject({
        serviceTotal: { gross: "0.05" },
      })
      expect(
        (
          await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })
        ).totalGross.toFixed(2),
      ).toBe("0.06")
    })
    it("converts legacy standard/zero-tax lines into explicit v2 out-of-scope services", async () => {
      const { org, quote, input } = await setup()
      await prisma.quoteItem.updateMany({
        where: { quoteId: quote.id },
        data: {
          taxRate: "0",
          vatRateInput: null,
          vatTreatment: "standard",
          quantityInput: null,
          unitPriceInput: null,
          inputPrecision: null,
        },
      })
      const agreement = completed(
        await executeCommand(createAgreementDraft, input, {
          actor: org.actors.admin,
        }),
      )
      expect(
        agreement.deliverables.every(
          (line) =>
            line.vatTreatment === "out_of_scope" && line.vatRateInput === "0",
        ),
      ).toBe(true)
      expect(buildOfferSnapshot(agreement)).toMatchObject({
        offerFormatVersion: 2,
        serviceTotal: { tax: "0.00" },
      })
    })
    it("refuses invoices, an existing agreement, unaccepted quotes and cross-organization quotes", async () => {
      const { org, quote, input } = await setup()
      completed(
        await executeCommand(
          convertQuoteToInvoice,
          { id: quote.id },
          { actor: org.actors.admin },
        ),
      )
      expect(
        await executeCommand(createAgreementDraft, input, {
          actor: org.actors.admin,
        }),
      ).toMatchObject({
        status: "failed",
        error: { code: "quote_has_invoices" },
      })
      const second = await setup()
      completed(
        await executeCommand(createAgreementDraft, second.input, {
          actor: second.org.actors.admin,
        }),
      )
      expect(
        await executeCommand(createAgreementDraft, second.input, {
          actor: second.org.actors.admin,
        }),
      ).toMatchObject({
        status: "failed",
        error: { code: "quote_has_agreement" },
      })
      expect(
        await executeCommand(
          convertQuoteToInvoice,
          { id: second.quote.id },
          { actor: second.org.actors.admin },
        ),
      ).toMatchObject({
        status: "failed",
        error: { code: "quote_has_agreement" },
      })
      expect(
        await executeCommand(createAgreementDraft, second.input, {
          actor: org.actors.admin,
        }),
      ).toMatchObject({ status: "failed", error: { tag: "NotFound" } })
      await prisma.quote.update({
        where: { id: quote.id },
        data: { status: "draft" },
      })
      expect(
        await executeCommand(createAgreementDraft, input, {
          actor: org.actors.admin,
        }),
      ).toMatchObject({ status: "failed", error: { code: "not_accepted" } })
    })
    it("serializes competing conversion paths and duplicate agreement requests", async () => {
      const { org, quote, input } = await setup()
      const outcomes = await Promise.all([
        executeCommand(createAgreementDraft, input, {
          actor: org.actors.admin,
        }),
        executeCommand(
          convertQuoteToInvoice,
          { id: quote.id },
          { actor: org.actors.admin },
        ),
      ])
      expect(outcomes.filter((o) => o.status === "completed")).toHaveLength(1)
      const second = await setup()
      const duplicates = await Promise.all(
        [0, 1].map(() =>
          executeCommand(createAgreementDraft, second.input, {
            actor: second.org.actors.admin,
          }),
        ),
      )
      expect(duplicates.filter((o) => o.status === "completed")).toHaveLength(1)
      expect(
        await prisma.agreement.count({
          where: { sourceQuoteId: second.quote.id },
        }),
      ).toBe(1)
    })
    it("exposes inward conversion to an approval-required MCP drafting agent with idempotency", async () => {
      const { org, input } = await setup()
      const tool = agreementTools.find(
        (row) => row.name === "agreement_create_draft_from_quote",
      )!
      const actor: AgentActor = {
        kind: "agent",
        organizationId: org.organizationId,
        agentKeyId: "phase4-key",
        label: "Drafting",
        mode: "approval_required",
        ownerRoles: ["admin"],
        scopes: ["agreement:create"],
      }
      const raw = tool.input.parse({
        ...input,
        clientRequestId: "phase4-conversion",
      })
      const record = await tool.run({ actor }, raw)
      expect(record).toMatchObject({
        status: "completed",
        result: { sourceQuoteId: input.sourceQuoteId },
      })
      expect(await tool.run({ actor }, raw)).toEqual(record)
    })
    it("creates, edits and deletes templates without changing existing agreements or reseeding deleted defaults", async () => {
      const { org, contact, api } = await setup()
      const template = await api.agreements.createTemplate({
        name: "Custom",
        termsMarkdown: "Original terms",
        isDefault: true,
      })
      const draft = await api.agreements.createDraft({
        contactId: contact.id,
        title: "Scope",
        validUntil: "2099-12-01",
        templateId: template.id,
      })
      await api.agreements.updateTemplate({
        id: template.id,
        termsMarkdown: "New terms",
      })
      expect((await api.agreements.get({ id: draft.id })).termsMarkdown).toBe(
        "Original terms",
      )
      await api.agreements.deleteTemplate({ id: template.id })
      expect(await api.agreements.get({ id: draft.id })).toMatchObject({
        templateId: null,
        termsMarkdown: "Original terms",
      })
      const seeded = await api.agreements.listTemplates()
      for (const row of seeded)
        await api.agreements.deleteTemplate({ id: row.id })
      expect(await api.agreements.listTemplates()).toEqual([])
      const other = await setup()
      await expect(
        other.api.agreements.updateTemplate({
          id: seeded[0]!.id,
          name: "Stolen",
        }),
      ).rejects.toThrow()
      expect(
        await prisma.agreement.count({
          where: { organizationId: org.organizationId, id: draft.id },
        }),
      ).toBe(1)
    })
    it("keeps template names unique and at most one default under concurrent writes", async () => {
      const { api } = await setup()
      await Promise.all(
        ["A", "B"].map((name) =>
          api.agreements.createTemplate({
            name,
            termsMarkdown: "",
            isDefault: true,
          }),
        ),
      )
      expect(
        (await api.agreements.listTemplates()).filter((t) => t.isDefault),
      ).toHaveLength(1)
      await expect(
        api.agreements.createTemplate({ name: "A", termsMarkdown: "" }),
      ).rejects.toThrow(/already exists/)
    })
  },
)
