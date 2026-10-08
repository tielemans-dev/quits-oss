import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../lib/email", async () => ({
  ...await vi.importActual<typeof import("../../../lib/email")>("../../../lib/email"),
  deliver: vi.fn().mockResolvedValue({ id: "calendar-date-email" }),
}))

import { loadEinvoiceDocument } from "../../../lib/exports/einvoice"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"
import type { RenderInput } from "../../../domain/documents/render-input"

const dates = ["2026-11-07", "2028-02-29", "2027-03-14", "2026-11-01"]
const zones = ["America/New_York", "Pacific/Pago_Pago", "Europe/Copenhagen"]

;(hasTestDatabase ? describe : describe.skip)("invoice calendar dates through issuance", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
    vi.unstubAllEnvs()
  })

  it.each(zones.flatMap(timezone => dates.map(date => ({ timezone, date }))))(
    "keeps $date in $timezone in the issued view, snapshot, PDF input and UBL input",
    async ({ timezone, date }) => {
      vi.stubEnv("RESEND_API_KEY", "calendar-date-test")
      vi.stubEnv("FROM_EMAIL", "billing@example.test")
      const org = await createTestOrganization({ settings: { timezone } })
      cleanups.push(org.cleanup)
      const caller = appRouter.createCaller({ session: {
        user: { id: org.actors.admin.userId, email: "admin@example.test", name: "Admin" },
        session: { activeOrganizationId: org.organizationId },
      } } as never)
      const contact = await prisma.contact.create({ data: {
        organizationId: org.organizationId, name: "Customer", email: "customer@example.test",
      } })
      const draft = await caller.invoices.createV2({
        contactId: contact.id, dueDate: date, supplyDate: date, taxRate: "0",
        items: [{ description: "Work", quantity: "1", unitPrice: "100" }],
      })
      await caller.invoices.send({ id: draft.id })
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } })
      expect(invoice.status).toBe("sent")
      expect(invoice.dueDate.toISOString()).toBe(`${date}T00:00:00.000Z`)
      expect(invoice.issuanceSnapshot).toMatchObject({ dueDate: date, supplyDate: date })
      // The legacy export mapper also reads the UTC calendar columns directly.
      expect(await loadEinvoiceDocument(org.organizationId, "invoice", draft.id)).toMatchObject({
        dueDate: date, deliveryDate: date,
      })
      const view = await caller.invoices.get({ id: draft.id })
      expect(new Date(view.dueDate).toISOString().slice(0, 10)).toBe(date)
      const staging = await prisma.artifactStaging.findFirstOrThrow({ where: {
        organizationId: org.organizationId, documentId: draft.id,
      } })
      const input = staging.renderInput as unknown as Extract<RenderInput, { kind: "invoice" }>
      expect(input.pdf.invoice.dueDate.slice(0, 10)).toBe(date)
      expect(input.pdf.invoice.supplyDate).toBe(date)
      expect(input.ubl).toMatchObject({ dueDate: date, deliveryDate: date })
    }
  )
})
