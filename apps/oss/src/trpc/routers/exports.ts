import { EinvoiceVatError } from "../../lib/exports/ubl"
import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { Prisma } from "../../../generated/prisma/client"
import { accountingExportInputSchema, einvoiceExportInputSchema } from "@quits/contracts/exports"
import { actorCan } from "../../domain/actor"
import { exportAccounting } from "../../lib/exports/accounting"
import { vatOverview } from "../../lib/exports/vat-overview"
import { prisma } from "../../lib/db"
import { EinvoiceSourceNotFound, EinvoiceArtifactUnavailable, exportEinvoice } from "../../lib/exports/einvoice"
import { authorizedProcedure, orgProcedure, router } from "../init"

export const exportsRouter = router({
  vatOverview: authorizedProcedure("export:read").query(({ ctx }) => vatOverview(prisma, ctx.organizationId)),
  setPurchaseVat: authorizedProcedure("settings:update")
    .input(z.object({ from: z.iso.date(), to: z.iso.date(),
      amount: z.string().regex(/^\d{1,16}([.,]\d{1,2})?$/).nullable() }))
    .mutation(({ ctx, input }) => prisma.$transaction(async db => {
      const now = new Date()
      const overview = await vatOverview(db, ctx.organizationId, now)
      if (!overview.available || overview.period.from !== input.from || overview.period.to !== input.to) {
        throw new TRPCError({ code: "CONFLICT", message: "Reload the VAT overview before editing purchase VAT" })
      }
      const key = { organizationId: ctx.organizationId, from: input.from, to: input.to }
      const data = { inputVat: input.amount === null ? null : new Prisma.Decimal(input.amount.replace(",", ".")), updatedBy: ctx.user.id }
      await db.vatPeriodEntry.upsert({ where: { organizationId_from_to: key }, create: { ...key, ...data }, update: data })
      return vatOverview(db, ctx.organizationId, now)
    })),
  /** Peppol BIS Billing 3.0 UBL for an issued invoice or credit note, or the data it lacks. */
  einvoice: orgProcedure.input(einvoiceExportInputSchema).query(async ({ ctx, input }) => {
    const permission = input.kind === "invoice" ? "invoice:read" : "creditNote:read"
    if (!actorCan(ctx.actor, permission)) {
      throw new TRPCError({ code: "FORBIDDEN", message: `Your role does not allow ${permission}` })
    }
    try {
      return await exportEinvoice(ctx.organizationId, input.kind, input.id)
    } catch (error) {
      if (error instanceof EinvoiceSourceNotFound) {
        throw new TRPCError({ code: "NOT_FOUND", message: error.message })
      }
      if (error instanceof EinvoiceArtifactUnavailable) throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message })
      if (error instanceof EinvoiceVatError) {
        throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error })
      }
      throw error
    }
  }),

  /** Accounting CSV of invoices, credit notes or payments for an inclusive date range. */
  accounting: authorizedProcedure("export:read")
    .input(accountingExportInputSchema)
    .query(({ ctx, input }) => exportAccounting(ctx.organizationId, input)),
})
